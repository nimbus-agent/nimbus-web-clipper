// test/unit/egress-client.test.ts
import { describe, expect, it } from "vitest";
import {
  getEgressHead,
  listEgress,
  proveEgressWindow,
  verifyEgress,
} from "../../src/background/egress-client.ts";

const ORIGIN = "http://127.0.0.1:7474";
const TOKEN = "tok-abc";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("listEgress", () => {
  it("sends a bearer GET and returns the parsed window", async () => {
    let seenUrl = "";
    let seenAuth: string | null = null;
    const res = await listEgress(
      ORIGIN,
      TOKEN,
      { since: 10, until: 20, limit: 5 },
      async (url, init) => {
        seenUrl = String(url);
        seenAuth = new Headers(init?.headers).get("authorization");
        return jsonResponse(200, { rows: [], rowsTotal: 0, rowsTruncated: false });
      },
    );

    expect(seenUrl).toContain("/v1/egress?");
    expect(seenUrl).toContain("since=10");
    expect(seenUrl).toContain("until=20");
    expect(seenUrl).toContain("limit=5");
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
    expect(res).toEqual({ ok: true, value: { rows: [], rowsTotal: 0, rowsTruncated: false } });
  });

  it("passes the cursor through as `before` when given", async () => {
    let seenUrl = "";
    await listEgress(ORIGIN, TOKEN, { before: 99 }, async (url) => {
      seenUrl = String(url);
      return jsonResponse(200, { rows: [], rowsTotal: 0, rowsTruncated: false });
    });
    expect(seenUrl).toContain("before=99");
  });

  it("maps 404 to unsupported — the gateway predates the route", async () => {
    const res = await listEgress(ORIGIN, TOKEN, {}, async () => new Response("", { status: 404 }));
    expect(res).toEqual({ ok: false, reason: "unsupported" });
  });

  it("maps 403 to insufficient_scope and carries the gap", async () => {
    const res = await listEgress(ORIGIN, TOKEN, {}, async () =>
      jsonResponse(403, { error: "insufficient_scope", required: "egress", granted: ["clip"] }),
    );
    expect(res).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { required: "egress", granted: ["clip"] },
    });
  });

  it("omits the gap when the 403 body is malformed", async () => {
    // No gap => the view falls back to generic guidance rather than inventing a
    // command it cannot build safely.
    const res = await listEgress(ORIGIN, TOKEN, {}, async () => jsonResponse(403, { nope: 1 }));
    expect(res).toEqual({ ok: false, reason: "insufficient_scope" });
  });

  it("maps 401, 429 and 500", async () => {
    const at = async (status: number) =>
      await listEgress(ORIGIN, TOKEN, {}, async () => new Response("", { status }));
    expect(await at(401)).toEqual({ ok: false, reason: "unauthorized" });
    expect(await at(429)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await at(500)).toEqual({ ok: false, reason: "server_error" });
  });

  it("maps a thrown fetch to unreachable", async () => {
    const res = await listEgress(ORIGIN, TOKEN, {}, async () => {
      throw new TypeError("connection refused");
    });
    expect(res).toEqual({ ok: false, reason: "unreachable" });
  });

  it("maps a 200 with an unparseable body to server_error", async () => {
    // Totals missing => the view would have to count the page. Refusing here is
    // what keeps that impossible downstream.
    const res = await listEgress(ORIGIN, TOKEN, {}, async () => jsonResponse(200, { rows: [] }));
    expect(res).toEqual({ ok: false, reason: "server_error" });
  });
});

describe("getEgressHead", () => {
  it("returns the head hash and count", async () => {
    const res = await getEgressHead(ORIGIN, TOKEN, async () =>
      jsonResponse(200, { head: "ff00", count: 12 }),
    );
    expect(res).toEqual({ ok: true, value: { head: "ff00", count: 12 } });
  });

  it("asks the head route with no query string at all", async () => {
    let seenUrl = "";
    await getEgressHead(ORIGIN, TOKEN, async (url) => {
      seenUrl = String(url);
      return jsonResponse(200, { head: "ff00", count: 12 });
    });
    expect(seenUrl).toBe(`${ORIGIN}/v1/egress/head`);
  });

  it.each([
    ["no count", { head: "ff00" }],
    ["a non-string head", { head: 255, count: 12 }],
    ["a non-object body", "ff00"],
  ])("maps a 200 with %s to server_error", async (_why, body) => {
    const res = await getEgressHead(ORIGIN, TOKEN, async () => jsonResponse(200, body));
    expect(res).toEqual({ ok: false, reason: "server_error" });
  });
});

