import { describe, expect, test } from "vitest";
import type {
  DecisionsFindings,
  ExpertFindings,
  GlossaryFindings,
  ImpactFindings,
  SynthesisProvenance,
  WhyFindings,
} from "../../src/shared/findings.ts";
import {
  decisionsFindingsFrom,
  expertFindingsFrom,
  gapNotesFrom,
  gapsOfBrief,
  glossaryFindingsFrom,
  impactFindingsFrom,
  laneFindingsFrom,
  synthesisFrom,
} from "../../src/shared/findings-guards.ts";

describe("findings types pin the fields we read", () => {
  // The mirrored types (§4.2) can drift from upstream with nothing enforcing it.
  // This is the "discoverability, not enforcement" position registry.ts takes
  // about the Product -> connector id coupling: a rename upstream surfaces here
  // as a failure rather than as a wrong render.
  test("WhyFindings carries the five fields the renderer reads", () => {
    const value: WhyFindings = {
      kind: "why",
      findings: [
        {
          lane: "authorship",
          title: "t",
          detail: "d",
          url: null,
          occurredAt: null,
          entityId: null,
        },
      ],
      subject: null,
      changeSubject: null,
      itemSubject: null,
    };
    expect(Object.keys(value).sort()).toEqual([
      "changeSubject",
      "findings",
      "itemSubject",
      "kind",
      "subject",
    ]);
  });

  test("SynthesisProvenance's used arm carries model and remote", () => {
    const used: SynthesisProvenance = {
      attempted: true,
      used: true,
      model: "llama3",
      remote: false,
    };
    expect(used.attempted && used.used ? used.remote : true).toBe(false);
  });
});

const validWhy = {
  kind: "why",
  agentVersion: 1,
  generatedAt: 1,
  latencyMs: 1,
  gaps: [],
  query: { ref: "r", line: null },
  subject: null,
  findings: [
    {
      lane: "ticket",
      title: "T",
      detail: "D",
      url: "https://x.test/1",
      occurredAt: 5,
      entityId: null,
    },
  ],
};

describe("gapNotesFrom validates a gaps ARRAY", () => {
  test("accepts well-formed notes and keeps optional remediation", () => {
    const raw = [{ category: "empty_index", detail: "d", remediation: "r" }];
    expect(gapNotesFrom(raw)).toEqual([{ category: "empty_index", detail: "d", remediation: "r" }]);
  });

  test("accepts a note without remediation", () => {
    expect(gapNotesFrom([{ category: "empty_index", detail: "d" }])).toEqual([
      { category: "empty_index", detail: "d" },
    ]);
  });

  test("accepts an empty array", () => {
    // An agent with nothing to report is not the same as a malformed payload.
    expect(gapNotesFrom([])).toEqual([]);
  });

  test("rejects the whole array when any element is malformed", () => {
    // Type narrow, runtime wide is this repo's recurring bug: a shallow
    // Array.isArray check would let `null` through as a GapNote.
    expect(gapNotesFrom([{ category: "empty_index", detail: "d" }, null])).toBeUndefined();
    expect(gapNotesFrom([{ category: 42, detail: "d" }])).toBeUndefined();
    expect(gapNotesFrom([{ category: "not_a_category", detail: "d" }])).toBeUndefined();
  });

  test("returns undefined for anything that is not an array", () => {
    expect(gapNotesFrom(null)).toBeUndefined();
    expect(gapNotesFrom(undefined)).toBeUndefined();
    expect(gapNotesFrom({ gaps: [] })).toBeUndefined();
    expect(gapNotesFrom("nope")).toBeUndefined();
  });
});

