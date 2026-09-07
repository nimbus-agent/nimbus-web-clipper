// src/shared/findings-guards.ts
// Runtime guards for the typed half of an agent answer.
//
// These are written HERE rather than imported from @nimbus-dev/sdk on purpose.
// The SDK's guards (`isWhyBrief` and friends, built by `createBriefGuard`) are
// DISPATCH-level: they check `kind`, `agentVersion`, that `gaps` is an array, two
// numbers, and one bare `Array.isArray(b.findings)`. No element is ever
// validated, so `isWhyBrief` asserts `WhyBrief` over `{ findings: [42, null] }`.
// Rendering from that is the "type narrow, runtime wide" bug this codebase keeps
// hitting: the guard licenses the renderer to trust fields nobody checked.
//
// So each guard validates exactly the fields the renderer reads, to the depth it
// reads them - and no further. A field we do not render is not a field we gate
// on, because an over-strict guard rejects briefs we could have rendered.
import type {
  DecisionEvidence,
  DecisionsEntry,
  DecisionsFindings,
  Evidence,
  ExpertFinding,
  ExpertFindings,
  GapNote,
  GlossaryEntry,
  GlossaryFindings,
  GlossaryMatchedVia,
  GlossarySourceRef,
  LaneFindings,
  SynthesisDiscardReason,
  SynthesisProvenance,
  WhyChangeSubject,
  WhyFinding,
  WhyFindings,
  WhyItemSubject,
  WhySubject,
} from "./findings.ts";
import type { AgentLane } from "./types.ts";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isNullableNumber(v: unknown): v is number | null {
  return v === null || typeof v === "number";
}

const GAP_CATEGORIES = [
  "missing_entity_type",
  "missing_relation_emit",
  "missing_connector",
  "missing_user_identity",
  "empty_index",
] as const;

function isGapNote(v: unknown): v is GapNote {
  return (
    isObject(v) &&
    typeof v["category"] === "string" &&
    (GAP_CATEGORIES as readonly string[]).includes(v["category"]) &&
    typeof v["detail"] === "string" &&
    (v["remediation"] === undefined || typeof v["remediation"] === "string")
  );
}

/**
 * Validate a `gaps` ARRAY — the field value, not the object holding it.
 *
 * Takes a field so it is symmetric with `synthesisFrom` and `laneFindingsFrom`:
 * every guard in this module validates one field, and `gapsOfBrief` below is the
 * only thing that knows `gaps` lives inside a brief. Two single-purpose
 * functions rather than one that accepts either shape — a guard that takes both
 * cannot tell a caller passing the right thing from one passing the wrong thing.
 *
 * All-or-nothing per array: one malformed note discards the set rather than
 * rendering a partial list under a heading that implies completeness.
 */
export function gapNotesFrom(raw: unknown): readonly GapNote[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw.every(isGapNote) ? (raw as readonly GapNote[]) : undefined;
}

/**
 * Read `gaps` off ANY agent brief, without knowing which agent answered.
 *
 * `gaps` sits on `AgentBriefBase`, so every one of the seven carries it — which
 * is what lets C8.1 keep the design's promise of gaps on all seven lanes while
 * only `why` has a findings arm. This is the wire-side reader; the stored side
 * already holds the array and calls `gapNotesFrom` directly.
 */
export function gapsOfBrief(brief: unknown): readonly GapNote[] | undefined {
  return isObject(brief) ? gapNotesFrom(brief["gaps"]) : undefined;
}

const DISCARD_REASONS = [
  "timeout",
  "contract_violation",
  "egress_append_failed",
  "provider_error",
  "empty_result",
] as const;

const NOT_ATTEMPTED_REASONS = [
  "disabled",
  "no_eligible_provider",
  "reserved_extraction_failed",
] as const;

/**
 * The `{ attempted: false }` arm — synthesis was never attempted, and `reason`
 * says why not. One of `NOT_ATTEMPTED_REASONS`, or the whole object is
 * rejected rather than accepted with a reason the renderer cannot label.
 */
function notAttemptedSynthesis(raw: Record<string, unknown>): SynthesisProvenance | undefined {
  return typeof raw["reason"] === "string" &&
    (NOT_ATTEMPTED_REASONS as readonly string[]).includes(raw["reason"])
    ? { attempted: false, reason: raw["reason"] as (typeof NOT_ATTEMPTED_REASONS)[number] }
    : undefined;
}

