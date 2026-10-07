// test/unit/deploy-client.test.ts
import { describe, expect, test, vi } from "vitest";
import {
  fetchDoraMetrics,
  fetchItemBranch,
  fetchPreflight,
  fetchServiceResolution,
  fetchStatsSeries,
} from "../../src/background/deploy-client.ts";
import { DAY_MS } from "../../src/shared/dora.ts";
import { MAX_BRANCH_LEN } from "../../src/shared/services.ts";

const ORIGIN = "http://127.0.0.1:7474";

const okEnvelope = {
  service: "web",
  target_ref: "main",
  computed_at: "2026-09-10T00:00:00.000Z",
  verdict: "ok",
  checks: {
    active_p1_incidents: { count: 0, findings: [], gap: null },
    failing_ci_runs: { count: 0, findings: [], gap: null },
    merge_conflicts: { count: 0, findings: [], gap: null },
  },
};

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("fetchPreflight", () => {
  test("sends service, target_ref and max_findings — and NO Authorization header", async () => {
    const doFetch = vi.fn(async () => jsonRes(okEnvelope));
    await fetchPreflight(ORIGIN, "web", "main", doFetch as unknown as typeof fetch);
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/preflight/deploy?");
    expect(url).toContain("service=web");
    expect(url).toContain("target_ref=main");
    expect(url).toContain("max_findings=10");
    expect(JSON.stringify(init?.headers ?? {})).not.toContain("Authorization");
  });

  test("url-encodes a ref containing slashes", async () => {
    const doFetch = vi.fn(async () => jsonRes(okEnvelope));
    await fetchPreflight(ORIGIN, "web", "feat/auth-v2", doFetch as unknown as typeof fetch);
    const [url] = doFetch.mock.calls[0] as unknown as [string];
    expect(url).toContain("target_ref=feat%2Fauth-v2");
  });

  test("returns the parsed envelope on 200", async () => {
    const doFetch = vi.fn(async () => jsonRes(okEnvelope));
    const r = await fetchPreflight(ORIGIN, "web", "main", doFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ verdict: "ok" }) });
  });

  test("a 200 that does not parse is malformed, not a server error", async () => {
    const doFetch = vi.fn(async () => jsonRes({ verdict: "pass" }));
    const r = await fetchPreflight(ORIGIN, "web", "main", doFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "malformed" });
  });

  test("a 400 is a server error", async () => {
    const doFetch = vi.fn(async () => jsonRes({ error: "missing" }, 400));
    const r = await fetchPreflight(ORIGIN, "web", "main", doFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "server_error" });
  });

  test("a 404 is a server error — an older gateway without the route", async () => {
    const doFetch = vi.fn(async () => new Response("", { status: 404 }));
    const r = await fetchPreflight(ORIGIN, "web", "main", doFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "server_error" });
  });

  test("a thrown fetch is unreachable", async () => {
    const doFetch = vi.fn(async () => {
      throw new TypeError("failed to fetch");
    });
    const r = await fetchPreflight(ORIGIN, "web", "main", doFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "unreachable" });
  });

  test("refuses out-of-bounds input before sending it", async () => {
    const doFetch = vi.fn(async () => jsonRes(okEnvelope));
    const r = await fetchPreflight(
      ORIGIN,
      "x".repeat(65),
      "main",
      doFetch as unknown as typeof fetch,
    );
    expect(r).toEqual({ ok: false, reason: "malformed" });
    expect(doFetch).not.toHaveBeenCalled();
  });

  test("refuses an empty or over-long target ref before sending it", async () => {
    for (const ref of ["", "r".repeat(MAX_BRANCH_LEN + 1)]) {
      const doFetch = vi.fn(async () => jsonRes(okEnvelope));
      const r = await fetchPreflight(ORIGIN, "web", ref, doFetch as unknown as typeof fetch);
      expect(r).toEqual({ ok: false, reason: "malformed" });
      expect(doFetch).not.toHaveBeenCalled();
    }
    // The longest LEGAL ref is sent: the refusal above is the bound, not an
    // off-by-one that would also refuse a real branch name.
    const doFetch = vi.fn(async () => jsonRes(okEnvelope));
    const r = await fetchPreflight(
      ORIGIN,
      "web",
      "r".repeat(MAX_BRANCH_LEN),
      doFetch as unknown as typeof fetch,
    );
    expect(r.ok).toBe(true);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * The public reads are bounded like the scoped ones: a wedged gateway must not
 * hold the deploy section open. Both doubles end only when the request's own
 * signal aborts, the way a real `fetch` does, and each read is checked as
 * "settled by then" rather than awaited, so one that ignored its signal fails
 * here instead of hanging. 10s is `DEPLOY_TIMEOUT_MS` in `deploy-client.ts`.
 */
describe("the public reads' timeout", () => {
  async function settleAfterTimeout(doFetch: typeof fetch): Promise<unknown> {
    vi.useFakeTimers();
    try {
      const p = fetchPreflight(ORIGIN, "web", "main", doFetch);
      let settled = false;
      void p.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      return await p;
    } finally {
      vi.useRealTimers();
    }
  }

  test("gives up on a gateway whose headers never arrive", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as unknown as typeof fetch;
    expect(await settleAfterTimeout(hanging)).toEqual({ ok: false, reason: "unreachable" });
  });

  // The timer stays armed across the body read, as the comment on `getJson`
  // says. A body cut off mid-object reads as no body, which the envelope parser
  // rejects — the same outcome as any 200 it cannot read.
  test("gives up on a 200 whose body never finishes", async () => {
    const hangingBody = (async (_url: string, init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"service":'));
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("aborted", "AbortError"));
            });
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    expect(await settleAfterTimeout(hangingBody)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("fetchItemBranch", () => {
  test("reads metadata.branch and returns ONLY the branch", async () => {
    const doFetch = vi.fn(async () =>
      jsonRes({ data: { id: "i1", body: "a very long body", metadata: { branch: "main" } } }),
    );
    const r = await fetchItemBranch(ORIGIN, "i1", doFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, value: "main" });
  });

  test("parses metadata delivered as a JSON string", async () => {
    const doFetch = vi.fn(async () =>
      jsonRes({ data: { id: "i1", metadata: JSON.stringify({ branch: "release" }) } }),
    );
    const r = await fetchItemBranch(ORIGIN, "i1", doFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, value: "release" });
  });

  test("an item with no branch is a null value, not a failure", async () => {
    const doFetch = vi.fn(async () => jsonRes({ data: { id: "i1", metadata: {} } }));
    const r = await fetchItemBranch(ORIGIN, "i1", doFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, value: null });
  });

  test("a missing item is a null value, not a failure", async () => {
    const doFetch = vi.fn(async () => jsonRes({ data: null }));
    const r = await fetchItemBranch(ORIGIN, "i1", doFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, value: null });
  });

  test("encodes an id containing a slash", async () => {
    const doFetch = vi.fn(async () => jsonRes({ data: null }));
    await fetchItemBranch(ORIGIN, "a/b", doFetch as unknown as typeof fetch);
    const [url] = doFetch.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${ORIGIN}/v1/items/a%2Fb`);
  });

  test("a 200 whose body is not an object is malformed — the item route did not answer", async () => {
    for (const body of ["i1", 42, null]) {
      const doFetch = vi.fn(async () => jsonRes(body));
      const r = await fetchItemBranch(ORIGIN, "i1", doFetch as unknown as typeof fetch);
      expect(r).toEqual({ ok: false, reason: "malformed" });
    }
  });

  // `metadata` is a JSON TEXT column upstream. A string that does not parse,
  // or parses to something other than an object, has no branch to offer: the
  // ladder falls through to the binding's default branch, it does not fail.
  test.each([
    ["a metadata string that is not JSON", "{branch: main"],
    ["a metadata string that parses to a number", "42"],
    ["metadata that is an array", ["main"]],
  ])("%s is a null value, not a failure", async (_why, metadata) => {
    const doFetch = vi.fn(async () => jsonRes({ data: { id: "i1", metadata } }));
    const r = await fetchItemBranch(ORIGIN, "i1", doFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, value: null });
  });

  test("an empty-string branch is no branch at all", async () => {
    const doFetch = vi.fn(async () => jsonRes({ data: { id: "i1", metadata: { branch: "" } } }));
    const r = await fetchItemBranch(ORIGIN, "i1", doFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, value: null });
  });
});

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchServiceResolution", () => {
  test("sends a bearer token and the repo query, and parses a claimant", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const doFetch = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>)["authorization"] ?? "";
      return res(200, { service: "checkout", ambiguous: false, candidates: ["checkout"] });
    }) as unknown as typeof fetch;

    const out = await fetchServiceResolution(
      "http://127.0.0.1:8787",
      "tok",
      "github:acme/web",
      doFetch,
    );

    expect(seenUrl).toBe("http://127.0.0.1:8787/v1/services/resolve?repo=github%3Aacme%2Fweb");
    expect(seenAuth).toBe("Bearer tok");
    expect(out).toEqual({
      ok: true,
      value: { service: "checkout", ambiguous: false, candidates: ["checkout"] },
    });
  });

  test("maps each status the way egress-client does", async () => {
    const at = async (status: number, body: unknown = {}) =>
      fetchServiceResolution("http://127.0.0.1:8787", "t", "github:a/b", (async () =>
        res(status, body)) as unknown as typeof fetch);

    expect((await at(401)).ok).toBe(false);
    expect(await at(401)).toMatchObject({ reason: "unauthorized" });
    expect(await at(404)).toMatchObject({ reason: "unsupported" });
    expect(await at(429)).toMatchObject({ reason: "rate_limited" });
    expect(await at(500, { error: "config_unreadable" })).toMatchObject({
      reason: "server_error",
    });
  });

  test("carries a full scope gap on 403, and none from a partial body", async () => {
    const withGap = await fetchServiceResolution(
      "http://127.0.0.1:8787",
      "t",
      "github:a/b",
      (async () =>
        res(403, { required: "resolve", granted: ["clip", "briefs"] })) as unknown as typeof fetch,
    );
    expect(withGap).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { required: "resolve", granted: ["clip", "briefs"] },
    });

    const partial = await fetchServiceResolution(
      "http://127.0.0.1:8787",
      "t",
      "github:a/b",
      (async () => res(403, { required: "resolve" })) as unknown as typeof fetch,
    );
    expect(partial).toEqual({ ok: false, reason: "insufficient_scope" });
  });

  test("a body the guard rejects is server_error, not a silent pass-through", async () => {
    const out = await fetchServiceResolution(
      "http://127.0.0.1:8787",
      "t",
      "github:a/b",
      (async () =>
        res(200, { service: "a", ambiguous: true, candidates: ["a"] })) as unknown as typeof fetch,
    );
    expect(out).toEqual({ ok: false, reason: "server_error" });
  });

  test("a thrown fetch is unreachable", async () => {
    const out = await fetchServiceResolution(
      "http://127.0.0.1:8787",
      "t",
      "github:a/b",
      (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    );
    expect(out).toEqual({ ok: false, reason: "unreachable" });
  });
});

function jsonFetch(status: number, body: unknown): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

const DORA_OK = {
  service: "web",
  since_ms: 1,
  computed_at: "2026-10-07T09:00:00.000Z",
  metrics: {
    deployment_frequency: { value: 1, unit: "deploys_per_day", sample: 9, gap: null },
    lead_time_for_changes: { value: 60, unit: "seconds_median", sample: 9, gap: null },
    change_failure_rate: { value: 0.1, unit: "ratio", sample: 9, gap: null },
    mttr: { value: null, unit: "seconds_median", sample: 0, gap: "no_pagerduty_mapping" },
  },
};

const STATS_OK = {
  metric: "mttr",
  service: "web",
  window: { since_ms: 0, until_ms: 91 * DAY_MS },
  bucket_ms: 7 * DAY_MS,
  points: [
    { start_ms: 0, end_ms: 7 * DAY_MS, value: 60, unit: "seconds_median", sample: 3, gap: null },
  ],
};

describe("fetchDoraMetrics", () => {
  test("asks the public route with the range's since and no bearer", async () => {
    const f = jsonFetch(200, DORA_OK);
    const res = await fetchDoraMetrics(ORIGIN, "web", "13w", f);
    expect(res.ok).toBe(true);
    expect(f.calls[0]).toBe(`${ORIGIN}/v1/metrics/dora?service=web&since=91d`);
  });

  test("a body for another service is malformed", async () => {
    const res = await fetchDoraMetrics(
      ORIGIN,
      "web",
      "13w",
      jsonFetch(200, { ...DORA_OK, service: "x" }),
    );
    expect(res).toEqual({ ok: false, reason: "malformed" });
  });

  test("an unsendable id never reaches the network", async () => {
    const f = jsonFetch(200, DORA_OK);
    expect(await fetchDoraMetrics(ORIGIN, "", "13w", f)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(f.calls).toHaveLength(0);
  });
});

describe("fetchStatsSeries", () => {
  test("sends the range's window and bucket in milliseconds", async () => {
    const f = jsonFetch(200, STATS_OK);
    const res = await fetchStatsSeries(ORIGIN, "web", "13w", "mttr", f);
    expect(res.ok).toBe(true);
    expect(f.calls[0]).toBe(
      `${ORIGIN}/v1/metrics/stats?service=web&metric=mttr&window_ms=${91 * DAY_MS}&bucket_ms=${7 * DAY_MS}`,
    );
  });

  test.each([
    [404, "unsupported"],
    [400, "refused"],
    [500, "server_error"],
    [503, "server_error"],
  ] as const)("status %i is %s", async (status, reason) => {
    expect(
      await fetchStatsSeries(ORIGIN, "web", "13w", "mttr", jsonFetch(status, { error: "x" })),
    ).toEqual({
      ok: false,
      reason,
    });
  });

  test("a thrown fetch is unreachable", async () => {
    const f = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    expect(await fetchStatsSeries(ORIGIN, "web", "13w", "mttr", f)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  test("a body that fails the parser is malformed", async () => {
    const res = await fetchStatsSeries(
      ORIGIN,
      "web",
      "13w",
      "mttr",
      jsonFetch(200, { ...STATS_OK, metric: "lead-time" }),
    );
    expect(res).toEqual({ ok: false, reason: "malformed" });
  });
});