describe("gapsOfBrief reads gaps OFF a brief object", () => {
  test("extracts and validates the array", () => {
    expect(gapsOfBrief({ kind: "why", gaps: [{ category: "empty_index", detail: "d" }] })).toEqual([
      { category: "empty_index", detail: "d" },
    ]);
  });

  test("returns undefined for a non-object, a missing key, or a malformed element", () => {
    expect(gapsOfBrief(null)).toBeUndefined();
    expect(gapsOfBrief({})).toBeUndefined();
    expect(gapsOfBrief({ gaps: "nope" })).toBeUndefined();
    expect(gapsOfBrief({ gaps: [null] })).toBeUndefined();
  });

  test("reads gaps from a brief whose lane has no findings arm", () => {
    // This is the whole point: six of seven lanes have no arm in C8.1, and their
    // gaps must still reach the panel.
    expect(
      gapsOfBrief({ kind: "glossary", gaps: [{ category: "empty_index", detail: "d" }] }),
    ).toEqual([{ category: "empty_index", detail: "d" }]);
  });
});

describe("synthesisFrom", () => {
  test("accepts the not-attempted arm", () => {
    expect(synthesisFrom({ attempted: false, reason: "disabled" })).toEqual({
      attempted: false,
      reason: "disabled",
    });
  });

  test("accepts the used arm and preserves remote", () => {
    expect(synthesisFrom({ attempted: true, used: true, model: "m", remote: true })).toEqual({
      attempted: true,
      used: true,
      model: "m",
      remote: true,
    });
  });

  test("accepts the discarded arm with violations and detail", () => {
    const raw = {
      attempted: true,
      used: false,
      reason: "contract_violation",
      violations: ["v"],
      detail: "d",
    };
    expect(synthesisFrom(raw)).toEqual(raw);
  });

  test("rejects an unknown discard reason and a used arm missing remote", () => {
    expect(synthesisFrom({ attempted: true, used: false, reason: "guardrail" })).toBeUndefined();
    expect(synthesisFrom({ attempted: true, used: true, model: "m" })).toBeUndefined();
  });
});

describe("laneFindingsFrom", () => {
  test("projects a valid why brief, dropping the base fields", () => {
    expect(laneFindingsFrom("why", validWhy)).toEqual({
      kind: "why",
      findings: [
        {
          lane: "ticket",
          title: "T",
          detail: "D",
          url: "https://x.test/1",
          occurredAt: 5,
          entityId: null,
        },
      ],
      subject: null,
      changeSubject: null,
      itemSubject: null,
    });
  });

  test("rejects the shallow shapes the SDK's own guard would admit", () => {
    // createBriefGuard checks only Array.isArray(b.findings) - see spec 4.3.
    expect(laneFindingsFrom("why", { ...validWhy, findings: [42, null] })).toBeUndefined();
  });

  test("rejects a finding with an unknown lane or a non-number occurredAt", () => {
    expect(
      laneFindingsFrom("why", {
        ...validWhy,
        findings: [{ ...validWhy.findings[0], lane: "nope" }],
      }),
    ).toBeUndefined();
    expect(
      laneFindingsFrom("why", {
        ...validWhy,
        findings: [{ ...validWhy.findings[0], occurredAt: "2026-01-01T00:00:00Z" }],
      }),
    ).toBeUndefined();
  });

  test("rejects when findings.kind disagrees with the lane asked about", () => {
    expect(laneFindingsFrom("why", { ...validWhy, kind: "expert" })).toBeUndefined();
  });

  test("returns undefined for a lane with no arm yet", () => {
    expect(laneFindingsFrom("expert", validWhy)).toBeUndefined();
    expect(laneFindingsFrom("glossary", validWhy)).toBeUndefined();
  });

  // `WhyChangeSubject.url` is non-nullable, unlike `WhyItemSubject.url`
  // (`string | null`) — the split the spec and two code comments make the
  // most noise about (why-view.ts, findings-guards.ts), and previously
  // unpinned by any test.
  test("rejects a changeSubject whose url is null — that field is non-nullable", () => {
    expect(
      laneFindingsFrom("why", {
        ...validWhy,
        changeSubject: {
          itemId: "i",
          entityId: "e",
          repo: "acme/web",
          number: 1,
          url: null,
          title: "t",
          modifiedAt: null,
        },
      }),
    ).toBeUndefined();
  });

  test("rejects a malformed itemSubject", () => {
    expect(
      laneFindingsFrom("why", {
        ...validWhy,
        itemSubject: {
          itemId: "i",
          entityId: "e",
          number: null,
          url: null,
          title: "t",
          modifiedAt: null,
          service: "jira",
          // `type` missing entirely — isWhyItemSubject requires it.
        },
      }),
    ).toBeUndefined();
  });
});

