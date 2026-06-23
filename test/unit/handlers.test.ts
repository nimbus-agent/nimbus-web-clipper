import { describe, expect, test } from "vitest";
import { handleClip, handlePair } from "../../src/background/handlers.ts";
import type { Connection } from "../../src/shared/types.ts";

const conn: Connection = { origin: "http://127.0.0.1:8765", token: "tok", label: "chrome", pairedAt: 100 };
const capture = { url: "https://ex.com/p", title: "T", mode: "article" as const, body: "b", readableFound: true };

describe("handlePair", () => {
  test("rejects a non-loopback origin without calling the gateway", async () => {
    let called = false;
    const res = await handlePair(
      { confirmPair: async () => { called = true; return { ok: true, token: "t", label: "l" }; }, setConnection: async () => undefined, nowMs: () => 1 },
      { kind: "pair", origin: "http://evil.com", code: "1" },
    );
    expect(res).toEqual({ kind: "pair", ok: false, reason: "bad_origin" });
    expect(called).toBe(false);
  });
  test("on 200 stores the connection and returns the label (never the token)", async () => {
    let stored: Connection | null = null;
    const res = await handlePair(
      {
        confirmPair: async () => ({ ok: true, token: "tok-xyz", label: "chrome" }),
        setConnection: async (c) => { stored = c; },
        nowMs: () => 100,
      },
      { kind: "pair", origin: "http://127.0.0.1:8765", code: "429173" },
    );
    expect(res).toEqual({ kind: "pair", ok: true, label: "chrome" });
    expect(JSON.stringify(res)).not.toContain("tok-xyz");
    expect(stored).toEqual({ origin: "http://127.0.0.1:8765", token: "tok-xyz", label: "chrome", pairedAt: 100 });
  });
  test("propagates a pairing failure", async () => {
    const res = await handlePair(
      { confirmPair: async () => ({ ok: false, reason: "pairing_failed" }), setConnection: async () => undefined, nowMs: () => 1 },
      { kind: "pair", origin: "http://127.0.0.1:8765", code: "000000" },
    );
    expect(res).toEqual({ kind: "pair", ok: false, reason: "pairing_failed" });
  });
});

describe("handleClip", () => {
  test("not paired → not_paired without posting", async () => {
    let called = false;
    const res = await handleClip(
      { getConnection: async () => null, postClip: async () => { called = true; return { ok: true, status: "created" }; }, nowMs: () => 1 },
      { kind: "clip", capture, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: false, reason: "not_paired" });
    expect(called).toBe(false);
  });
  test("paired → posts and returns status + bookmarked=false for a readable article", async () => {
    let postedTo = "";
    const res = await handleClip(
      {
        getConnection: async () => conn,
        postClip: async (origin) => { postedTo = origin; return { ok: true, status: "created" }; },
        nowMs: () => 1,
      },
      { kind: "clip", capture, tags: ["a"] },
    );
    expect(postedTo).toBe("http://127.0.0.1:8765");
    expect(res).toEqual({ kind: "clip", ok: true, status: "created", bookmarked: false });
  });
  test("bookmarked=true when the capture was a fallback", async () => {
    const res = await handleClip(
      { getConnection: async () => conn, postClip: async () => ({ ok: true, status: "created" }), nowMs: () => 1 },
      { kind: "clip", capture: { ...capture, readableFound: false }, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: true, status: "created", bookmarked: true });
  });
  test("propagates unauthorized", async () => {
    const res = await handleClip(
      { getConnection: async () => conn, postClip: async () => ({ ok: false, reason: "unauthorized" }), nowMs: () => 1 },
      { kind: "clip", capture, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: false, reason: "unauthorized" });
  });
});
