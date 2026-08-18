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