describe("listEgress query building", () => {
  // An absent option must not become the string "undefined" in the query. The
  // type forbids an explicit `undefined`, so only an untyped caller can send
  // one — the cast is how this test plays that caller.
  it("drops an option passed as undefined rather than sending it", async () => {
    let seenUrl = "";
    const opts = { since: 10, until: undefined, limit: 5 } as unknown as Parameters<
      typeof listEgress
    >[2];
    await listEgress(ORIGIN, TOKEN, opts, async (url) => {
      seenUrl = String(url);
      return jsonResponse(200, { rows: [], rowsTotal: 0, rowsTruncated: false });
    });
    expect(seenUrl).toContain("since=10");
    expect(seenUrl).toContain("limit=5");
    expect(seenUrl).not.toContain("until");
    expect(seenUrl).not.toContain("undefined");
  });
});

describe("verifyEgress", () => {
  it("reads an intact verdict", async () => {
    const res = await verifyEgress(ORIGIN, TOKEN, async () =>
      jsonResponse(200, { ok: true, verifiedRows: 5 }),
    );
    expect(res).toEqual({
      ok: true,
      value: { intact: true, brokenAt: null, verifiedRows: 5, reason: null },
    });
  });

  it("reads a broken verdict, keeping the gateway's own brokenAt and reason", async () => {
    const res = await verifyEgress(ORIGIN, TOKEN, async () =>
      jsonResponse(200, { ok: false, verifiedRows: 40, brokenAt: 41, reason: "hash mismatch" }),
    );
    expect(res).toEqual({
      ok: true,
      value: { intact: false, brokenAt: 41, verifiedRows: 40, reason: "hash mismatch" },
    });
  });

  it("treats a missing ok field as server_error rather than as intact", async () => {
    // Defaulting an absent verdict to "verified" would print the one claim this
    // page may never make without evidence.
    const res = await verifyEgress(ORIGIN, TOKEN, async () => jsonResponse(200, {}));
    expect(res).toEqual({ ok: false, reason: "server_error" });
  });

  it("reads a non-integer row count as 0 and a non-integer brokenAt as null", async () => {
    const res = await verifyEgress(ORIGIN, TOKEN, async () =>
      jsonResponse(200, { ok: false, verifiedRows: 4.5, brokenAt: "41", reason: 7 }),
    );
    expect(res).toEqual({
      ok: true,
      value: { intact: false, brokenAt: null, verifiedRows: 0, reason: null },
    });
  });
});

describe("proveEgressWindow", () => {
  it("returns the signed artifact, ignoring the fields it does not use", async () => {
    // The gateway also returns `completeness` and `verify`; the client reads the
    // five it needs and does not fail on a superset.
    const res = await proveEgressWindow(ORIGIN, TOKEN, { since: 1, until: 2 }, async () =>
      jsonResponse(200, {
        digest: "abc",
        sigB64: "c2ln",
        pubkeyB64: "cHVi",
        rowsTotal: 3,
        rowsTruncated: false,
        completeness: { indeterminate: false },
        verify: { ok: true },
      }),
    );
    expect(res).toEqual({
      ok: true,
      value: {
        digest: "abc",
        sigB64: "c2ln",
        pubkeyB64: "cHVi",
        rowsTotal: 3,
        rowsTruncated: false,
      },
    });
  });

  it("maps the rate limit the gateway applies only to this route", async () => {
    const res = await proveEgressWindow(ORIGIN, TOKEN, {}, async () =>
      jsonResponse(429, { error: "rate_limited" }),
    );
    expect(res).toEqual({ ok: false, reason: "rate_limited" });
  });

  // Each body drops exactly ONE of the five fields the client reads, so each
  // can only be refused by its own clause.
  const proof = {
    digest: "abc",
    sigB64: "c2ln",
    pubkeyB64: "cHVi",
    rowsTotal: 3,
    rowsTruncated: false,
  };
  it.each([
    ["digest", { ...proof, digest: 1 }],
    ["sigB64", { ...proof, sigB64: null }],
    ["pubkeyB64", { ...proof, pubkeyB64: undefined }],
    ["rowsTotal", { ...proof, rowsTotal: "3" }],
    ["rowsTruncated", { ...proof, rowsTruncated: "false" }],
  ])("maps a 200 whose %s is malformed to server_error", async (_field, body) => {
    const res = await proveEgressWindow(ORIGIN, TOKEN, {}, async () => jsonResponse(200, body));
    expect(res).toEqual({ ok: false, reason: "server_error" });
  });

  it("maps a 200 whose body is not an object to server_error", async () => {
    const res = await proveEgressWindow(ORIGIN, TOKEN, {}, async () => jsonResponse(200, null));
    expect(res).toEqual({ ok: false, reason: "server_error" });
  });
});
