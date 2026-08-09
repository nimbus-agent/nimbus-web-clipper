// test/unit/service-worker.test.ts
//
// Drives src/background/service-worker.ts — the message router + alarm/command
// listeners + startup sequence — end to end through the fake `chrome` surface.
// Importing the module registers its listeners against `globalThis.chrome`, so
// each test installs a FRESH chrome mock and resets the module cache *before*
// importing, then drives the freshly-registered listeners via the harness.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { QueuedClip } from "../../src/shared/queue.ts";
import type { CaptureResult, Connection } from "../../src/shared/types.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

// Real storage keys (see connection-store.ts / clip-queue-store.ts) and the
// alarm name (a local const in service-worker.ts, not exported).
const FLUSH_ALARM = "flush-clip-queue";
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
      item: null,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("resolve: a recognised page posts the canonical URL and returns the item", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    const item = {
      id: "i1",
      service: "github",
      type: "pr",
      title: "Add thing",
      canonicalUrl: "https://github.com/acme/web/pull/1",
      url: "https://github.com/acme/web/pull/1",
    };
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { item }));

    const res = await harness.emitMessage({
      kind: "resolve",
      pageUrl: "https://github.com/acme/web/pull/1/files",
    });

    expect(res).toMatchObject({ kind: "resolve", ok: true, item });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:8765/v1/items/resolve");
    expect(JSON.parse(String(init.body))).toEqual({
      canonicalUrl: "https://github.com/acme/web/pull/1",
    });
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

    const res = await harness.emitMessage({ kind: "connection-status" });

    expect(res).toEqual({
      kind: "connection",
      paired: true,
      label: conn.label,
      origin: conn.origin,
      pairedAt: conn.pairedAt,
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

  test("registers the two context menus on startup (removeAll before create)", async () => {
    await load();

    expect(harness.contextMenusRemoveAll).toHaveBeenCalled();
    expect(harness.contextMenusCreate).toHaveBeenCalledTimes(2);
    const ids = harness.contextMenusCreate.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(["clip-page", "clip-selection"]);
  });

  test("onInstalled re-registers the menus (removeAll first, no duplicate ids)", async () => {
    await load();
    harness.contextMenusCreate.mockClear();
    harness.contextMenusRemoveAll.mockClear();

    harness.emitInstalled();
    await settle();

    expect(harness.contextMenusRemoveAll).toHaveBeenCalled();
    expect(harness.contextMenusCreate).toHaveBeenCalledTimes(2);
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
    vi.useRealTimers();
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
    vi.useRealTimers();
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
