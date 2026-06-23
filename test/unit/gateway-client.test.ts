import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { confirmPair, postClip } from "../../src/background/gateway-client.ts";
import type { ClipPayload } from "../../src/shared/clip.ts";

const ORIGIN = "http://127.0.0.1:8765";
function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
    expect(await confirmPair(ORIGIN, "x", async () => jsonRes(403, { error: "pairing_failed" }))).toEqual({
      ok: false,
      reason: "pairing_failed",
    });
  });
  test("fetch throw → unreachable", async () => {
    expect(await confirmPair(ORIGIN, "x", async () => { throw new Error("net"); })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
  test("5xx → server_error", async () => {
    expect(await confirmPair(ORIGIN, "x", async () => jsonRes(500, { error: "internal_error" }))).toEqual({
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
    expect(await postClip(ORIGIN, "t", payload, async () => jsonRes(200, { id: "x", status: "updated" }))).toEqual({
      ok: true,
      status: "updated",
    });
  });
  test("401 → unauthorized", async () => {
    expect(await postClip(ORIGIN, "t", payload, async () => jsonRes(401, { error: "unauthorized" }))).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });
  test("400 → invalid_request", async () => {
    expect(await postClip(ORIGIN, "t", payload, async () => jsonRes(400, { error: "invalid_request" }))).toEqual({
      ok: false,
      reason: "invalid_request",
    });
  });
  test("fetch throw → unreachable", async () => {
    expect(await postClip(ORIGIN, "t", payload, async () => { throw new Error("net"); })).toEqual({
      ok: false,
      reason: "unreachable",
    });
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
