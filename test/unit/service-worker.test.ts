// test/unit/service-worker.test.ts
//
// Drives src/background/service-worker.ts — the message router + alarm/command
// listeners + startup sequence — end to end through the fake `chrome` surface.
// Importing the module registers its listeners against `globalThis.chrome`, so
// each test installs a FRESH chrome mock and resets the module cache *before*
// importing, then drives the freshly-registered listeners via the harness.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { addNavigationListener } from "../../src/browser/tabs.ts";
import type { QueuedClip } from "../../src/shared/queue.ts";
import type { CaptureResult, Connection } from "../../src/shared/types.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

// Real storage keys (see connection-store.ts / clip-queue-store.ts) and the
// alarm names. FLUSH_ALARM is a local const in service-worker.ts, not
// exported, so it's mirrored here as a literal; AGENT_POLL_ALARM IS exported
// but is mirrored the same way for consistency with FLUSH_ALARM's convention.
const FLUSH_ALARM = "flush-clip-queue";
const AGENT_POLL_ALARM = "nimbus-agent-poll";
const CONNECTION_KEY = "connection";
const QUEUE_KEY = "clipQueue";

const conn: Connection = {
  origin: "http://127.0.0.1:8765",
  token: "tok-abc",
  label: "chrome",
  pairedAt: 1,
};

const capture: CaptureResult = {
  url: "https://ex.com/p",
  title: "T",
  mode: "article",
  body: "b",
  readableFound: true,
};

function queued(url: string): QueuedClip {
  return {
    payload: { url, title: url, mode: "article", body: "b", tags: [], capturedAt: 1 },
    queuedAt: 1,
    attempts: 0,
  };
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Flush pending promise chains that aren't awaited by the caller (alarm/command
 * listeners, the fire-and-forget startup sequence). Real macrotask ticks — not
 * fake timers — so every layer of chained storage/fetch awaits gets a turn. */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

let harness: ChromeHarness;
const originalFetch = globalThis.fetch;

/** Install a fresh chrome mock, optionally seed its storage BEFORE the module
 * is imported (so the fire-and-forget startup sequence sees it), reset the
 * module cache, import the service worker (registering its listeners against
 * the fresh mock), and let the startup sequence settle. */
async function load(seed?: (h: ChromeHarness) => void): Promise<ChromeHarness> {
  harness = installChromeMock();
  seed?.(harness);
  vi.resetModules();
  await import("../../src/background/service-worker.ts");
  await settle();
  return harness;
}

afterEach(() => {
  harness.restore();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  // vi.restoreAllMocks() does NOT reset timers. Restoring here — rather than as
  // each fake-timer test's own last statement — means a test that fails (and
  // exits before reaching that statement) does not leave Date/setTimeout faked
  // for every test that runs after it.
  vi.useRealTimers();
});

