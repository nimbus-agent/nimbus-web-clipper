import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import {
  confirmPair,
  fetchItem,
  getAgentRun,
  getConnectors,
  invokeAgent,
  parseRetryAfterMs,
  postClip,
  postRelated,
  probeHealth,
  resolveFile,
  resolveItem,
} from "../../src/background/gateway-client.ts";
import type { ClipPayload } from "../../src/shared/clip.ts";
import type { RelatedQuery } from "../../src/shared/related.ts";

const ORIGIN = "http://127.0.0.1:8765";
function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("confirmPair", () => {
  test("200 → ok with token + label; posts code to the confirm path", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const out = await confirmPair(ORIGIN, "429173", async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body));
      return jsonRes(200, { token: "tok-abc", label: "chrome" });
    });
    expect(seenUrl).toBe("http://127.0.0.1:8765/v1/clips/pair/confirm");
    expect(seenBody).toEqual({ code: "429173" });
    expect(out).toEqual({ ok: true, token: "tok-abc", label: "chrome" });
  });
  test("403 → pairing_failed", async () => {
    expect(
      await confirmPair(ORIGIN, "x", async () => jsonRes(403, { error: "pairing_failed" })),
    ).toEqual({
      ok: false,
      reason: "pairing_failed",
    });
  });
  test("fetch throw → unreachable", async () => {
    expect(
      await confirmPair(ORIGIN, "x", async () => {
        throw new Error("net");
      }),
    ).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
  test("5xx → server_error", async () => {
    expect(
      await confirmPair(ORIGIN, "x", async () => jsonRes(500, { error: "internal_error" })),
    ).toEqual({
      ok: false,
      reason: "server_error",
    });
  });
});

describe("postClip", () => {
  const payload: ClipPayload = {
    url: "https://ex.com/p",
    title: "T",
    mode: "article",
    body: "b",
    tags: [],
    capturedAt: 1,
  };
  test("200 created → ok; sends Bearer header + payload to the ingest path", async () => {
    let seenUrl = "";
    let auth: string | null = null;
    let seenBody: unknown;
    const out = await postClip(ORIGIN, "tok-abc", payload, async (url, init) => {
      seenUrl = url;
      auth = new Headers(init?.headers).get("authorization");
      seenBody = JSON.parse(String(init?.body));
      return jsonRes(200, { id: "nimbus:clip:1", status: "created" });
    });
    expect(seenUrl).toBe("http://127.0.0.1:8765/v1/clips");
    expect(auth).toBe("Bearer tok-abc");
    expect(seenBody).toEqual(payload);
    expect(out).toEqual({ ok: true, status: "created" });
  });
  test("200 updated → ok updated", async () => {
    expect(
      await postClip(ORIGIN, "t", payload, async () =>
        jsonRes(200, { id: "x", status: "updated" }),
      ),
    ).toEqual({
      ok: true,
      status: "updated",
    });
  });
  test("401 → unauthorized", async () => {
    expect(
      await postClip(ORIGIN, "t", payload, async () => jsonRes(401, { error: "unauthorized" })),
    ).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });
  test("400 → invalid_request", async () => {
    expect(
      await postClip(ORIGIN, "t", payload, async () => jsonRes(400, { error: "invalid_request" })),
    ).toEqual({
      ok: false,
      reason: "invalid_request",
    });
  });
  test("413 → payload_too_large", async () => {
    expect(
      await postClip(ORIGIN, "t", payload, async () =>
        jsonRes(413, { error: "payload_too_large" }),
      ),
    ).toEqual({
      ok: false,
      reason: "payload_too_large",
    });
  });
  test("fetch throw → unreachable", async () => {
    expect(
      await postClip(ORIGIN, "t", payload, async () => {
        throw new Error("net");
      }),
    ).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
  test("429 → rate_limited with Retry-After parsed to ms", async () => {
    const res = new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "45" },
    });
    expect(await postClip(ORIGIN, "tok", payload, async () => res)).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfterMs: 45_000,
    });
  });

  test("429 without Retry-After → the full 60s window", async () => {
    const res = new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 });
    expect(await postClip(ORIGIN, "tok", payload, async () => res)).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfterMs: 60_000,
    });
  });
});

