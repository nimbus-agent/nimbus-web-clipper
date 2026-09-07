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
  CatchupItem,
  CatchupSection,
  DecisionEvidence,
  Evidence,
  EvidenceKind,
  ExpertFinding,
  ExtractionSource,
  GapNote,
  GlossaryDefinitionSource,
  GlossaryEntry,
  GlossaryMatchedVia,
  GlossarySourceRef,
  ImpactFinding,
  OwnershipCoverage,
  OwnershipOwner,
  OwnershipTargetView,
  SynthesisDiscardReason,
  SynthesisProvenance,
  WhyChangeSubject,
  WhyFinding,
  WhyItemSubject,
  WhyLane,
  WhySubject,
} from "@nimbus-dev/sdk";

export type {
  CatchupItem,
  CatchupSection,
  DecisionEvidence,
  Evidence,
  EvidenceKind,
  ExpertFinding,
  ExtractionSource,
  GapNote,
  GlossaryDefinitionSource,
  GlossaryEntry,
  GlossaryMatchedVia,
  GlossarySourceRef,
  ImpactFinding,
  OwnershipCoverage,
  OwnershipOwner,
  OwnershipTargetView,
  SynthesisDiscardReason,
  SynthesisProvenance,
  WhyChangeSubject,
  WhyFinding,
  WhyItemSubject,
  WhyLane,
  WhySubject,
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
 * The `glossary` lane's payload, as a client projection (§4.1).
 *
 * `stats` is deliberately not projected: every field on it is a corpus-level
 * diagnostic the panel does not render. `gaps` is the honesty channel and lives
 * as a sibling on `LaneState`.
 */
export type GlossaryFindings = {
  readonly kind: "glossary";
  readonly entries: readonly GlossaryEntry[];
  /**
   * How the resolved term was matched. Rendered as a badge on the term
   * heading when `"synonym"` — a fact worth surfacing, since it tells the
   * reader the word they selected is not the canonical one. `"exact"` and
   * `null` render nothing extra.
   *
   * `mode` (list/term/miss) is deliberately NOT projected here, unlike
   * `matchedVia`: the renderer branches only on `entries.length`, never on
   * `mode`, so gating on it would reject briefs this client could render —
   * exactly the rule this module's header states.
   */
  readonly matchedVia: GlossaryMatchedVia;
  readonly suggestions: readonly string[];
};

/**
 * The gateway's own `DecisionsEntry` (`@nimbus-dev/sdk`) also carries `explain`
 * and `matchedVia`. This client type is a DELIBERATE NARROWING of that shape,
 * not a stand-in mirror awaiting SDK publication — see `DecisionsFindings`'s
 * comment below for why those two fields are dropped. Keep it hand-declared
 * (rather than importing the SDK's wider type) so this stays true: nothing here
 * claims a field `isDecisionsEntry` does not validate.
 */
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
 * The `expert` lane's payload, as a client projection of `ExpertBrief` (§4.1).
 *
 * `query` is not projected: the panel already knows what was asked (it asked
 * it), so echoing the topic back adds nothing the renderer needs. This is the
 * first of C8.3's four link-less lanes: `Evidence.itemId` is a genuine item
 * id, but this client has no id→URL resolver, so evidence titles render as
 * plain text, never as `findingLink`.
 */
export type ExpertFindings = {
  readonly kind: "expert";
  readonly ranked: readonly ExpertFinding[];
};

/**
 * The `impact` lane's payload, as a client projection of `ImpactBrief` (§4.1).
 *
 * `query` is not projected, same reasoning as `ExpertFindings`: the panel
 * already knows what was asked.
 *
 * **`ImpactFinding.affectedItemId` is not an item id.** It is a
 * `graph_entity.id` — every one of the gateway's five impact sub-lanes selects
 * `e.id FROM graph_entity` (`agents/impact.ts:218,264,308,343,378`). So is
 * `startEntityId`, or the synthetic `` `item:${id}` `` string on the topic arm.
 * Spec §4.6 records this. Neither field is rendered as an item reference, given
 * a resolver, or shown to the reader at all — `affectedTitle` is what a reader
 * can use, and this projection keeps `affectedItemId` only because the guard
 * validates the field the wire sends, not because anything downstream reads it.
 *
 * `startEntityId` stays `string | null` rather than being dropped: `null` means
 * the change's own start point did not resolve in the graph, which is a
 * reportable fact distinct from "nothing downstream is indexed" — collapsing
 * the two would make a real gap look like a clean, empty result.
 */
export type ImpactFindings = {
  readonly kind: "impact";
  readonly startEntityId: string | null;
  readonly affected: readonly ImpactFinding[];
};

/**
 * The `catchup` lane's payload, as a client projection of `CatchupBrief`
 * (§4.1). `query` is not projected, same reasoning as `ExpertFindings`: the
 * panel already knows what was asked (it asked for everything `sinceMs`).
 *
 * `selfPersonId` and `involvement` ARE kept, unlike `query` — they are not an
 * echo of the request, they are the whole basis on which the window was
 * filtered down to *this reader*, and the flattened markdown never prints
 * `involvement` at all. `involvement` is kept as the wire's own nested object,
 * verbatim, rather than flattened into sibling fields on this type: flattening
 * is exactly what made `decisionsFindingsFrom` fail its own idempotence check
 * (see that guard's comment), so every nested object in this projection is
 * copied through unchanged instead.
 *
 * `sections` keeps `CatchupSection`/`CatchupItem` as the SDK types them,
 * including `totalItemsInWindow` alongside `items` — the truncation fact a
 * reader needs to tell a quiet window from a truncated one, which the prose
 * also never prints.
 */
export type CatchupFindings = {
  readonly kind: "catchup";
  readonly selfPersonId: string | null;
  readonly involvement: {
    readonly ownedServices: readonly string[];
    readonly activeRepos: readonly string[];
    readonly incidentServices: readonly string[];
    readonly collaboratorPersonIds: readonly string[];
  };
  readonly sections: readonly CatchupSection[];
};

/**
 * The `ownership` lane's payload, as a client projection of `OwnershipBrief`
 * (§4.1). This is the last of C8.3's four link-less lanes, and the one that
 * carries no item id at all: `OwnershipOwner.externalId` is a PERSON id and
 * `OwnershipTargetView.displayPath` is a PATH, so there is no URL anywhere on
 * this brief to begin with — unlike `expert`/`impact`/`catchup`, which have
 * ids this client simply has no resolver for.
 *
 * `query` is not projected, same reasoning as `ExpertFindings`: the panel
 * already knows what was asked. The top-level `service: { id } | null` is
 * also dropped — it is redundant with `target`/`parentDirectory`'s own `kind`
 * (a `"service"` target already IS the service ownership answer), and no
 * render spec calls for a bare id line the reader cannot act on.
 *
 * `target` and `parentDirectory` are kept as `OwnershipTargetView | null`
 * VERBATIM, not flattened — see `CatchupFindings`'s comment for why every
 * nested object in these projections is copied through unchanged rather than
 * rebuilt field-by-field; that is exactly the flattening that broke
 * `decisionsFindingsFrom`'s idempotence.
 *
 * `coverage` is kept whole too, even though the renderer reads only
 * `lastPassAt` from it. Unlike `DecisionsFindings.truncatedSources` — where
 * the guard pulls one field out of `stats` and leaves the rest unchecked —
 * `isOwnershipCoverage` (findings-guards.ts) validates every one of
 * `OwnershipCoverage`'s ten counters, because a `coverage` object missing one
 * is a malformed brief, not a brief this client renders less of. Since the
 * guard validates the whole shape, keeping the whole shape here does not
 * claim a guarantee nothing checks — the same test `ImpactFindings.affected`
 * `.affectedItemId` passes despite not being rendered either.
 */
export type OwnershipFindings = {
  readonly kind: "ownership";
  readonly target: OwnershipTargetView | null;
  readonly parentDirectory: OwnershipTargetView | null;
  readonly coverage: OwnershipCoverage;
};

/**
 * The per-lane structured payload. ONE ARM PER SLICE: `why` in C8.1,
 * `glossary` and `decisions` in C8.2, the four link-less lanes in C8.3.
 *
 * A lane whose arm does not exist yet behaves exactly like a guard rejection —
 * no findings, prose body, and its gaps and provenance still render.
 */
export type LaneFindings =
  | WhyFindings
  | GlossaryFindings
  | DecisionsFindings
  | ExpertFindings
  | ImpactFindings
  | CatchupFindings
  | OwnershipFindings;