describe("message routing — success shapes", () => {
  test("unrecognized message kind is not handled (listener returns false, resolves undefined)", async () => {
    await load();
    const res = await harness.emitMessage({ kind: "ping" });
    expect(res).toBeUndefined();
  });

  test("clip: not paired → not_paired without a fetch, and still syncs the badge", async () => {
    await load();
    globalThis.fetch = vi.fn();
    const res = await harness.emitMessage({ kind: "clip", capture, tags: [] });
    expect(res).toEqual({ kind: "clip", ok: false, reason: "not_paired" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(harness.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });

  test("clip: paired + gateway 200 → created, bookmarked=false for a readable article", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { id: "1", status: "created" }));

    const res = await harness.emitMessage({ kind: "clip", capture, tags: ["a"] });

    expect(res).toEqual({ kind: "clip", ok: true, status: "created", bookmarked: false });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/v1/clips",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("clip: paired + gateway unreachable → queues the clip and ensures the flush alarm", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.alarmsCreate.mockClear();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await harness.emitMessage({ kind: "clip", capture, tags: [] });

    expect(res).toEqual({ kind: "clip", ok: false, reason: "unreachable", queued: true });
    const stored = harness.storage.get(QUEUE_KEY) as QueuedClip[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.payload.url).toBe(capture.url);
    expect(harness.alarmsCreate).toHaveBeenCalledWith(FLUSH_ALARM, { periodInMinutes: 1 });
  });

  test("related: not paired → not_paired without a fetch", async () => {
    await load();
    globalThis.fetch = vi.fn();
    const res = await harness.emitMessage({ kind: "related", title: "T" });
    expect(res).toEqual({ kind: "related", ok: false, reason: "not_paired" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("related: paired + gateway 200 → returns items", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const hit = { id: "1", title: "Doc", service: "drive", snippet: "…", url: null };
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { items: [hit] }));

    const res = await harness.emitMessage({ kind: "related", title: "T" });

    expect(res).toEqual({ kind: "related", ok: true, items: [hit] });
  });

  test("routes a recognise request and answers with a recognition", async () => {
    await load();
    const res = await harness.emitMessage({
      kind: "recognise",
      pageUrl: "https://github.com/acme/web/pull/482",
    });
    expect(res).toMatchObject({
      kind: "recognition",
      ok: true,
      recognition: { ok: true, kind: "pr" },
    });
  });

  // The catch branch: `getOrigins()` reads chrome.storage.local, and that read
  // can fail (the recogniser itself cannot throw). The response must report the
  // failure honestly rather than fabricate an `{ok:false}` recognition a future
  // navigation watcher could not tell apart from a genuinely unrecognised page.
  test("recognise: a storage read failure answers ok:false, never a fabricated recognition", async () => {
    await load();
    harness.storageGet.mockRejectedValueOnce(new Error("storage unavailable"));

    const res = await harness.emitMessage({
      kind: "recognise",
      pageUrl: "https://github.com/acme/web/pull/482",
    });

    expect(res).toEqual({ kind: "recognition", ok: false, reason: "server_error" });
  });

  test("resolve: an unrecognised page answers without a fetch", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi.fn();

    const res = await harness.emitMessage({
      kind: "resolve",
      pageUrl: "https://example.com/nope",
    });

    expect(res).toEqual({
      kind: "resolve",
      ok: true,
      recognition: { ok: false, reason: "unknown-host" },
      outcome: { kind: "not-indexed", fetchable: false },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("resolve: a recognised page GETs the address-bar URL and returns the outcome", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const item = {
      id: "i1",
      service: "github",
      type: "pr",
      title: "Add thing",
      url: "https://github.com/acme/web/pull/1",
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonRes(200, { found: true, matchKind: "exact", item: { ...item, modified_at: 5 } }),
      );

    const res = await harness.emitMessage({
      kind: "resolve",
      pageUrl: "https://github.com/acme/web/pull/1/files",
    });

    expect(res).toMatchObject({
      kind: "resolve",
      ok: true,
      outcome: { kind: "found", matchKind: "exact", item: { ...item, modifiedAt: 5 } },
    });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `http://127.0.0.1:8765/v1/items/resolve?url=${encodeURIComponent("https://github.com/acme/web/pull/1/files")}`,
    );
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok-abc");
  });

  test("resolve: a gateway 404 is unsupported, and the recognition survives", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(404, {}));

    const res = await harness.emitMessage({
      kind: "resolve",
      pageUrl: "https://github.com/acme/web/pull/1",
    });

    expect(res).toMatchObject({ kind: "resolve", ok: false, reason: "unsupported" });
    expect((res as { recognition: { ok: boolean } }).recognition.ok).toBe(true);
  });

  test("fetch: an unrecognised page answers without a fetch (the recogniser gate)", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi.fn();

    const res = await harness.emitMessage({
      kind: "fetch",
      pageUrl: "https://example.com/nope",
    });

    expect(res).toEqual({
      kind: "fetch",
      ok: true,
      recognition: { ok: false, reason: "unknown-host" },
      outcome: { kind: "unfetchable" },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("fetch: a recognised page POSTs to /v1/items/fetch and returns the outcome", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { status: "indexed", itemId: "i1" }));

    const res = await harness.emitMessage({
      kind: "fetch",
      pageUrl: "https://github.com/acme/web/pull/1",
    });

    expect(res).toMatchObject({
      kind: "fetch",
      ok: true,
      outcome: { kind: "indexed", itemId: "i1" },
    });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:8765/v1/items/fetch");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok-abc");
  });

  test("agent-run: an unrecognised page answers without a fetch (the recogniser gate)", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi.fn();

    const res = await harness.emitMessage({
      kind: "agent-run",
      lane: "impact",
      pageUrl: "https://example.com/nope",
    });

    // `not_resolved`, never `unsupported` — this is a condition of the PAGE
    // (nothing recognised), not a claim that the gateway lacks an agents surface.
    expect(res).toEqual({
      kind: "agent-state",
      lane: "impact",
      state: { kind: "failed", reason: "not_resolved" },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("agent-state: an unrecognised page answers without a fetch (the recogniser gate)", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi.fn();

    const res = await harness.emitMessage({
      kind: "agent-state",
      lane: "impact",
      pageUrl: "https://example.com/nope",
    });

    expect(res).toEqual({
      kind: "agent-state",
      lane: "impact",
      state: { kind: "failed", reason: "not_resolved" },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("agent-run: a resolved page invokes the lane's agent with its params, and persists running", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const item = {
      id: "i1",
      service: "github",
      type: "pr",
      title: "Add thing",
      url: "https://github.com/acme/web/pull/1",
    };
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/v1/items/resolve")) {
        return jsonRes(200, { found: true, matchKind: "exact", item: { ...item, modified_at: 5 } });
      }
      return jsonRes(202, { runId: "run-42" });
    });

    // A successful "running" persist schedules the in-worker poll loop's first
    // tick via a real setTimeout; fake timers here stop that pending timer from
    // leaking into a LATER test (the global afterEach's vi.useRealTimers() drops
    // it unfired) rather than firing mid-suite against a different test's mock.
    vi.useFakeTimers();
    const res = await harness.emitMessage({
      kind: "agent-run",
      lane: "impact",
      pageUrl: "https://github.com/acme/web/pull/1",
    });

    expect(res).toEqual({
      kind: "agent-state",
      lane: "impact",
      state: { kind: "running", runId: "run-42" },
    });
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, RequestInit]
    >;
    const invokeCall = calls.find(([url]) => String(url).includes("/v1/agents/impact"));
    expect(invokeCall?.[0]).toBe("http://127.0.0.1:8765/v1/agents/impact");
    expect(JSON.parse(String(invokeCall?.[1]?.body))).toEqual({
      fileOrPrUrl: "https://github.com/acme/web/pull/1",
    });
  });

  // THE load-bearing eviction-net test: a bare chrome.alarms.create (or a
  // one-shot) would still leave every "resumes polling" test below green,
  // because those fire the alarm directly via harness.emitAlarm — they don't
  // verify anything actually ARMS it. This is the test that would catch a
  // regression to either. periodInMinutes is asserted explicitly, not just
  // "some alarm was created": a one-shot alarm silently orphans a run that
  // outlives a SECOND eviction, which is exactly what the periodic design
  // exists to prevent (see AGENT_POLL_ALARM's doc comment in service-worker.ts).
  test("agent-run: a successful invoke ensures the poll alarm as PERIODIC, not one-shot", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const item = {
      id: "i1",
      service: "github",
      type: "pr",
      title: "Add thing",
      url: "https://github.com/acme/web/pull/1",
    };
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/v1/items/resolve")) {
        return jsonRes(200, { found: true, matchKind: "exact", item: { ...item, modified_at: 5 } });
      }
      return jsonRes(202, { runId: "run-42" });
    });
    harness.alarmsCreate.mockClear();

    vi.useFakeTimers();
    await harness.emitMessage({
      kind: "agent-run",
      lane: "impact",
      pageUrl: "https://github.com/acme/web/pull/1",
    });

    expect(harness.alarmsCreate).toHaveBeenCalledWith(AGENT_POLL_ALARM, { periodInMinutes: 1 });
  });

  test("agent-run then agent-state: the persisted running state round-trips through storage", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const item = {
      id: "i1",
      service: "github",
      type: "pr",
      title: "Add thing",
      url: "https://github.com/acme/web/pull/1",
    };
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/v1/items/resolve")) {
        return jsonRes(200, { found: true, matchKind: "exact", item: { ...item, modified_at: 5 } });
      }
      return jsonRes(202, { runId: "run-42" });
    });

    // See the previous test's comment: fake timers only to stop the poll
    // loop's setTimeout from leaking into a later test.
    vi.useFakeTimers();
    await harness.emitMessage({
      kind: "agent-run",
      lane: "impact",
      pageUrl: "https://github.com/acme/web/pull/1",
    });
    const res = await harness.emitMessage({
      kind: "agent-state",
      lane: "impact",
      pageUrl: "https://github.com/acme/web/pull/1",
    });

    expect(res).toEqual({
      kind: "agent-state",
      lane: "impact",
      state: { kind: "running", runId: "run-42" },
    });
  });

  test("queue-list: reads storage only, projects to views", async () => {
    await load();
    harness.storage.set(QUEUE_KEY, [queued("a"), queued("b")]);

    const res = await harness.emitMessage({ kind: "queue-list" });

    expect(res).toEqual({
      kind: "queue",
      items: [
        { url: "a", title: "a", queuedAt: 1, attempts: 0 },
        { url: "b", title: "b", queuedAt: 1, attempts: 0 },
      ],
    });
  });

  test("queue-retry: flushes (manual) then returns the updated list, clearing the alarm once empty", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.storage.set(QUEUE_KEY, [queued("a")]);
    harness.alarmsClear.mockClear();
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { id: "1", status: "created" }));

    const res = await harness.emitMessage({ kind: "queue-retry" });

    expect(res).toEqual({ kind: "queue", items: [] });
    expect(harness.storage.get(QUEUE_KEY)).toEqual([]);
    expect(harness.alarmsClear).toHaveBeenCalledWith(FLUSH_ALARM);
  });

  test("queue-remove: removing the only entry empties the queue and clears the alarm", async () => {
    await load();
    harness.storage.set(QUEUE_KEY, [queued("a")]);
    harness.alarmsClear.mockClear();

    const res = await harness.emitMessage({ kind: "queue-remove", url: "a" });

    expect(res).toEqual({ kind: "queue", items: [] });
    expect(harness.alarmsClear).toHaveBeenCalledWith(FLUSH_ALARM);
  });

  test("queue-remove: leaving entries behind ensures the flush alarm stays live", async () => {
    await load();
    harness.storage.set(QUEUE_KEY, [queued("a"), queued("b")]);
    harness.alarmsCreate.mockClear();

    const res = await harness.emitMessage({ kind: "queue-remove", url: "a" });

    expect(res).toEqual({
      kind: "queue",
      items: [{ url: "b", title: "b", queuedAt: 1, attempts: 0 }],
    });
    expect(harness.alarmsCreate).toHaveBeenCalledWith(FLUSH_ALARM, { periodInMinutes: 1 });
  });

  test("connection-status: not paired → paired:false", async () => {
    await load();
    const res = await harness.emitMessage({ kind: "connection-status" });
    expect(res).toEqual({ kind: "connection", paired: false });
  });

  test("connection-status: paired → token-free projection", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonRes(200, { status: "ok", gateway: "read_only_http" }));

    const res = await harness.emitMessage({ kind: "connection-status" });

    expect(res).toEqual({
      kind: "connection",
      paired: true,
      label: conn.label,
      origin: conn.origin,
      pairedAt: conn.pairedAt,
      queueDepth: 0,
      reachable: true,
      stale: false,
    });
    expect(JSON.stringify(res)).not.toContain(conn.token);
  });

  test("unpair: clears the stored connection", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);

    const res = await harness.emitMessage({ kind: "unpair" });

    expect(res).toEqual({ kind: "connection", paired: false });
    expect(harness.storage.has(CONNECTION_KEY)).toBe(false);
  });

  test("pair: non-loopback origin is rejected without reaching the gateway", async () => {
    await load();
    globalThis.fetch = vi.fn();

    const res = await harness.emitMessage({ kind: "pair", origin: "http://evil.com", code: "1" });

    expect(res).toEqual({ kind: "pair", ok: false, reason: "bad_origin" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("pair: loopback origin + gateway 200 → stores the connection, returns the label only", async () => {
    await load();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonRes(200, { token: "tok-xyz", label: "chrome" }));

    const res = await harness.emitMessage({
      kind: "pair",
      origin: "http://127.0.0.1:8765",
      code: "429173",
    });

    expect(res).toEqual({ kind: "pair", ok: true, label: "chrome" });
    expect(JSON.stringify(res)).not.toContain("tok-xyz");
    const stored = harness.storage.get(CONNECTION_KEY) as Connection;
    expect(stored.origin).toBe("http://127.0.0.1:8765");
    expect(stored.token).toBe("tok-xyz");
    expect(stored.label).toBe("chrome");
  });

  test("pair: a failed confirm (403) leaves any existing connection untouched", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(403, { error: "pairing_failed" }));

    const res = await harness.emitMessage({
      kind: "pair",
      origin: "http://127.0.0.1:8765",
      code: "000000",
    });

    expect(res).toEqual({ kind: "pair", ok: false, reason: "pairing_failed" });
    expect(harness.storage.get(CONNECTION_KEY)).toEqual(conn);
  });
});

