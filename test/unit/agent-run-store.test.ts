import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_RUN_CACHE_TTL_MS,
  getRun,
  listRunning,
  MAX_STORED_RUNS,
  putRun,
} from "../../src/background/agent-run-store.ts";
import { installChromeMock } from "./helpers/chrome-mock.ts";

const NOW = 1_800_000_000_000;
// The store's real key format (itemId + U+0000 + lane, matching
// agent-run-store.ts's own KEY_SEP) — built via String.fromCharCode, never a
// literal control character typed into this source file, which git/editors
// mishandle. Needed by the two "drops a malformed X" tests below: a
// mismatched key would make `getRun` miss the entry regardless of whether the
// validation guard under test is even correct, which would make those tests
// worthless.
const realKey = (itemId: string, lane: string) => `${itemId}${String.fromCharCode(0)}${lane}`;
const run = (itemId: string, lane: "impact" | "expert", expiresAtMs: number) => ({
  itemId,
  lane,
  runId: `${itemId}-${lane}`,
  state: { kind: "done" as const, brief: "b" },
  expiresAtMs,
});

describe("agent-run-store", () => {
  beforeEach(() => {
    installChromeMock();
  });

  it("round-trips a run", async () => {
    await putRun(run("i1", "impact", NOW + 1000), NOW);
    expect(await getRun("i1", "impact", NOW)).toMatchObject({ runId: "i1-impact" });
  });

  it("keys by item AND lane — two lanes on one item do not collide", async () => {
    await putRun(run("i1", "impact", NOW + 1000), NOW);
    await putRun(run("i1", "expert", NOW + 1000), NOW);
    expect((await getRun("i1", "impact", NOW))?.runId).toBe("i1-impact");
    expect((await getRun("i1", "expert", NOW))?.runId).toBe("i1-expert");
  });

  // The cache must never outlive the gateway's own run TTL: a brief we still hold
  // after the gateway has forgotten it cannot be re-polled.
  it("drops an entry past its expiry on read", async () => {
    await putRun(run("i1", "impact", NOW + 1000), NOW);
    expect(await getRun("i1", "impact", NOW + 1001)).toBeNull();
  });

  it("mirrors the gateway's 10-minute run TTL", () => {
    expect(AGENT_RUN_CACHE_TTL_MS).toBe(10 * 60_000);
  });

  it("caps entries at the gateway's own retained-run count, evicting oldest first", async () => {
    expect(MAX_STORED_RUNS).toBe(16);
    for (let i = 0; i < MAX_STORED_RUNS + 2; i++) {
      await putRun(run(`i${i}`, "impact", NOW + 60_000), NOW + i);
    }
    expect(await getRun("i0", "impact", NOW)).toBeNull();
    expect(await getRun("i1", "impact", NOW)).toBeNull();
    expect(await getRun(`i${MAX_STORED_RUNS + 1}`, "impact", NOW)).not.toBeNull();
  });

  it("lists only running entries, and only unexpired ones", async () => {
    await putRun(
      { ...run("i1", "impact", NOW + 1000), state: { kind: "running", runId: "r1" } },
      NOW,
    );
    await putRun(run("i2", "impact", NOW + 1000), NOW); // done
    await putRun({ ...run("i3", "impact", NOW - 1), state: { kind: "running", runId: "r3" } }, NOW);
    const out = await listRunning(NOW);
    expect(out.map((r) => r.itemId)).toEqual(["i1"]);
  });

  it("survives malformed stored data rather than throwing", async () => {
    // Storage is external input: a hand-edited or partially-written value must not
    // take the panel down.
    chrome.storage.local.set({ agentRuns: { nonsense: 42 } });
    expect(await getRun("i1", "impact", NOW)).toBeNull();
    expect(await listRunning(NOW)).toEqual([]);
  });

  it("serializes concurrent putRun calls (no lost update)", async () => {
    // Both calls are invoked synchronously, so without a single-writer lock both
    // reads would see the same empty snapshot and each write a single entry — the
    // result would be one lane persisted, never both. This is the store's primary
    // use case: two lanes on one item expanded together, or a poll's `done`
    // landing while a fresh lane-start writes `running`.
    const p1 = putRun(run("i1", "impact", NOW + 1000), NOW);
    const p2 = putRun(run("i1", "expert", NOW + 1000), NOW);
    await Promise.all([p1, p2]);
    expect((await getRun("i1", "impact", NOW))?.runId).toBe("i1-impact");
    expect((await getRun("i1", "expert", NOW))?.runId).toBe("i1-expert");
  });

  it("round-trips a failed state carrying a scopeGap and a detail", async () => {
    await putRun(
      {
        ...run("i1", "impact", NOW + 1000),
        state: {
          kind: "failed",
          reason: "insufficient_scope",
          scopeGap: { label: "chrome", required: "agents", granted: ["clip"] },
          detail: "no LLM configured",
        },
      },
      NOW,
    );
    expect((await getRun("i1", "impact", NOW))?.state).toEqual({
      kind: "failed",
      reason: "insufficient_scope",
      scopeGap: { label: "chrome", required: "agents", granted: ["clip"] },
      detail: "no LLM configured",
    });
  });

  // Storage is external input (the same rule the malformed-data test above pins):
  // a hand-edited or partially-written `scopeGap`/`detail` must drop the whole
  // entry on read, not pass a malformed shape through to a caller that trusts
  // `getRun`'s return type.
  it("drops a failed entry whose stored scopeGap is malformed", async () => {
    chrome.storage.local.set({
      agentRuns: {
        [realKey("i1", "impact")]: {
          itemId: "i1",
          lane: "impact",
          runId: "r1",
          state: {
            kind: "failed",
            reason: "insufficient_scope",
            scopeGap: { label: "chrome", required: "agents" }, // missing granted
          },
          expiresAtMs: NOW + 1000,
          writtenAtMs: NOW,
        },
      },
    });
    expect(await getRun("i1", "impact", NOW)).toBeNull();
  });

  it("drops a failed entry whose stored detail is not a string", async () => {
    chrome.storage.local.set({
      agentRuns: {
        [realKey("i1", "impact")]: {
          itemId: "i1",
          lane: "impact",
          runId: "r1",
          state: { kind: "failed", reason: "agent_failed", detail: 42 },
          expiresAtMs: NOW + 1000,
          writtenAtMs: NOW,
        },
      },
    });
    expect(await getRun("i1", "impact", NOW)).toBeNull();
  });

  it("does not leak the internal write-order tag across the public boundary", async () => {
    await putRun(run("i1", "impact", NOW + 1000), NOW);
    expect(await getRun("i1", "impact", NOW)).not.toHaveProperty("writtenAtMs");
    await putRun(
      { ...run("i2", "impact", NOW + 1000), state: { kind: "running", runId: "r2" } },
      NOW,
    );
    const [running] = await listRunning(NOW);
    expect(running).not.toHaveProperty("writtenAtMs");
  });
});