/**
 * The `{ attempted: true, used: true }` arm. `remote` is the local/remote bit
 * and is REQUIRED on this arm. A brief that says a model wrote it but will not
 * say where is not one we render a provenance claim from.
 */
function usedSynthesis(raw: Record<string, unknown>): SynthesisProvenance | undefined {
  return typeof raw["model"] === "string" && typeof raw["remote"] === "boolean"
    ? { attempted: true, used: true, model: raw["model"], remote: raw["remote"] }
    : undefined;
}

/**
 * The `{ attempted: true, used: false }` arm — synthesis ran but was
 * discarded. `violations` is accepted only as an array of strings; absent
 * optional keys (`violations`, `detail`) stay ABSENT via the spread-omit
 * idiom below rather than becoming explicit `undefined` values.
 */
function discardedSynthesis(raw: Record<string, unknown>): SynthesisProvenance | undefined {
  if (
    typeof raw["reason"] !== "string" ||
    !(DISCARD_REASONS as readonly string[]).includes(raw["reason"])
  ) {
    return undefined;
  }
  const violations = raw["violations"];
  if (
    violations !== undefined &&
    !(Array.isArray(violations) && violations.every((v) => typeof v === "string"))
  ) {
    return undefined;
  }
  if (raw["detail"] !== undefined && typeof raw["detail"] !== "string") {
    return undefined;
  }
  return {
    attempted: true,
    used: false,
    reason: raw["reason"] as SynthesisDiscardReason,
    ...(violations === undefined ? {} : { violations: violations as readonly string[] }),
    ...(raw["detail"] === undefined ? {} : { detail: raw["detail"] as string }),
  };
}

export function synthesisFrom(raw: unknown): SynthesisProvenance | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  if (raw["attempted"] === false) {
    return notAttemptedSynthesis(raw);
  }
  if (raw["attempted"] !== true) {
    return undefined;
  }
  if (raw["used"] === true) {
    return usedSynthesis(raw);
  }
  if (raw["used"] !== false) {
    return undefined;
  }
  return discardedSynthesis(raw);
}

const WHY_LANES = [
  "authorship",
  "pull_request",
  "ticket",
  "discussion",
  "driver",
  "downstream",
] as const;

function isWhyFinding(v: unknown): v is WhyFinding {
  return (
    isObject(v) &&
    typeof v["lane"] === "string" &&
    (WHY_LANES as readonly string[]).includes(v["lane"]) &&
    typeof v["title"] === "string" &&
    typeof v["detail"] === "string" &&
    isNullableString(v["url"]) &&
    // Epoch ms. Every timestamp on this wire is a number - the gateway and the
    // SDK both type it so. A date STRING is a malformed value, not an
    // alternative encoding, and must not be parsed into acceptance.
    isNullableNumber(v["occurredAt"]) &&
    isNullableString(v["entityId"])
  );
}

function isWhySubject(v: unknown): v is WhySubject {
  return (
    isObject(v) &&
    typeof v["repoRoot"] === "string" &&
    typeof v["filePath"] === "string" &&
    isNullableNumber(v["lineNo"]) &&
    isNullableString(v["symbol"])
  );
}

function isWhyChangeSubject(v: unknown): v is WhyChangeSubject {
  return (
    isObject(v) &&
    typeof v["itemId"] === "string" &&
    typeof v["entityId"] === "string" &&
    typeof v["repo"] === "string" &&
    isNullableNumber(v["number"]) &&
    // NON-NULLABLE here, unlike WhyItemSubject.url. One null-check cannot span
    // the two arms; the types genuinely differ.
    typeof v["url"] === "string" &&
    typeof v["title"] === "string" &&
    isNullableNumber(v["modifiedAt"])
  );
}

function isWhyItemSubject(v: unknown): v is WhyItemSubject {
  return (
    isObject(v) &&
    typeof v["itemId"] === "string" &&
    typeof v["entityId"] === "string" &&
    isNullableNumber(v["number"]) &&
    isNullableString(v["url"]) &&
    typeof v["title"] === "string" &&
    isNullableNumber(v["modifiedAt"]) &&
    typeof v["service"] === "string" &&
    typeof v["type"] === "string"
  );
}