describe("message routing — fail-closed on a thrown/rejected handler", () => {
  test("pair: a storage write failure after a successful confirm → server_error, never an unhandled rejection", async () => {
    await load();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonRes(200, { token: "tok-xyz", label: "chrome" }));
    harness.storageSet.mockRejectedValueOnce(new Error("disk full"));

    const res = await harness.emitMessage({
      kind: "pair",
      origin: "http://127.0.0.1:8765",
      code: "429173",
    });

    expect(res).toEqual({ kind: "pair", ok: false, reason: "server_error" });
  });

  test("clip: a storage read failure → server_error", async () => {
    await load();
    harness.storageGet.mockRejectedValueOnce(new Error("boom"));

    const res = await harness.emitMessage({ kind: "clip", capture, tags: [] });

    expect(res).toEqual({ kind: "clip", ok: false, reason: "server_error" });
  });

  test("related: a storage read failure → server_error", async () => {
    await load();
    harness.storageGet.mockRejectedValueOnce(new Error("boom"));

    const res = await harness.emitMessage({ kind: "related", title: "T" });

    expect(res).toEqual({ kind: "related", ok: false, reason: "server_error" });
  });

  test("queue-list: a storage read failure → empty list, not an unhandled rejection", async () => {
    await load();
    harness.storageGet.mockRejectedValueOnce(new Error("boom"));

    const res = await harness.emitMessage({ kind: "queue-list" });

    expect(res).toEqual({ kind: "queue", items: [] });
  });

  test("queue-retry: a storage read failure → empty list fallback", async () => {
    await load();
    harness.storageGet.mockRejectedValueOnce(new Error("boom"));

    const res = await harness.emitMessage({ kind: "queue-retry" });

    expect(res).toEqual({ kind: "queue", items: [] });
  });

  test("queue-remove: a storage write failure → empty list fallback", async () => {
    await load();
    harness.storageSet.mockRejectedValueOnce(new Error("boom"));

    const res = await harness.emitMessage({ kind: "queue-remove", url: "a" });

    expect(res).toEqual({ kind: "queue", items: [] });
  });

  test("connection-status: a storage read failure → paired:false fallback", async () => {
    await load();
    harness.storageGet.mockRejectedValueOnce(new Error("boom"));

    const res = await harness.emitMessage({ kind: "connection-status" });

    expect(res).toEqual({ kind: "connection", paired: false });
  });

  test("unpair: a storage remove failure → paired:false fallback", async () => {
    await load();
    harness.storageRemove.mockRejectedValueOnce(new Error("boom"));

    const res = await harness.emitMessage({ kind: "unpair" });

    expect(res).toEqual({ kind: "connection", paired: false });
  });
});

describe("startup sequence", () => {
  test("empty queue: paints the badge background, clears the flush alarm, badge shows nothing", async () => {
    await load();

    expect(harness.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#5b6470" });
    expect(harness.setBadgeText).toHaveBeenCalledWith({ text: "" });
    expect(harness.alarmsClear).toHaveBeenCalledWith(FLUSH_ALARM);
    expect(harness.alarmsCreate).not.toHaveBeenCalled();
  });

  test("seeded backlog with no connection: badge shows the count and the alarm stays ensured", async () => {
    await load((h) => h.storage.set(QUEUE_KEY, [queued("a"), queued("b")]));

    expect(harness.setBadgeText).toHaveBeenCalledWith({ text: "2" });
    expect(harness.alarmsCreate).toHaveBeenCalledWith(FLUSH_ALARM, { periodInMinutes: 1 });
    // No connection paired → the startup drain is a no-op, queue stays intact.
    expect(harness.storage.get(QUEUE_KEY)).toHaveLength(2);
  });
});

describe("alarm route", () => {
  test("the flush alarm drains a paired backlog and reconciles the badge + alarm", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.storage.set(QUEUE_KEY, [queued("a"), queued("b")]);
    harness.setBadgeText.mockClear();
    harness.alarmsClear.mockClear();
    // A fresh Response per call — a Response body can only be read once, and this
    // route drains two queued entries against the same mock.
    globalThis.fetch = vi.fn(async () => jsonRes(200, { id: "1", status: "created" }));

    harness.emitAlarm(FLUSH_ALARM);
    await settle();

    expect(harness.storage.get(QUEUE_KEY)).toEqual([]);
    expect(harness.setBadgeText).toHaveBeenCalledWith({ text: "" });
    expect(harness.alarmsClear).toHaveBeenCalledWith(FLUSH_ALARM);
  });

  test("an unrelated alarm name is ignored", async () => {
    await load();
    harness.storage.set(QUEUE_KEY, [queued("a")]);
    harness.setBadgeText.mockClear();

    harness.emitAlarm("some-other-alarm");
    await settle();

    expect(harness.setBadgeText).not.toHaveBeenCalled();
    expect(harness.storage.get(QUEUE_KEY)).toHaveLength(1);
  });
});

describe("command route", () => {
  test("show_related injects the panel into the active tab", async () => {
    await load();
    harness.tabsQuery.mockResolvedValue([{ id: 7, url: "https://ex.com/", title: "Ex" }]);

    harness.emitCommand("show_related");
    await settle();

    expect(harness.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["panel.js"],
    });
  });

  test("show_related fails closed silently when there is no active tab", async () => {
    await load();
    harness.tabsQuery.mockResolvedValue([{ url: "https://ex.com/", title: "Ex" }]);
    harness.executeScript.mockClear();

    harness.emitCommand("show_related");
    await settle();

    expect(harness.executeScript).not.toHaveBeenCalled();
  });

  test("an unrecognized command does nothing", async () => {
    await load();
    harness.tabsQuery.mockClear();

    harness.emitCommand("some-other-command");
    await settle();

    expect(harness.tabsQuery).not.toHaveBeenCalled();
  });
});

