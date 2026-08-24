import { describe, expect, it, test } from "vitest";
import {
  CLIP_INGEST,
  PAIR_CONFIRM,
  RELATED,
  RESOLVE_FIXTURE,
  type Scenario,
} from "../../scripts/screenshots/gateway-fixtures.ts";
import {
  type BriefRuns,
  handleRequest,
  newBriefRuns,
} from "../../scripts/screenshots/mock-gateway.ts";

describe("mock gateway fixtures — locked contract shape", () => {
  test("pair/confirm returns a non-empty token and label", () => {
    expect(typeof PAIR_CONFIRM.token).toBe("string");
    expect(PAIR_CONFIRM.token.length).toBeGreaterThan(0);
    expect(typeof PAIR_CONFIRM.label).toBe("string");
    expect(PAIR_CONFIRM.label.length).toBeGreaterThan(0);
  });

  test("clip ingest returns an id and a created|updated status", () => {
    expect(typeof CLIP_INGEST.id).toBe("string");
    expect(["created", "updated"]).toContain(CLIP_INGEST.status);
  });

  test("related returns RelatedHit items including a url:null hit", () => {
    expect(RELATED.items.length).toBeGreaterThan(0);
    for (const hit of RELATED.items) {
      expect(typeof hit.id).toBe("string");
      expect(typeof hit.title).toBe("string");
      expect(typeof hit.service).toBe("string");
      expect(typeof hit.snippet).toBe("string");
      expect(hit.url === null || typeof hit.url === "string").toBe(true);
    }
    expect(RELATED.items.some((h) => h.url === null)).toBe(true);
  });

  it("serves GET /v1/items/resolve with a found outcome", async () => {
    const res = await handleRequest(
      new Request(
        "http://127.0.0.1:8765/v1/items/resolve?url=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fpull%2F1",
        {
          method: "GET",
          headers: { authorization: "Bearer test-token" },
        },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["found"]).toBe(true);
    expect(body["matchKind"]).toBe("exact");
    expect((body["item"] as Record<string, unknown>)["modified_at"]).toEqual(expect.any(Number));
  });

  it("serves POST /v1/items/fetch with an indexed outcome", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:8765/v1/items/fetch", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/acme/web/pull/482" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "indexed", itemId: expect.any(String) });
  });

  it("serves POST /v1/agents/impact with a run id, and the run as done", async () => {
    const invoke = await handleRequest(
      new Request("http://127.0.0.1:8765/v1/agents/impact", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ fileOrPrUrl: "https://github.com/acme/web/pull/482" }),
      }),
    );
    expect(invoke.status).toBe(202);
    const { runId } = (await invoke.json()) as { runId: string };

    const poll = await handleRequest(
      new Request(`http://127.0.0.1:8765/v1/agents/runs/${runId}`, {
        headers: { authorization: "Bearer test-token" },
      }),
    );
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({ status: "done" });
  });
});

