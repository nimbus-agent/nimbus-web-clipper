// src/shared/findings.ts
// The typed half of an agent answer.
//
// The gateway sends `findings` — the full typed brief — alongside the flattened
// `brief` markdown on every agent run, and has since the route shipped. This
// module is where those shapes are named. See
// docs/superpowers/specs/2026-09-06-the-answer-has-structure-design.md.
//
// Types come from @nimbus-dev/sdk where it publishes them, and are mirrored here
// where it does not (§4.2). Every import from the SDK is `import type`: a value
// import would put SDK code into the shipped bundle, which the "bundled, no
// runtime deps" rule forbids.
import type {
  GapNote,
  WhyChangeSubject,
  WhyFinding,
  WhyItemSubject,
  WhyLane,
  WhySubject,
} from "@nimbus-dev/sdk";

export type { GapNote, WhyChangeSubject, WhyFinding, WhyItemSubject, WhyLane, WhySubject };

/**
 * Why a synthesized rewrite was, or was not, used.
 *
 * MIRRORED, not imported: this is declared in the gateway's
 * `agents/_lib/synthesize.ts` and is exported nowhere in @nimbus-dev/sdk — the
 * SDK models brief SHAPES, and provenance is a property of the response that
 * carries one. Publishing it upstream is tracked in the design's §9; until then
 * this is the fourth local mirror, and the only one C8.1 cannot defer, because
 * provenance is a universal field (§4.1).
 *
 * `remote` exists ONLY on the `used: true` arm. That is the local/remote bit —
 * do not look for it elsewhere.
 */
export type SynthesisDiscardReason =
  | "timeout"
  | "contract_violation"
  | "egress_append_failed"
  | "provider_error"
  | "empty_result";

export type SynthesisProvenance =
  | {
      readonly attempted: false;
      readonly reason: "disabled" | "no_eligible_provider" | "reserved_extraction_failed";
    }
  | {
      readonly attempted: true;
      readonly used: true;
      readonly model: string;
      readonly remote: boolean;
    }
  | {
      readonly attempted: true;
      readonly used: false;
      readonly reason: SynthesisDiscardReason;
      readonly violations?: readonly string[];
      readonly detail?: string;
    };

/**
 * The `why` lane's payload, as a CLIENT PROJECTION of `WhyBrief`.
 *
 * Not the SDK type verbatim, deliberately (§4.1): the base fields
 * (`gaps`, `agentVersion`, `generatedAt`, `latencyMs`) are NOT duplicated here.
 * `gaps` is stored once as a sibling of `findings` on `LaneState`, so it survives
 * a findings drop and is available on lanes whose arm does not exist yet. What
 * this type holds is what this client renders, which is also what the byte bound
 * in agent-run-store.ts is protecting.
 *
 * The three subjects are alternatives, never a union — the gateway upholds that
 * and the type cannot. A renderer reads whichever is non-null and must not
 * assume the other two are absent keys rather than nulls.
 */
export type WhyFindings = {
  readonly kind: "why";
  readonly findings: readonly WhyFinding[];
  readonly subject: WhySubject | null;
  readonly changeSubject: WhyChangeSubject | null;
  readonly itemSubject: WhyItemSubject | null;
};

/**
 * How a queried term was resolved; `null` when nothing matched.
 *
 * MIRRORED, not imported — `glossary` is one of the three briefs
 * `@nimbus-dev/sdk` deliberately does not publish (its `agent-names.ts` states
 * that lagging the gateway is the intended state). Retiring this mirror is
 * tracked in the design's §9. Source of truth:
 * `packages/gateway/src/agents/_lib/glossary-types.ts` in the Nimbus repo.
 */
export type GlossaryMatchedVia = "exact" | "synonym" | null;

/** Where a definition came from. `null` when the term has no definition yet. */
export type GlossaryDefinitionSource = "llm" | "snippet" | "manual";

export type GlossarySourceRef = {
  readonly itemId: string;
  readonly title: string;
  /** The only URL in the glossary tree. Null when the indexed item carried none. */
  readonly url: string | null;
  readonly service: string;
  readonly modifiedAt: number;
};

export type GlossaryEntry = {
  readonly term: string;
  readonly definition: string | null;
  readonly definitionSource: GlossaryDefinitionSource | null;
  readonly docFreq: number;
  /**
   * The value the list is ORDERED by. Rendered deliberately: upstream records
   * that showing only `docFreq` while sorting on this made the visible number
   * contradict the visible order.
   */
  readonly score: number;
  readonly serviceSpread: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly topSources: readonly GlossarySourceRef[];
  readonly synonyms: readonly string[];
  readonly nearMisses: readonly string[];
};

/**
 * The `glossary` lane's payload, as a client projection (§4.1).
 *
 * `stats` is deliberately not projected: every field on it is a corpus-level
 * diagnostic the panel does not render. `gaps` is the honesty channel and lives
 * as a sibling on `LaneState`.
 */
export type GlossaryFindings = {
  readonly kind: "glossary";
  /** `term` = resolved; `miss` = unknown term with suggestions; `list` = no argument. */
  readonly mode: "list" | "term" | "miss";
  readonly entries: readonly GlossaryEntry[];
  readonly matchedVia: GlossaryMatchedVia;
  readonly suggestions: readonly string[];
};

/**
 * MIRRORED, not imported — `decisions` is the second of the three briefs
 * `@nimbus-dev/sdk` does not publish. Source of truth:
 * `packages/gateway/src/decisions/decision-types.ts` and
 * `agents/_lib/decisions-types.ts` in the Nimbus repo. Retiring this mirror is
 * tracked in the design's §9.
 */
export type EvidenceKind = "source" | "pr" | "commit" | "migration" | "iac" | "adr";

/** How the decision was extracted from its source. */
export type ExtractionSource = "llm" | "snippet";

export type DecisionEvidence = {
  readonly kind: EvidenceKind;
  readonly entityId: string | null;
  readonly itemId: string | null;
  readonly label: string;
  /** The only URL in the decisions tree. */
  readonly url: string | null;
  readonly occurredAt: number | null;
};

export type DecisionsEntry = {
  readonly id: string;
  readonly statement: string;
  readonly rationale: string | null;
  readonly alternatives: readonly string[];
  readonly confidence: number;
  readonly decidedAt: number;
  readonly hasAdr: boolean;
  readonly extractionSource: ExtractionSource | null;
  readonly evidence: readonly DecisionEvidence[];
};

/**
 * The `decisions` lane's payload, as a client projection (§4.1).
 *
 * `explain` is not projected: it is populated only when the caller asks for it
 * and this client never does, so it is always empty. `matchedVia` is a routing
 * detail of the service filter, not something a reader can act on. From `stats`
 * only `truncatedSources` survives — it is the honesty signal, and the rest are
 * corpus diagnostics.
 */
export type DecisionsFindings = {
  readonly kind: "decisions";
  readonly entries: readonly DecisionsEntry[];
  /**
   * How many source items in this window were indexed with a truncated body.
   * Rendered as a caveat: a decision extracted from a cut body may be partial.
   */
  readonly truncatedSources: number;
};

/**
 * The per-lane structured payload. ONE ARM PER SLICE: `why` in C8.1,
 * `glossary` and `decisions` in C8.2, the four link-less lanes in C8.3.
 *
 * A lane whose arm does not exist yet behaves exactly like a guard rejection —
 * no findings, prose body, and its gaps and provenance still render.
 */
export type LaneFindings = WhyFindings | GlossaryFindings;