describe("quick clip — context menu + shortcut routes", () => {
  /** Seed the harness so a quick clip on a normal page runs end to end: a paired
   * connection, an active tab, a capture.js result, and a 200 from the gateway.
   * The executeScript queue is: capture.js file inject → the capture func (whose
   * result is read) → toast.js inject → the toast func. */
  function seedQuickClip(h: ChromeHarness, mode: "article" | "selection" = "article"): void {
    h.storage.set(CONNECTION_KEY, conn);
    h.tabsQuery.mockResolvedValue([{ id: 5, url: "https://ex.com/a", title: "A" }]);
    h.executeScript
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([
        {
          result: {
            url: "https://ex.com/a",
            title: "A",
            mode,
            body: "b",
            readableFound: true,
          },
        },
      ])
      .mockResolvedValue([{ result: undefined }]);
  }

  test("registers the three context menus on startup (removeAll before create)", async () => {
    await load();

    expect(harness.contextMenusRemoveAll).toHaveBeenCalled();
    expect(harness.contextMenusCreate).toHaveBeenCalledTimes(3);
    const ids = harness.contextMenusCreate.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(["clip-page", "clip-selection", "show-related"]);
  });

  test("onInstalled re-registers the menus (removeAll first, no duplicate ids)", async () => {
    await load();
    harness.contextMenusCreate.mockClear();
    harness.contextMenusRemoveAll.mockClear();

    harness.emitInstalled();
    await settle();

    expect(harness.contextMenusRemoveAll).toHaveBeenCalled();
    expect(harness.contextMenusCreate).toHaveBeenCalledTimes(3);
  });

  test("clip-page command captures the active tab and posts a clip", async () => {
    await load();
    seedQuickClip(harness);
    globalThis.fetch = vi.fn(async () => jsonRes(200, { id: "1", status: "created" }));

    harness.emitCommand("clip-page");
    await settle();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/v1/clips",
      expect.objectContaining({ method: "POST" }),
    );
    // Confirmed in page: toast.js injected into the same tab, then invoked.
    expect(harness.executeScript).toHaveBeenCalledWith({
      target: { tabId: 5 },
      files: ["toast.js"],
    });
    // …and the state actually handed to the page is the success toast, worded like
    // the popup. This is the user-visible contract of the whole feature.
    expect(harness.executeScript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: { tabId: 5 },
        args: [{ variant: "success", text: "Saved to Nimbus." }],
      }),
    );
  });

  test("a badge-sync failure does not swallow the success toast", async () => {
    await load();
    seedQuickClip(harness);
    globalThis.fetch = vi.fn(async () => jsonRes(200, { id: "1", status: "created" }));
    // syncQueueState()'s badge write blows up right after the clip succeeds.
    harness.setBadgeText.mockRejectedValueOnce(new Error("badge boom"));

    harness.emitCommand("clip-page");
    await settle();

    expect(harness.executeScript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: [{ variant: "success", text: "Saved to Nimbus." }],
      }),
    );
  });

  test("a rejecting clip pipeline still confirms with an error toast", async () => {
    await load();
    seedQuickClip(harness);
    globalThis.fetch = vi.fn(async () => jsonRes(200, { id: "1", status: "created" }));
    // The connection read inside handleClip fails → the clip promise rejects.
    harness.storageGet.mockRejectedValueOnce(new Error("storage boom"));

    harness.emitCommand("clip-page");
    await settle();

    expect(harness.executeScript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: [{ variant: "error", text: "Nimbus had an error saving this." }],
      }),
    );
  });

  test("a context-menu click clips the CLICKED tab, not the active one", async () => {
    await load();
    seedQuickClip(harness); // active tab is id 5
    globalThis.fetch = vi.fn(async () => jsonRes(200, { id: "1", status: "created" }));

    harness.emitMenuClick("clip-page", 9);
    await settle();

    expect(harness.executeScript).toHaveBeenCalledWith({
      target: { tabId: 9 },
      files: ["capture.js"],
    });
    expect(harness.executeScript).toHaveBeenCalledWith({
      target: { tabId: 9 },
      files: ["toast.js"],
    });
    const targets = harness.executeScript.mock.calls.map(
      (c) => (c[0] as { target: { tabId: number } }).target.tabId,
    );
    expect(targets).not.toContain(5);
  });

  test("the clip-selection menu item captures in selection mode", async () => {
    await load();
    seedQuickClip(harness, "selection");
    globalThis.fetch = vi.fn(async () => jsonRes(200, { id: "1", status: "created" }));

    harness.emitMenuClick("clip-selection", 5);
    await settle();

    expect(harness.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 5 }, args: ["selection"] }),
    );
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  test("a restricted page flashes the badge instead of injecting a toast", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.tabsQuery.mockResolvedValue([{ id: 5, url: "chrome://extensions", title: "X" }]);
    harness.executeScript.mockClear();
    harness.setBadgeText.mockClear();
    globalThis.fetch = vi.fn();

    harness.emitCommand("clip-page");
    await settle();

    expect(harness.executeScript).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(harness.setBadgeText).toHaveBeenCalledWith({ text: "!" });
  });

  // Regression for quick-clip being one of the four clip paths that used to
  // bypass `stale` entirely — this route calls handleClip directly, never
  // through the message router's `respond` wrap, so only postClipPaced can
  // catch it.
  test("a 401 on the quick-clip (hotkey) path sets stale, alongside the error toast", async () => {
    await load();
    seedQuickClip(harness);
    globalThis.fetch = vi.fn(async () => jsonRes(401, { error: "unauthorized" }));

    harness.emitCommand("clip-page");
    await settle();

    expect(harness.executeScript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: [{ variant: "error", text: "Pairing expired — re-pair in Options." }],
      }),
    );
    expect((harness.storage.get(CONNECTION_KEY) as Connection).stale).toBe(true);
  });
});

describe("rate-limit pacing", () => {
  const PAUSE_KEY = "clipRateLimitPauseUntil";
  const NOW = 1_700_000_000_000;

  function rateLimitedRes(retryAfter: string): Response {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": retryAfter },
    });
  }

  test("a 429 clip queues it, arms the pause, and re-arms the alarm with the delay", async () => {
    // Fake ONLY Date — `settle()` relies on real setTimeout to drain the SW's
    // fire-and-forget promise chains.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.alarmsCreate.mockClear();
    globalThis.fetch = vi.fn().mockResolvedValue(rateLimitedRes("45"));

    const res = await harness.emitMessage({ kind: "clip", capture, tags: [] });

    expect(res).toEqual({ kind: "clip", ok: false, reason: "rate_limited", queued: true });
    expect(harness.storage.get(PAUSE_KEY)).toBe(NOW + 45_000);
    expect(harness.alarmsCreate).toHaveBeenCalledWith(FLUSH_ALARM, {
      delayInMinutes: 0.75,
      periodInMinutes: 1,
    });
  });

  // Chrome ignores a delay under 0.5 and logs a warning, so short waits round up.
  test("a sub-30s Retry-After is clamped to the 0.5-minute alarm floor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.alarmsCreate.mockClear();
    globalThis.fetch = vi.fn().mockResolvedValue(rateLimitedRes("5"));

    await harness.emitMessage({ kind: "clip", capture, tags: [] });

    expect(harness.alarmsCreate).toHaveBeenCalledWith(FLUSH_ALARM, {
      delayInMinutes: 0.5,
      periodInMinutes: 1,
    });
  });

  test("a successful clip clears an existing pause", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.storage.set(PAUSE_KEY, Date.now() + 45_000);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { id: "1", status: "created" }));

    const res = await harness.emitMessage({ kind: "clip", capture, tags: [] });

    expect(res).toEqual({ kind: "clip", ok: true, status: "created", bookmarked: false });
    expect(harness.storage.get(PAUSE_KEY)).toBe(0);
  });

  // Regression: clearing the pause alone would leave the alarm on the delayed
  // schedule, and the (correctly) idempotent ensureAlarm won't replace it — so the
  // queue would keep waiting out a delay that no longer applies.
  test("ending a pause drops the delayed alarm so a plain periodic one replaces it", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.storage.set(QUEUE_KEY, [queued("https://ex.com/a")]);
    harness.storage.set(PAUSE_KEY, Date.now() + 45_000);
    harness.alarmsCreate.mockClear();
    harness.alarmsClear.mockClear();
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { id: "1", status: "created" }));

    await harness.emitMessage({ kind: "clip", capture, tags: [] });

    expect(harness.alarmsClear).toHaveBeenCalledWith(FLUSH_ALARM);
    expect(harness.alarmsCreate).toHaveBeenCalledWith(FLUSH_ALARM, { periodInMinutes: 1 });
  });

  // The no-op path must not churn the alarm on every ordinary clip.
  test("a successful clip with no pause set leaves the alarm alone", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.storage.set(QUEUE_KEY, [queued("https://ex.com/a")]);
    harness.alarmsClear.mockClear();
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { id: "1", status: "created" }));

    await harness.emitMessage({ kind: "clip", capture, tags: [] });

    expect(harness.alarmsClear).not.toHaveBeenCalled();
  });

  test("an alarm flush during an active pause posts nothing", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.storage.set(QUEUE_KEY, [queued("https://ex.com/a")]);
    harness.storage.set(PAUSE_KEY, Date.now() + 45_000);
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(200, { id: "1", status: "created" }));
    globalThis.fetch = fetchMock;

    harness.emitAlarm(FLUSH_ALARM);
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.storage.get(QUEUE_KEY)).toHaveLength(1);
  });

  test("an alarm flush after the pause expires drains the queue", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.storage.set(QUEUE_KEY, [queued("https://ex.com/a")]);
    harness.storage.set(PAUSE_KEY, Date.now() - 1000);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { id: "1", status: "created" }));

    harness.emitAlarm(FLUSH_ALARM);
    await settle();

    expect(harness.storage.get(QUEUE_KEY)).toEqual([]);
  });
});

