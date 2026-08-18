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
});