describe("parseRetryAfterMs", () => {
  test("plain delta-seconds", () => {
    expect(parseRetryAfterMs("45")).toBe(45_000);
    expect(parseRetryAfterMs(" 45 ")).toBe(45_000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  // The gateway is loopback-only and emits String(Math.ceil(seconds)); anything
  // else is untrustworthy, so fall back rather than guess. An HTTP-date would also
  // reintroduce the clock skew this design deliberately avoids.
  test("missing, non-numeric, or negative → the 60s default", () => {
    expect(parseRetryAfterMs(null)).toBe(60_000);
    expect(parseRetryAfterMs("")).toBe(60_000);
    expect(parseRetryAfterMs("soon")).toBe(60_000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT")).toBe(60_000);
    expect(parseRetryAfterMs("-5")).toBe(60_000);
    expect(parseRetryAfterMs("45abc")).toBe(60_000);
  });

  test("an absurd value is clamped so it cannot wedge the queue", () => {
    expect(parseRetryAfterMs("999999")).toBe(120_000);
  });
});

describe("timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("confirmPair aborts after its timeout → unreachable", async () => {
    const doFetch = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const p = confirmPair(ORIGIN, "429173", doFetch);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual({ ok: false, reason: "unreachable" });
  });

  test("postClip aborts after its timeout → unreachable", async () => {
    const payload = {
      url: "https://ex.com/p",
      title: "T",
      mode: "article" as const,
      body: "b",
      tags: [],
      capturedAt: 1,
    };
    const doFetch = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const p = postClip(ORIGIN, "tok", payload, doFetch);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("postRelated", () => {
  const query: RelatedQuery = {
    title: "T",
    canonicalUrl: "https://ex.com/p",
    selection: "s",
    limit: 10,
  };
  const hit = {
    id: "nimbus:1",
    title: "Doc",
    service: "drive",
    snippet: "…",
    url: "https://ex.com/d",
  };

  test("200 → ok with items; sends Bearer + query to the related path", async () => {
    let seenUrl = "";
    let auth: string | null = null;
    let seenBody: unknown;
    const out = await postRelated("http://127.0.0.1:8765", "tok-abc", query, async (url, init) => {
      seenUrl = url;
      auth = new Headers(init?.headers).get("authorization");
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ items: [hit] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    expect(seenUrl).toBe("http://127.0.0.1:8765/v1/clips/related");
    expect(auth).toBe("Bearer tok-abc");
    expect(seenBody).toEqual(query);
    expect(out).toEqual({ ok: true, items: [hit] });
  });
  test("200 with a malformed item → server_error", async () => {
    const out = await postRelated(
      "http://127.0.0.1:8765",
      "t",
      query,
      async () =>
        new Response(JSON.stringify({ items: [{ id: 1 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(out).toEqual({ ok: false, reason: "server_error" });
  });
  test("401 → unauthorized", async () => {
    expect(
      await postRelated(
        "http://127.0.0.1:8765",
        "t",
        query,
        async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      ),
    ).toEqual({ ok: false, reason: "unauthorized" });
  });
  test("400/500 → server_error", async () => {
    expect(
      await postRelated(
        "http://127.0.0.1:8765",
        "t",
        query,
        async () => new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 }),
      ),
    ).toEqual({ ok: false, reason: "server_error" });
  });
  test("fetch throw → unreachable", async () => {
    expect(
      await postRelated("http://127.0.0.1:8765", "t", query, async () => {
        throw new Error("net");
      }),
    ).toEqual({ ok: false, reason: "unreachable" });
  });
  test("aborts and returns unreachable after the timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const result = postRelated(
        "http://127.0.0.1:8765",
        "t",
        query,
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await result).toEqual({ ok: false, reason: "unreachable" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("200 → modified_at is renamed to modifiedAt at the boundary", async () => {
    const out = await postRelated(
      "http://127.0.0.1:8765",
      "t",
      query,
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: "gh:1",
                title: "T",
                service: "github",
                snippet: "s",
                url: null,
                type: "pr",
                modified_at: 1_700_000_000_000,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    expect(out).toEqual({
      ok: true,
      items: [
        {
          id: "gh:1",
          title: "T",
          service: "github",
          snippet: "s",
          url: null,
          type: "pr",
          modifiedAt: 1_700_000_000_000,
        },
      ],
    });
  });

  test("200 → a hit from a gateway with neither new field still parses", async () => {
    const out = await postRelated(
      "http://127.0.0.1:8765",
      "t",
      query,
      async () =>
        new Response(
          JSON.stringify({
            items: [{ id: "gh:2", title: "T", service: "github", snippet: "s", url: null }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    expect(out).toEqual({
      ok: true,
      items: [{ id: "gh:2", title: "T", service: "github", snippet: "s", url: null }],
    });
  });
});

describe("resolveItem", () => {
  test("GETs /v1/items/resolve with the url as a query param and a bearer header", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const doFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonRes(200, { found: false, reason: "not_indexed", service: null, fetchable: false });
    };
    await resolveItem("http://127.0.0.1:8765", "tok", "https://github.com/a/b/pull/1?w=1", doFetch);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.init?.method).toBe("GET");
    // The URL is a query PARAM, so it must be percent-encoded, not concatenated raw.
    expect(call?.url).toBe(
      "http://127.0.0.1:8765/v1/items/resolve?url=" +
        encodeURIComponent("https://github.com/a/b/pull/1?w=1"),
    );
    expect((call?.init?.headers as Record<string, string> | undefined)?.["authorization"]).toBe(
      "Bearer tok",
    );
    // A GET carries no body and must not advertise one.
    expect(call?.init?.body).toBeUndefined();
  });

  test("maps a hit, renaming modified_at to modifiedAt", async () => {
    const doFetch = async () =>
      jsonRes(200, {
        found: true,
        matchKind: "exact",
        item: {
          id: "i1",
          service: "github",
          type: "pr",
          title: "Fix it",
          url: "https://github.com/a/b/pull/1",
          modified_at: 1_700_000_000_000,
        },
      });
    const r = await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch);

    expect(r).toEqual({
      ok: true,
      outcome: {
        kind: "found",
        matchKind: "exact",
        item: {
          id: "i1",
          service: "github",
          type: "pr",
          title: "Fix it",
          url: "https://github.com/a/b/pull/1",
          modifiedAt: 1_700_000_000_000,
        },
      },
    });
  });

  test("accepts every matchKind the ladder can return", async () => {
    for (const kind of ["exact", "query_stripped", "path_trimmed"] as const) {
      const doFetch = async () =>
        jsonRes(200, {
          found: true,
          matchKind: kind,
          item: { id: "i", service: "s", type: "t", title: "T", url: null, modified_at: 1 },
        });
      const r = await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch);
      expect(r.ok && r.outcome.kind === "found" && r.outcome.matchKind).toBe(kind);
    }
  });

  test("rejects an unknown matchKind rather than widening the union", async () => {
    const doFetch = async () =>
      jsonRes(200, {
        found: true,
        matchKind: "vibes",
        item: { id: "i", service: "s", type: "t", title: "T", url: null, modified_at: 1 },
      });
    expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: false,
      reason: "server_error",
    });
  });

  test("maps not_indexed and carries fetchable through for C3.1", async () => {
    const doFetch = async () =>
      jsonRes(200, { found: false, reason: "not_indexed", service: null, fetchable: true });
    expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: true,
      outcome: { kind: "not-indexed", fetchable: true },
    });
  });

  test("maps unresolvable_url", async () => {
    const doFetch = async () =>
      jsonRes(200, { found: false, reason: "unresolvable_url", service: null, fetchable: false });
    expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: true,
      outcome: { kind: "unresolvable", fetchable: false },
    });
  });

  test("maps ambiguous with its candidates", async () => {
    const doFetch = async () =>
      jsonRes(200, {
        found: false,
        reason: "ambiguous",
        service: "jira",
        fetchable: false,
        truncated: false,
        candidates: [
          { id: "a", service: "jira", type: "issue", title: "One", url: "https://j.test/a" },
          { id: "b", service: "jira", type: "issue", title: "Two", url: null },
        ],
      });
    const r = await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch);
    expect(r).toEqual({
      ok: true,
      outcome: {
        kind: "ambiguous",
        fetchable: false,
        truncated: false,
        candidates: [
          { id: "a", service: "jira", type: "issue", title: "One", url: "https://j.test/a" },
          { id: "b", service: "jira", type: "issue", title: "Two", url: null },
        ],
      },
    });
  });

  test("keeps a truncated ambiguous list EMPTY — upstream sends no list, and a sliced one would lie", async () => {
    const doFetch = async () =>
      jsonRes(200, {
        found: false,
        reason: "ambiguous",
        service: "jira",
        fetchable: false,
        truncated: true,
        candidates: [],
      });
    const r = await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch);
    expect(r.ok && r.outcome.kind === "ambiguous" && r.outcome.truncated).toBe(true);
    expect(r.ok && r.outcome.kind === "ambiguous" && r.outcome.candidates).toEqual([]);
  });

  test("ignores a service field on the ambiguous arm — it is no longer modelled", async () => {
    const doFetch = async () =>
      jsonRes(200, {
        found: false,
        reason: "ambiguous",
        service: "jira",
        fetchable: false,
        truncated: true,
        candidates: [],
      });
    const r = await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch);
    expect(r.ok && r.outcome.kind === "ambiguous").toBe(true);
    expect(r.ok && r.outcome).not.toHaveProperty("service");
  });

  test("maps 403 to insufficient_scope, NOT server_error — it is the every-existing-pairing case", async () => {
    const doFetch = async () =>
      jsonRes(403, {
        error: "insufficient_scope",
        required: "resolve",
        granted: ["clip", "briefs"],
      });
    expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { required: "resolve", granted: ["clip", "briefs"] },
    });
  });

  test("403 with no parseable scope detail carries no scopeGap", async () => {
    for (const body of [{}, { required: "resolve" }, { granted: ["clip"] }, null]) {
      const doFetch = async () => jsonRes(403, body);
      expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
        ok: false,
        reason: "insufficient_scope",
      });
    }
  });

  test("maps 401 / 404 / 500 / transport failure", async () => {
    const cases: Array<[() => Promise<Response>, string]> = [
      [async () => jsonRes(401, { error: "unauthorized" }), "unauthorized"],
      [async () => jsonRes(404, { error: "resolve_disabled" }), "unsupported"],
      [async () => jsonRes(400, { error: "missing_url" }), "server_error"],
      [async () => jsonRes(500, {}), "server_error"],
    ];
    for (const [doFetch, reason] of cases) {
      expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
        ok: false,
        reason,
      });
    }
    const boom = async () => {
      throw new Error("offline");
    };
    expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", boom)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  test("treats a malformed 200 as a server error rather than a silent miss", async () => {
    for (const body of [null, {}, { found: true }, { found: false, reason: "nope" }]) {
      const doFetch = async () => jsonRes(200, body);
      expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
        ok: false,
        reason: "server_error",
      });
    }
  });
});

