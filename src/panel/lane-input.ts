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
import { gatePolicy } from "../shared/connector-health.ts";
import { normaliseTerm } from "../shared/term.ts";
import {
  AGENT_LANES,
  type AgentLane,
  type FileResolution,
  LANE_RULES,
  laneBelongsOnSurface,
  type Recognition,
  type SurfaceKind,
} from "../shared/types.ts";
import type { HeaderState } from "./panel-view.ts";

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
  /**
   * False only for a service (dashboard) header whose connector `gatePolicy` says
   * cannot serve lanes. Fails open: a header of any other kind is healthy here, so
   * "we don't know" never blanks the lanes. Read by `visibleLanes`, on `home` only.
   */
  readonly connectorHealthy: boolean;
}

/** Everything `laneContextFrom` derives a {@link LaneContext} from. The panel
 *  passes its own `shownHeader()`; the palette passes
 *  `withPick(headerFrom(...), chosenId)` — the same header, derived two ways. */
export interface LaneContextInput {
  readonly shown: HeaderState;
  readonly recognition: Recognition | null;
  readonly file: FileResolution | null;
  readonly offered: readonly AgentLane[] | null;
  readonly term: TermState;
}

/** Everything `lanesFor`/`laneRequestInput`/`laneCanRun` need, from one place —
 *  so a lane cannot be rendered under one context and then asked under another. */
