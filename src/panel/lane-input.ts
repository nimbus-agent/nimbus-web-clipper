// src/panel/lane-input.ts
// What input does a lane need, where did it come from, and does the lane belong
// in this panel at all? Pure — no DOM, no messaging — so the rules that decide
// what the user sees are unit-testable on their own.
//
// This lives in its own module rather than inside panel-in-page.ts, which is the
// largest file in the repo: this is the module the logic belongs in, not a
// refactor of convenience. Before the lane path took an input, "which lanes
// render" was one `filter` over a surface table and reasonably lived inline; it
// is now a decision over four inputs with two independent gates, and inlining it
// would bury the C2.5 rule inside a 60-line repaint function.
import { normaliseTerm } from "../shared/term.ts";
import {
  AGENT_LANES,
  type AgentLane,
  LANE_RULES,
  laneBelongsOnSurface,
  type SurfaceKind,
} from "../shared/types.ts";

/**
 * The selected term, as far as this panel is concerned.
 *
 * `refused` is a first-class state rather than an absence, because the user made
 * a gesture and is owed an answer. Dropping an over-long selection on the floor
 * would make *Define in Nimbus* look broken; sending it truncated would answer
 * about a term they never selected.
 */
export type TermState =
  | { readonly kind: "none" }
  | { readonly kind: "ready"; readonly term: string }
  | { readonly kind: "refused"; readonly reason: "empty" | "too_long" };

/** Wrap a raw selection in the state the panel renders from. `null` — no
 *  selection was ever made — is the one input that yields `none`. */
export function termStateFrom(raw: string | null): TermState {
  if (raw === null) {
    return { kind: "none" };
  }
  const checked = normaliseTerm(raw);
  return checked.ok
    ? { kind: "ready", term: checked.term }
    : { kind: "refused", reason: checked.reason };
}

export interface LaneContext {
  /** The pinned page's recognised surface, or `null` when the recogniser
   *  rejected it. A page lane needs this; a term lane never consults it. */
  readonly surfaceKind: SurfaceKind | null;
  /**
   * Does the header name something the page lanes can answer about — a resolved
   * item, a dashboard's service, or a candidate the user picked out of an
   * ambiguous answer? False on a miss, an error, and on an ambiguous answer
   * nobody has picked from yet.
   */
  readonly pageSubject: boolean;
  /** The candidate the user picked, when the header is `chosen`. Carried into
   *  the request so the handler does not re-resolve into the same ambiguity. */
  readonly pickedItemId: string | null;
  readonly term: TermState;
  /**
   * The lanes the paired gateway can serve on this page, or `null` to filter
   * nothing — a capability read that failed must leave this panel exactly as it
   * rendered before capability discovery existed. Withholding every lane because
   * we could not ask is a bigger claim than the one we missed.
   *
   * `null` is not the same as "we did not learn", and this module must not treat
   * it as such. A failed roster read still arrives here as a PRESENT list on a
   * surface whose lanes need an arm only a new enough gateway serves — narrowed
   * to exactly the lanes that arm was never needed for. `offeredLanes`
   * (`background/agents-capability.ts`) makes that call; this side only applies
   * whatever it decided.
   */
  readonly offered: readonly AgentLane[] | null;
}

/**
 * Which lanes this panel shows, in `AGENT_LANES` order.
 *
 * Two independent gates, one per `LANE_RULES` arm, and neither may borrow the
 * other's condition:
 *
 * - a `page` lane needs a recognised surface it belongs on AND a subject in the
 *   header. Its whole input comes from the page, so no page means no lane.
 * - a `term` lane needs a term and nothing else — not a recognised surface, not
 *   a resolved item, not even a page the recogniser will admit to knowing. A
 *   `refused` term still shows the lane, because the refusal is what the user
 *   needs to see.
 */
export function lanesFor(ctx: LaneContext): readonly AgentLane[] {
  return AGENT_LANES.filter((lane) => {
    // The gateway's own answer, and it outranks both arms below: a lane this
    // gateway does not serve cannot be answered no matter how good the page is.
    if (ctx.offered !== null && !ctx.offered.includes(lane)) {
      return false;
    }
    if (LANE_RULES[lane].input === "term") {
      return ctx.term.kind !== "none";
    }
    return (
      ctx.pageSubject && ctx.surfaceKind !== null && laneBelongsOnSurface(lane, ctx.surfaceKind)
    );
  });
}

/**
 * The extra fields this lane's `agent-run`/`agent-state` carries.
 *
 * Deliberately returns the fields rather than a whole message: the two message
 * kinds differ only in `kind`, and they MUST agree on everything else — they key
 * the same cache entry, so a poll that omitted what the run sent would look up a
 * different subject and report `collapsed` forever. One source for both is what
 * makes that impossible rather than merely unlikely.
 *
 * A `refused` term yields no `term` field, and the caller must not send at all —
 * `lanesFor` shows that lane so the refusal can be rendered locally, never so a
 * request can go out without the input it needs.
 */
export function laneRequestInput(
  lane: AgentLane,
  ctx: LaneContext,
): { readonly itemId?: string; readonly term?: string } {
  if (LANE_RULES[lane].input === "term") {
    return ctx.term.kind === "ready" ? { term: ctx.term.term } : {};
  }
  return ctx.pickedItemId === null ? {} : { itemId: ctx.pickedItemId };
}

/** Is this lane ready to be asked anything? False for a term lane whose term was
 *  refused — the one case where a lane renders but must never send. */
export function laneCanRun(lane: AgentLane, ctx: LaneContext): boolean {
  return LANE_RULES[lane].input !== "term" || ctx.term.kind === "ready";
}