describe("resolveFile", () => {
  const call = (status: number, body: unknown, seen?: string[]) =>
    resolveFile("http://127.0.0.1:7474", "tok", "github", "acme/web", "main/src/a.ts", (async (
      url: string,
    ) => {
      seen?.push(url);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

  it("percent-encodes the coordinate into the query", async () => {
    const seen: string[] = [];
    await call(200, { ok: true, path: "src/a.ts" }, seen);
    // A branch name legitimately contains slashes and may contain anything else a
    // ref allows; the shared getJson helper builds this with URLSearchParams.
    expect(seen[0]).toContain("service=github");
    expect(seen[0]).toContain("repo=acme%2Fweb");
    expect(seen[0]).toContain("refAndPath=main%2Fsrc%2Fa.ts");
  });

  it("reads a hit", async () => {
    expect(await call(200, { ok: true, path: "src/a.ts" })).toEqual({
      ok: true,
      resolution: { kind: "found", path: "src/a.ts" },
    });
  });

  it.each(["remote_not_tracked", "file_not_indexed"] as const)(
    "reads the %s miss as a value, never as prose",
    async (reason) => {
      expect(await call(200, { ok: false, reason, repo: "acme/web" })).toEqual({
        ok: true,
        resolution: { kind: "miss", reason, repo: "acme/web" },
      });
    },
  );

  it("rejects a miss reason outside the closed set", async () => {
    // Fails closed: an unknown reason has no sentence, and inventing one would
    // put words in the gateway's mouth.
    expect(await call(200, { ok: false, reason: "banana", repo: "a/b" })).toEqual({
      ok: false,
      reason: "server_error",
    });
  });

  it("treats 404 as a gateway older than the route", async () => {
    expect(await call(404, { error: "not_found" })).toEqual({
      ok: true,
      resolution: { kind: "unsupported" },
    });
  });

  it("maps 403 to insufficient_scope with its gap", async () => {
    // LEGACY_SCOPES is ["clip","briefs"], so every pre-scopes pairing lands here first.
    expect(
      await call(403, { error: "insufficient_scope", required: "resolve", granted: ["clip"] }),
    ).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { required: "resolve", granted: ["clip"] },
    });
  });
});

describe("fetchItem", () => {
  function jsonRes(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("POSTs the url with a bearer header and no url in the query string", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const doFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonRes({ status: "indexed", itemId: "i1" });
    };
    await fetchItem("http://127.0.0.1:8765", "tok", "https://github.com/a/b/pull/1", doFetch);

    const call = calls[0];
    expect(call?.url).toBe("http://127.0.0.1:8765/v1/items/fetch");
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ url: "https://github.com/a/b/pull/1" });
    expect((call?.init?.headers as Record<string, string> | undefined)?.["authorization"]).toBe(
      "Bearer tok",
    );
    // The token belongs in the header and nowhere else.
    expect(call?.url).not.toContain("tok");
    expect(String(call?.init?.body)).not.toContain("tok");
  });

  it("maps indexed with its itemId", async () => {
    const doFetch = async () => jsonRes({ status: "indexed", itemId: "gh-482" });
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: true,
      outcome: { kind: "indexed", itemId: "gh-482" },
    });
  });

  it("collapses the three no-action arms into unfetchable", async () => {
    for (const status of ["not_found", "unsupported_url", "no_targeted_fetch"]) {
      const doFetch = async () => jsonRes({ status, service: "github" });
      const r = await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch);
      expect(r).toEqual({ ok: true, outcome: { kind: "unfetchable" } });
    }
  });

  it("keeps not_configured distinct — the user can act on it", async () => {
    const doFetch = async () => jsonRes({ status: "not_configured" });
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: true,
      outcome: { kind: "not-configured" },
    });
  });

  it("maps rate_limited", async () => {
    const doFetch = async () => jsonRes({ status: "rate_limited" });
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: true,
      outcome: { kind: "rate-limited" },
    });
  });

  it("rejects indexed without an itemId rather than inventing one", async () => {
    const doFetch = async () => jsonRes({ status: "indexed" });
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: false,
      reason: "server_error",
    });
  });

  it("treats an unknown status as server_error, never as a miss", async () => {
    for (const body of [null, {}, { status: "vibes" }]) {
      const doFetch = async () => jsonRes(body);
      expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
        ok: false,
        reason: "server_error",
      });
    }
  });

  it("maps 403 to insufficient_scope and keeps the scope detail", async () => {
    const doFetch = async () =>
      jsonRes(
        { error: "insufficient_scope", required: "fetch", granted: ["clip", "resolve"] },
        403,
      );
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { required: "fetch", granted: ["clip", "resolve"] },
    });
  });

  it("maps 401 / 404 / 400 / 500", async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ error: "unauthorized" }, 401, "unauthorized"],
      [{ error: "fetch_disabled" }, 404, "unsupported"],
      [{ error: "missing_url" }, 400, "server_error"],
      [{}, 500, "server_error"],
    ];
    for (const [body, status, reason] of cases) {
      const doFetch = async () => jsonRes(body, status);
      expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
        ok: false,
        reason,
      });
    }
  });

  // THE test for this task. These two must not collapse: one means the gateway may
  // still be working, the other means nothing was sent.
  it("maps our own timeout to `timeout`, NOT to `unreachable`", async () => {
    const abort = async () => {
      throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    };
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", abort)).toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  it("maps a transport failure to `unreachable`, NOT to `timeout`", async () => {
    const refused = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", refused)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  // FIX 5: the test above fabricates an `AbortError`-named Error directly, so it
  // proves `isAbortError`'s predicate matches its own fixture — not that a REAL
  // AbortController timeout produces the same shape. This test honours
  // `init.signal` the way a real `fetch` would (rejecting with the signal's own
  // DOMException reason on abort) and drives the actual postJson timeout path.
  it("maps a genuine AbortController timeout (not a fabricated error) to `timeout`", async () => {
    vi.useFakeTimers();
    try {
      const p = fetchItem(
        "http://127.0.0.1:8765",
        "t",
        "https://x.test/",
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await p).toEqual({ ok: false, reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("invokeAgent", () => {
  function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  it("POSTs to /v1/agents/<agent> with the params verbatim and a bearer header", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const doFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonRes({ runId: "r1" }, 202);
    };
    await invokeAgent(
      "http://127.0.0.1:8765",
      "tok",
      "impact",
      { fileOrPrUrl: "https://github.com/a/b/pull/1" },
      doFetch,
    );

    const call = calls[0];
    expect(call?.url).toBe("http://127.0.0.1:8765/v1/agents/impact");
    expect(call?.init?.method).toBe("POST");
    // Verbatim: the gateway owns validation, so we must not reshape the body.
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      fileOrPrUrl: "https://github.com/a/b/pull/1",
    });
    expect((call?.init?.headers as Record<string, string> | undefined)?.["authorization"]).toBe(
      "Bearer tok",
    );
    expect(call?.url).not.toContain("tok");
    expect(String(call?.init?.body)).not.toContain("tok");
  });

  it("maps 202 to the run id", async () => {
    const doFetch = async () => jsonRes({ runId: "run-42" }, 202);
    expect(await invokeAgent("http://127.0.0.1:8765", "t", "expert", {}, doFetch)).toEqual({
      ok: true,
      runId: "run-42",
    });
  });

  it("rejects a 202 with no runId rather than inventing one", async () => {
    const doFetch = async () => jsonRes({}, 202);
    expect(await invokeAgent("http://127.0.0.1:8765", "t", "expert", {}, doFetch)).toEqual({
      ok: false,
      reason: "server_error",
    });
  });

  it("maps 429 to busy and parses Retry-After", async () => {
    const doFetch = async () => jsonRes({ error: "busy" }, 429, { "retry-after": "1" });
    expect(await invokeAgent("http://127.0.0.1:8765", "t", "impact", {}, doFetch)).toEqual({
      ok: false,
      reason: "busy",
      retryAfterMs: 1000,
    });
  });

  it("maps 404 / 401 / 403 / 500", async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ error: "unknown_agent" }, 404, "unsupported"],
      [{ error: "unauthorized" }, 401, "unauthorized"],
      [{}, 500, "server_error"],
    ];
    for (const [body, status, reason] of cases) {
      const doFetch = async () => jsonRes(body, status);
      expect(await invokeAgent("http://127.0.0.1:8765", "t", "impact", {}, doFetch)).toMatchObject({
        ok: false,
        reason,
      });
    }
    const scoped = async () =>
      jsonRes({ error: "insufficient_scope", required: "agents", granted: ["clip"] }, 403);
    expect(await invokeAgent("http://127.0.0.1:8765", "t", "impact", {}, scoped)).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { required: "agents", granted: ["clip"] },
    });
  });
});