const validSource = {
  itemId: "github:acme/web#1",
  title: "Auth rewrite",
  url: "https://example.test/pr/1",
  service: "github",
  modifiedAt: 1_700_000_000_000,
};

const validGlossary = {
  kind: "glossary",
  agentVersion: 1,
  generatedAt: 1,
  latencyMs: 1,
  gaps: [],
  query: { term: "peek", limit: 5 },
  mode: "term",
  matchedVia: "exact",
  suggestions: [],
  stats: { total: 1, pending: 0, vetoed: 0, manual: 0, lastPassAt: null, truncatedSources: 0 },
  entries: [
    {
      term: "peek",
      definition: "A read that does not consume.",
      definitionSource: "snippet",
      docFreq: 6,
      score: 0.82,
      serviceSpread: 2,
      firstSeenAt: 1_600_000_000_000,
      lastSeenAt: 1_700_000_000_000,
      topSources: [validSource],
      synonyms: ["peeking"],
      nearMisses: ["peak"],
    },
  ],
};

describe("glossaryFindingsFrom", () => {
  test("projects a valid brief, dropping the base fields, stats, and mode", () => {
    // `mode` is on the wire (validGlossary carries it) but is not projected:
    // the renderer never reads it, so the guard does not gate on it either.
    expect(glossaryFindingsFrom(validGlossary)).toEqual({
      kind: "glossary",
      matchedVia: "exact",
      suggestions: [],
      entries: validGlossary.entries,
    });
  });

  test("accepts a miss with suggestions and no entries", () => {
    const miss = {
      ...validGlossary,
      mode: "miss",
      matchedVia: null,
      entries: [],
      suggestions: ["peak"],
    };
    expect(glossaryFindingsFrom(miss)?.kind).toBe("glossary");
  });

  test("accepts an unknown mode — it is not gated on", () => {
    // A field we do not render is not a field we gate on: the day the
    // gateway adds a new `mode` value, this lane must not lose its
    // structured render for a value no renderer would have consulted.
    expect(glossaryFindingsFrom({ ...validGlossary, mode: "something-new" })).not.toBeUndefined();
    const noMode = { ...validGlossary } as Record<string, unknown>;
    delete noMode["mode"];
    expect(glossaryFindingsFrom(noMode)).not.toBeUndefined();
  });

  test("accepts a null definition and a null definitionSource", () => {
    const e = { ...validGlossary.entries[0], definition: null, definitionSource: null };
    expect(glossaryFindingsFrom({ ...validGlossary, entries: [e] })).not.toBeUndefined();
  });

  test("accepts a source whose url is null", () => {
    const e = { ...validGlossary.entries[0], topSources: [{ ...validSource, url: null }] };
    expect(glossaryFindingsFrom({ ...validGlossary, entries: [e] })).not.toBeUndefined();
  });

  test("rejects an unknown matchedVia or definitionSource", () => {
    expect(glossaryFindingsFrom({ ...validGlossary, matchedVia: "fuzzy" })).toBeUndefined();
    const e = { ...validGlossary.entries[0], definitionSource: "guess" };
    expect(glossaryFindingsFrom({ ...validGlossary, entries: [e] })).toBeUndefined();
  });

  test("rejects malformed elements rather than rendering a partial list", () => {
    // The SDK-style shallow guard would admit these; ours must not.
    expect(glossaryFindingsFrom({ ...validGlossary, entries: [42] })).toBeUndefined();
    expect(glossaryFindingsFrom({ ...validGlossary, suggestions: [null] })).toBeUndefined();
    const e = { ...validGlossary.entries[0], topSources: [null] };
    expect(glossaryFindingsFrom({ ...validGlossary, entries: [e] })).toBeUndefined();
    const e2 = { ...validGlossary.entries[0], synonyms: [7] };
    expect(glossaryFindingsFrom({ ...validGlossary, entries: [e2] })).toBeUndefined();
  });

  test("rejects a date string where an epoch number is required", () => {
    const e = { ...validGlossary.entries[0], lastSeenAt: "2026-01-01T00:00:00Z" };
    expect(glossaryFindingsFrom({ ...validGlossary, entries: [e] })).toBeUndefined();
  });
});

