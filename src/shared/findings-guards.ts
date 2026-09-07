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
  GapNote,
  LaneFindings,
  SynthesisDiscardReason,
  SynthesisProvenance,
  WhyChangeSubject,
  WhyFinding,
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

function whyFindingsFrom(raw: Record<string, unknown>): LaneFindings | undefined {
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
  // One arm per slice. C8.2 and C8.3 add cases here; a lane not listed is not an
  // error, it is a lane whose structure this build does not model yet.
  return lane === "why" ? whyFindingsFrom(raw) : undefined;
}