describe("getAgentRun", () => {
  function jsonRes(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("GETs /v1/agents/runs/<id>", async () => {
    const calls: string[] = [];
    const doFetch = async (url: string) => {
      calls.push(url);
      return jsonRes({ status: "running" });
    };
    await getAgentRun("http://127.0.0.1:8765", "t", "run-42", doFetch);
    expect(calls[0]).toBe("http://127.0.0.1:8765/v1/agents/runs/run-42");
  });

  it("maps running, done and failed", async () => {
    const running = async () => jsonRes({ status: "running", brief: null });
    expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", running)).toEqual({
      ok: true,
      status: "running",
    });

    const done = async () => jsonRes({ status: "done", brief: "## Impact\n\nthings" });
    expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", done)).toEqual({
      ok: true,
      status: "done",
      brief: "## Impact\n\nthings",
    });

    const failed = async () => jsonRes({ status: "failed", failureReason: "no index" });
    expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", failed)).toEqual({
      ok: true,
      status: "failed",
      failureReason: "no index",
    });
  });

  // Closes a documented gap: upstream builds the body as
  // `...(run.error === null ? {} : { failureReason: run.error })`, so an ABSENT
  // failureReason is well-formed ("failed, no explanation given"), while a
  // PRESENT-but-non-string one is malformed and still falls through to
  // server_error — the two must not be conflated.
  it("maps failed with no failureReason at all (well-formed, not malformed)", async () => {
    const doFetch = async () => jsonRes({ status: "failed" });
    expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", doFetch)).toEqual({
      ok: true,
      status: "failed",
    });
  });

  it("rejects failed with a non-string failureReason", async () => {
    const doFetch = async () => jsonRes({ status: "failed", failureReason: 42 });
    expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", doFetch)).toEqual({
      ok: false,
      reason: "server_error",
    });
  });

  it("rejects done with no brief — a done run without one is malformed", async () => {
    const doFetch = async () => jsonRes({ status: "done", brief: null });
    expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", doFetch)).toEqual({
      ok: false,
      reason: "server_error",
    });
  });

  // THE collapse for this task: upstream distinguishes these two, and says the
  // client's answer to both is to re-issue. One state, one affordance.
  it("collapses poll 404 and 410 into `stale`", async () => {
    for (const [body, status] of [
      [{ error: "not_found" }, 404],
      [{ error: "expired" }, 410],
    ] as Array<[unknown, number]>) {
      const doFetch = async () => jsonRes(body, status);
      expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", doFetch)).toEqual({
        ok: false,
        reason: "stale",
      });
    }
  });

  it("treats an unknown status as server_error, never as a terminal answer", async () => {
    for (const body of [null, {}, { status: "vibes" }]) {
      const doFetch = async () => jsonRes(body);
      expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", doFetch)).toEqual({
        ok: false,
        reason: "server_error",
      });
    }
  });
});

