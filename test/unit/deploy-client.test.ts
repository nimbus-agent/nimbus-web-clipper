// test/unit/deploy-client.test.ts
import { describe, expect, test, vi } from "vitest";
import {
  fetchItemBranch,
  fetchPreflight,
  fetchServiceResolution,
} from "../../src/background/deploy-client.ts";

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