/** `absent | null` both normalise to null: the renderer asks "is there one?". */
function optionalSubject<T>(v: unknown, is: (x: unknown) => x is T): T | null | undefined {
  if (v === undefined || v === null) {
    return null;
  }
  return is(v) ? v : undefined;
}

function whyFindingsFrom(raw: Record<string, unknown>): WhyFindings | undefined {
  if (!Array.isArray(raw["findings"]) || !raw["findings"].every(isWhyFinding)) {
    return undefined;
  }
  const subject = optionalSubject(raw["subject"], isWhySubject);
  const changeSubject = optionalSubject(raw["changeSubject"], isWhyChangeSubject);
  const itemSubject = optionalSubject(raw["itemSubject"], isWhyItemSubject);
  if (subject === undefined || changeSubject === undefined || itemSubject === undefined) {
    return undefined;
  }
  return {
    kind: "why",
    findings: raw["findings"] as readonly WhyFinding[],
    subject,
    changeSubject,
    itemSubject,
  };
}

const GLOSSARY_MATCHED_VIA = ["exact", "synonym"] as const;
const GLOSSARY_DEFINITION_SOURCES = ["llm", "snippet", "manual"] as const;

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isGlossarySourceRef(v: unknown): v is GlossarySourceRef {
  return (
    isObject(v) &&
    typeof v["itemId"] === "string" &&
    typeof v["title"] === "string" &&
    isNullableString(v["url"]) &&
    typeof v["service"] === "string" &&
    typeof v["modifiedAt"] === "number"
  );
}

function isGlossaryEntry(v: unknown): v is GlossaryEntry {
  return (
    isObject(v) &&
    typeof v["term"] === "string" &&
    isNullableString(v["definition"]) &&
    (v["definitionSource"] === null ||
      (typeof v["definitionSource"] === "string" &&
        (GLOSSARY_DEFINITION_SOURCES as readonly string[]).includes(v["definitionSource"]))) &&
    typeof v["docFreq"] === "number" &&
    typeof v["score"] === "number" &&
    typeof v["serviceSpread"] === "number" &&
    typeof v["firstSeenAt"] === "number" &&
    typeof v["lastSeenAt"] === "number" &&
    Array.isArray(v["topSources"]) &&
    v["topSources"].every(isGlossarySourceRef) &&
    isStringArray(v["synonyms"]) &&
    isStringArray(v["nearMisses"])
  );
}

export function glossaryFindingsFrom(raw: Record<string, unknown>): GlossaryFindings | undefined {
  // `mode` is deliberately NOT gated on — the renderer never reads it (it
  // branches on `entries.length` instead), so it is not projected either. See
  // `GlossaryFindings`'s own comment.
  const matchedVia = raw["matchedVia"];
  if (
    matchedVia !== null &&
    !(
      typeof matchedVia === "string" &&
      (GLOSSARY_MATCHED_VIA as readonly string[]).includes(matchedVia)
    )
  ) {
    return undefined;
  }
  if (!Array.isArray(raw["entries"]) || !raw["entries"].every(isGlossaryEntry)) {
    return undefined;
  }
  if (!isStringArray(raw["suggestions"])) {
    return undefined;
  }
  return {
    kind: "glossary",
    matchedVia: matchedVia as GlossaryMatchedVia,
    entries: raw["entries"] as readonly GlossaryEntry[],
    suggestions: raw["suggestions"],
  };
}

const EVIDENCE_KINDS = ["source", "pr", "commit", "migration", "iac", "adr"] as const;
const EXTRACTION_SOURCES = ["llm", "snippet"] as const;

function isDecisionEvidence(v: unknown): v is DecisionEvidence {
  return (
    isObject(v) &&
    typeof v["kind"] === "string" &&
    (EVIDENCE_KINDS as readonly string[]).includes(v["kind"]) &&
    isNullableString(v["entityId"]) &&
    isNullableString(v["itemId"]) &&
    typeof v["label"] === "string" &&
    isNullableString(v["url"]) &&
    isNullableNumber(v["occurredAt"])
  );
}