describe("probeHealth", () => {
  test("200 with status ok → reachable", async () => {
    const doFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ status: "ok", gateway: "read_only_http" }), {
        status: 200,
      });
    expect(await probeHealth("http://127.0.0.1:7474", doFetch)).toBe(true);
  });

  test("a non-200 is not reachable", async () => {
    const doFetch = async (): Promise<Response> => new Response("nope", { status: 404 });
    expect(await probeHealth("http://127.0.0.1:7474", doFetch)).toBe(false);
  });

  test("a 200 that is not this gateway's health shape is not reachable", async () => {
    const doFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ hello: "world" }), { status: 200 });
    expect(await probeHealth("http://127.0.0.1:7474", doFetch)).toBe(false);
  });

  test("a thrown fetch (connection refused, abort) is not reachable", async () => {
    const doFetch = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    expect(await probeHealth("http://127.0.0.1:7474", doFetch)).toBe(false);
  });

  test("a non-loopback origin is refused WITHOUT a request (I6)", async () => {
    let called = false;
    const doFetch = async (): Promise<Response> => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    expect(await probeHealth("https://evil.example", doFetch)).toBe(false);
    expect(called).toBe(false);
  });

  test("a loopback lookalike host is refused without a request", async () => {
    let called = false;
    const doFetch = async (): Promise<Response> => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    expect(await probeHealth("http://127.0.0.1.attacker.com", doFetch)).toBe(false);
    expect(called).toBe(false);
  });
});