describe("agent run polling — survives eviction", () => {
  const NOW = 1_700_000_000_000;

  /** Point globalThis.fetch at a handler keyed by URL, recording nothing itself —
   *  callers push into their own `polls` array from inside `handler`. */
  function stubFetch(handler: (url: string) => Response): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (url: string | URL | Request) => handler(String(url)));
    globalThis.fetch = fn;
    return fn;
  }

  /** Fire the alarm and let its fire-and-forget promise chain settle — same
   *  shape as the "alarm route" describe block above. */
  async function fireAlarm(name: string): Promise<void> {
    harness.emitAlarm(name);
    await settle();
  }

  // Date is faked (not setTimeout — the poll loop's real setTimeout still needs
  // to interoperate with settle()'s real macrotask ticks) so `Date.now()` inside
  // the SW lines up with the fixed `expiresAtMs` values these tests seed.
  test("resumes polling a persisted run after a simulated worker eviction", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    // Persist a running run directly through the store (bypassing agent-run,
    // whose module is the SAME fresh instance load() just imported) — the
    // closest this harness gets to modelling "the worker was evicted": module
    // state (activeAgentPolls, any in-flight setTimeout) is gone, storage is not.
    const { putRun, getRun } = await import("../../src/background/agent-run-store.ts");
    await putRun(
      {
        subject: { kind: "item", id: "gh-1" },
        lane: "impact",
        runId: "r1",
        state: { kind: "running", runId: "r1" },
        expiresAtMs: NOW + 60_000,
      },
      NOW,
    );

    const polls: string[] = [];
    stubFetch((url) => {
      polls.push(url);
      return jsonRes(200, { status: "done", brief: "answered" });
    });

    await fireAlarm(AGENT_POLL_ALARM);

    expect(polls.some((u) => u.includes("/v1/agents/runs/r1"))).toBe(true);
    expect((await getRun({ kind: "item", id: "gh-1" }, "impact", NOW))?.state).toEqual({
      kind: "done",
      brief: "answered",
    });
  });

  test("stops polling a run past its expiry rather than polling forever", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const { putRun } = await import("../../src/background/agent-run-store.ts");
    await putRun(
      {
        subject: { kind: "item", id: "gh-1" },
        lane: "impact",
        runId: "r1",
        state: { kind: "running", runId: "r1" },
        expiresAtMs: NOW - 1,
      },
      NOW - 2,
    );

    const polls: string[] = [];
    const fetchMock = stubFetch((url) => {
      polls.push(url);
      return jsonRes(200, { status: "running" });
    });

    await fireAlarm(AGENT_POLL_ALARM);

    expect(polls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a done poll result also clears the now-empty poll alarm", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const { putRun } = await import("../../src/background/agent-run-store.ts");
    await putRun(
      {
        subject: { kind: "item", id: "gh-1" },
        lane: "impact",
        runId: "r1",
        state: { kind: "running", runId: "r1" },
        expiresAtMs: NOW + 60_000,
      },
      NOW,
    );
    harness.alarmsClear.mockClear();
    stubFetch(() => jsonRes(200, { status: "done", brief: "answered" }));

    await fireAlarm(AGENT_POLL_ALARM);

    expect(harness.alarmsClear).toHaveBeenCalledWith(AGENT_POLL_ALARM);
  });

  test("a stale poll result is terminal and does not auto-re-invoke", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const { putRun, getRun } = await import("../../src/background/agent-run-store.ts");
    await putRun(
      {
        subject: { kind: "item", id: "gh-1" },
        lane: "impact",
        runId: "r1",
        state: { kind: "running", runId: "r1" },
        expiresAtMs: NOW + 60_000,
      },
      NOW,
    );
    const invokeCalls: string[] = [];
    stubFetch((url) => {
      if (url.includes("/v1/agents/runs/")) {
        return new Response(null, { status: 410 });
      }
      invokeCalls.push(url);
      return jsonRes(202, { runId: "should-not-happen" });
    });

    await fireAlarm(AGENT_POLL_ALARM);

    expect((await getRun({ kind: "item", id: "gh-1" }, "impact", NOW))?.state).toEqual({
      kind: "failed",
      reason: "stale",
    });
    expect(invokeCalls).toEqual([]);
  });

  // The wire's `failed` status is a NORMAL terminal outcome (transport worked,
  // gateway healthy, the agent itself couldn't answer) — `agent_failed`, never
  // `server_error`, which is reserved for a genuinely failed CALL. The
  // gateway's free-text explanation carries through as `detail`.
  test("the agent's own failed run maps to agent_failed, carrying the gateway's detail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const { putRun, getRun } = await import("../../src/background/agent-run-store.ts");
    await putRun(
      {
        subject: { kind: "item", id: "gh-1" },
        lane: "impact",
        runId: "r1",
        state: { kind: "running", runId: "r1" },
        expiresAtMs: NOW + 60_000,
      },
      NOW,
    );
    stubFetch(() => jsonRes(200, { status: "failed", failureReason: "no LLM configured" }));

    await fireAlarm(AGENT_POLL_ALARM);

    expect((await getRun({ kind: "item", id: "gh-1" }, "impact", NOW))?.state).toEqual({
      kind: "failed",
      reason: "agent_failed",
      detail: "no LLM configured",
    });
  });

  // A blank failureReason omits `detail` entirely — never a written
  // `detail: undefined` — since toEqual treats an explicit undefined as equal
  // and would let that regress silently.
  test("a blank failureReason stores agent_failed with no detail key at all", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const { putRun, getRun } = await import("../../src/background/agent-run-store.ts");
    await putRun(
      {
        subject: { kind: "item", id: "gh-1" },
        lane: "impact",
        runId: "r1",
        state: { kind: "running", runId: "r1" },
        expiresAtMs: NOW + 60_000,
      },
      NOW,
    );
    stubFetch(() => jsonRes(200, { status: "failed", failureReason: "" }));

    await fireAlarm(AGENT_POLL_ALARM);

    const state = (await getRun({ kind: "item", id: "gh-1" }, "impact", NOW))?.state;
    expect(state).toEqual({ kind: "failed", reason: "agent_failed" });
    expect(state !== undefined && "detail" in state).toBe(false);
  });

  // C2.1's done-when is "never a silent empty lane". Without this, a run whose
  // worker keeps waking up unpaired would sit as `running` until its 10-minute
  // TTL lapsed, then silently become `collapsed` — a spinner that quietly
  // resets to nothing, having told the user nothing. No fetch happens at all
  // here (there is no connection to fetch WITH), so a stubbed fetch that throws
  // if called doubles as proof of that.
  test("give-up with no connection to poll with writes not_paired, not silence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await load();
    // Deliberately NOT seeding CONNECTION_KEY.
    const { putRun, getRun } = await import("../../src/background/agent-run-store.ts");
    await putRun(
      {
        subject: { kind: "item", id: "gh-1" },
        lane: "impact",
        runId: "r1",
        state: { kind: "running", runId: "r1" },
        expiresAtMs: NOW + 60_000,
      },
      NOW,
    );
    stubFetch(() => {
      throw new Error("must not fetch with no connection");
    });

    await fireAlarm(AGENT_POLL_ALARM);

    expect((await getRun({ kind: "item", id: "gh-1" }, "impact", NOW))?.state).toEqual({
      kind: "failed",
      reason: "not_paired",
    });
  });

  // `activeAgentPolls` has two halves, and each needs its own test: the filter in
  // `resumeAgentPolls` (this test) and `startAgentPollLoop`'s own guard (the next
  // one). Neither is covered by any other test here — the suite stayed green with
  // either one deleted.
  //
  // The alarm is PERIODIC, and Chrome fires it every minute whether or not the
  // worker was ever evicted. Without the filter, each tick would start a SECOND
  // uncoordinated backoff loop for a run already being polled — one extra loop per
  // minute for up to the run's 10-minute TTL, and only for runs that stay
  // `running`, i.e. against a gateway that is already slow or down.
  //
  // Fakes setTimeout as well as Date (unlike the Date-only tests above) because the
  // assertion is about WHICH backoff ticks fire and when; with real timers the
  // 750ms step would race the test body.
  test("a second alarm tick does not start a second poll loop for a run already being polled", async () => {
    await load();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    harness.storage.set(CONNECTION_KEY, conn);
    const { putRun } = await import("../../src/background/agent-run-store.ts");
    await putRun(
      {
        subject: { kind: "item", id: "gh-1" },
        lane: "impact",
        runId: "r1",
        state: { kind: "running", runId: "r1" },
        // Well past every tick this test drives: the run must stay `running` the
        // whole way, so nothing here can be mistaken for the expiry give-up.
        expiresAtMs: NOW + 600_000,
      },
      NOW,
    );
    const polls: string[] = [];
    stubFetch((url) => {
      polls.push(url);
      return jsonRes(200, { status: "running" });
    });

    harness.emitAlarm(AGENT_POLL_ALARM);
    await vi.advanceTimersByTimeAsync(0); // the alarm's immediate first tick
    expect(polls).toHaveLength(1);

    // The next minute-tick, with the run still `running` and its loop mid-backoff.
    harness.emitAlarm(AGENT_POLL_ALARM);
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toHaveLength(1);

    // And exactly one loop is still ticking: the single scheduled 500 * 1.5 poll.
    // A second loop would have its own tick at the same moment.
    await vi.advanceTimersByTimeAsync(750);
    expect(polls).toHaveLength(2);
  });

  // The other half: `startAgentPollLoop`'s guard, which the test above cannot
  // reach — `resumeAgentPolls` adds to the Set itself and never calls it. This
  // guard covers the other way one runId can be polled twice: a `running` state
  // persisted for it more than once. Two tabs on the same PR expanding the same
  // lane at the same moment do exactly that whenever the gateway answers both
  // invokes with one run id — which `scripts/screenshots/mock-gateway.ts` does
  // by design (`gateway-fixtures.ts` hands back a fixed `runId` for every
  // invoke), so it is not a hypothetical shape. The
  // guard's promise is one loop per runId, however often that runId is persisted
  // as running.
  test("persisting the same runId as running twice starts one poll loop, not two", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const item = {
      id: "i1",
      service: "github",
      type: "pr",
      title: "Add thing",
      url: "https://github.com/acme/web/pull/1",
    };
    const runPolls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/v1/items/resolve")) {
        return jsonRes(200, { found: true, matchKind: "exact", item: { ...item, modified_at: 5 } });
      }
      if (u.includes("/v1/agents/runs/")) {
        runPolls.push(u);
        return jsonRes(200, { status: "running" });
      }
      return jsonRes(202, { runId: "run-42" });
    });

    vi.useFakeTimers();
    // CONCURRENT, not sequential: sequential calls would find the first run
    // already cached as `running` and short-circuit before invoking at all.
    const [a, b] = await Promise.all([
      harness.emitMessage({
        kind: "agent-run",
        lane: "impact",
        pageUrl: "https://github.com/acme/web/pull/1",
      }),
      harness.emitMessage({
        kind: "agent-run",
        lane: "impact",
        pageUrl: "https://github.com/acme/web/pull/1",
      }),
    ]);
    // Both really did invoke and persist — otherwise this test would be pinning
    // the cache short-circuit instead of the poll-loop guard.
    for (const res of [a, b]) {
      expect(res).toEqual({
        kind: "agent-state",
        lane: "impact",
        state: { kind: "running", runId: "run-42" },
      });
    }
    const invokes = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
      String(url).includes("/v1/agents/impact"),
    );
    expect(invokes).toHaveLength(2);

    // One loop polls once at the 500ms first step; two loops would poll twice.
    await vi.advanceTimersByTimeAsync(500);
    expect(runPolls).toHaveLength(1);
  });

  // The OTHER give-up path: a run that outlives its own TTL. `listRunning`
  // already filters out an ALREADY-expired run before ever polling it (see the
  // "stops polling... rather than polling forever" test above) — this test is
  // different: it reaches EXPIRY WHILE the in-worker backoff loop is actively
  // ticking, which is the branch inside tickAgentPoll itself, not listRunning's
  // filter. Needs real (fake-driven) elapsed time across two ticks, so this one
  // fakes setTimeout too, not just Date — advancing the fake clock is what
  // fake timers are for.
  test("a run that outlives its TTL while still 'running' gives up as stale, not silence", async () => {
    // load()'s own settle() relies on REAL setTimeout(0) ticks, so fake timers
    // (including setTimeout, unlike the Date-only tests above) go on AFTER
    // load() completes, never before.
    await load();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    harness.storage.set(CONNECTION_KEY, conn);
    const { putRun, getRun } = await import("../../src/background/agent-run-store.ts");
    // Expires 600ms out: past the first backoff step (500ms) but short of the
    // second (500 * 1.5 = 750ms), so the run is still "running" at t=0 (included
    // by listRunning) but has expired by the time the SECOND tick fires.
    await putRun(
      {
        subject: { kind: "item", id: "gh-1" },
        lane: "impact",
        runId: "r1",
        state: { kind: "running", runId: "r1" },
        expiresAtMs: NOW + 600,
      },
      NOW,
    );
    stubFetch(() => jsonRes(200, { status: "running" }));

    harness.emitAlarm(AGENT_POLL_ALARM);
    await vi.advanceTimersByTimeAsync(0); // the alarm's own immediate first tick
    expect((await getRun({ kind: "item", id: "gh-1" }, "impact", NOW))?.state).toEqual({
      kind: "running",
      runId: "r1",
    });
    await vi.advanceTimersByTimeAsync(750); // the scheduled second tick, past expiry

    expect((await getRun({ kind: "item", id: "gh-1" }, "impact", NOW))?.state).toEqual({
      kind: "failed",
      reason: "stale",
    });
  });

  // Same expiry boundary, but the last thing actually observed before giving up
  // was a transient gateway failure, not a `running` answer — the give-up must
  // report THAT reason, not invent `stale` for a condition that was never
  // ambiguous about what was wrong.
  test("a run that outlives its TTL after only ever seeing unreachable gives up as unreachable", async () => {
    await load();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    harness.storage.set(CONNECTION_KEY, conn);
    const { putRun, getRun } = await import("../../src/background/agent-run-store.ts");
    await putRun(
      {
        subject: { kind: "item", id: "gh-1" },
        lane: "impact",
        runId: "r1",
        state: { kind: "running", runId: "r1" },
        expiresAtMs: NOW + 600,
      },
      NOW,
    );
    // A doFetch rejection (not merely a non-2xx status) is what getAgentRun
    // maps to `unreachable` — see its own try/catch.
    stubFetch(() => {
      throw new Error("simulated network failure");
    });

    harness.emitAlarm(AGENT_POLL_ALARM);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(750);

    expect((await getRun({ kind: "item", id: "gh-1" }, "impact", NOW))?.state).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
  });

  // A poll already awaiting the gateway when the pairing changes underneath it
  // must not repopulate the store `clearRuns` just emptied — see
  // `pairingGeneration`'s own doc comment in service-worker.ts. The fetch below
  // is gated so the poll is provably still mid-flight (inside its
  // `getAgentRun` await) at the moment `unpair` runs.
  test("a poll whose generation is superseded mid-flight does not call putRun", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const { putRun, getRun } = await import("../../src/background/agent-run-store.ts");
    await putRun(
      {
        subject: { kind: "item", id: "gh-1" },
        lane: "impact",
        runId: "r1",
        state: { kind: "running", runId: "r1" },
        expiresAtMs: NOW + 60_000,
      },
      NOW,
    );

    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    globalThis.fetch = vi.fn(async () => {
      await gate;
      return jsonRes(200, { status: "done", brief: "from the gateway we already left" });
    });

    // The alarm's resumeAgentPolls captures the CURRENT generation and starts
    // polling; settle()'s real macrotask ticks carry it up to (and no further
    // than) the gated fetch call inside getAgentRun.
    await fireAlarm(AGENT_POLL_ALARM);

    // Change the pairing while the poll above is still awaiting the gateway.
    // handleUnpair awaits clearConnection then clearRuns (wrapped to bump the
    // generation) before responding, so by the time this resolves the
    // generation has already moved on and the store is already empty.
    await harness.emitMessage({ kind: "unpair" });
    expect(await getRun({ kind: "item", id: "gh-1" }, "impact", NOW)).toBeNull();

    // Let the gated fetch resolve and the poll's continuation run.
    releaseFetch?.();
    await settle();

    // Had the superseded poll written its result, this would be `done` with
    // the stale brief instead of staying absent.
    expect(await getRun({ kind: "item", id: "gh-1" }, "impact", NOW)).toBeNull();
  });
});