describe("GlossaryFindings pins the fields we read", () => {
  // Same reason as the existing WhyFindings pin: these are local mirrors of a
  // type another repo owns, and nothing enforces they stay in step. A rename
  // upstream surfaces here as a failure rather than as a wrong render.
  test("carries exactly the four projected keys", () => {
    const value: GlossaryFindings = {
      kind: "glossary",
      entries: [],
      matchedVia: null,
      suggestions: [],
    };
    expect(Object.keys(value).sort()).toEqual(["entries", "kind", "matchedVia", "suggestions"]);
  });
});

const validEvidence = {
  kind: "pr",
  entityId: "e1",
  itemId: "github:acme/web#7",
  label: "Adopt SQLite WAL",
  url: "https://example.test/pr/7",
  occurredAt: 1_700_000_000_000,
};

const validDecisions = {
  kind: "decisions",
  agentVersion: 1,
  generatedAt: 1,
  latencyMs: 1,
  gaps: [],
  query: { sinceMs: 1, service: "github", minConfidence: 0.5, explain: false },
  stats: { total: 1, pending: 0, extracted: 1, vetoed: 0, lastPassAt: null, truncatedSources: 2 },
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
      evidence: [validEvidence],
      explain: [],
      matchedVia: "repo",
    },
  ],
};

describe("decisionsFindingsFrom", () => {
  test("projects a valid brief, keeping only truncatedSources from stats", () => {
    const out = decisionsFindingsFrom(validDecisions);
    expect(out?.kind).toBe("decisions");
    expect(out).toMatchObject({ truncatedSources: 2 });
    expect(Object.keys(out ?? {}).sort()).toEqual(["entries", "kind", "truncatedSources"]);
  });

  test("accepts agentVersion values other than 1", () => {
    // DecisionsBrief types agentVersion as `number`, unlike every other brief's
    // literal 1. Asserting === 1 here would reject valid briefs.
    expect(decisionsFindingsFrom({ ...validDecisions, agentVersion: 2 })).not.toBeUndefined();
  });

  test("accepts nullable rationale, extractionSource, and evidence ids", () => {
    const e = { ...validDecisions.entries[0], rationale: null, extractionSource: null };
    expect(decisionsFindingsFrom({ ...validDecisions, entries: [e] })).not.toBeUndefined();
    const ev = { ...validEvidence, entityId: null, itemId: null, url: null, occurredAt: null };
    const e2 = { ...validDecisions.entries[0], evidence: [ev] };
    expect(decisionsFindingsFrom({ ...validDecisions, entries: [e2] })).not.toBeUndefined();
  });

  test("rejects an unknown evidence kind or extraction source", () => {
    const ev = { ...validEvidence, kind: "tweet" };
    const e = { ...validDecisions.entries[0], evidence: [ev] };
    expect(decisionsFindingsFrom({ ...validDecisions, entries: [e] })).toBeUndefined();
    const e2 = { ...validDecisions.entries[0], extractionSource: "vibes" };
    expect(decisionsFindingsFrom({ ...validDecisions, entries: [e2] })).toBeUndefined();
  });

  test("rejects malformed elements rather than rendering a partial list", () => {
    expect(decisionsFindingsFrom({ ...validDecisions, entries: [null] })).toBeUndefined();
    const e = { ...validDecisions.entries[0], evidence: [42] };
    expect(decisionsFindingsFrom({ ...validDecisions, entries: [e] })).toBeUndefined();
    const e2 = { ...validDecisions.entries[0], alternatives: [null] };
    expect(decisionsFindingsFrom({ ...validDecisions, entries: [e2] })).toBeUndefined();
  });

  test("rejects a missing or non-numeric truncatedSources", () => {
    const s = { ...validDecisions.stats, truncatedSources: "2" };
    expect(decisionsFindingsFrom({ ...validDecisions, stats: s })).toBeUndefined();
    expect(decisionsFindingsFrom({ ...validDecisions, stats: {} })).toBeUndefined();
  });
});