export function laneContextFrom(input: LaneContextInput): LaneContext {
  const { shown, recognition, file } = input;
  return {
    surfaceKind: recognition?.ok === true ? recognition.kind : null,
    pageSubject:
      shown.kind === "resolved" ||
      shown.kind === "service" ||
      shown.kind === "chosen" ||
      // A file page's lanes are gated on the PROBE, not on the header: the header
      // is the same shape on a hit, a miss and an older gateway, and only a hit
      // has a subject to answer about.
      (shown.kind === "file" && file?.kind === "found"),
    pickedItemId: shown.kind === "chosen" ? shown.candidate.id : null,
    term: input.term,
    offered: input.offered,
    // On a dashboard, whether the agent lanes render at all is gated on the
    // connector's health (`gatePolicy`): three lanes that can only ever come back
    // empty read as "you have no work", not as "Nimbus cannot ask this connector
    // anything". `shown.kind === "service"` whenever the surface is `home` — see
    // `headerFrom` — so the `!== "service"` arm is unreachable in practice. It is
    // written to FAIL OPEN on purpose: "we don't know" means ungated, never blank,
    // so a `shown` of some other kind must not silently blank the lanes if that
    // invariant ever stops holding.
    connectorHealthy: shown.kind !== "service" || gatePolicy(shown.connector.state).lanes,
  };
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

/**
 * What the glossary agent's lane says when it will not send the selection.
 *
 * Rendered locally, without a round trip, because the panel is the side that
 * still has the user in front of it: the message boundary refuses the same input
 * (`isNormalisedTerm` in messages.ts), but a rejected message can only come back
 * as a transport error, which would tell the user Nimbus is broken when in fact
 * they selected three paragraphs.
 */
const TERM_MESSAGES: Record<"empty" | "too_long", string> = {
  too_long: "That's a passage, not a term — select a word or phrase.",
  empty: "Select a word or phrase first — this lane needs one.",
};

/** Why the current selection will not be sent. Only ever called for a lane
 *  `laneCanRun` refused, which is only ever a refused term. */
export function termRefusal(term: TermState): string {
  return term.kind === "refused" ? TERM_MESSAGES[term.reason] : TERM_MESSAGES.empty;
}

/**
 * The C2 agent lanes' summary labels — each phrased as the question its
 * agent answers. The wording is load-bearing, not decorative: see
 * `docs/architecture.md`'s "The agent lanes" section, which is where that
 * reasoning lives now that the design spec has been pruned.
 *
 * `Lane.title` (panel-view.ts) is caller-supplied by design, so the copy lives
 * here with the rule that decides which lanes show, not in the shared shell.
 */
const LANE_TITLES: Record<AgentLane, string> = {
  // The fallback only — a glossary lane with a term shows the TERM as its title
  // (see `laneTitle` below), because "Definition" repeated on every lane says
  // nothing about which word the user asked about.
  glossary: "Definition",
  impact: "What breaks if it lands",
  expert: "Who should review it",
  why: "Why does this change exist",
  catchup: "What happened while I was away",
  decisions: "What got decided",
  ownership: "Who owns what",
};

/**
 * The titles an ITEM surface asks for instead — the same three lanes, on a page
 * that is not a change under review.
 *
 * `LANE_TITLES` above was written for a pull request, and on one it is right:
 * "Why does this change exist" over a PR names exactly what the lane answers. On
 * a PagerDuty incident the same words are not merely awkward, they are false —
 * an incident is not a change. These are the spec's own phrasings (§4.2).
 */
const ITEM_SURFACE_TITLES: Partial<Record<AgentLane, string>> = {
  why: "How did we get here",
  expert: "Who should I talk to",
  ownership: "Who owns this",
};

/**
 * Which surfaces override which titles. An EXCEPTION table, deliberately not a
 * second copy of `LANE_TITLES`: an unlisted (lane, surface) pair falls straight
 * through to the title above, so `pr` and `home` keep the shipped copy written
 * for them and nothing but the changed words lives here.
 *
 * `issue` and `incident` share ONE object rather than two identical literals.
 * They are the same question asked about the same kind of thing — an indexed item
 * with a graph entity — and two copies would be two places for one wording to
 * drift.
 */
const SURFACE_LANE_TITLES: Partial<Record<SurfaceKind, Partial<Record<AgentLane, string>>>> = {
  issue: ITEM_SURFACE_TITLES,
  incident: ITEM_SURFACE_TITLES,
  /**
   * A file gets its own object rather than sharing `ITEM_SURFACE_TITLES`. `ownership`
   * happens to want the same words today, but an issue and a file are not the same
   * kind of thing — sharing the literal would tie two independent reasons to change.
   */
  file: {
    impact: "What breaks if this changes",
    expert: "Who knows this file",
    ownership: "Who owns this",
  },
};

/** A term lane wears its term as its title — "Definition" on every one of them
 *  would say nothing about which word was asked about. Quoted so a one-word
 *  term still reads as a quotation rather than as a heading this panel wrote.
 *
 *  Otherwise the surface may override the title (`SURFACE_LANE_TITLES`), and
 *  anything it does not name falls through to `LANE_TITLES`. `surfaceKind` is
 *  passed in rather than taken from the header or re-derived here: the title and
 *  the gate that decided to show this lane at all must answer from one surface,
 *  not two. */
export function laneTitle(
  lane: AgentLane,
  surfaceKind: SurfaceKind | null,
  term: TermState,
): string {
  if (lane === "glossary" && term.kind === "ready") {
    return `“${term.term}”`;
  }
  const override = surfaceKind === null ? undefined : SURFACE_LANE_TITLES[surfaceKind]?.[lane];
  return override ?? LANE_TITLES[lane];
}

/** One lane as a caller renders it: its title, and whether it may be asked. */
export interface VisibleLane {
  readonly lane: AgentLane;
  readonly title: string;
  readonly canRun: boolean;
  /** Present iff `!canRun`: why a refused term will not be sent. */
  readonly refusal?: string;
}

function visibleLane(lane: AgentLane, ctx: LaneContext): VisibleLane {
  const title = laneTitle(lane, ctx.surfaceKind, ctx.term);
  return laneCanRun(lane, ctx)
    ? { lane, title, canRun: true }
    : { lane, title, canRun: false, refusal: termRefusal(ctx.term) };
}

/**
 * The agent lanes a caller shows, titled — never `"related"`, which is not an
 * agent lane (see `showsRelated`).
 *
 * On a dashboard whose connector cannot serve lanes this is empty, glossary
 * included: three lanes that can only ever come back empty read as "you have no
 * work", not as "Nimbus cannot ask this connector anything".
 */
export function visibleLanes(ctx: LaneContext): readonly VisibleLane[] {
  if (ctx.surfaceKind === "home" && !ctx.connectorHealthy) {
    return [];
  }
  return lanesFor(ctx).map((lane) => visibleLane(lane, ctx));
}

/** No related lane on a dashboard: `/v1/clips/related` keyed on a dashboard's
 *  title and URL returns noise dressed as recall. The related REQUEST is still
 *  sent — after the resolve, once the recognition is known — its answer is
 *  simply not rendered. */
export function showsRelated(ctx: LaneContext): boolean {
  return ctx.surfaceKind !== "home";
}
