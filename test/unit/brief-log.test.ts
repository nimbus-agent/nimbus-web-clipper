import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLogEntry,
  clearLog,
  readLog,
  updateLogEntry,
} from "../../src/background/brief-log-store.ts";
import {
  type BriefLogEntry,
  evictLog,
  isBriefLogEntry,
  MAX_LOG_ENTRIES,
} from "../../src/shared/brief-log.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

function entry(over: Partial<BriefLogEntry> = {}): BriefLogEntry {
  return { runId: "r1", at: 1000, question: "q", sourceCount: 2, truncatedCount: 0, ...over };
}

describe("isBriefLogEntry", () => {
  it("accepts a minimal entry", () => {
    expect(isBriefLogEntry(entry())).toBe(true);
  });

  it("accepts a completed remote entry", () => {
    expect(isBriefLogEntry(entry({ model: "gpt", remote: true, savedItemId: "i1" }))).toBe(true);
  });

  it("rejects a missing sourceCount", () => {
    const { sourceCount: _drop, ...rest } = entry();
    expect(isBriefLogEntry(rest)).toBe(false);
  });

  it("rejects a non-boolean remote", () => {
    expect(isBriefLogEntry(entry({ remote: "yes" } as never))).toBe(false);
  });

  it("accepts an entry recording that the index was consulted", () => {
    expect(isBriefLogEntry(entry({ usedIndex: true }))).toBe(true);
  });

  it("still accepts an entry written before this field existed", () => {
    // Old entries are the ONLY evidence their egress happened. They must not
    // become unreadable because a later build added a field.
    expect(isBriefLogEntry(entry())).toBe(true);
  });

  it("rejects a non-boolean usedIndex", () => {
    expect(isBriefLogEntry(entry({ usedIndex: "yes" } as never))).toBe(false);
  });
});

describe("evictLog", () => {
  it("keeps everything under the cap", () => {
    const entries = [entry({ runId: "a" }), entry({ runId: "b" })];
    expect(evictLog(entries, 5)).toHaveLength(2);
  });

  it("EVICTS SAVED RUNS FIRST — the unsaved entry is the only record that exists", () => {
    // A saved run's disclosure is durable upstream: brief-save.ts persists
    // `synthesis` as its own metadata field on the research_brief item. An
    // unsaved run's log entry is the only record anywhere that the egress
    // happened, so it outlives the saved one.
    const entries = [
      entry({ runId: "saved-old", at: 1, savedItemId: "i1" }),
      entry({ runId: "unsaved-old", at: 2 }),
      entry({ runId: "unsaved-new", at: 3 }),
    ];
    const kept = evictLog(entries, 2).map((e) => e.runId);
    expect(kept).not.toContain("saved-old");
    expect(kept).toContain("unsaved-old");
    expect(kept).toContain("unsaved-new");
  });

  it("falls back to oldest-first once only unsaved entries remain", () => {
    const entries = [entry({ runId: "a", at: 1 }), entry({ runId: "b", at: 2 })];
    expect(evictLog(entries, 1).map((e) => e.runId)).toEqual(["b"]);
  });

  it("keeps the newest entry even at a cap of one", () => {
    const entries = [entry({ runId: "a", at: 1 }), entry({ runId: "b", at: 9 })];
    expect(evictLog(entries, 1)).toEqual([entry({ runId: "b", at: 9 })]);
  });

  it("preserves input order in what it keeps", () => {
    const entries = [entry({ runId: "a", at: 3 }), entry({ runId: "b", at: 1 })];
    expect(evictLog(entries, 2).map((e) => e.runId)).toEqual(["a", "b"]);
  });
});

describe("brief-log-store", () => {
  let harness: ChromeHarness;

  beforeEach(() => {
    harness = installChromeMock();
  });

  afterEach(() => {
    harness.restore();
  });

  it("appends and reads back, newest last", async () => {
    await appendLogEntry(entry({ runId: "a", at: 1 }));
    await appendLogEntry(entry({ runId: "b", at: 2 }));
    expect((await readLog()).map((e) => e.runId)).toEqual(["a", "b"]);
  });

  it("patches an entry in place, so the model lands on the run that caused it", async () => {
    await appendLogEntry(entry({ runId: "a" }));
    await updateLogEntry("a", { model: "llama3", remote: false });
    const [got] = await readLog();
    expect(got?.model).toBe("llama3");
    expect(got?.remote).toBe(false);
  });

  it("ignores a patch for an unknown runId rather than inventing a row", async () => {
    await appendLogEntry(entry({ runId: "a" }));
    await updateLogEntry("zzz", { model: "m" });
    expect(await readLog()).toHaveLength(1);
  });

  it("never stores a source body", async () => {
    await appendLogEntry(entry({ question: "q".repeat(500) }));
    const raw = JSON.stringify([...harness.storage.entries()]);
    expect(raw.toLowerCase().includes('"body"')).toBe(false);
  });

  it("discards a malformed stored entry rather than throwing", async () => {
    harness.storage.set("briefLog", [{ runId: "r1" }, entry({ runId: "good" })]);
    expect((await readLog()).map((e) => e.runId)).toEqual(["good"]);
  });

  it("enforces the cap on write", async () => {
    for (let i = 0; i < MAX_LOG_ENTRIES + 5; i++) {
      await appendLogEntry(entry({ runId: `r${i}`, at: i }));
    }
    expect(await readLog()).toHaveLength(MAX_LOG_ENTRIES);
  });

  it("clearLog empties it", async () => {
    await appendLogEntry(entry());
    await clearLog();
    expect(await readLog()).toEqual([]);
  });
});