describe("ambient surfacing", () => {
  const PR_URL = "https://github.com/acme/web/pull/482";
  const OTHER_PR_URL = "https://github.com/acme/web/pull/517";

  /** A `found` resolve answer for the given page, same shape as the existing
   *  "resolve: a recognised page GETs…" test above. */
  function resolveFoundResponse(pageUrl: string): Response {
    return jsonRes(200, {
      found: true,
      matchKind: "exact",
      item: {
        id: pageUrl,
        service: "github",
        type: "pr",
        title: "Add thing",
        url: pageUrl,
        modified_at: 5,
      },
    });
  }

  /** Load the worker module fresh, registering its listeners against the
   *  already-installed harness. Unlike the file's own `load()`, this does not
   *  flush via a real setTimeout: fake timers are already active for this whole
   *  describe block (see beforeEach), and every listener this task cares about
   *  is registered synchronously at import time, before the fire-and-forget
   *  startup sequence even begins. */
  async function loadWorker(): Promise<void> {
    vi.resetModules();
    await import("../../src/background/service-worker.ts");
  }

  /** Advance past the 600ms debounce and let the resulting resolve settle. */
  async function settleAmbient(): Promise<void> {
    await vi.advanceTimersByTimeAsync(700);
  }

  beforeEach(() => {
    harness = installChromeMock();
    harness.storage.set(CONNECTION_KEY, conn);
    // Keep tabsGet truthful across navigations: decideAmbient re-reads the tab's
    // CURRENT url via tabUrl only after its resolve settles, and the overtaken-run
    // test needs that read to reflect whichever navigation happened most recently,
    // not a fixed fixture value.
    addNavigationListener((nav) => {
      harness.tabsGet.mockResolvedValue({ url: nav.url });
    });
    // The gateway stub for /v1/items/resolve: a `found` outcome for either PR,
    // gated through takeResolveGate so holdNextResolve can hold one call open.
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const gate = harness.takeResolveGate();
      if (gate !== undefined) {
        await gate;
      }
      const u = String(url);
      if (u.includes(encodeURIComponent(PR_URL))) {
        return resolveFoundResponse(PR_URL);
      }
      if (u.includes(encodeURIComponent(OTHER_PR_URL))) {
        return resolveFoundResponse(OTHER_PR_URL);
      }
      return jsonRes(404, {});
    });
    // Fake timers from the START of the test — the debounce's setTimeout is
    // scheduled synchronously inside emitTabUpdated, so the clock it runs on
    // must already be the fake one by the time that call happens.
    vi.useFakeTimers();
  });

  test("a navigation to a resolved page on an enabled host mounts the cue", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.grantedOrigins.add("https://github.com/*");
    await loadWorker();
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    const files = harness.executeScript.mock.calls.map((c) => (c[0] as { files?: string[] }).files);
    expect(files).toContainEqual(["cue.js"]);
  });

  test("a navigation on a host that is not switched on injects nothing", async () => {
    await loadWorker();
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    expect(harness.executeScript).not.toHaveBeenCalled();
  });

  // The preference alone is not enough: a grant withdrawn from
  // chrome://extensions never touches the "ambient-hosts" list, so a stored,
  // switched-on pattern that the browser no longer grants must produce no
  // cue. `harness.grantedOrigins` is deliberately left empty here — the
  // pattern is enabled in storage but not (or no longer) granted.
  test("a host enabled in storage but not granted by the browser injects nothing", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    await loadWorker();
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    expect(harness.executeScript).not.toHaveBeenCalled();
  });

  test("a host enabled in storage AND granted by the browser mounts the cue", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.grantedOrigins.add("https://github.com/*");
    await loadWorker();
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    const files = harness.executeScript.mock.calls.map((c) => (c[0] as { files?: string[] }).files);
    expect(files).toContainEqual(["cue.js"]);
  });

  test("the same item twice in one tab injects the cue once", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.grantedOrigins.add("https://github.com/*");
    await loadWorker();
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    harness.emitTabUpdated(7, { url: `${PR_URL}/files` }, { active: true });
    await settleAmbient();
    const cueInjections = harness.executeScript.mock.calls.filter(
      (c) => (c[0] as { files?: string[] }).files?.[0] === "cue.js",
    );
    expect(cueInjections).toHaveLength(1);
  });

  test("closing the tab forgets it, so returning to the same PR cues again", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.grantedOrigins.add("https://github.com/*");
    await loadWorker();
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    harness.emitTabRemoved(7);
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    const cueInjections = harness.executeScript.mock.calls.filter(
      (c) => (c[0] as { files?: string[] }).files?.[0] === "cue.js",
    );
    expect(cueInjections).toHaveLength(2);
  });

  test("a run overtaken by a newer navigation in the same tab drops its result", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.grantedOrigins.add("https://github.com/*");
    await loadWorker();
    // Hold the first resolve open past the second navigation, so the two runs
    // genuinely overlap rather than merely being scheduled apart.
    let release: (() => void) | undefined;
    harness.holdNextResolve(new Promise<void>((r) => (release = r)));
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    harness.emitTabUpdated(7, { url: OTHER_PR_URL }, { active: true });
    await settleAmbient();
    release?.();
    await settleAmbient();
    const cued = harness.executeScript.mock.calls.filter(
      (c) => (c[0] as { files?: string[] }).files?.[0] === "cue.js",
    );
    // Exactly one cue, and it is the newer page's.
    expect(cued).toHaveLength(1);
  });

  // The test above overlaps runs for two DIFFERENT items, so ambient.ts's own
  // post-resolve recheck (comparing `currentUrl` against the recognition it
  // resolved) already kills the stale run on its own — that test would still
  // pass with the generation check deleted. Pin the generation check itself by
  // overlapping two navigations to the SAME item (a PR's Conversation tab, then
  // its Files tab): the post-resolve recheck PASSES for the stale run (same
  // product/kind/ref), and the already-cued gate can't save it either, because
  // it reads `lastCued` before the resolve — before the second nav's run has had
  // a chance to record anything there. Only the generation check stops the stale
  // run from calling showCue a second time.
  test("a run overtaken by a navigation to the SAME item also drops its result", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.grantedOrigins.add("https://github.com/*");
    await loadWorker();
    let release: (() => void) | undefined;
    harness.holdNextResolve(new Promise<void>((r) => (release = r)));
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    harness.emitTabUpdated(7, { url: `${PR_URL}/files` }, { active: true });
    await settleAmbient();
    release?.();
    await settleAmbient();
    const cued = harness.executeScript.mock.calls.filter(
      (c) => (c[0] as { files?: string[] }).files?.[0] === "cue.js",
    );
    expect(cued).toHaveLength(1);
  });

  // If a tab closes while the winning run is still inside `showCue`'s await, the
  // close handler clears `ambientGeneration`/`lastCuedByTab` for that tab BEFORE
  // the pending run resumes and writes its own `lastCuedByTab` entry — a stale
  // write for a tab nothing is tracking any more. Reusing the same tab id for a
  // fresh navigation to the SAME PR is the observable proxy: a leaked entry would
  // wrongly read as "already cued" and suppress the second cue.
  test("a tab closed while showCue is in flight leaves no stale dedupe entry", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.grantedOrigins.add("https://github.com/*");
    await loadWorker();
    let releaseInject: (() => void) | undefined;
    harness.executeScript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseInject = () => resolve([{ result: undefined }]);
        }),
    );
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    // decideAmbient has resolved "show"; showCue's cue.js inject is now pending.
    harness.emitTabRemoved(7);
    releaseInject?.();
    await settleAmbient();
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    const cued = harness.executeScript.mock.calls.filter(
      (c) => (c[0] as { files?: string[] }).files?.[0] === "cue.js",
    );
    expect(cued).toHaveLength(2);
  });

  // The tab-close test above proves the guard skips the write for a DEAD tab.
  // This is the other half: a run whose tab is still open, but whose generation
  // was superseded by a newer navigation while showCue was still in flight, must
  // still WRITE its dedupe entry — the cue it mounted is a true fact regardless
  // of what navigated next, and it can never wrongly suppress a cue for a
  // DIFFERENT item (the dedupe check compares with sameItem). The superseding
  // navigation here is INACTIVE, so it bumps the generation without itself
  // reaching a resolve/showCue — isolating the guard's effect on the first run's
  // own write.
  test("a same-item navigation superseding an in-flight showCue does not block that run's dedupe write", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.grantedOrigins.add("https://github.com/*");
    await loadWorker();
    let releaseInject: (() => void) | undefined;
    harness.executeScript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseInject = () => resolve([{ result: undefined }]);
        }),
    );
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    // Supersedes the generation without producing a cue of its own (inactive tab
    // — decideAmbient's cheapest gate returns before any resolve).
    harness.emitTabUpdated(7, { url: `${PR_URL}/files` }, { active: false });
    await settleAmbient();
    releaseInject?.();
    await settleAmbient();
    // The tab is still open, so the first run's write went through despite being
    // superseded. A third navigation to the same item must find it already-cued.
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    const cued = harness.executeScript.mock.calls.filter(
      (c) => (c[0] as { files?: string[] }).files?.[0] === "cue.js",
    );
    expect(cued).toHaveLength(1);
  });

  test("an injection failure on a restricted page is swallowed, not thrown", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.grantedOrigins.add("https://github.com/*");
    harness.executeScript.mockRejectedValue(new Error("Cannot access contents of the page"));
    await loadWorker();
    expect(() => {
      harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    }).not.toThrow();
    await settleAmbient();
  });

  test("cue-open injects the panel into the sender's own tab", async () => {
    await loadWorker();
    await harness.emitMessageFromTab({ kind: "cue-open" }, 7);
    expect(harness.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["panel.js"],
    });
  });

  test("cue-open from a sender with no tab injects nothing", async () => {
    await loadWorker();
    // A message with no `sender.tab` — what the popup or the options page sends.
    // Only a real tab can be acted on, and the tab id comes from the browser's
    // sender rather than the message, so there is nothing here to fall back to.
    await harness.emitMessage({ kind: "cue-open" });
    expect(harness.executeScript).not.toHaveBeenCalled();
  });
});