describe("the four egress-ledger reads", () => {
  const get = (path: string, scenario?: Parameters<typeof handleRequest>[1]) =>
    handleRequest(
      new Request(`http://127.0.0.1:8765${path}`, {
        method: "GET",
        headers: { authorization: "Bearer test-token" },
      }),
      scenario,
    );

  it("serves a window newest-first, with totals counted over the whole window", async () => {
    const res = await get("/v1/egress");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: { id: number }[]; rowsTotal: number };
    expect(body.rows.map((r) => r.id)).toEqual([5, 4, 3, 2, 1]);
    // Not derived from `rows` — the whole reason the route returns it.
    expect(body.rowsTotal).toBe(5);
  });

  it("covers every row shape the page has to tell apart", async () => {
    const body = (await (await get("/v1/egress")).json()) as {
      rows: { sourceType: string; sourceId: string | null; method: string }[];
    };
    const shapes = body.rows.map((r) => `${r.sourceType}:${r.method}:${r.sourceId ?? "null"}`);
    // The outcome marker leads, because it carries a HIGHER id than the fetch it
    // describes and the read is newest-first — the ordering the page must cope with.
    expect(shapes).toEqual([
      "outcome:items.fetch.outcome:" + "c3".repeat(32),
      "sync:sync.run:null",
      "sync:items.fetch:null",
      "http:agents.impact:nimbus-editor",
      "http:agents.why:Mock Device",
    ]);
  });

  it("serves head, verify and prove in the gateway's own vocabulary", async () => {
    const head = (await (await get("/v1/egress/head")).json()) as Record<string, unknown>;
    expect(head["count"]).toBe(5);

    // `ok` / `verifiedRows`, not a client-side re-spelling of them.
    const verify = (await (await get("/v1/egress/verify")).json()) as Record<string, unknown>;
    expect(verify["ok"]).toBe(true);
    expect(verify["verifiedRows"]).toBe(5);

    const prove = (await (await get("/v1/egress/prove")).json()) as Record<string, unknown>;
    expect(prove["digest"]).toEqual(expect.any(String));
    expect(prove["sigB64"]).toEqual(expect.any(String));
    expect(prove["pubkeyB64"]).toEqual(expect.any(String));
  });

  it("honours the before cursor and the limit", async () => {
    // A mock that ignored the cursor would answer every page with the same rows,
    // so a paging test could pass against a client that never sent one.
    const page = (await (await get("/v1/egress?before=3")).json()) as { rows: { id: number }[] };
    expect(page.rows.map((r) => r.id)).toEqual([2, 1]);

    const limited = (await (await get("/v1/egress?limit=2")).json()) as {
      rows: { id: number }[];
      rowsTotal: number;
      rowsTruncated: boolean;
    };
    expect(limited.rows.map((r) => r.id)).toEqual([5, 4]);
    expect(limited.rowsTotal).toBe(5);
    expect(limited.rowsTruncated).toBe(true);
  });

  it("honours a status override, so a suite can force 403 and 404", async () => {
    // 404 is the too-old gateway; 403 is the ungranted `egress` scope. Both are
    // states the page must render distinctly, so both must be forceable.
    expect((await get("/v1/egress", { status: { "/v1/egress": 404 } })).status).toBe(404);
    expect((await get("/v1/egress", { status: { "/v1/egress": 403 } })).status).toBe(403);
  });
});

describe("brief run routes — method-checked per action", () => {
  // One shared `runs` map per test, threaded through every call — the default
  // parameter on `handleRequest` mints a FRESH one per call, so a run created
  // in one call is invisible to the next unless the same map is passed along.
  async function createRun(runs: BriefRuns): Promise<string> {
    const res = await handleRequest(
      new Request("http://127.0.0.1:8765/v1/briefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brief: "q", sources: [{ url: "http://h/a", title: "A" }] }),
      }),
      {},
      runs,
    );
    const { id } = (await res.json()) as { id: string };
    return id;
  }

  test("a GET to .../sources is refused, not answered by the POST default", async () => {
    const runs = newBriefRuns();
    const id = await createRun(runs);
    const res = await handleRequest(
      new Request(`http://127.0.0.1:8765/v1/briefs/${id}/sources`),
      {},
      runs,
    );
    expect(res.status).toBe(405);
  });

  test("a GET to .../run is refused, not the cheerful running default", async () => {
    const runs = newBriefRuns();
    const id = await createRun(runs);
    const res = await handleRequest(
      new Request(`http://127.0.0.1:8765/v1/briefs/${id}/run`),
      {},
      runs,
    );
    expect(res.status).toBe(405);
  });

  test("a GET to .../save is refused, not the cheerful itemId default", async () => {
    const runs = newBriefRuns();
    const id = await createRun(runs);
    const res = await handleRequest(
      new Request(`http://127.0.0.1:8765/v1/briefs/${id}/save`),
      {},
      runs,
    );
    expect(res.status).toBe(405);
  });

  test("a POST to the bare poll route is refused, not answered as done", async () => {
    const runs = newBriefRuns();
    const id = await createRun(runs);
    const res = await handleRequest(
      new Request(`http://127.0.0.1:8765/v1/briefs/${id}`, { method: "POST" }),
      {},
      runs,
    );
    expect(res.status).toBe(405);
  });

  test("the poll route still answers GET as before", async () => {
    const runs = newBriefRuns();
    const id = await createRun(runs);
    const res = await handleRequest(new Request(`http://127.0.0.1:8765/v1/briefs/${id}`), {}, runs);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "done" });
  });

  test("two runs from one server never share an id", async () => {
    const runs = newBriefRuns();
    const first = await createRun(runs);
    const second = await createRun(runs);
    expect(first).not.toBe(second);
  });
});

