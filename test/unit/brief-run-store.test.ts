import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BRIEF_RUN_TTL_MS,
  clearBriefRuns,
  getBriefRun,
  listBriefRuns,
  MAX_STORED_BRIEFS,
  putBriefRun,
  type StoredBrief,
} from "../../src/background/brief-run-store.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

const NOW = 1_800_000_000_000;

function run(over: Partial<StoredBrief> = {}): StoredBrief {
  return {
    id: "b1",
    question: "Where do these contradict each other?",
    declared: [{ url: "https://example.com/a", title: "A" }],
    phase: { kind: "feeding", received: 0, expected: 1 },
    expiresAtMs: NOW + BRIEF_RUN_TTL_MS,
    ...over,
  };
}

const report = {
  summary: "s",
  findings: [],
  conflicts: [],
  gaps: [],
  synthesis: { model: "m", remote: true, disclosure: "d" },
} as const;

describe("brief-run-store", () => {
  let harness: ChromeHarness;

  beforeEach(() => {
    harness = installChromeMock();
  });

  afterEach(() => {
    harness.restore();
  });

  it("round-trips a run", async () => {
    await putBriefRun(run(), NOW);
    expect(await getBriefRun("b1", NOW)).toEqual(run());
  });

  it("hides an expired run", async () => {
    await putBriefRun(run({ expiresAtMs: NOW - 1 }), NOW);
    expect(await getBriefRun("b1", NOW)).toBeNull();
  });

  it("keeps a done report so reopening the page replays instead of re-running", async () => {
    await putBriefRun(run({ phase: { kind: "done", report } }), NOW);
    const got = await getBriefRun("b1", NOW);
    expect(got?.phase).toEqual({ kind: "done", report });
  });

  it("NEVER stores source text — only declared url and title", async () => {
    await putBriefRun(run(), NOW);
    const raw = JSON.stringify([...harness.storage.entries()]);
    expect(raw.includes("https://example.com/a")).toBe(true);
    expect(raw.toLowerCase().includes('"body"')).toBe(false);
  });

  it("discards a stored entry that fails the guard rather than throwing", async () => {
    harness.storage.set("briefRuns", { b1: { id: "b1", phase: "nonsense" } });
    expect(await getBriefRun("b1", NOW)).toBeNull();
    expect(await listBriefRuns(NOW)).toEqual([]);
  });

  it("discards a done entry whose report fails the report guard", async () => {
    harness.storage.set("briefRuns", {
      b1: {
        id: "b1",
        question: "q",
        declared: [],
        phase: { kind: "done", report: { summary: 1 } },
        expiresAtMs: NOW + 1000,
        writtenAtMs: NOW,
      },
    });
    expect(await getBriefRun("b1", NOW)).toBeNull();
  });

  it("serialises concurrent writes instead of clobbering", async () => {
    await Promise.all([
      putBriefRun(run({ id: "a" }), NOW),
      putBriefRun(run({ id: "b" }), NOW),
      putBriefRun(run({ id: "c" }), NOW),
    ]);
    const ids = (await listBriefRuns(NOW)).map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("enforces the cap on write, evicting the oldest", async () => {
    for (let i = 0; i < MAX_STORED_BRIEFS + 3; i++) {
      await putBriefRun(run({ id: `r${i}` }), NOW + i);
    }
    const kept = await listBriefRuns(NOW + 1000);
    expect(kept).toHaveLength(MAX_STORED_BRIEFS);
    expect(kept.map((r) => r.id)).not.toContain("r0");
  });

  it("does not leak the internal writtenAtMs across the public boundary", async () => {
    await putBriefRun(run(), NOW);
    const got = await getBriefRun("b1", NOW);
    expect(got).not.toHaveProperty("writtenAtMs");
  });

  it("clearBriefRuns drops everything, so a brief cannot outlive its gateway", async () => {
    await putBriefRun(run(), NOW);
    await clearBriefRuns();
    expect(await listBriefRuns(NOW)).toEqual([]);
  });
});
