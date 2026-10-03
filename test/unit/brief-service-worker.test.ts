// Drives the brief half of src/background/service-worker.ts: the single router
// branch, the eviction-net alarm, and the unpair path.
//
// Entry-point ordering matters here — installChromeMock() -> seed storage ->
// vi.resetModules() -> await import() -> settle. Seeding after the import means
// the startup sequence never saw it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function storedRun(id: string, kind: string, now: number): Record<string, unknown> {
  return {
    id,
    question: "q",
    declared: [],
    phase: kind === "done" ? { kind, report: REPORT } : { kind },
    expiresAtMs: now + 60_000,
    writtenAtMs: now,
  };
}

const REPORT = {
  summary: "s",
  findings: [],
  conflicts: [],
  gaps: [],
  synthesis: { model: "m", remote: false },
};

describe("service worker brief routing", () => {
  let harness: ChromeHarness;

  beforeEach(() => {
    harness = installChromeMock();
    vi.resetModules();
  });

  afterEach(() => {
    harness.restore();
  });

  it("routes brief-tabs and answers with named tabs plus a hidden count", async () => {
    harness.tabsQuery.mockResolvedValue([
      { id: 1, url: "https://example.com/a", title: "A" },
      { id: 2 },
    ]);
    await import("../../src/background/service-worker.ts");
    await settle();
    const res = (await harness.emitMessage({ kind: "brief-tabs" })) as {
      named: unknown[];
      hiddenCount: number;
    };
    expect(res.named).toHaveLength(1);
    expect(res.hiddenCount).toBe(1);
  });

  it("refuses a brief-start whose tabIds fail the guard, without calling the gateway", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await import("../../src/background/service-worker.ts");
    await settle();
    const res = await harness.emitMessage({ kind: "brief-start", question: "q", tabIds: ["1"] });
    expect(res).toMatchObject({ kind: "failed", reason: "invalid_request" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a brief-save with no id rather than throwing", async () => {
    await import("../../src/background/service-worker.ts");
    await settle();
    expect(await harness.emitMessage({ kind: "brief-save" })).toMatchObject({
      kind: "failed",
      reason: "invalid_request",
    });
  });

  it("answers an unknown brief-* kind instead of falling through to another route", async () => {
    await import("../../src/background/service-worker.ts");
    await settle();
    expect(await harness.emitMessage({ kind: "brief-nonsense" })).toMatchObject({
      reason: "unknown_brief_message",
    });
  });

  it("does NOT disarm the eviction net while another brief is still running", async () => {
    // Two briefs can overlap — the gateway allows three concurrent runs. Clearing
    // the alarm when the first reaches a terminal state would orphan the second.
    const now = Date.now();
    harness.storage.set("briefRuns", {
      a: storedRun("a", "done", now),
      b: storedRun("b", "running", now),
    });
    await import("../../src/background/service-worker.ts");
    await settle();
    harness.alarmsClear.mockClear();
    harness.emitAlarm("nimbus-brief-poll");
    await settle();
    expect(harness.alarmsClear).not.toHaveBeenCalledWith("nimbus-brief-poll");
  });

  it("disarms the net once nothing is running", async () => {
    const now = Date.now();
    harness.storage.set("briefRuns", { a: storedRun("a", "done", now) });
    await import("../../src/background/service-worker.ts");
    await settle();
    harness.alarmsClear.mockClear();
    harness.emitAlarm("nimbus-brief-poll");
    await settle();
    expect(harness.alarmsClear).toHaveBeenCalledWith("nimbus-brief-poll");
  });

  it("clears stored briefs on unpair, so a report cannot outlive its gateway", async () => {
    harness.storage.set("briefRuns", { b1: storedRun("b1", "running", Date.now()) });
    await import("../../src/background/service-worker.ts");
    await settle();
    await harness.emitMessage({ kind: "unpair" });
    await settle();
    expect(harness.storage.get("briefRuns")).toEqual({});
  });

  it("KEEPS the disclosure log across unpair — a past egress did not un-happen", async () => {
    harness.storage.set("briefLog", [
      { runId: "r1", at: 1, question: "q", sourceCount: 1, truncatedCount: 0 },
    ]);
    await import("../../src/background/service-worker.ts");
    await settle();
    await harness.emitMessage({ kind: "unpair" });
    await settle();
    expect(harness.storage.get("briefLog")).toHaveLength(1);
  });

  it("routes a passage-drop naming one passage and leaves the rest of the page", async () => {
    harness.storage.set("passages", [
      { url: "http://h/a", title: "A", text: "one", at: 100 },
      { url: "http://h/a#x", title: "A", text: "two", at: 200 },
    ]);
    await import("../../src/background/service-worker.ts");
    await settle();
    expect(await harness.emitMessage({ kind: "passage-drop", url: "http://h/a", at: 100 })).toEqual(
      { ok: true },
    );
    await settle();
    expect(harness.storage.get("passages")).toEqual([
      { url: "http://h/a#x", title: "A", text: "two", at: 200 },
    ]);
  });

  it("routes a passage-drop with no `at` as the whole page, fragments included", async () => {
    harness.storage.set("passages", [
      { url: "http://h/a", title: "A", text: "one", at: 100 },
      { url: "http://h/a#x", title: "A", text: "two", at: 200 },
      { url: "http://h/b", title: "B", text: "three", at: 300 },
    ]);
    await import("../../src/background/service-worker.ts");
    await settle();
    await harness.emitMessage({ kind: "passage-drop", url: "http://h/a" });
    await settle();
    expect(harness.storage.get("passages")).toEqual([
      { url: "http://h/b", title: "B", text: "three", at: 300 },
    ]);
  });

  it("routes a passage-clear to an empty collection", async () => {
    harness.storage.set("passages", [{ url: "http://h/a", title: "A", text: "one", at: 100 }]);
    await import("../../src/background/service-worker.ts");
    await settle();
    expect(await harness.emitMessage({ kind: "passage-clear" })).toEqual({ ok: true });
    await settle();
    expect(harness.storage.get("passages")).toEqual([]);
  });

  it("refuses a passage-drop whose url fails the guard, and writes nothing", async () => {
    harness.storage.set("passages", [{ url: "http://h/a", title: "A", text: "one", at: 100 }]);
    await import("../../src/background/service-worker.ts");
    await settle();
    expect(await harness.emitMessage({ kind: "passage-drop", url: "javascript:alert(1)" })).toEqual(
      { ok: false },
    );
    await settle();
    expect(harness.storage.get("passages")).toHaveLength(1);
  });

  it("serves the log and clears it only on request", async () => {
    harness.storage.set("briefLog", [
      { runId: "r1", at: 1, question: "q", sourceCount: 1, truncatedCount: 0 },
    ]);
    await import("../../src/background/service-worker.ts");
    await settle();
    expect(await harness.emitMessage({ kind: "brief-log" })).toMatchObject({
      entries: [{ runId: "r1" }],
    });
    await harness.emitMessage({ kind: "brief-log-clear" });
    await settle();
    expect(await harness.emitMessage({ kind: "brief-log" })).toMatchObject({ entries: [] });
  });

  it("answers brief-state with the stored run for an id, and null without one", async () => {
    const now = Date.now();
    harness.storage.set("briefRuns", { b1: storedRun("b1", "running", now) });
    await import("../../src/background/service-worker.ts");
    await settle();
    expect(await harness.emitMessage({ kind: "brief-state", id: "b1" })).toEqual({
      run: {
        id: "b1",
        question: "q",
        declared: [],
        phase: { kind: "running" },
        expiresAtMs: now + 60_000,
      },
    });
    expect(await harness.emitMessage({ kind: "brief-state" })).toEqual({ run: null });
    expect(await harness.emitMessage({ kind: "brief-state", id: "gone" })).toEqual({ run: null });
  });

  it("answers failed/server_error when a brief route's storage read fails", async () => {
    await import("../../src/background/service-worker.ts");
    await settle();
    harness.storageGet.mockRejectedValueOnce(new Error("storage unavailable"));
    expect(await harness.emitMessage({ kind: "brief-log" })).toEqual({
      kind: "failed",
      reason: "server_error",
    });
  });
});

// The worker's OWN poll loop for a brief run: armed when a run goes `running`,
// driven by `setTimeout` (the alarm is only the eviction net), and bound to the
// pairing it started under. Fake timers go on AFTER the import has settled —
// the startup sequence relies on real ticks.
describe("service worker brief poll loop", () => {
  const ORIGIN = "http://127.0.0.1:8765";
  const BRIEF_POLL_ALARM = "nimbus-brief-poll";
  const PAGE = "https://example.com/a";
  const START = {
    kind: "brief-start",
    question: "What changed?",
    picks: [{ kind: "passages", url: PAGE }],
    useIndex: false,
  };
  const originalFetch = globalThis.fetch;
  let harness: ChromeHarness;

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * The five brief routes, answered in order. Each GET of the run consumes the
   * next entry of `polls` (the last repeats); `gate`, when given, holds the GET
   * at that index until released.
   */
  function stubGateway(polls: readonly unknown[], gate?: { at: number; until: Promise<void> }) {
    let pollIndex = 0;
    const gets: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "POST" && u === `${ORIGIN}/v1/briefs`) {
        return json(200, { id: "b1", expected: 1 });
      }
      if (u === `${ORIGIN}/v1/briefs/b1/sources`) {
        return json(200, { received: 1, expected: 1 });
      }
      if (u === `${ORIGIN}/v1/briefs/b1/run`) {
        return json(200, {});
      }
      if (u === `${ORIGIN}/v1/briefs/b1/save`) {
        return json(200, { itemId: "brief-item-1" });
      }
      if (method === "GET" && u === `${ORIGIN}/v1/briefs/b1`) {
        const index = pollIndex;
        pollIndex += 1;
        gets.push(u);
        if (gate !== undefined && gate.at === index) {
          await gate.until;
        }
        return json(200, polls[Math.min(index, polls.length - 1)]);
      }
      return json(404, {});
    }) as unknown as typeof fetch;
    return gets;
  }

  /** Every `brief-state` the worker broadcast, in order. */
  function broadcasts(): Array<{ kind: string }> {
    return harness.sendMessage.mock.calls
      .map((c) => c[0] as { kind?: string; state?: { kind: string } })
      .filter((m) => m.kind === "brief-state" && m.state !== undefined)
      .map((m) => m.state as { kind: string });
  }

  async function bootPaired(): Promise<void> {
    harness.storage.set("connection", {
      origin: ORIGIN,
      token: "tok",
      label: "chrome",
      pairedAt: 1,
    });
    harness.storage.set("passages", [{ url: PAGE, title: "A", text: "collected words", at: 100 }]);
    await import("../../src/background/service-worker.ts");
    await settle();
    vi.useFakeTimers();
  }

  beforeEach(() => {
    harness = installChromeMock();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    harness.restore();
  });

  it("polls a running brief to done on its own loop, arming then disarming the net", async () => {
    const gets = stubGateway([
      { status: "running" },
      { status: "running" },
      { status: "done", report: REPORT },
    ]);
    await bootPaired();

    expect(await harness.emitMessage(START)).toEqual({ kind: "running", id: "b1" });
    // The run went `running`, so the eviction net is armed, and the passages it
    // sent were forgotten at the moment they left.
    expect(harness.alarmsCreate).toHaveBeenCalledWith(BRIEF_POLL_ALARM, { periodInMinutes: 1 });
    expect(harness.storage.get("passages")).toEqual([]);
    expect(gets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500); // first in-worker tick: still running
    expect(gets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000); // doubled backoff: done
    expect(gets).toHaveLength(3);

    expect(broadcasts().at(-1)).toEqual({
      kind: "done",
      id: "b1",
      report: REPORT,
      skipped: [],
      truncated: [],
    });
    const stored = harness.storage.get("briefRuns") as Record<string, { phase: unknown }>;
    expect(stored["b1"]?.phase).toEqual({ kind: "done", report: REPORT });
    expect(harness.alarmsClear).toHaveBeenCalledWith(BRIEF_POLL_ALARM);

    // Settled: nothing is left polling.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gets).toHaveLength(3);
  });

  // A tick scheduled under one pairing that fires after the user has unpaired
  // AND paired again must not act on the new pairing's state — here a run that
  // happens to carry the same id. Without the check at the top of the tick it
  // would poll the new gateway and broadcast its answer as if it were its own.
  it("a scheduled tick that outlived its pairing polls and broadcasts nothing", async () => {
    const gets = stubGateway([{ status: "running" }]);
    await bootPaired();
    await harness.emitMessage(START);
    await harness.emitMessage({ kind: "unpair" });
    harness.storage.set("connection", {
      origin: ORIGIN,
      token: "tok2",
      label: "chrome",
      pairedAt: 2,
    });
    harness.storage.set("briefRuns", { b1: storedRun("b1", "running", Date.now()) });
    harness.sendMessage.mockClear();

    await vi.advanceTimersByTimeAsync(500);

    expect(gets).toHaveLength(1);
    expect(broadcasts()).toEqual([]);
  });

  // The pairing changes while the tick's own poll is in flight. The answer that
  // comes back belongs to a gateway the browser has left: the loop stops without
  // its own terminal broadcast, and does not touch the eviction net.
  it("a pairing change during a poll suppresses the tick's terminal broadcast", async () => {
    let release: (() => void) | undefined;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gets = stubGateway([{ status: "running" }, { status: "done", report: REPORT }], {
      at: 1,
      until,
    });
    await bootPaired();
    await harness.emitMessage(START);

    await vi.advanceTimersByTimeAsync(500); // the tick is now parked on the gated GET
    expect(gets).toHaveLength(2);
    await harness.emitMessage({ kind: "unpair" });
    harness.sendMessage.mockClear();
    harness.alarmsClear.mockClear();

    release?.();
    await vi.advanceTimersByTimeAsync(0);

    // settleRun's own `done` reaches the page once; the tick adds no second one.
    expect(broadcasts().filter((s) => s.kind === "done")).toHaveLength(1);
    expect(harness.alarmsClear).not.toHaveBeenCalledWith(BRIEF_POLL_ALARM);
  });

  // A tick that REJECTS must give up its slot, or the eviction net's resume
  // would skip the run forever as "already being polled".
  it("a scheduled tick that rejects frees the run for the alarm to resume", async () => {
    const gets = stubGateway([{ status: "running" }, { status: "done", report: REPORT }]);
    await bootPaired();
    await harness.emitMessage(START);

    harness.storageGet.mockRejectedValueOnce(new Error("storage unavailable"));
    await vi.advanceTimersByTimeAsync(500); // the tick's connection read fails
    expect(gets).toHaveLength(1);

    harness.emitAlarm(BRIEF_POLL_ALARM);
    await vi.advanceTimersByTimeAsync(0);
    expect(gets).toHaveLength(2);
    expect(broadcasts().at(-1)).toMatchObject({ kind: "done", id: "b1" });
  });

  // A TAB pick is captured by the worker itself — the whole page, in that tab,
  // pinned to the url the tab list named — and its text is what gets fed.
  it("captures a picked tab as an article and feeds its text", async () => {
    stubGateway([{ status: "done", report: REPORT }]);
    harness.tabsQuery.mockResolvedValue([{ id: 4, url: PAGE, title: "A" }]);
    harness.tabsGet.mockResolvedValue({ url: PAGE });
    harness.executeScript.mockResolvedValueOnce([{ result: undefined }]).mockResolvedValueOnce([
      {
        result: {
          url: PAGE,
          title: "A",
          mode: "article",
          body: "the tab body",
          readableFound: true,
        },
      },
    ]);
    await bootPaired();

    const res = await harness.emitMessage({ ...START, picks: [{ kind: "tab", id: 4 }] });

    expect(res).toMatchObject({ kind: "done", id: "b1" });
    expect(harness.executeScript).toHaveBeenCalledWith({
      target: { tabId: 4 },
      files: ["capture.js"],
    });
    expect(harness.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 4 }, args: ["article"] }),
    );
    const feed = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => String(c[0]) === `${ORIGIN}/v1/briefs/b1/sources`,
    ) as [string, RequestInit] | undefined;
    expect(String(feed?.[1].body)).toContain("the tab body");
  });

  it("routes brief-save with an id to the gateway and answers the saved run", async () => {
    stubGateway([{ status: "done", report: REPORT }]);
    await bootPaired();
    expect(await harness.emitMessage(START)).toMatchObject({ kind: "done", id: "b1" });

    const res = await harness.emitMessage({ kind: "brief-save", id: "b1" });

    expect(res).toMatchObject({ kind: "done", id: "b1", savedItemId: "brief-item-1" });
  });

  it("a resumed tick that rejects frees the run too, and keeps the net armed", async () => {
    const gets = stubGateway([{ status: "done", report: REPORT }]);
    harness.storage.set("briefRuns", { b1: storedRun("b1", "running", Date.now()) });
    await bootPaired();
    let failedOnce = false;
    harness.storageGet.mockImplementation(async (key: string) => {
      if (key === "connection" && !failedOnce) {
        failedOnce = true;
        throw new Error("storage unavailable");
      }
      return { [key]: harness.storage.get(key) };
    });
    harness.alarmsClear.mockClear();

    harness.emitAlarm(BRIEF_POLL_ALARM);
    await vi.advanceTimersByTimeAsync(0);
    expect(failedOnce).toBe(true);
    expect(gets).toHaveLength(0);
    expect(harness.alarmsClear).not.toHaveBeenCalledWith(BRIEF_POLL_ALARM);

    harness.emitAlarm(BRIEF_POLL_ALARM);
    await vi.advanceTimersByTimeAsync(0);
    expect(gets).toHaveLength(1);
    expect(harness.alarmsClear).toHaveBeenCalledWith(BRIEF_POLL_ALARM);
  });
});