describe("scenarios", () => {
  test("no scenario returns today's fixtures (the screenshot path)", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:8765/v1/clips/related", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RELATED);
  });

  test("a related override replaces the fixture", async () => {
    const related = { items: [] };
    const res = await handleRequest(
      new Request("http://127.0.0.1:8765/v1/clips/related", { method: "POST" }),
      { related },
    );
    expect(await res.json()).toEqual(related);
  });

  test("resolve is keyed off the url query param", async () => {
    const scenario: Scenario = {
      resolve: { "https://github.com/acme/web/pull/482": RESOLVE_FIXTURE },
      resolveDefault: { found: false, reason: "not_indexed", service: null, fetchable: false },
    };
    const hit = await handleRequest(
      new Request(
        "http://127.0.0.1:8765/v1/items/resolve?url=https%3A%2F%2Fgithub.com%2Facme%2Fweb%2Fpull%2F482",
      ),
      scenario,
    );
    expect(await hit.json()).toEqual(RESOLVE_FIXTURE);

    const miss = await handleRequest(
      new Request(
        "http://127.0.0.1:8765/v1/items/resolve?url=https%3A%2F%2Fwiki.internal%2Frunbook",
      ),
      scenario,
    );
    expect((await miss.json()).found).toBe(false);
  });

  test("a status override wins over the body (rate limiting)", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:8765/v1/clips", { method: "POST" }),
      { status: { "/v1/clips": 429 } },
    );
    expect(res.status).toBe(429);
  });

  test("the related fixture carries the wire's type and modified_at", () => {
    // Guards the defect this task fixes: typed against the CLIENT shape, the
    // fixture silently omitted both fields and no e2e could assert the chip
    // or the freshness line.
    for (const item of RELATED.items) {
      expect(typeof item.type).toBe("string");
      expect(typeof item.modified_at).toBe("number");
    }
  });

  test("a delayMs route takes measurably longer than one without", async () => {
    // Not a tight timing assertion — a real timer on a shared CI runner can
    // overshoot by a lot. The claim this guards is just "delayMs held the
    // response open at all", so the bar is generous and one-sided.
    const scenario: Scenario = { delayMs: { "/v1/clips": 200 } };

    const undelayedStart = performance.now();
    await handleRequest(new Request("http://127.0.0.1:8765/v1/clips", { method: "POST" }));
    const undelayedMs = performance.now() - undelayedStart;

    const delayedStart = performance.now();
    await handleRequest(
      new Request("http://127.0.0.1:8765/v1/clips", { method: "POST" }),
      scenario,
    );
    const delayedMs = performance.now() - delayedStart;

    expect(delayedMs).toBeGreaterThanOrEqual(150);
    expect(delayedMs).toBeGreaterThan(undelayedMs);
  });

  test("delayMs is keyed by path — a route absent from the map is unaffected", async () => {
    // Not a wall-clock upper bound (the earlier version asserted
    // `toBeLessThan(150)`, which a single GC stall under v8 coverage
    // instrumentation can blow past, reddening the unit run that feeds
    // SonarCloud's coverage gate for a route with no delay configured at
    // all). The claim this guards is relative: a route absent from `delayMs`
    // settles faster than one the SAME scenario deliberately holds open —
    // see the companion test above for the symmetric lower-bound claim on
    // the delayed route itself.
    const scenario: Scenario = { delayMs: { "/v1/clips": 200 } };

    const unaffectedStart = performance.now();
    const res = await handleRequest(
      new Request("http://127.0.0.1:8765/v1/clips/related", { method: "POST" }),
      scenario,
    );
    const unaffectedMs = performance.now() - unaffectedStart;

    const delayedStart = performance.now();
    await handleRequest(
      new Request("http://127.0.0.1:8765/v1/clips", { method: "POST" }),
      scenario,
    );
    const delayedMs = performance.now() - delayedStart;

    expect(unaffectedMs).toBeLessThan(delayedMs);
    expect(await res.json()).toEqual(RELATED);
  });
});