describe("getConnectors", () => {
  it("returns the parsed map on 200", async () => {
    const doFetch = async () =>
      new Response(JSON.stringify({ data: [{ connectorId: "github", state: "healthy" }] }), {
        status: 200,
      });
    const map = await getConnectors("http://127.0.0.1:7777", doFetch);
    expect(map?.get("github")?.state).toBe("healthy");
  });

  it("sends no Authorization header — the route is public upstream", async () => {
    let seen: HeadersInit | undefined;
    const doFetch = async (_url: string, init?: RequestInit) => {
      seen = init?.headers;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    await getConnectors("http://127.0.0.1:7777", doFetch);
    expect(JSON.stringify(seen ?? {})).not.toContain("Bearer");
  });

  it("returns null on 404 — a gateway too old to serve the route", async () => {
    const doFetch = async () => new Response("", { status: 404 });
    expect(await getConnectors("http://127.0.0.1:7777", doFetch)).toBeNull();
  });

  it("returns null when the gateway is unreachable", async () => {
    const doFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await getConnectors("http://127.0.0.1:7777", doFetch)).toBeNull();
  });

  it("returns null on a body the guard rejects", async () => {
    const doFetch = async () => new Response(JSON.stringify({ nope: true }), { status: 200 });
    expect(await getConnectors("http://127.0.0.1:7777", doFetch)).toBeNull();
  });
});
