import { describe, expect, it } from "vitest";
import {
  createBrief,
  feedBriefSource,
  getBrief,
  runBrief,
  saveBrief,
} from "../../src/background/brief-client.ts";

const ORIGIN = "http://127.0.0.1:7474";
const TOKEN = "tok";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stub(res: Response): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fake = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(res);
  }) as unknown as typeof fetch;
  return { fetch: fake, calls };
}

describe("createBrief", () => {
  it("returns the id and expected count on 200", async () => {
    const { fetch: f, calls } = stub(
      jsonResponse(200, { id: "b1", status: "collecting", expected: 2 }),
    );
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({ ok: true, id: "b1", expected: 2 });
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/briefs`);
  });

  it("maps 404 briefs_disabled to `disabled`, carrying the gateway's hint", async () => {
    const { fetch: f } = stub(
      jsonResponse(404, { error: "briefs_disabled", hint: "enable [briefs] in nimbus.toml" }),
    );
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({ ok: false, reason: "disabled", hint: "enable [briefs] in nimbus.toml" });
  });

  it("maps 503 briefs_busy to `busy`", async () => {
    const { fetch: f } = stub(jsonResponse(503, { error: "briefs_busy" }));
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({ ok: false, reason: "busy" });
  });

  it("parses a 403 scope gap", async () => {
    const { fetch: f } = stub(
      jsonResponse(403, { error: "insufficient_scope", required: "briefs", granted: ["clip"] }),
    );
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { required: "briefs", granted: ["clip"] },
    });
  });

  it("maps 401 to unauthorized", async () => {
    const { fetch: f } = stub(jsonResponse(401, { error: "unauthorized" }));
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("maps a thrown fetch to unreachable", async () => {
    const f = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({ ok: false, reason: "unreachable" });
  });

  it("treats a malformed 200 as server_error rather than trusting it", async () => {
    const { fetch: f } = stub(jsonResponse(200, { id: 7 }));
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({ ok: false, reason: "server_error" });
  });
});

describe("feedBriefSource", () => {
  const src = { url: "u", title: "t", body: "b", capturedAt: 1, truncated: false };

  it("returns the running count on 200", async () => {
    const { fetch: f, calls } = stub(
      jsonResponse(200, { accepted: true, received: 1, expected: 3 }),
    );
    const out = await feedBriefSource(ORIGIN, TOKEN, "b1", src, f);
    expect(out).toEqual({ ok: true, received: 1, expected: 3 });
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/briefs/b1/sources`);
  });

  it("DISTINGUISHES run_capacity from source_too_large — same status, different detail", async () => {
    const cap = stub(jsonResponse(413, { error: "payload_too_large", detail: "run_capacity" }));
    expect(await feedBriefSource(ORIGIN, TOKEN, "b1", src, cap.fetch)).toEqual({
      ok: false,
      reason: "refused",
      detail: "run_capacity",
    });

    const big = stub(jsonResponse(413, { error: "payload_too_large", detail: "source_too_large" }));
    expect(await feedBriefSource(ORIGIN, TOKEN, "b1", src, big.fetch)).toEqual({
      ok: false,
      reason: "refused",
      detail: "source_too_large",
    });
  });

  it("treats a 413 with an unknown detail as source_too_large, the recoverable reading", async () => {
    const { fetch: f } = stub(jsonResponse(413, { error: "payload_too_large" }));
    const out = await feedBriefSource(ORIGIN, TOKEN, "b1", src, f);
    expect(out).toEqual({ ok: false, reason: "refused", detail: "source_too_large" });
  });

  it("maps 410 to expired", async () => {
    const { fetch: f } = stub(jsonResponse(410, { error: "expired" }));
    expect(await feedBriefSource(ORIGIN, TOKEN, "b1", src, f)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("maps 429 to rate_limited", async () => {
    const { fetch: f } = stub(jsonResponse(429, { error: "rate_limited" }));
    expect(await feedBriefSource(ORIGIN, TOKEN, "b1", src, f)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
  });

  it("never puts the token in the URL", async () => {
    const { fetch: f, calls } = stub(
      jsonResponse(200, { accepted: true, received: 1, expected: 1 }),
    );
    await feedBriefSource(ORIGIN, TOKEN, "b1", src, f);
    expect(calls[0]?.url.includes(TOKEN)).toBe(false);
  });
});

describe("runBrief", () => {
  it("succeeds on 200", async () => {
    const { fetch: f, calls } = stub(jsonResponse(200, { status: "running" }));
    expect(await runBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/briefs/b1/run`);
  });

  it("maps 404 to not_found", async () => {
    const { fetch: f } = stub(jsonResponse(404, { error: "not_found" }));
    expect(await runBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("getBrief", () => {
  const report = {
    summary: "s",
    findings: [],
    conflicts: [],
    gaps: [],
    synthesis: { model: "m", remote: false },
  };

  it("returns a done report", async () => {
    const { fetch: f } = stub(jsonResponse(200, { status: "done", report }));
    const out = await getBrief(ORIGIN, TOKEN, "b1", f);
    expect(out).toEqual({ ok: true, status: "done", report });
  });

  it("returns failed with its failureReason, NOT an error", async () => {
    const { fetch: f } = stub(
      jsonResponse(200, { status: "failed", failureReason: "no_provider" }),
    );
    const out = await getBrief(ORIGIN, TOKEN, "b1", f);
    expect(out).toEqual({ ok: true, status: "failed", failureReason: "no_provider" });
  });

  it("returns collecting and running as non-terminal", async () => {
    for (const status of ["collecting", "running"] as const) {
      const { fetch: f } = stub(jsonResponse(200, { status }));
      expect(await getBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: true, status });
    }
  });

  it("rejects a done body whose report fails the guard", async () => {
    const { fetch: f } = stub(jsonResponse(200, { status: "done", report: { summary: 1 } }));
    expect(await getBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: false, reason: "server_error" });
  });

  it("maps 410 to expired and 404 to not_found", async () => {
    const gone = stub(jsonResponse(410, { error: "expired" }));
    expect(await getBrief(ORIGIN, TOKEN, "b1", gone.fetch)).toEqual({
      ok: false,
      reason: "expired",
    });
    const missing = stub(jsonResponse(404, { error: "not_found" }));
    expect(await getBrief(ORIGIN, TOKEN, "b1", missing.fetch)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("saveBrief", () => {
  it("returns the minted item id", async () => {
    const { fetch: f, calls } = stub(jsonResponse(200, { itemId: "nimbus:brief:abc" }));
    expect(await saveBrief(ORIGIN, TOKEN, "b1", f)).toEqual({
      ok: true,
      itemId: "nimbus:brief:abc",
    });
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/briefs/b1/save`);
  });

  it("maps 410 to expired — a finished run can age out before save", async () => {
    const { fetch: f } = stub(jsonResponse(410, { error: "expired" }));
    expect(await saveBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: false, reason: "expired" });
  });
});
describe("every route survives a gateway that is not there", () => {
  // `send()` aborts on a timeout and `fetch` rejects on a dead socket. Both land
  // in the same catch, and every route must answer `unreachable` rather than
  // letting the rejection escape into the caller's `void`-ed promise chain.
  const down = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
  const src = { url: "u", title: "t", body: "b", capturedAt: 1, truncated: false };

  it("feedBriefSource", async () => {
    expect(await feedBriefSource(ORIGIN, TOKEN, "b1", src, down)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("runBrief", async () => {
    expect(await runBrief(ORIGIN, TOKEN, "b1", down)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("getBrief", async () => {
    expect(await getBrief(ORIGIN, TOKEN, "b1", down)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("saveBrief", async () => {
    expect(await saveBrief(ORIGIN, TOKEN, "b1", down)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});

describe("the status ladder shared by feed/run/get/save", () => {
  // A 403 here means the token was narrowed AFTER it was minted (`briefs` is a
  // LEGACY scope, so it is not what a pre-scopes token hits first). It must not
  // be flattened into server_error: the remedy is `nimbus clip scopes`, not a
  // re-pair, and only the distinct reason gets the user there.
  const src = { url: "u", title: "t", body: "b", capturedAt: 1, truncated: false };

  it("maps 403 to insufficient_scope on every route", async () => {
    const forbidden = (): typeof fetch =>
      stub(jsonResponse(403, { error: "insufficient_scope" })).fetch;
    expect(await feedBriefSource(ORIGIN, TOKEN, "b1", src, forbidden())).toEqual({
      ok: false,
      reason: "insufficient_scope",
    });
    expect(await runBrief(ORIGIN, TOKEN, "b1", forbidden())).toEqual({
      ok: false,
      reason: "insufficient_scope",
    });
    expect(await getBrief(ORIGIN, TOKEN, "b1", forbidden())).toEqual({
      ok: false,
      reason: "insufficient_scope",
    });
    expect(await saveBrief(ORIGIN, TOKEN, "b1", forbidden())).toEqual({
      ok: false,
      reason: "insufficient_scope",
    });
  });

  it("maps 404 to not_found on every route that has an id to miss", async () => {
    // createBrief is deliberately absent: it has no id yet, so its 404 is the
    // seam being off, and it is asserted as `disabled` elsewhere in this file.
    const missing = (): typeof fetch => stub(jsonResponse(404, { error: "not_found" })).fetch;
    expect(await feedBriefSource(ORIGIN, TOKEN, "b1", src, missing())).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await getBrief(ORIGIN, TOKEN, "b1", missing())).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await saveBrief(ORIGIN, TOKEN, "b1", missing())).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("falls back to server_error for a status the ladder does not name", async () => {
    // 500 is the shape that matters: an unmapped status must not be reported as
    // one of the actionable reasons, because each of those tells the user to do
    // something specific that would not help here.
    const boom = (): typeof fetch => stub(jsonResponse(500, { error: "kaboom" })).fetch;
    expect(await runBrief(ORIGIN, TOKEN, "b1", boom())).toEqual({
      ok: false,
      reason: "server_error",
    });
    expect(await getBrief(ORIGIN, TOKEN, "b1", boom())).toEqual({
      ok: false,
      reason: "server_error",
    });
    expect(await saveBrief(ORIGIN, TOKEN, "b1", boom())).toEqual({
      ok: false,
      reason: "server_error",
    });
    expect(await feedBriefSource(ORIGIN, TOKEN, "b1", src, boom())).toEqual({
      ok: false,
      reason: "server_error",
    });
  });
});

describe("a 403 body that is not a scope gap", () => {
  // `parseScopeGap` is the only thing standing between a malformed 403 body and
  // a `scopeGap` the views would print as a `nimbus clip scopes` command. A
  // partial parse would build that command out of whatever happened to be
  // there, so anything short of the full shape must yield NO gap at all.
  const body = { brief: "q", sources: [], useIndex: false };

  it("rejects a body with no `required` string", async () => {
    const { fetch: f } = stub(jsonResponse(403, { granted: ["clip"] }));
    expect(await createBrief(ORIGIN, TOKEN, body, f)).toEqual({
      ok: false,
      reason: "insufficient_scope",
    });
  });

  it("rejects a `granted` that is not an array", async () => {
    const { fetch: f } = stub(jsonResponse(403, { required: "briefs", granted: "clip" }));
    expect(await createBrief(ORIGIN, TOKEN, body, f)).toEqual({
      ok: false,
      reason: "insufficient_scope",
    });
  });

  it("rejects a `granted` array holding a non-string", async () => {
    const { fetch: f } = stub(jsonResponse(403, { required: "briefs", granted: ["clip", 7] }));
    expect(await createBrief(ORIGIN, TOKEN, body, f)).toEqual({
      ok: false,
      reason: "insufficient_scope",
    });
  });

  it("rejects a 403 whose body is not JSON at all", async () => {
    // `readJson` swallows the parse error and yields null; the route must then
    // report the plain reason rather than throwing out of the await.
    const f = (() =>
      Promise.resolve(
        new Response("<html>proxy error</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
      )) as unknown as typeof fetch;
    expect(await createBrief(ORIGIN, TOKEN, body, f)).toEqual({
      ok: false,
      reason: "insufficient_scope",
    });
  });
});

describe("parseBriefBody rejects what it cannot recognise", () => {
  it("treats a non-object 200 body as server_error", async () => {
    // A gateway that answered `null`, or a proxy that returned a bare string,
    // must never be read as a run in some state.
    const f = (() =>
      Promise.resolve(
        new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
      )) as unknown as typeof fetch;
    expect(await getBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: false, reason: "server_error" });
  });

  it("treats an unknown status word as server_error, never as terminal", async () => {
    // Guessing "done" on an unrecognised status would show a report that does
    // not exist; guessing "running" would poll forever. Neither is safe, so the
    // body is refused outright.
    const { fetch: f } = stub(jsonResponse(200, { status: "queued" }));
    expect(await getBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: false, reason: "server_error" });
  });

  it("reports a failed run with no failureReason, with no `failureReason` key", async () => {
    // Not `failureReason: undefined` — the page branches on the key's presence,
    // and `toEqual` treats an explicit undefined as equal, so the key check is
    // what actually pins this.
    const { fetch: f } = stub(jsonResponse(200, { status: "failed", failureReason: 7 }));
    const out = await getBrief(ORIGIN, TOKEN, "b1", f);
    expect(out).toEqual({ ok: true, status: "failed" });
    expect(Object.keys(out)).not.toContain("failureReason");
  });
});

describe("saveBrief guards the minted id", () => {
  it("refuses a 200 whose itemId is not a string", async () => {
    // The id is handed to the panel to link to; a number would render as one.
    const { fetch: f } = stub(jsonResponse(200, { itemId: 7 }));
    expect(await saveBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: false, reason: "server_error" });
  });
});

describe("feedBriefSource guards its running count", () => {
  it("refuses a 200 that is missing `expected`", async () => {
    // The count drives "3 of 5 sent". A missing half would render as NaN, or
    // worse, silently stop the feed early.
    const { fetch: f } = stub(jsonResponse(200, { received: 1 }));
    expect(
      await feedBriefSource(
        ORIGIN,
        TOKEN,
        "b1",
        { url: "u", title: "t", body: "b", capturedAt: 1, truncated: false },
        f,
      ),
    ).toEqual({ ok: false, reason: "server_error" });
  });
});

describe("createBrief's own 404 and its fallback", () => {
  const body = { brief: "q", sources: [], useIndex: false };

  it("reports `disabled` with NO hint key when the gateway sent none", async () => {
    // An older gateway answers a bare 404. The page must still say "the seam is
    // off" rather than invent copy it cannot stand behind, and it branches on
    // the key's presence — `hint: undefined` would render an empty line.
    const { fetch: f } = stub(jsonResponse(404, { error: "briefs_disabled" }));
    const out = await createBrief(ORIGIN, TOKEN, body, f);
    expect(out).toEqual({ ok: false, reason: "disabled" });
    expect(Object.keys(out)).not.toContain("hint");
  });

  it("falls back to server_error for a status its own ladder does not name", async () => {
    const { fetch: f } = stub(jsonResponse(500, { error: "kaboom" }));
    expect(await createBrief(ORIGIN, TOKEN, body, f)).toEqual({
      ok: false,
      reason: "server_error",
    });
  });
});
