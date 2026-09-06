import { describe, expect, test } from "vitest";
import type { SynthesisProvenance, WhyFindings } from "../../src/shared/findings.ts";
import {
  gapNotesFrom,
  gapsOfBrief,
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
});