describe("a rejected token is remembered", () => {
  test("a 401 from the gateway sets stale on the stored connection", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(401, { error: "unauthorized" }));

    const res = await harness.emitMessage({ kind: "clip", capture, tags: [] });
    await settle();

    expect(res).toMatchObject({ kind: "clip", ok: false, reason: "unauthorized" });
    expect((harness.storage.get(CONNECTION_KEY) as Connection).stale).toBe(true);
  });

  test("a successful clip records the time and leaves stale false", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, { ...conn, stale: true });
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { id: "1", status: "created" }));

    await harness.emitMessage({ kind: "clip", capture, tags: [] });
    await settle();

    const stored = harness.storage.get(CONNECTION_KEY) as Connection;
    expect(stored.stale).toBe(false);
    expect(typeof stored.lastClipAt).toBe("number");
  });

  test("an unreachable gateway is NOT a rejected token", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await harness.emitMessage({ kind: "clip", capture, tags: [] });
    await settle();

    expect((harness.storage.get(CONNECTION_KEY) as Connection).stale).toBeUndefined();
  });

  // Regression for the queue drain being one of the four clip paths that used to
  // bypass `stale` entirely — postClipPaced is the seam shared by clipDeps AND
  // flushDeps, so a 401 discovered by the background drain must set it too.
  test("a 401 discovered by the queue drain (background alarm) sets stale", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.storage.set(QUEUE_KEY, [queued("https://ex.com/a")]);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(401, { error: "unauthorized" }));

    harness.emitAlarm(FLUSH_ALARM);
    await settle();

    expect((harness.storage.get(CONNECTION_KEY) as Connection).stale).toBe(true);
    // The entry stays queued — a dead token is not something a retry can fix.
    expect(harness.storage.get(QUEUE_KEY)).toHaveLength(1);
  });
});