describe("DecisionsFindings pins the fields we read", () => {
  test("carries exactly the three projected keys", () => {
    const value: DecisionsFindings = { kind: "decisions", entries: [], truncatedSources: 0 };
    expect(Object.keys(value).sort()).toEqual(["entries", "kind", "truncatedSources"]);
  });
});

const validEvidenceItem = {
  itemId: "github:acme/web#7",
  type: "pr_authored",
  serviceId: "github",
  title: "Adopt SQLite WAL",
  modifiedAt: 1_700_000_000_000,
  weight: 0.6,
};

const validExpert = {
  kind: "expert",
  agentVersion: 1,
  generatedAt: 1,
  latencyMs: 1,
  gaps: [],
  query: { topicOrFile: "src/index.ts", itemUrl: null },
  ranked: [
    {
      personId: "person:1",
      displayName: "Ada Lovelace",
      evidence: [validEvidenceItem],
      score: 0.91,
      confidence: "high",
    },
  ],
};

describe("expertFindingsFrom", () => {
  test("projects a valid brief, dropping the base fields", () => {
    expect(expertFindingsFrom(validExpert)).toEqual({
      kind: "expert",
      ranked: validExpert.ranked,
    });
  });

  test("rejects a ranked element missing displayName", () => {
    const finding = { ...validExpert.ranked[0] };
    const withoutDisplayName = { ...finding } as Record<string, unknown>;
    delete withoutDisplayName["displayName"];
    expect(expertFindingsFrom({ ...validExpert, ranked: [withoutDisplayName] })).toBeUndefined();
  });

  test("rejects an unknown confidence", () => {
    const finding = { ...validExpert.ranked[0], confidence: "certain" };
    expect(expertFindingsFrom({ ...validExpert, ranked: [finding] })).toBeUndefined();
  });

  test("rejects an unknown evidence type", () => {
    const ev = { ...validEvidenceItem, type: "carrier_pigeon" };
    const finding = { ...validExpert.ranked[0], evidence: [ev] };
    expect(expertFindingsFrom({ ...validExpert, ranked: [finding] })).toBeUndefined();
  });

  test("rejects malformed evidence elements rather than rendering a partial list", () => {
    // The SDK-style shallow guard would admit these; ours must not (§4.3).
    const finding = { ...validExpert.ranked[0], evidence: [42, null] };
    expect(expertFindingsFrom({ ...validExpert, ranked: [finding] })).toBeUndefined();
  });

  test("rejects malformed ranked elements rather than rendering a partial list", () => {
    expect(expertFindingsFrom({ ...validExpert, ranked: [42, null] })).toBeUndefined();
  });
});

describe("ExpertFindings pins the fields we read", () => {
  test("carries exactly the two projected keys", () => {
    const value: ExpertFindings = { kind: "expert", ranked: [] };
    expect(Object.keys(value).sort()).toEqual(["kind", "ranked"]);
  });
});

const validImpactFinding = {
  // `affectedItemId` is a `graph_entity.id`, not an item id - see findings.ts.
  // It is still accepted here (the field exists on the wire), just never
  // projected or rendered.
  category: "service",
  affectedItemId: "entity:456",
  affectedTitle: "billing-service",
  serviceId: "billing",
  hops: 1,
  pathSummary: "billing-service depends directly on payments-api",
};

