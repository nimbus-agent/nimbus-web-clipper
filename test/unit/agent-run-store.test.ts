import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_RUN_CACHE_TTL_MS,
  clearRuns,
  getRun,
  listRunning,
  MAX_STORED_RUNS,
  MAX_STORED_TERM_RUNS,
  putItemUrls,
  putRun,
} from "../../src/background/agent-run-store.ts";
import type { DecisionsFindings } from "../../src/shared/findings.ts";
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
    await putRun(
      {
        subject: b,
        lane: "impact",
        runId: "run_b",
        state: { kind: "done", brief: "B" },
        expiresAtMs: NOW + 1000,
      },
      NOW,
    );
    expect((await getRun(a, "impact", NOW))?.runId).toBe("run_a");
    expect((await getRun(b, "impact", NOW))?.runId).toBe("run_b");
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

    describe("findings sanitisation", () => {
      it("a stored run with malformed findings survives and replays as prose", async () => {
        // readGuarded DISCARDS any entry whose guard returns false (keyed-store.ts).
        // Validating findings at the entry level would therefore throw away the whole
        // run, including a perfectly good brief. That is the regression this pins.
        chrome.storage.local.set({
          agentRuns: {
            [realKey("item", "i1", "why")]: {
              subject: { kind: "item", id: "i1" },
              lane: "why",
              runId: "r1",
              state: {
                kind: "done",
                brief: "good text",
                findings: { kind: "why", findings: [42] },
              },
              expiresAtMs: NOW + 60_000,
              writtenAtMs: NOW,
            },
          },
        });
        const found = await getRun({ kind: "item", id: "i1" }, "why", NOW);
        expect(found?.state).toEqual({ kind: "done", brief: "good text" });
      });

      it("valid gaps and synthesis survive a malformed findings payload", async () => {
        chrome.storage.local.set({
          agentRuns: {
            [realKey("item", "i2", "why")]: {
              subject: { kind: "item", id: "i2" },
              lane: "why",
              runId: "r2",
              state: {
                kind: "done",
                brief: "b",
                gaps: [{ category: "empty_index", detail: "d" }],
                synthesis: { attempted: false, reason: "disabled" },
                findings: { kind: "why", findings: [42] },
              },
              expiresAtMs: NOW + 60_000,
              writtenAtMs: NOW,
            },
          },
        });
        const found = await getRun({ kind: "item", id: "i2" }, "why", NOW);
        expect(found?.state).toEqual({
          kind: "done",
          brief: "b",
          gaps: [{ category: "empty_index", detail: "d" }],
          synthesis: { attempted: false, reason: "disabled" },
        });
      });

      it("findings past the byte bound are dropped, brief and synthesis kept", async () => {
        const big = Array.from({ length: 400 }, (_, i) => ({
          lane: "ticket" as const,
          title: "t".repeat(80),
          detail: "d".repeat(80),
          url: null,
          occurredAt: i,
          entityId: null,
        }));
        await putRun(
          {
            subject: { kind: "item", id: "i3" },
            lane: "why",
            runId: "r3",
            state: {
              kind: "done",
              brief: "b",
              synthesis: { attempted: false, reason: "disabled" },
              findings: {
                kind: "why",
                findings: big,
                subject: null,
                changeSubject: null,
                itemSubject: null,
              },
            },
            expiresAtMs: NOW + 60_000,
          },
          NOW,
        );
        const found = await getRun({ kind: "item", id: "i3" }, "why", NOW);
        expect(found?.state).toEqual({
          kind: "done",
          brief: "b",
          synthesis: { attempted: false, reason: "disabled" },
        });
      });

      // The regression `laneFindingsFrom`'s own idempotence test also pins
      // (findings-guards.test.ts): `sanitiseState` re-runs the lane's guard
      // over the STORED projection on every `getRun`, not the wire object. A
      // decisions guard that could parse the wire but not its own projection
      // would strip these findings right back out on this very read — the
      // existing tests in this block only covered *malformed* and *oversized*
      // findings, which is exactly why nothing caught that bug.
      it("round-trips an itemUrls map alongside findings", async () => {
        const findings: DecisionsFindings = {
          kind: "decisions",
          entries: [],
          truncatedSources: 0,
        };
        await putRun(
          {
            subject: { kind: "item", id: "i-urls" },
            lane: "expert",
            runId: "r-urls",
            state: {
              kind: "done",
              brief: "b",
              findings: { kind: "expert", ranked: [] },
              itemUrls: { "github:acme/web#1": "https://github.com/acme/web/pull/1" },
            },
            expiresAtMs: NOW + 60_000,
          },
          NOW,
        );
        const found = await getRun({ kind: "item", id: "i-urls" }, "expert", NOW);
        expect(found?.state).toEqual({
          kind: "done",
          brief: "b",
          findings: { kind: "expert", ranked: [] },
          itemUrls: { "github:acme/web#1": "https://github.com/acme/web/pull/1" },
        });
        // Sanity — findings unrelated to itemUrls, used only above to keep this
        // test self-contained about the DecisionsFindings import already present.
        expect(findings.truncatedSources).toBe(0);
      });

      it("a run stored before this shipped (no itemUrls key at all) reads back with no map — same as a gateway that could not resolve", async () => {
        chrome.storage.local.set({
          agentRuns: {
            [realKey("item", "i-old", "expert")]: {
              subject: { kind: "item", id: "i-old" },
              lane: "expert",
              runId: "r-old",
              state: {
                kind: "done",
                brief: "b",
                findings: { kind: "expert", ranked: [] },
                // no itemUrls key at all — the pre-this-phase shape.
              },
              expiresAtMs: NOW + 60_000,
              writtenAtMs: NOW,
            },
          },
        });
        const found = await getRun({ kind: "item", id: "i-old" }, "expert", NOW);
        expect(found?.state).toEqual({
          kind: "done",
          brief: "b",
          findings: { kind: "expert", ranked: [] },
        });
        expect(found?.state.kind === "done" ? found.state.itemUrls : undefined).toBeUndefined();
      });

      it("a malformed stored itemUrls (non-string value) is dropped, findings and brief kept", async () => {
        chrome.storage.local.set({
          agentRuns: {
            [realKey("item", "i-bad-urls", "expert")]: {
              subject: { kind: "item", id: "i-bad-urls" },
              lane: "expert",
              runId: "r-bad",
              state: {
                kind: "done",
                brief: "b",
                findings: { kind: "expert", ranked: [] },
                itemUrls: { "github:acme/web#1": 42 },
              },
              expiresAtMs: NOW + 60_000,
              writtenAtMs: NOW,
            },
          },
        });
        const found = await getRun({ kind: "item", id: "i-bad-urls" }, "expert", NOW);
        expect(found?.state).toEqual({
          kind: "done",
          brief: "b",
          findings: { kind: "expert", ranked: [] },
        });
      });

      it("findings plus an itemUrls map that together exceed the byte bound drop BOTH, brief kept — the existing over-budget behaviour, now counting the map too", async () => {
        // Findings alone are small; the map alone pushes the combined total
        // past MAX_FINDINGS_BYTES (16 KiB). If only `findings` were measured
        // (the pre-Task-3 behaviour) this would be kept in full.
        const evidence = Array.from({ length: 30 }, (_, i) => ({
          itemId: `github:acme/web#${i}`,
          type: "pr_authored" as const,
          serviceId: "github",
          title: "t",
          modifiedAt: i,
          weight: 0.1,
        }));
        const itemUrls: Record<string, string> = {};
        for (const e of evidence) {
          itemUrls[e.itemId] = `https://github.com/acme/web/pull/${e.itemId}${"x".repeat(700)}`;
        }
        await putRun(
          {
            subject: { kind: "item", id: "i-big-urls" },
            lane: "expert",
            runId: "r-big",
            state: {
              kind: "done",
              brief: "b",
              synthesis: { attempted: false, reason: "disabled" },
              findings: {
                kind: "expert",
                ranked: [
                  {
                    personId: "person:1",
                    displayName: "Ada",
                    score: 0.9,
                    confidence: "high",
                    evidence,
                  },
                ],
              },
              itemUrls,
            },
            expiresAtMs: NOW + 60_000,
          },
          NOW,
        );
        const found = await getRun({ kind: "item", id: "i-big-urls" }, "expert", NOW);
        expect(found?.state).toEqual({
          kind: "done",
          brief: "b",
          synthesis: { attempted: false, reason: "disabled" },
        });
      });

      it("valid decisions findings survive a put -> get round trip", async () => {
        const findings: DecisionsFindings = {
          kind: "decisions",
          entries: [
            {
              id: "d1",
              statement: "Use WAL mode for the index database.",
              rationale: "Concurrent readers during a sync pass.",
              alternatives: ["Rollback journal"],
              confidence: 0.9,
              decidedAt: 1_700_000_000_000,
              hasAdr: true,
              extractionSource: "snippet",
              evidence: [
                {
                  kind: "pr",
                  entityId: "e1",
                  itemId: "github:acme/web#7",
                  label: "Adopt SQLite WAL",
                  url: "https://example.test/pr/7",
                  occurredAt: 1_700_000_000_000,
                },
              ],
            },
          ],
          truncatedSources: 3,
        };
        await putRun(
          {
            subject: { kind: "service", service: "github" },
            lane: "decisions",
            runId: "r4",
            state: { kind: "done", brief: "b", findings },
            expiresAtMs: NOW + 60_000,
          },
          NOW,
        );
        const found = await getRun({ kind: "service", service: "github" }, "decisions", NOW);
        expect(found?.state).toEqual({ kind: "done", brief: "b", findings });
      });
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

  // The race the review of this phase's task 3/4 work found: the caller used
  // to `getRun` OUTSIDE the store's write chain, then `putRun` back in later
  // — a plain read a concurrent write could land after, silently clobbered by
  // the stale state that outside read captured. `putItemUrls` closes that by
  // doing the read, the freshness check and the write all inside the SAME
  // `exclusively` critical section `putRun` itself uses.
  describe("putItemUrls", () => {
    it("merges the map onto the still-current run", async () => {
      await putRun(
        {
          subject: { kind: "item", id: "i-put" },
          lane: "expert",
          runId: "r1",
          state: { kind: "done", brief: "b", findings: { kind: "expert", ranked: [] } },
          expiresAtMs: NOW + 60_000,
        },
        NOW,
      );
      await putItemUrls(
        { kind: "item", id: "i-put" },
        "expert",
        "r1",
        { "github:acme/web#1": "https://github.com/acme/web/pull/1" },
        NOW,
      );
      const found = await getRun({ kind: "item", id: "i-put" }, "expert", NOW);
      expect(found?.state).toEqual({
        kind: "done",
        brief: "b",
        findings: { kind: "expert", ranked: [] },
        itemUrls: { "github:acme/web#1": "https://github.com/acme/web/pull/1" },
      });
    });

    it("writes nothing when the runId no longer matches — a Re-run already replaced it", async () => {
      await putRun(
        {
          subject: { kind: "item", id: "i-mismatch" },
          lane: "expert",
          runId: "r-new",
          state: { kind: "done", brief: "fresh", findings: { kind: "expert", ranked: [] } },
          expiresAtMs: NOW + 60_000,
        },
        NOW,
      );
      await putItemUrls(
        { kind: "item", id: "i-mismatch" },
        "expert",
        "r-stale",
        { "github:acme/web#1": "https://github.com/acme/web/pull/1" },
        NOW,
      );
      const found = await getRun({ kind: "item", id: "i-mismatch" }, "expert", NOW);
      expect(found?.state).toEqual({
        kind: "done",
        brief: "fresh",
        findings: { kind: "expert", ranked: [] },
      });
    });

    it("writes nothing once the run has expired", async () => {
      await putRun(
        {
          subject: { kind: "item", id: "i-exp" },
          lane: "expert",
          runId: "r1",
          state: { kind: "done", brief: "b", findings: { kind: "expert", ranked: [] } },
          expiresAtMs: NOW + 10,
        },
        NOW,
      );
      await putItemUrls(
        { kind: "item", id: "i-exp" },
        "expert",
        "r1",
        { x: "https://x.test" },
        NOW + 11,
      );
      expect(await getRun({ kind: "item", id: "i-exp" }, "expert", NOW + 11)).toBeNull();
    });

    it("writes nothing once the run is running again, not done", async () => {
      await putRun(
        {
          subject: { kind: "item", id: "i-run" },
          lane: "expert",
          runId: "r1",
          state: { kind: "running", runId: "r1" },
          expiresAtMs: NOW + 60_000,
        },
        NOW,
      );
      await putItemUrls(
        { kind: "item", id: "i-run" },
        "expert",
        "r1",
        { x: "https://x.test" },
        NOW,
      );
      const found = await getRun({ kind: "item", id: "i-run" }, "expert", NOW);
      expect(found?.state).toEqual({ kind: "running", runId: "r1" });
    });

    // The interleaving itself, constructed deliberately rather than hoped
    // for: `exclusively`'s single-writer chain runs queued work in EXACTLY
    // the order it was called, regardless of how many `await`s each does
    // internally, so calling `putRun` (the Re-run) and THEN `putItemUrls`
    // (the stale resolve) without awaiting between them — and only awaiting
    // both afterward — deterministically reproduces "a concurrent Re-run
    // landing between the read and the write" every run, not on lucky timing.
    it("a concurrent Re-run's write landing before a stale itemUrls attempt is not clobbered", async () => {
      await putRun(
        {
          subject: { kind: "item", id: "i-race" },
          lane: "expert",
          runId: "r1",
          state: {
            kind: "done",
            brief: "first answer",
            findings: { kind: "expert", ranked: [] },
          },
          expiresAtMs: NOW + 60_000,
        },
        NOW,
      );

      // Queued FIRST (not awaited yet): the Re-run's own fresh terminal
      // write — same subject+lane, a NEW runId — exactly what task 6's
      // Re-run produces while a slow resolve-ids call is still in flight.
      const reRun = putRun(
        {
          subject: { kind: "item", id: "i-race" },
          lane: "expert",
          runId: "r2",
          state: {
            kind: "done",
            brief: "second answer",
            findings: { kind: "expert", ranked: [] },
          },
          expiresAtMs: NOW + 60_000,
        },
        NOW + 1,
      );
      // Queued SECOND: the stale resolve, still carrying the ORIGINAL run's
      // id — exactly what `resolveAndPersistItemUrls` passes after a slow
      // `/v1/items/resolve-ids` call outlives a Re-run of the same lane.
      const staleAttach = putItemUrls(
        { kind: "item", id: "i-race" },
        "expert",
        "r1",
        { "github:acme/web#1": "https://github.com/acme/web/pull/1" },
        NOW + 2,
      );

      await Promise.all([reRun, staleAttach]);

      const found = await getRun({ kind: "item", id: "i-race" }, "expert", NOW + 2);
      // The Re-run's fresh answer survives untouched: no itemUrls attached to
      // it, and its own brief is intact — not clobbered by the stale write
      // that (with the bug) would have overwritten it with `runId: "r1"`'s
      // captured-before-the-race state.
      expect(found?.runId).toBe("r2");
      expect(found?.state).toEqual({
        kind: "done",
        brief: "second answer",
        findings: { kind: "expert", ranked: [] },
      });
    });
  });
});