function isDecisionsEntry(v: unknown): v is DecisionsEntry {
  return (
    isObject(v) &&
    typeof v["id"] === "string" &&
    typeof v["statement"] === "string" &&
    isNullableString(v["rationale"]) &&
    isStringArray(v["alternatives"]) &&
    typeof v["confidence"] === "number" &&
    typeof v["decidedAt"] === "number" &&
    typeof v["hasAdr"] === "boolean" &&
    (v["extractionSource"] === null ||
      (typeof v["extractionSource"] === "string" &&
        (EXTRACTION_SOURCES as readonly string[]).includes(v["extractionSource"]))) &&
    Array.isArray(v["evidence"]) &&
    v["evidence"].every(isDecisionEvidence)
  );
}

export function decisionsFindingsFrom(raw: Record<string, unknown>): DecisionsFindings | undefined {
  // NOTE: `agentVersion` is deliberately NOT checked against the literal 1.
  // `DecisionsBrief` types it as `number`, unlike every other brief, so
  // asserting 1 would reject valid briefs.
  if (!Array.isArray(raw["entries"]) || !raw["entries"].every(isDecisionsEntry)) {
    return undefined;
  }
  // Accept the wire shape (stats.truncatedSources) AND this module's own
  // projection (a flat truncatedSources): sanitiseState re-runs this guard over
  // the STORED projection on every read, so a guard that cannot parse its own
  // output silently destroys the findings it just produced.
  const stats = raw["stats"];
  const truncated =
    stats === undefined
      ? raw["truncatedSources"]
      : isObject(stats)
        ? stats["truncatedSources"]
        : undefined;
  if (typeof truncated !== "number") {
    return undefined;
  }
  return {
    kind: "decisions",
    entries: raw["entries"] as readonly DecisionsEntry[],
    truncatedSources: truncated,
  };
}

const EVIDENCE_TYPES = [
  "pr_authored",
  "pr_reviewed",
  "issue_opened",
  "issue_resolved",
  "incident_resolved",
  "commit_authored",
  "chat_mention",
  "chat_post",
] as const;

const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

function isEvidence(v: unknown): v is Evidence {
  return (
    isObject(v) &&
    typeof v["itemId"] === "string" &&
    typeof v["type"] === "string" &&
    (EVIDENCE_TYPES as readonly string[]).includes(v["type"]) &&
    typeof v["serviceId"] === "string" &&
    typeof v["title"] === "string" &&
    typeof v["modifiedAt"] === "number" &&
    typeof v["weight"] === "number"
  );
}

function isExpertFinding(v: unknown): v is ExpertFinding {
  return (
    isObject(v) &&
    typeof v["personId"] === "string" &&
    typeof v["displayName"] === "string" &&
    Array.isArray(v["evidence"]) &&
    v["evidence"].every(isEvidence) &&
    typeof v["score"] === "number" &&
    typeof v["confidence"] === "string" &&
    (CONFIDENCE_LEVELS as readonly string[]).includes(v["confidence"])
  );
}

export function expertFindingsFrom(raw: Record<string, unknown>): ExpertFindings | undefined {
  if (!Array.isArray(raw["ranked"]) || !raw["ranked"].every(isExpertFinding)) {
    return undefined;
  }
  return {
    kind: "expert",
    ranked: raw["ranked"] as readonly ExpertFinding[],
  };
}

/**
 * Narrow a raw `findings` payload against the lane that asked for it.
 *
 * `undefined` for a lane with no arm yet (six of seven in C8.1), for a payload
 * whose `kind` disagrees with the lane, and for anything malformed. Every one of
 * those means the same thing to the caller: render the prose brief.
 */
export function laneFindingsFrom(lane: AgentLane, raw: unknown): LaneFindings | undefined {
  if (!isObject(raw) || raw["kind"] !== lane) {
    return undefined;
  }
  // One arm per slice. A lane not listed is not an error, it is a lane whose
  // structure this build does not model yet.
  if (lane === "why") {
    return whyFindingsFrom(raw);
  }
  if (lane === "glossary") {
    return glossaryFindingsFrom(raw);
  }
  if (lane === "decisions") {
    return decisionsFindingsFrom(raw);
  }
  if (lane === "expert") {
    return expertFindingsFrom(raw);
  }
  return undefined;
}
