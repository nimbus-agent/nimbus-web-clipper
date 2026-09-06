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
  | { readonly attempted: true; readonly used: true; readonly model: string; readonly remote: boolean }
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
 * The per-lane structured payload. ONE ARM PER SLICE: `why` here (C8.1),
 * expert/impact/ownership in C8.2, catchup/decisions/glossary in C8.3.
 *
 * A lane whose arm does not exist yet behaves exactly like a guard rejection —
 * no findings, prose body, and its gaps and provenance still render.
 */
export type LaneFindings = WhyFindings;