describe("discover route", () => {
  test("responds with the first origin that answers", async () => {
    await load();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonRes(200, { status: "ok", gateway: "read_only_http" }));

    const res = await harness.emitMessage({ kind: "discover" });

    expect(res).toEqual({ kind: "discover", origin: "http://127.0.0.1:7474" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7474/v1/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("nothing listening responds with null, not an error", async () => {
    await load();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await harness.emitMessage({ kind: "discover" });

    expect(res).toEqual({ kind: "discover", origin: null });
  });

  test("discovery needs no pairing — it is the step before pairing", async () => {
    await load();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonRes(200, { status: "ok", gateway: "read_only_http" }));

    const res = await harness.emitMessage({ kind: "discover" });

    expect(res).toEqual({ kind: "discover", origin: "http://127.0.0.1:7474" });
    // No Authorization header on the only tokenless route in the client.
    const init = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1];
    expect(JSON.stringify(init)).not.toContain("Authorization");
  });
});

describe("show-related context menu", () => {
  test("clicking it injects the panel into the RIGHT-CLICKED tab", async () => {
    await load();
    harness.executeScript.mockClear();
    harness.emitMenuClick("show-related", 42);
    await settle();
    expect(harness.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 42 }, files: ["panel.js"] }),
    );
  });

  test("an unknown menu id does nothing at all — it does not fall through to a clip", async () => {
    await load();
    harness.executeScript.mockClear();
    harness.emitMenuClick("not-ours", 42);
    await settle();
    expect(harness.executeScript).not.toHaveBeenCalled();
  });

  test("the menu registers all three entries", async () => {
    await load();
    const ids = harness.contextMenusCreate.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(["clip-page", "clip-selection", "show-related"]);
  });
});