const validImpact = {
  kind: "impact",
  agentVersion: 1,
  generatedAt: 1,
  latencyMs: 1,
  gaps: [],
  query: { fileOrPrUrl: "https://github.com/acme/web/pull/42" },
  startEntityId: "entity:123",
  affected: [validImpactFinding],
};

describe("impactFindingsFrom", () => {
  test("projects a valid brief, dropping the base fields and query", () => {
    expect(impactFindingsFrom(validImpact)).toEqual({
      kind: "impact",
      startEntityId: "entity:123",
      affected: validImpact.affected,
    });
  });

  test("accepts a null startEntityId - the start not resolving is a real state", () => {
    expect(impactFindingsFrom({ ...validImpact, startEntityId: null })).toEqual({
      kind: "impact",
      startEntityId: null,
      affected: validImpact.affected,
    });
  });

  test("rejects a missing startEntityId key", () => {
    const without = { ...validImpact } as Record<string, unknown>;
    delete without["startEntityId"];
    expect(impactFindingsFrom(without)).toBeUndefined();
  });

  test("rejects an unknown category", () => {
    const finding = { ...validImpactFinding, category: "database" };
    expect(impactFindingsFrom({ ...validImpact, affected: [finding] })).toBeUndefined();
  });

  test("rejects a non-numeric hops", () => {
    const finding = { ...validImpactFinding, hops: "1" };
    expect(impactFindingsFrom({ ...validImpact, affected: [finding] })).toBeUndefined();
  });

  test("rejects an element missing affectedTitle", () => {
    const finding = { ...validImpactFinding } as Record<string, unknown>;
    delete finding["affectedTitle"];
    expect(impactFindingsFrom({ ...validImpact, affected: [finding] })).toBeUndefined();
  });

  test("rejects malformed elements rather than rendering a partial list", () => {
    // The SDK-style shallow guard would admit these; ours must not (§4.3).
    expect(impactFindingsFrom({ ...validImpact, affected: [null] })).toBeUndefined();
    expect(impactFindingsFrom({ ...validImpact, affected: [42, null] })).toBeUndefined();
  });
});

describe("ImpactFindings pins the fields we read", () => {
  test("carries exactly the three projected keys", () => {
    const value: ImpactFindings = { kind: "impact", startEntityId: null, affected: [] };
    expect(Object.keys(value).sort()).toEqual(["affected", "kind", "startEntityId"]);
  });
});

describe("laneFindingsFrom is idempotent over its own projection", () => {
  // `sanitiseState` (agent-run-store.ts) re-runs `laneFindingsFrom` over the
  // STORED PROJECTION on every read — not the wire object. A guard that
  // cannot parse its own output silently destroys the findings it just
  // produced, on the very next repaint. This was a real, shipped bug:
  // `decisionsFindingsFrom` read `truncatedSources` from the nested wire
  // location (`stats.truncatedSources`) but emitted it flattened onto the
  // projection, so `laneFindingsFrom("decisions", laneFindingsFrom("decisions",
  // wire))` returned `undefined` — the lane silently fell back to prose on
  // every repaint in production. `why` and `glossary` happened to survive only
  // because their projections are already flat.
  //
  // EVERY arm of `LaneFindings` is listed here so a C8.3 arm that skips this
  // property is caught immediately, the same way this one was not.
  const IDEMPOTENCE_CASES: ReadonlyArray<
    readonly [Parameters<typeof laneFindingsFrom>[0], unknown]
  > = [
    ["why", validWhy],
    ["glossary", validGlossary],
    ["decisions", validDecisions],
    ["expert", validExpert],
    ["impact", validImpact],
  ];

  test.each(IDEMPOTENCE_CASES)("%s round-trips through its own projection", (lane, wire) => {
    const once = laneFindingsFrom(lane, wire);
    expect(once).not.toBeUndefined();
    const twice = laneFindingsFrom(lane, once);
    expect(twice).toEqual(once);
  });
});
