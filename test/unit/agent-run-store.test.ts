import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_RUN_CACHE_TTL_MS,
  clearRuns,
  getRun,
  listRunning,
  MAX_STORED_RUNS,
  MAX_STORED_TERM_RUNS,
  putRun,
} from "../../src/background/agent-run-store.ts";
import { installChromeMock } from "./helpers/chrome-mock.ts";

const NOW = 1_800_000_000_000;
// The store's real key format (kind + U+0000 + value + U+0000 + lane, matching
// agent-run-store.ts's own KEY_SEP) — built via String.fromCharCode, never a
// literal control character typed into this source file, which git/editors
// mishandle. Needed by the two "drops a malformed X" tests below: a
// mismatched key would make `getRun` miss the entry regardless of whether the
// validation guard under test is even correct, which would make those tests
// worthless.
const SEP = String.fromCharCode(0);
const realKey = (kind: string, value: string, lane: string) => `${kind}${SEP}${value}${SEP}${lane}`;

const run = (itemId: string, lane: "impact" | "expert", expiresAtMs: number) => ({
  subject: { kind: "item" as const, id: itemId },
  lane,
  runId: `run_${itemId}_${lane}`,
  state: { kind: "done" as const, brief: "B" },
  expiresAtMs,
});

describe("agent-run-store", () => {
  beforeEach(() => {
    installChromeMock();
  });

  it("round-trips a run", async () => {
    await putRun(run("i1", "impact", NOW + 1000), NOW);
    expect(await getRun({ kind: "item", id: "i1" }, "impact", NOW)).toMatchObject({
      runId: "run_i1_impact",
    });
  });

  it("keys by item AND lane — two lanes on one item do not collide", async () => {
    await putRun(run("i1", "impact", NOW + 1000), NOW);
    await putRun(run("i1", "expert", NOW + 1000), NOW);
    expect((await getRun({ kind: "item", id: "i1" }, "impact", NOW))?.runId).toBe("run_i1_impact");
    expect((await getRun({ kind: "item", id: "i1" }, "expert", NOW))?.runId).toBe("run_i1_expert");
  });

  // The cache must never outlive the gateway's own run TTL: a brief we still hold
  // after the gateway has forgotten it cannot be re-polled.
  it("drops an entry past its expiry on read", async () => {
    await putRun(run("i1", "impact", NOW + 1000), NOW);
    expect(await getRun({ kind: "item", id: "i1" }, "impact", NOW + 1001)).toBeNull();
  });

  it("mirrors the gateway's 10-minute run TTL", () => {
    expect(AGENT_RUN_CACHE_TTL_MS).toBe(10 * 60_000);
  });

  it("caps entries at the gateway's own retained-run count, evicting oldest first", async () => {
    expect(MAX_STORED_RUNS).toBe(16);
    for (let i = 0; i < MAX_STORED_RUNS + 2; i++) {
      await putRun(run(`i${i}`, "impact", NOW + 60_000), NOW + i);
    }
    expect(await getRun({ kind: "item", id: "i0" }, "impact", NOW)).toBeNull();
    expect(await getRun({ kind: "item", id: "i1" }, "impact", NOW)).toBeNull();
    expect(
      await getRun({ kind: "item", id: `i${MAX_STORED_RUNS + 1}` }, "impact", NOW),
    ).not.toBeNull();
  });

  describe("the term subject", () => {
    const termRun = (t: string, expiresAtMs = NOW + 60_000) => ({
      subject: { kind: "term" as const, term: t },
      lane: "glossary" as const,
      runId: `run_${t}`,
      state: { kind: "done" as const, brief: `about ${t}` },
      expiresAtMs,
    });

    // Without its own arm, a second term would replay the first term's answer —
    // exactly the failure the discriminated subject exists to prevent.
    it("keeps two terms apart", async () => {
      await putRun(termRun("canary"), NOW);
      await putRun(termRun("blast radius"), NOW + 1);
      expect(await getRun({ kind: "term", term: "canary" }, "glossary", NOW)).toMatchObject({
        runId: "run_canary",
      });
      expect(await getRun({ kind: "term", term: "blast radius" }, "glossary", NOW)).toMatchObject({
        runId: "run_blast radius",
      });
    });

    it("cannot collide with an item or a service of the same value", async () => {
      await putRun(termRun("github"), NOW);
      expect(await getRun({ kind: "service", service: "github" }, "glossary", NOW)).toBeNull();
      expect(await getRun({ kind: "item", id: "github" }, "glossary", NOW)).toBeNull();
    });

    // The asymmetry this budget exists for: terms are unbounded in cardinality,
    // items and services are not, so an unbounded subject must never evict a
    // bounded one.
    it("evicts the oldest TERM before touching an item, once past its own budget", async () => {
      expect(MAX_STORED_TERM_RUNS).toBe(6);
      await putRun(run("keep-me", "impact", NOW + 60_000), NOW);
      for (let i = 0; i < MAX_STORED_TERM_RUNS + 1; i++) {
        await putRun(termRun(`t${i}`), NOW + 10 + i);
      }
      // The item written FIRST — and therefore the oldest entry in the store —
      // survives, because the seventh term displaced the first term instead.
      expect(await getRun({ kind: "item", id: "keep-me" }, "impact", NOW)).not.toBeNull();
      expect(await getRun({ kind: "term", term: "t0" }, "glossary", NOW)).toBeNull();
      expect(await getRun({ kind: "term", term: "t1" }, "glossary", NOW)).not.toBeNull();
      expect(
        await getRun({ kind: "term", term: `t${MAX_STORED_TERM_RUNS}` }, "glossary", NOW),
      ).not.toBeNull();
    });

    it("holds its full budget when nothing else is stored", async () => {
      for (let i = 0; i < MAX_STORED_TERM_RUNS; i++) {
        await putRun(termRun(`t${i}`), NOW + i);
      }
      for (let i = 0; i < MAX_STORED_TERM_RUNS; i++) {
        expect(await getRun({ kind: "term", term: `t${i}` }, "glossary", NOW)).not.toBeNull();
      }
    });

    it("drops a malformed term subject on read", async () => {
      chrome.storage.local.set({
        agentRuns: {
          [realKey("term", "canary", "glossary")]: {
            subject: { kind: "term" },
            lane: "glossary",
            runId: "r",
            state: { kind: "done", brief: "B" },
            expiresAtMs: NOW + 1000,
            writtenAtMs: NOW,
          },
        },
      });
      expect(await getRun({ kind: "term", term: "canary" }, "glossary", NOW)).toBeNull();
    });
  });

  it("lists only running entries, and only unexpired ones", async () => {
    await putRun(
      { ...run("i1", "impact", NOW + 1000), state: { kind: "running", runId: "r1" } },
      NOW,
    );
    await putRun(run("i2", "impact", NOW + 1000), NOW); // done
    await putRun({ ...run("i3", "impact", NOW - 1), state: { kind: "running", runId: "r3" } }, NOW);
    const out = await listRunning(NOW);
    expect(out.map((r) => (r.subject.kind === "item" ? r.subject.id : "not-an-item"))).toEqual([
      "i1",
    ]);
  });

  it("survives malformed stored data rather than throwing", async () => {
    // Storage is external input: a hand-edited or partially-written value must not
    // take the panel down.
    chrome.storage.local.set({ agentRuns: { nonsense: 42 } });
    expect(await getRun({ kind: "item", id: "i1" }, "impact", NOW)).toBeNull();
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
    expect((await getRun({ kind: "item", id: "i1" }, "impact", NOW))?.runId).toBe("run_i1_impact");
    expect((await getRun({ kind: "item", id: "i1" }, "expert", NOW))?.runId).toBe("run_i1_expert");
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
    expect((await getRun({ kind: "item", id: "i1" }, "impact", NOW))?.state).toEqual({
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
        [realKey("item", "i1", "impact")]: {
          subject: { kind: "item", id: "i1" },
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
    expect(await getRun({ kind: "item", id: "i1" }, "impact", NOW)).toBeNull();
  });

  it("drops a failed entry whose stored detail is not a string", async () => {
    chrome.storage.local.set({
      agentRuns: {
        [realKey("item", "i1", "impact")]: {
          subject: { kind: "item", id: "i1" },
          lane: "impact",
          runId: "r1",
          state: { kind: "failed", reason: "agent_failed", detail: 42 },
          expiresAtMs: NOW + 1000,
          writtenAtMs: NOW,
        },
      },
    });
    expect(await getRun({ kind: "item", id: "i1" }, "impact", NOW)).toBeNull();
  });

  it("does not leak the internal write-order tag across the public boundary", async () => {
    await putRun(run("i1", "impact", NOW + 1000), NOW);
    expect(await getRun({ kind: "item", id: "i1" }, "impact", NOW)).not.toHaveProperty(
      "writtenAtMs",
    );
    await putRun(
      { ...run("i2", "impact", NOW + 1000), state: { kind: "running", runId: "r2" } },
      NOW,
    );
    const [running] = await listRunning(NOW);
    expect(running).not.toHaveProperty("writtenAtMs");
  });

  it("clears every stored run", async () => {
    await putRun(
      {
        subject: { kind: "service", service: "github" },
        lane: "catchup",
        runId: "r1",
        state: { kind: "done", brief: "B" },
        expiresAtMs: NOW + 1000,
      },
      NOW,
    );
    await clearRuns();
    expect(await getRun({ kind: "service", service: "github" }, "catchup", NOW)).toBeNull();
  });

  it("round-trips a file subject through storage", async () => {
    // The guard, not the key, is the gap: makeKey/subjectValue already handle `file`,
    // so this fails only on the read back — silently, and only on the storage path.
    const subject = { kind: "file" as const, repo: "acme/web", refAndPath: "main/src/index.ts" };
    await putRun(
      {
        subject,
        lane: "impact",
        runId: "run_file_impact",
        state: { kind: "done", brief: "B" },
        expiresAtMs: NOW + 1000,
      },
      NOW,
    );
    expect(await getRun(subject, "impact", NOW)).toMatchObject({ runId: "run_file_impact" });
  });

  it("keys two files in one repo separately", async () => {
    // subjectValue joins repo and coordinate with the key separator precisely so one
    // file's cached run cannot be served for another.
    const a = { kind: "file" as const, repo: "acme/web", refAndPath: "main/src/a.ts" };
    const b = { kind: "file" as const, repo: "acme/web", refAndPath: "main/src/b.ts" };
    await putRun(
      {
        subject: a,
        lane: "impact",
        runId: "run_a",
        state: { kind: "done", brief: "A" },
        expiresAtMs: NOW + 1000,
      },
      NOW,
    );
    expect(await getRun(b, "impact", NOW)).toBeNull();
  });

  describe("run subjects", () => {
    it("keeps an item subject and a service subject with the same text apart", async () => {
      const item = { kind: "item" as const, id: "jenkins" };
      const service = { kind: "service" as const, service: "jenkins" };
      await putRun(
        {
          subject: item,
          lane: "impact",
          runId: "r1",
          state: { kind: "done", brief: "I" },
          expiresAtMs: NOW + 1000,
        },
        NOW,
      );
      await putRun(
        {
          subject: service,
          lane: "impact",
          runId: "r2",
          state: { kind: "done", brief: "S" },
          expiresAtMs: NOW + 1000,
        },
        NOW,
      );
      // Same lane on both writes — `kind` is the ONLY thing distinguishing the
      // two keys here. A `makeKey` that ignored `subject.kind` and keyed only
      // on value+lane would collide these two ("jenkins" + "impact" twice) and
      // this assertion would catch it.
      expect((await getRun(item, "impact", NOW))?.runId).toBe("r1");
      expect((await getRun(service, "impact", NOW))?.runId).toBe("r2");
    });

    it("shares one entry across two instances of the same service", async () => {
      // Two self-hosted Jenkins dashboards produce the SAME subject, so the
      // second visit replays the first answer instead of spending a second run.
      // `service` is a flat connector id — both instances are one scope.
      const subject = { kind: "service" as const, service: "jenkins" };
      await putRun(
        {
          subject,
          lane: "expert",
          runId: "r1",
          state: { kind: "done", brief: "B" },
          expiresAtMs: NOW + 1000,
        },
        NOW,
      );
      expect((await getRun(subject, "expert", NOW))?.runId).toBe("r1");
    });

    it("drops a stored entry written in the old itemId shape", async () => {
      // The pre-subject shape. Dropping it costs at most one re-run: this store
      // is a ten-minute cache, not durable state. Written through
      // `chrome.storage.local.set` directly, exactly as this file's existing
      // "drops a malformed X" tests do.
      chrome.storage.local.set({
        agentRuns: {
          [realKey("item", "abc", "impact")]: {
            itemId: "abc",
            lane: "impact",
            runId: "r1",
            state: { kind: "done", brief: "B" },
            expiresAtMs: NOW + 1000,
            writtenAtMs: NOW,
          },
        },
      });
      expect(await getRun({ kind: "item", id: "abc" }, "impact", NOW)).toBeNull();
    });
  });
});
