// src/panel/panel-in-page.ts
// Injected as dist/<target>/panel.js. Self-toggling: re-injection closes an open
// panel. Mounts a Shadow-DOM overlay (inlined styles — no web_accessible_resources),
// reads the page context, asks the SW for related items, and renders them.
import { sendMessage } from "../browser/runtime.ts";
import { declaredCanonicalHref, resolveCanonical } from "../shared/canonical.ts";
import { isCapturedCopy } from "../shared/capture-offer.ts";
import { gatePolicy } from "../shared/connector-health.ts";
import {
  type ClipResponse,
  isAgentStateResponse,
  isCaptureResponse,
  isFetchResponse,
  isRecognitionResponse,
  isRelatedResponse,
  isResolveResponse,
} from "../shared/messages.ts";
import { PANEL_HOST_ID, type PanelSelection } from "../shared/panel-host.ts";
import type { ClipPreview } from "../shared/preview.ts";
import { sameItem, surfaceLine } from "../shared/recognise/index.ts";
import {
  AGENT_LANES,
  type AgentLane,
  type CaptureError,
  type CaptureResult,
  type FetchTarget,
  type LaneState,
  type Product,
  type Recognition,
  type RelatedHit,
  type ResolveCandidate,
} from "../shared/types.ts";
import {
  type LaneContext,
  laneCanRun,
  laneRequestInput,
  lanesFor,
  type TermState,
  termStateFrom,
} from "./lane-input.ts";
import {
  type HeaderState,
  type Lane,
  renderError,
  renderHits,
  renderLaneBody,
  renderShell,
} from "./panel-view.ts";

const HOST_ID = PANEL_HOST_ID;

/**
 * What the panel says when it will not send a selection to the glossary agent.
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

/**
 * The four ways `capture` can refuse, each answered honestly rather than with
 * one generic failure — same pattern as `RESOLVE_MESSAGES`/`FETCH_MESSAGES`
 * below, but total over `CaptureError`'s four members rather than falling
 * back for an open-ended reason set: there is nowhere else for a fifth
 * capture reason to come from.
 */
const CAPTURE_MESSAGES: Record<CaptureError, string> = {
  restricted: "Nimbus can't capture browser system pages.",
  "url-changed": "You've moved on — this panel is still about the page you opened it on.",
  "injection-failed": "Couldn't read this page.",
  empty: "There's nothing readable on this page to save.",
};

/**
 * Narrows the worker's `clip` response for the capture flow, without
 * importing popup.ts's own private copy of the same check (that module keeps
 * its own for the same reason: neither owns the other). A kind check alone is
 * enough here — this file only ever reads `.ok`/`.reason` off the result,
 * never a field `messages.ts`'s exported guards would need to validate.
 */
function isClipResponse(v: unknown): v is ClipResponse {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "clip";
}

const RELATED_MESSAGES: Record<string, string> = {
  not_paired: "Pair a browser first (Options).",
  unauthorized: "Pairing expired — re-pair in Options.",
  unreachable: "Can't reach Nimbus — is the gateway running?",
  server_error: "Nimbus had an error fetching related items.",
};

const RESOLVE_MESSAGES: Record<string, string> = {
  not_paired: "Pair with Nimbus in Options to see what it knows about this page.",
  unauthorized: "Nimbus rejected this pairing. Re-pair in Options.",
  unsupported: "This Nimbus gateway can't resolve pages yet.",
  unreachable: "Couldn't connect to Nimbus.",
  server_error: "Nimbus had an error resolving this page.",
  // `insufficient_scope` is handled BEFORE this map is consulted, in headerFrom
  // below — but only when `surface !== null`. That guard always holds in
  // practice: `handleResolve` calls the gateway only after `recognise()`
  // succeeds, and a 403 can only come back from a gateway call, so a 403 always
  // carries a surface. This entry exists as a fallback for that invariant alone
  // — if it were ever violated, this is the one message this branch went out of
  // its way to avoid reusing the generic "Couldn't resolve this page." for.
  insufficient_scope:
    "This pairing can't resolve pages yet. Run nimbus clip status to find this device, then nimbus clip scopes.",
};

// `insufficient_scope` and `timeout` are handled BEFORE this map is consulted,
// in `fetchOutcomeHeader` below, where they get their own first-class header
// states (`fetch-blocked`/`needs-fetch-scope` and `fetch-retry`/`still-working`)
// instead of a flat message. What's left here is the generic fallback for the
// remaining five `FetchError` reasons — `not_paired`, `unauthorized`,
// `unsupported`, `unreachable` and `server_error` — every one of them a
// designed, reachable outcome (a stale/missing pairing, a gateway with the
// route disabled, the network down, or an unexpected server failure), not an
// undesigned catch-all. This mirrors `RESOLVE_MESSAGES` above, which is the
// same fallback for the same five reasons on the resolve route.
const FETCH_MESSAGES: Record<string, string> = {
  not_paired: "Pair with Nimbus in Options to fetch this page.",
  unauthorized: "Nimbus rejected this pairing. Re-pair in Options.",
  unsupported: "This Nimbus gateway can't fetch pages yet.",
  unreachable: "Couldn't connect to Nimbus.",
  server_error: "Nimbus had an error fetching this page.",
};

/**
 * The C2 agent lanes' summary labels — each phrased as the question its
 * agent answers, matching the design spec's own naming
 * (docs/superpowers/specs/2026-08-10-c2-agent-lanes-design.md).
 *
 * Left here rather than moved into `panel-view.ts`, which nominally owns
 * render code but not a fixed copy table: `Lane.title` is caller-supplied by
 * design (see `Lane` in panel-view.ts) precisely so a lane's label lives with
 * its caller, not hardcoded into the shared shell. `RELATED_MESSAGES` /
 * `RESOLVE_MESSAGES` / `FETCH_MESSAGES` above are the same pattern for
 * per-outcome copy — this file, not panel-view.ts, is where copy keyed off a
 * caller-owned identifier (a lane id, an error reason) actually lives.
 * Consolidating all of it into panel-view.ts would mean changing that
 * contract for four tables at once, which is out of scope here.
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

/** How often an OPEN panel re-asks the worker for a running lane's state — a
 *  repaint cadence, not the worker's own poll of the gateway (which lives in
 *  service-worker.ts's tickAgentPoll and keeps running after this panel closes). */
const AGENT_POLL_MS = 1_000;

/** How often an OPEN, VISIBLE panel checks whether the tab has moved to a
 *  different indexed item. A string compare per tick; a `recognise` message goes
 *  out only when the URL has actually changed since the last check. */
const NAV_CHECK_MS = 500;

/**
 * Attaches a lane's `<details>` toggle listener — swallowing exactly the
 * FIRST toggle event the element ever receives if it just repeats the `open`
 * value the element was already created with, and delivering every other one
 * (including a genuine SECOND toggle on the same still-mounted element) to
 * `onToggle`.
 *
 * `renderLane` (panel-view.ts) sets `details.open = lane.expanded` on a
 * FRESH element every repaint. Per the HTML spec — confirmed directly in
 * jsdom, including on a still-detached element, regardless of when a
 * listener is attached relative to it — that queues a "toggle" task exactly
 * like a real click would, EVEN THOUGH nothing was clicked. Left unguarded,
 * every repaint of an already-expanded lane would replay as a fresh "expand"
 * — and if the caller's own state ever reads a value that its own toggle
 * handler treats as "never asked yet" while the lane sits open, each replay
 * would invoke a brand-new action, forever, from one real click. This
 * function holds as an INVARIANT over any repaint of any open lane — a
 * programmatic open that just repeats the element's own starting value is
 * never a user action — independent of whatever the caller's state happens
 * to be at the time.
 *
 * A pure DOM-level invariant, deliberately kept free of `AgentLane`/
 * `LaneState`/panel closure state so it is testable one level down from the
 * full panel: build an element with a starting `open` value, attach, and
 * assert whether `onToggle` fires — no panel state, message scripting, or
 * poll required. See its own tests in panel-in-page.test.ts.
 */
export function attachLaneToggle(el: HTMLDetailsElement, onToggle: (open: boolean) => void): void {
  let startedOpen: boolean | null = el.open;
  el.addEventListener("toggle", () => {
    const open = el.open;
    if (startedOpen !== null) {
      const synthetic = open === startedOpen;
      startedOpen = null;
      if (synthetic) {
        return;
      }
    }
    onToggle(open);
  });
}

// Inlined so the panel is fully self-contained. `:host { all: initial }` drops
// inherited page styles; only our own --nimbus-* tokens are referenced, with a
// dark set behind prefers-color-scheme (custom props survive `all: initial`).
const STYLES = `
:host {
  all: initial;
  --nimbus-bg: #ffffff;
  --nimbus-fg: #1a1a1a;
  --nimbus-muted: #666666;
  --nimbus-border: rgba(0, 0, 0, 0.12);
  --nimbus-accent: #2d6cdf;
}
@media (prefers-color-scheme: dark) {
  :host {
    --nimbus-bg: #1e1e1e;
    --nimbus-fg: #eaeaea;
    --nimbus-muted: #a0a0a0;
    --nimbus-border: rgba(255, 255, 255, 0.16);
    --nimbus-accent: #6ea8ff;
  }
}
.nimbus-related {
  position: fixed;
  top: 0;
  right: 0;
  width: 340px;
  height: 100vh;
  box-sizing: border-box;
  background: var(--nimbus-bg);
  color: var(--nimbus-fg);
  font-family: system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.4;
  border-left: 1px solid var(--nimbus-border);
  box-shadow: -2px 0 12px rgba(0, 0, 0, 0.18);
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
}
.nimbus-related__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--nimbus-border);
}
.nimbus-related__heading { margin: 0; font-size: 14px; font-weight: 600; }
.nimbus-related__close {
  all: unset;
  cursor: pointer;
  padding: 2px 8px;
  font-size: 16px;
  color: var(--nimbus-muted);
}
.nimbus-related__body { overflow-y: auto; padding: 8px 0; }
.nimbus-related__list { list-style: none; margin: 0; padding: 0; }
.nimbus-related__item { padding: 10px 16px; border-bottom: 1px solid var(--nimbus-border); }
.nimbus-related__title { display: block; font-weight: 600; color: var(--nimbus-accent); text-decoration: none; }
.nimbus-related__snippet { margin: 4px 0 0; color: var(--nimbus-muted); }
.nimbus-related__group-head { margin: 10px 0 4px; padding: 0 16px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
.nimbus-related__kind { display: inline-block; padding: 0 5px; border-radius: 3px; font-size: 10px; background: rgba(127,127,127,.18); }
.nimbus-related__age { margin: 2px 0 0; font-size: 11px; opacity: .55; }
.nimbus-related__status { padding: 16px; color: var(--nimbus-muted); overflow-wrap: anywhere; }
.nimbus-related__shell { display: flex; flex-direction: column; }
.nimbus-related__header-state { padding: 12px 16px; border-bottom: 1px solid var(--nimbus-border); }
.nimbus-related__header-state .nimbus-related__status { padding: 4px 0 0; }
.nimbus-related__navaway { padding: 10px 16px 12px; border-bottom: 1px solid var(--nimbus-border); }
.nimbus-related__navaway .nimbus-related__status { padding: 2px 0 4px; }
/* A capture refusal, appended BENEATH the header rather than replacing it —
   see captureRefusal, above in this file. No border of its own: it reads as
   a continuation of the header/offer above it, not a separate section. */
.nimbus-related__capture-refusal { padding: 0 16px 10px; }
.nimbus-related__capture-refusal .nimbus-related__status { padding: 0; }
.nimbus-related__navaway-lead { margin: 0; font-weight: 600; }
.nimbus-related__surface { margin: 0; font-weight: 600; }
.nimbus-related__header-item { margin: 4px 0 0; }
.nimbus-related__header-item a { color: var(--nimbus-accent); text-decoration: none; }
.nimbus-related__lane { border-bottom: 1px solid var(--nimbus-border); }
.nimbus-related__lane-title { cursor: pointer; padding: 10px 16px; font-weight: 600; }
.nimbus-related__candidates { list-style: none; margin: 4px 0 0; padding: 0; }
.nimbus-related__candidate {
  background: none; border: none; padding: 4px 0; cursor: pointer;
  color: var(--nimbus-accent); font: inherit; text-align: left;
}
.nimbus-related__candidate:hover { text-decoration: underline; }
.nimbus-related__action {
  background: none; border: none; padding: 4px 0; cursor: pointer;
  color: var(--nimbus-accent); font: inherit; text-align: left;
}
.nimbus-related__action:hover { text-decoration: underline; }
.nimbus-related__recapture { margin-top: 6px; font-size: 11px; opacity: .75; }
/* :host { all: initial } gives <pre> no useful defaults (browser UA styles for
   <pre> don't survive it), so the brief's wrapping/font/spacing is set explicitly
   here rather than relied on. */
.nimbus-related__brief {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  margin: 0;
}
/* The single inset for an agent lane's body (impact/expert): 16px horizontal,
   matching the panel's other insets (.nimbus-related__lane-title,
   .nimbus-related__header-state), plus a little breathing room top and bottom.
   The nested override below zeroes .nimbus-related__status's OWN 16px padding —
   without it, a status line inside a lane body would get 32px on top of the
   pre/button below it, which have no padding of their own and would otherwise
   sit flush against the panel edge instead of lining up with it. */
.nimbus-related__lane-body { padding: 4px 16px 12px; }
.nimbus-related__lane-body .nimbus-related__status { padding: 0; }
/* The confirm-fetch preview (renderFetchPreview, panel-view.ts): field rows
   from shared/preview-view.ts, whose classes carry no styling of their own —
   the popup gets its equivalent from popup.css, but this panel is a Shadow
   DOM with no external stylesheet, so its own copy lives here. */
.preview__row { display: flex; gap: 8px; padding: 2px 0; overflow-wrap: anywhere; }
.preview__label { flex: 0 0 5.5em; color: var(--nimbus-muted); }
.preview__value { word-break: break-all; }
.preview__body { margin-top: 6px; max-height: 8em; overflow-y: auto; white-space: pre-wrap; color: var(--nimbus-muted); }
.preview__note { margin: 4px 0 0; font-size: 12px; color: var(--nimbus-muted); }
/* Send/Cancel: stacked full-width, never side by side — this is a narrow
   right-edge overlay, the same reason nimbus-related__candidates stacks. */
.nimbus-related__fetch-actions { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.nimbus-related__fetch-send, .nimbus-related__fetch-cancel {
  all: unset;
  box-sizing: border-box;
  display: block;
  width: 100%;
  text-align: center;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
.nimbus-related__fetch-send { background: var(--nimbus-accent); color: #fff; }
.nimbus-related__fetch-cancel { background: var(--nimbus-border); color: var(--nimbus-fg); }
`;

interface NimbusHost extends HTMLElement {
  __nimbusClose?: () => void;
  /**
   * How the service worker hands a selection to an ALREADY-OPEN panel. Named by
   * `PANEL_SELECTION_HOOK` (shared/panel-host.ts) — the worker looks it up by
   * that string, so the two must not drift.
   *
   * The worker cannot deliver by re-injecting `panel.js`: that entry is a
   * self-toggle and would close the panel the user is trying to use.
   */
  __nimbusSelection?: (selection: PanelSelection) => void;
}

function readContext(): { title: string; canonicalUrl?: string; selection: string } {
  // The SAME reading of the DOM and the SAME judgement the capture path makes,
  // so that
  // WHEN a canonical is accepted, the panel's related-items query names the
  // same address the clip will be filed under. That guarantee is one-sided:
  // on a rejection the clip still gets an identity (ClipPayload.url is the
  // address bar), but `RelatedQuery` (shared/related.ts) has no `url` field
  // at all, so the query below goes out with title and selection and no URL
  // context. Sending `location.href` as a fallback there is a deliberate open
  // question for the repo owner, not something this reads decides on its own.
  const canonical = resolveCanonical(declaredCanonicalHref(document), location.href);
  const selection = window.getSelection()?.toString() ?? "";
  return {
    title: document.title,
    ...(canonical.kind === "resolved" ? { canonicalUrl: canonical.url } : {}),
    selection,
  };
}

function headerFrom(res: unknown, nowMs: number, fetchSent: boolean): HeaderState {
  if (!isResolveResponse(res)) {
    return { kind: "error", surface: null, message: "Couldn't read Nimbus's answer." };
  }
  const surface = surfaceLine(res.recognition);
  if (!res.ok) {
    // `insufficient_scope` is NOT an error: the route works, the owner just has
    // not granted this device the scope. It gets its own state so the panel can
    // say what to run instead of blaming Nimbus.
    if (res.reason === "insufficient_scope" && surface !== null) {
      return { kind: "needs-scope", surface, scopeGap: res.scopeGap ?? null };
    }
    return {
      kind: "error",
      surface,
      message: RESOLVE_MESSAGES[res.reason] ?? "Couldn't resolve this page.",
    };
  }
  if (surface === null) {
    return { kind: "unrecognised" };
  }
  // Before any outcome is read. A home page carries an inert outcome
  // (handlers.ts fills one in only because the response type demands it), so
  // reading it here would render a dashboard as a miss.
  if (res.recognition.ok && res.recognition.kind === "home") {
    // `res.connector` is optional only because the type is shared with every
    // other surface (see its doc comment in messages.ts) — `handlers.ts` always
    // fills one in for a home recognition, falling back to `unknown` itself when
    // the read failed or listed no row for this connector. The fallback here is
    // a second line of defence, for the same "unknown" reason: never guess.
    return {
      kind: "service",
      surface,
      product: res.recognition.product,
      connector: res.connector ?? { state: "unknown" },
      nowMs,
    };
  }
  const outcome = res.outcome;
  if (outcome.kind === "found") {
    // A captured copy is keyed on the ITEM, never on "we just captured it" —
    // see `isCapturedCopy`'s own doc comment. Without this branch, a COLD
    // panel open on a page captured last week would present the copy as
    // ordinary connector data, which is exactly the dishonesty the `captured`
    // header arm exists to prevent — capturing IN this session is not the
    // only way to reach it.
    if (isCapturedCopy(outcome.item)) {
      return { kind: "captured", item: outcome.item, ageNowMs: nowMs };
    }
    return { kind: "resolved", surface, item: outcome.item, matchKind: outcome.matchKind, nowMs };
  }
  if (outcome.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      surface,
      candidates: outcome.candidates,
      truncated: outcome.truncated,
    };
  }
  // `unresolvable` means the gateway could not parse the URL we sent — a client
  // bug, not a user-facing distinction. It reads as "not indexed" either way.
  //
  // `res.recognition.ok` is guaranteed true whenever `surface` is non-null (see
  // `surfaceLine`), so this guard is unreachable in practice; it exists only so
  // TS can narrow `product` off `res.recognition` without a non-null assertion.
  if (!res.recognition.ok) {
    return { kind: "unrecognised" };
  }
  return {
    kind: "not-indexed",
    surface,
    product: res.recognition.product,
    // Once a fetch has been sent for this panel, `fetchable` is forced false on
    // every subsequent resolve — including a recovery re-resolve that comes back
    // as another miss. See the `fetchSent` doc comment in `createPanel` for why
    // the button must not return.
    fetchable: outcome.fetchable && !fetchSent,
  };
}

/**
 * Maps a settled `FetchResponse` — everything except `indexed`, which the
 * caller re-resolves instead of rendering (the response carries only
 * `{status:"indexed", itemId}`, no title/url/modified_at to build a `resolved`
 * header from) — to a header state.
 *
 * `!res.ok` is checked BEFORE `res.recognition`, deliberately: `surface` (the
 * function's own parameter) already carries the page identity the panel
 * learned from the resolve that offered the fetch button in the first place —
 * it does NOT come from `res.recognition`. That matters because
 * `service-worker.ts` synthesises `recognition: {ok:false,
 * reason:"unknown-host"}` on ANY rejection from `handleFetch` (e.g. a
 * `chrome.storage` read failing mid-fetch), even for an already-recognised
 * page. Checking `res.recognition` first would read that synthesised,
 * non-recognising value and discard the real surface, rendering "Not a
 * recognised Nimbus surface" for a page the panel had just correctly named a
 * moment earlier — and because `fetchState` has no button in that state, the
 * wrong header would stick until the panel is reopened. Routing `!res.ok`
 * through `FETCH_MESSAGES` first keeps the known `surface` and reports the
 * real failure instead.
 */
function fetchOutcomeHeader(res: unknown, surface: string, product: Product): HeaderState {
  if (!isFetchResponse(res)) {
    return { kind: "error", surface, message: "Couldn't read Nimbus's answer." };
  }
  if (!res.ok) {
    // `timeout` is not a failure: our client-side timer fired, the gateway may
    // still finish. It gets its own retry state that re-resolves rather than
    // re-fetching — see `fetch-retry`/`still-working` in panel-view.ts.
    if (res.reason === "timeout") {
      return { kind: "fetch-retry", surface, reason: "still-working" };
    }
    if (res.reason === "insufficient_scope") {
      return {
        kind: "fetch-blocked",
        surface,
        product,
        reason: "needs-fetch-scope",
        scopeGap: res.scopeGap ?? null,
      };
    }
    return {
      kind: "error",
      surface,
      message: FETCH_MESSAGES[res.reason] ?? "Couldn't fetch this page.",
    };
  }
  if (surfaceLine(res.recognition) === null) {
    return { kind: "unrecognised" };
  }
  const outcome = res.outcome;
  if (outcome.kind === "rate-limited") {
    // Returned before any outbound call happens — safe to retry as a fresh fetch.
    return { kind: "fetch-retry", surface, reason: "rate-limited" };
  }
  if (outcome.kind === "not-configured") {
    return { kind: "fetch-blocked", surface, product, reason: "not-configured", scopeGap: null };
  }
  if (outcome.kind === "indexed") {
    // Not reached: the caller re-resolves on `indexed` before calling this
    // function (see `sendFetch` in `createPanel`). Handled here only so this
    // function stays total over `FetchOutcome`.
    return { kind: "fetching", surface, product };
  }
  // outcome.kind === "unfetchable"
  return { kind: "fetch-blocked", surface, product, reason: "unfetchable", scopeGap: null };
}

/**
 * The line a QUEUED clip gets — busy versus offline.
 *
 * Split out of the caller's condition rather than nested inside it: a queued
 * outcome is not a failure (the clip was not dropped), so the two readings of
 * "queued" deserve to be named where they are decided.
 */
function queuedClipMessage(reason: string): string {
  return reason === "rate_limited"
    ? "Nimbus is busy — queued, will retry shortly."
    : "Saved offline — will sync when Nimbus is back.";
}

/**
 * The item the shown header names: `resolved`'s item, `chosen`'s candidate, or
 * nothing at all on a miss, an error, or an unpicked ambiguous answer.
 */
function shownItemId(shown: HeaderState): string | undefined {
  if (shown.kind === "resolved") {
    return shown.item.id;
  }
  if (shown.kind === "chosen") {
    return shown.candidate.id;
  }
  return undefined;
}

/**
 * One panel's state and the two loads that fill it. Related now waits on
 * Resolve (see `loadRelated`'s `shownHeader()` read and the mount-time
 * `loadHeader().then(loadRelated)` chain): Related queries the item the
 * header names, so a SLOW resolve delays Related by one loopback round-trip.
 * A FAILING resolve does not, though — `loadHeader` never rejects, it catches
 * its own send failure and paints an error header, so Related still runs
 * (with no `itemId`, falling back to a title-only query).
 *
 * State lives in this closure rather than at module level. Each injection of
 * panel.js re-evaluates the bundle in a fresh scope, so module-level `let` would
 * not actually leak between mounts — but a closure needs no reset step, and it
 * makes "this response belongs to that panel" structural instead of incidental.
 */
function createPanel(body: HTMLElement): {
  paint: () => void;
  loadHeader: () => Promise<void>;
  loadRelated: (selection?: string) => Promise<void>;
  stopPolling: () => void;
  checkNavigation: () => Promise<void>;
  applySelection: (text: string, intent: PanelSelection["intent"] | null) => void;
} {
  let header: HeaderState = { kind: "loading" };
  /**
   * The page this panel describes, captured ONCE at mount.
   *
   * Every message this panel sends carries this URL, never
   * `window.location.href`: on an SPA the two diverge the moment the user
   * navigates, and a lane answering about the tab's current page under a header
   * naming the pinned one is precisely the defect this exists to make
   * impossible. `reread()` is its only other writer, from an explicit user
   * click.
   */
  let pinnedUrl = window.location.href;
  /**
   * The pinned page's identity, taken from the resolve response's `recognition` —
   * which rides on BOTH arms of that response on purpose (see `handleResolve`).
   * One source, so the pin cannot disagree with the header painted from the same
   * response, and a re-read re-pins it as an ordinary consequence of re-running
   * `loadHeader` rather than as a second thing to remember.
   *
   * Null until a resolve RESPONSE lands, not merely attempted: `loadHeader`'s
   * own `catch` arm leaves it null on a rejected send, and a failed re-read
   * leaves it null for as long as resolve keeps failing — there is no separate
   * retry, only whatever resolve `reread` or the initial mount already sent.
   * While it is null, `checkNavigation`'s own early return means the watcher
   * cannot conclude anything about a navigation, no matter how many happen,
   * until a later resolve actually succeeds.
   */
  let pinnedRecognition: Recognition | null = null;
  /** The last URL `checkNavigation` looked at — so a tick on an unchanged URL
   *  costs a string compare and nothing else. */
  let lastCheckedUrl = pinnedUrl;
  /** Whether the tab is currently showing a DIFFERENT item than the pinned one.
   *  Not a latch: navigating back to the pinned item clears it. */
  let navAway = false;
  /**
   * Orders `recognise` answers. Rapid navigation puts several in flight, and a
   * LATE answer about an earlier URL would otherwise decide the notice — pinned
   * #482 -> /files -> #517 could clear the notice while the user sits on #517.
   * Each send takes a ticket; only the latest may act.
   */
  let recogniseSeq = 0;
  /**
   * Bumped by `reread()`. Every async function here resumes after a real round
   * trip, and a response belonging to the page the panel has stopped describing
   * must neither store nor paint — the same reasoning as `closed` below, for a
   * panel that stays mounted instead of going away.
   */
  let generation = 0;
  let navCheckTimer: ReturnType<typeof setInterval> | undefined;
  // The candidate the user picked out of an `ambiguous` header. Only meaningful
  // alongside an `ambiguous` header — see the `shown` narrowing in paint() below.
  let chosen: ResolveCandidate | null = null;
  let relatedBody: (doc: Document) => HTMLElement = (doc) => renderError(doc, "Loading…");
  /**
   * Whether an outbound provider request may currently be IN FLIGHT for this
   * panel — not simply "a fetch message was sent". That distinction matters
   * for exactly one outcome: `rate-limited` is returned BEFORE any outbound
   * call happens, so nothing is in flight when it comes back, and `sendFetch`
   * clears this latch back to `false` in that one case so "Try again" can send
   * a genuinely fresh fetch.
   *
   * For every other outcome — most importantly `timeout`, the case this latch
   * exists for, where our client-side timer fired but the gateway may still be
   * completing the outbound call — it stays `true` for the life of this panel,
   * and the Fetch button never returns, not even if a recovery resolve is
   * still a miss. The panel cannot tell "still fetching" from "the fetch
   * died", so re-offering the button in that case would risk a second
   * outbound request for work that may still be running. Reopening the panel
   * resets this, which is the deliberate escape hatch: a fresh resolve either
   * finds the item or offers the button again, by which point the original
   * fetch has landed or genuinely failed.
   */
  let fetchSent = false;
  /**
   * The fetch-related header (`fetching` / `fetch-blocked` / `fetch-retry`),
   * shown INSTEAD of `header` for as long as it is non-null.
   *
   * It is set the moment a fetch is sent and cleared only when a resolve lands
   * with something other than a miss (`found`, `ambiguous`, `needs-scope`,
   * `unrecognised`, or an error) — see `loadHeader` below. A recovery resolve
   * that comes back as another miss leaves it untouched: `header` itself would
   * flip back to `not-indexed`, but `paint()` never shows that while this is set,
   * which is what keeps the button from reappearing.
   */
  let fetchState: HeaderState | null = null;
  /**
   * The "about to fetch" confirm target, shown INSTEAD of the normal header
   * for as long as it is non-null — set by `handleFetchAction("fetch")`,
   * reached from both the initial "Fetch this from X" button and a
   * rate-limited "Try again" click, since both fire the SAME outbound
   * provider request under the user's stored credential and both must be
   * confirmed before it goes out.
   *
   * Setting this does NOT touch `fetchSent` — see that flag's own doc comment
   * for why. Opening the preview is not an attempt; only `confirmFetch`
   * (the Send control) hands off to the real `sendFetch`, which is where
   * `fetchSent` latches. `cancelFetchPreview` (Cancel) clears this and
   * repaints back to the ordinary header, leaving the Fetch button exactly as
   * usable as before it was ever clicked.
   */
  let fetchPreview: FetchTarget | null = null;
  /**
   * Mirrors `fetchState`: an override that wins in `shownHeader()` while a
   * capture is reading the page, saving the clip, or — the ONE terminal
   * outcome this also covers — once it has SUCCEEDED. A REFUSAL is
   * deliberately NOT one of the things this holds; see `captureRefusal`
   * below for why and where those go instead.
   *
   * The success line is sticky on purpose: on the primary target for this
   * feature — a page with no configured connector at all — a post-save
   * re-resolve can never produce anything richer (`handleResolve`'s own
   * recognise gate means it never even calls the gateway for a page it
   * cannot recognise), so this line is the only confirmation that path can
   * ever show. `loadHeader` clears it once the settled header is something
   * richer the user can act on instead — see its own doc comment for the
   * exact list.
   *
   * NOT set while merely awaiting the user's own confirmation — that is
   * `capturePreview` below, the same split `fetchState`/`fetchPreview` already
   * draw: confirming an outbound write is not yet attempting it, so there is
   * no network activity for a status line to describe.
   */
  let captureState: HeaderState | null = null;
  /**
   * A capture REFUSAL — `url-changed`, `empty`, `restricted`,
   * `injection-failed`, a connect failure, an unreadable response, or a
   * non-queued clip failure — kept SEPARATE from `captureState` above.
   *
   * Unlike `captureState`'s in-flight lines and its terminal success line,
   * a refusal must NOT override the header: `shownHeader()` never reads
   * this. It is instead rendered as its own line BENEATH the header (see
   * `paint()`'s `captureRefusal` and `renderShell`'s own arm for it) so the
   * header — and, critically, its still-live capture offer — stays on
   * screen for the user to retry. Before this field existed, a refusal rode
   * on `captureState` exactly like the in-flight/success lines and replaced
   * the header outright; nothing ever cleared it, and a refusal on a
   * fetchable-only page (e.g. an SPA route change mid-capture) stranded the
   * panel with no control left to click.
   *
   * A queued clip outcome (offline, or rate-limit-paused) is NOT a refusal —
   * the clip was not dropped — and stays on `captureState`; see
   * `sendCapturedClip`'s own comment on that branch.
   *
   * Cleared the moment a fresh capture attempt starts (`sendCapture`) and on
   * `reread()` — the same lifetime as every other per-attempt capture field.
   */
  let captureRefusal: string | null = null;
  /** The captured page, held between the preview and Send — and the exact
   *  payload `sendCapturedClip` POSTs. */
  let pendingCapture: CaptureResult | null = null;
  /** The 1.3 confirm preview for `pendingCapture`, shown INSTEAD of the header
   *  — same precedence as `fetchPreview` — for as long as it is non-null. */
  let capturePreview: ClipPreview | null = null;
  /**
   * One capture at a time — the same rule, and the same reason, as
   * `fetchSent`: a stray extra click must not fire a second outbound clip
   * while one might still be running.
   *
   * Unlike `fetchSent`, this is NOT latched for the panel's whole life: it
   * clears on refusal, on Cancel, and once a save settles, so "Update this
   * copy" stays usable on the `captured` header after a successful save —
   * ingest upserts on the canonicalised URL, so a re-capture is meant to be
   * repeatable, not a one-shot-per-panel action like a targeted fetch.
   */
  let capturing = false;
  // Resolve and related land at different times and each triggers a full repaint,
  // so a lane the user collapsed in between would spring back open. Read the live
  // <details> state before replacing it and carry it into the next render.
  let relatedExpanded = true;

  // --- Agent lanes -------------------------------------------------------
  //
  // Per-lane state, seeded to `collapsed` — "never opened" — for the life of
  // this panel. WHICH lanes render is `lanesFor` (lane-input.ts); this table
  // holds state for all of them regardless, so a lane that comes and goes (the
  // glossary lane does) keeps its answer across the repaints in between.
  const laneState: Record<AgentLane, LaneState> = {
    glossary: { kind: "collapsed" },
    impact: { kind: "collapsed" },
    expert: { kind: "collapsed" },
    why: { kind: "collapsed" },
    catchup: { kind: "collapsed" },
    decisions: { kind: "collapsed" },
    ownership: { kind: "collapsed" },
  };
  // Whether each lane's own <details> is open, carried across repaints exactly
  // like `relatedExpanded` above.
  const laneOpen: Record<AgentLane, boolean> = {
    glossary: false,
    impact: false,
    expert: false,
    why: false,
    catchup: false,
    decisions: false,
    ownership: false,
  };
  /**
   * The term this panel is holding, if any — from a selection live on the page
   * when the panel mounted, or one handed over since by a context-menu entry.
   *
   * `none` until there is one, which is why no glossary lane exists on an
   * ordinary panel: the lane materialises with the term and not before.
   */
  let term: TermState = { kind: "none" };
  /**
   * Lanes with an `agent-run` genuinely IN FLIGHT — sent but not yet answered.
   * Guards a double invoke on rapid toggling: expand -> collapse -> expand
   * before the worker has persisted `{kind:"running"}` would otherwise send a
   * SECOND `agent-run`, and `handleAgentRun`'s cached-state check would still
   * read null at that point (`chrome.storage` is not transactional) and invoke
   * a second time — two agent runs, and on a configured gateway two model
   * calls, for one question, each consuming one of the gateway's three run
   * slots. `chrome.storage` cannot be made race-free on its own; THIS set is
   * what actually holds. `sendAgentRun` (the only sender of `agent-run`, called
   * from both a lane's toggle-open and its Re-run button) adds on send and
   * removes on response — never left set on a response, success or failure.
   */
  const laneInFlight = new Set<AgentLane>();
  /**
   * One poll timer handle per lane currently `running`. This is a SEPARATE
   * cadence from the worker's own poll of the gateway (`tickAgentPoll` in
   * service-worker.ts): that one is what completes a run and survives the
   * panel closing; THIS one only repaints an open panel, and stops the moment
   * the lane settles or this panel is torn down (see `stopAgentPolls`).
   */
  const lanePollTimers: Partial<Record<AgentLane, ReturnType<typeof setTimeout>>> = {};
  /**
   * Set once, by `stopAgentPolls`, when this panel is torn down. `pollLane` and
   * `sendAgentRun` both resume after an `await` — a real gateway round trip —
   * with no other liveness check, so a response landing after teardown would
   * otherwise `paint()` into a detached `body` and, worse, call
   * `scheduleLanePoll` to start a brand-new timer that `stopAgentPolls` has
   * already run past and can never clear. Checked immediately after every
   * `await` in both functions, before either effect.
   */
  let closed = false;

  /**
   * The header actually on screen.
   *
   * `fetchState` wins whenever it is set — see its doc comment above for why a
   * recovery resolve that is still a miss must not displace it. A chosen
   * candidate renders via `chosen`, never `resolved` — candidates carry no
   * `modifiedAt`, and `resolved` would demand one.
   *
   * Extracted from `paint()` because the lane path now needs the same answer:
   * whether a lane may run, and which item id it sends, both follow from the
   * header the user is looking at. Deriving that twice would be two chances to
   * derive it differently.
   */
  function shownHeader(): HeaderState {
    // `captureState` wins over `fetchState` — NOT the other way round. Capture
    // is only ever reachable once a fetch has already settled terminally
    // (`offersCapture` is true only for `unrecognised`, `fetch-blocked`, and
    // an unfetchable `not-indexed` miss), so the two are never in flight at
    // once — this is a precedence choice with no live conflict to arbitrate.
    // But `fetch-blocked` EXISTS ONLY as a `fetchState` value (`headerFrom`
    // never produces it), so checking `fetchState` first would make every
    // capture state invisible on that whole arm: no "Capturing this page…",
    // no "Saving to Nimbus…", and no refusal sentence from `CAPTURE_MESSAGES`
    // — the offer's own click would repaint straight back to the unchanged
    // `fetch-blocked` box, reading as a dead control.
    if (captureState !== null) {
      return captureState;
    }
    if (fetchState !== null) {
      return fetchState;
    }
    return chosen !== null && header.kind === "ambiguous"
      ? { kind: "chosen", surface: header.surface, candidate: chosen }
      : header;
  }

  /**
   * The surface line to carry on a `captureState` status/error box. Reads
   * `header`, the RAW resolve-derived state — deliberately not
   * `shownHeader()`, which folds `fetchState` in and, once a capture state is
   * set, returns that instead: `captureSurface` is called precisely to BUILD
   * a fresh `captureState`, so reading `shownHeader()` here would read the
   * very state this function exists to produce.
   *
   * `header` itself can never hold `fetch-blocked` — that kind lives only in
   * `fetchState` (see `fetchOutcomeHeader`; `headerFrom` never produces it) —
   * so `not-indexed` is the only header kind with a `surface` to read here.
   * `unrecognised` and the `captured` re-capture path have none, matching
   * `error`'s own nullable `surface` field.
   */
  function captureSurface(): string | null {
    return header.kind === "not-indexed" ? header.surface : null;
  }

  /** Everything `lanesFor`/`laneRequestInput`/`laneCanRun` need, from one place —
   *  so a lane cannot be rendered under one context and then asked under another. */
  function laneContext(): LaneContext {
    const shown = shownHeader();
    return {
      surfaceKind: pinnedRecognition?.ok === true ? pinnedRecognition.kind : null,
      pageSubject: shown.kind === "resolved" || shown.kind === "service" || shown.kind === "chosen",
      pickedItemId: shown.kind === "chosen" ? shown.candidate.id : null,
      term,
    };
  }

  /** A term lane wears its term as its title — "Definition" on every one of them
   *  would say nothing about which word was asked about. Quoted so a one-word
   *  term still reads as a quotation rather than as a heading this panel wrote. */
  function laneTitle(lane: AgentLane): string {
    return lane === "glossary" && term.kind === "ready" ? `“${term.term}”` : LANE_TITLES[lane];
  }

  /** Why this panel will not send the current selection. Only ever called for a
   *  lane `laneCanRun` refused, which is only ever a refused term. */
  function termRefusal(): string {
    return term.kind === "refused" ? TERM_MESSAGES[term.reason] : TERM_MESSAGES.empty;
  }

  function clearLanePoll(lane: AgentLane): void {
    const handle = lanePollTimers[lane];
    if (handle !== undefined) {
      clearTimeout(handle);
      delete lanePollTimers[lane];
    }
  }

  function scheduleLanePoll(lane: AgentLane): void {
    clearLanePoll(lane);
    lanePollTimers[lane] = setTimeout(() => {
      pollLane(lane).catch(() => undefined);
    }, AGENT_POLL_MS);
  }

  /** Repaints an OPEN panel while a lane runs — never invokes (see
   *  `AgentStateRequest`'s own doc comment). Reschedules itself while the
   *  answer is still `running`; any terminal state (or an unreadable response)
   *  stops the loop rather than polling forever. */
  async function pollLane(lane: AgentLane): Promise<void> {
    const gen = generation;
    let res: unknown;
    try {
      // The SAME extra input the run sent — the two messages key one cache
      // entry, so a poll that dropped the term or the picked id would look up a
      // different subject and report `collapsed` forever, which `pollLane` reads
      // as "the run is gone" and turns into a stale failure under a lane that is
      // in fact running fine.
      res = await sendMessage({
        kind: "agent-state",
        lane,
        pageUrl: pinnedUrl,
        ...laneRequestInput(lane, laneContext()),
      });
    } catch {
      // The worker itself is unreachable — nothing to retry against here; the
      // next lane toggle or Re-run will find out again. Leave the last known
      // state on screen rather than guessing a new one.
      return;
    }
    if (closed || gen !== generation) {
      // The panel was torn down while this poll was in flight, OR a re-read
      // moved it on to a different item — either way, there's nothing left to
      // repaint, and scheduling another tick would poll — and, via
      // handleAgentState's own resolve call, hit the gateway — forever for a
      // page nobody is describing anymore. See `closed`'s own doc comment; a
      // re-read is the same reasoning for a panel that stays mounted.
      return;
    }
    if (!isAgentStateResponse(res)) {
      return;
    }
    if (res.state.kind === "collapsed" && laneOpen[lane]) {
      // A lane the user has OPEN going back to `collapsed` mid-poll means the
      // run this poll was tracking is gone — its TTL lapsed, it was evicted
      // past MAX_STORED_RUNS, or a resolve landed on a different item id
      // (handlers.ts's own `?? {kind:"collapsed"}` fallback). Storing
      // `collapsed` here would repaint straight into `renderLaneBody`'s
      // `collapsed` arm, which is a deliberately EMPTY box for a lane never
      // opened (Task 7) — correct there, but on an OPEN lane it reads as a
      // permanently blank panel with no affordance, since `collapsed` is not
      // `running` and this loop stops right after. `failed`/`stale` is the
      // state that already exists for exactly this condition: "This run is
      // gone — re-run it." with a working Re-run button that genuinely
      // re-invokes (`handleAgentRun` does not short-circuit on `failed`).
      laneState[lane] = { kind: "failed", reason: "stale" };
      paint();
      return;
    }
    laneState[lane] = res.state;
    paint();
    if (res.state.kind === "running") {
      scheduleLanePoll(lane);
    }
  }

  /**
   * Compare the tab's item identity against the pinned one, and flip `navAway`
   * when it differs. Identity, NOT the URL: `resolveUrl` keeps sub-tab segments
   * and the query string on purpose, so a PR's Files tab is a different URL and
   * the same item — announcing that would be a lie in the other direction.
   *
   * Paints ONLY when `navAway` actually changes. A `paint()` per tick would make
   * this panel's repaints timer-driven, which `HeaderState.resolved`'s `nowMs`
   * doc comment (panel-view.ts) explicitly rules out while that value is frozen
   * at response time.
   */
  async function checkNavigation(): Promise<void> {
    if (!body.isConnected) {
      // The self-toggle fallback path at the file's own end (`existing.remove()`
      // when `__nimbusClose` is absent) removes a stale host directly, without
      // going through `stopAgentPolls` — so this interval would otherwise keep
      // firing forever with nothing left to paint into. Unreachable today (a
      // host left by a real Nimbus panel always carries `__nimbusClose`), but
      // the check is cheap insurance against a timer that never self-terminates.
      if (navCheckTimer !== undefined) {
        clearInterval(navCheckTimer);
        navCheckTimer = undefined;
      }
      return;
    }
    if (document.hidden) {
      // Nothing to be right about while the panel cannot be seen. The
      // visibilitychange listener in mount() runs one check on the way back, so
      // the notice is correct the moment the user looks at it.
      return;
    }
    const url = window.location.href;
    if (url === lastCheckedUrl) {
      return;
    }
    const gen = generation;
    if (pinnedRecognition === null) {
      // No pinned identity to compare against yet, so there is nothing this
      // check could conclude. Return WITHOUT marking: marking would burn the
      // check and leave this URL matching on every later tick, so the notice for
      // it could never appear. That window is real and not rare — the interval
      // starts at mount, before the first resolve lands, and `reread` nulls the
      // pin again for its whole round trip. Same principle as below: a check
      // that reached no conclusion is not a completed check.
      return;
    }
    // Marked BEFORE the send, so a round trip slower than NAV_CHECK_MS cannot
    // stack duplicate requests for one URL — and rolled back below if the check
    // reaches no conclusion, because a check that never got an answer is not a
    // completed check.
    const previous = lastCheckedUrl;
    lastCheckedUrl = url;
    const seq = ++recogniseSeq;
    let res: unknown;
    try {
      res = await sendMessage({ kind: "recognise", pageUrl: url });
    } catch {
      // The worker is unreachable. Every OTHER sendMessage failure in this panel
      // leaves the user a way back — an error header, a Re-run button — but a
      // navigation check has no button, so the next tick is the only recovery
      // there is. Leaving `lastCheckedUrl` marked would remove it: this URL would
      // match on every future tick and never be re-checked, and the notice for it
      // would never appear.
      //
      // Rolled back only while this is still the LATEST check AND still this same
      // generation — `generation`'s own doc comment says a stale response must
      // neither store nor paint, and this is a store.
      if (gen === generation && seq === recogniseSeq) {
        lastCheckedUrl = previous;
      }
      return;
    }
    if (closed || gen !== generation || seq !== recogniseSeq) {
      // A newer check — a later tick, or a `reread` — already owns the marker.
      // Restoring an older URL over it here would make that newer check re-send
      // for a URL it has already moved past.
      return;
    }
    if (!isRecognitionResponse(res) || !res.ok) {
      // The worker reached no conclusion — the response was unreadable, or (on
      // `ok: false`) its storage read failed. "I could not look" is not "there
      // is no item here": treating either as a completed check would leave this
      // URL sitting in `lastCheckedUrl` forever, matching on every later tick, so
      // the notice for it could never appear — the exact defect class this
      // watcher exists to remove. Roll the marker back to `previous` so the
      // NEXT TICK re-asks about this same URL instead. No second guard is needed
      // on the rollback itself: the check just above has already established
      // this is still the latest ticket and the current generation.
      lastCheckedUrl = previous;
      return;
    }
    // `pinnedRecognition` cannot actually be null here — the early return above
    // already refused to spend a check without one — but TypeScript does not
    // retain that narrowing of a closure `let` across the `await` on the send
    // above, so it still types as `Recognition | null` at this line.
    const away = pinnedRecognition !== null && !sameItem(pinnedRecognition, res.recognition);
    if (away === navAway) {
      return;
    }
    navAway = away;
    paint();
  }

  /**
   * Re-pin to the page the tab is on now and describe THAT page instead.
   *
   * Only reachable from the notice's own button — an explicit user action, which
   * is why it is allowed to spend two gateway calls when nothing else in this
   * panel re-reads on its own.
   *
   * `fetchSent` resets deliberately: the one-fetch-per-panel rule exists to stop
   * a second outbound provider request for the SAME item, and this is a different
   * item behind a click. A lane whose new item was already answered still replays
   * from the worker's store on first expand (`agent-run-store` keys by item id),
   * so resetting `laneState` here costs no re-run.
   */
  async function reread(): Promise<void> {
    generation += 1;
    // Drop the old page's <details> BEFORE resetting the flags below. `paint()`
    // opens by carrying over each lane's live open/closed state from the mounted
    // elements — correct on every ordinary repaint, and fatal here: it would
    // restore the very flags this function is clearing, and a lane left expanded
    // on the old item would reopen EMPTY on the new one (its `laneState` is now
    // `collapsed`, whose rendered body is deliberately blank, and
    // `attachLaneToggle` swallows the programmatic re-open, so no run starts).
    body.replaceChildren();
    pinnedUrl = window.location.href;
    lastCheckedUrl = pinnedUrl;
    pinnedRecognition = null;
    navAway = false;
    header = { kind: "loading" };
    chosen = null;
    fetchState = null;
    fetchSent = false;
    fetchPreview = null;
    // A capture in flight (or awaiting confirmation) belonged to the OLD
    // page, exactly like `fetchState`/`fetchSent`/`fetchPreview` just above —
    // its own `generation` guard already stops it from storing or painting,
    // this just drops the now-stale UI state instead of leaving it stuck on
    // screen under a header describing a different page.
    captureState = null;
    captureRefusal = null;
    pendingCapture = null;
    capturePreview = null;
    capturing = false;
    // The selection belonged to the page this panel has stopped describing.
    // Keeping it would leave a glossary lane on the new page titled with a term
    // lifted from the old one.
    term = { kind: "none" };
    relatedBody = (doc) => renderError(doc, "Loading…");
    relatedExpanded = true;
    for (const lane of AGENT_LANES) {
      clearLanePoll(lane);
      laneState[lane] = { kind: "collapsed" };
      laneOpen[lane] = false;
      // A run genuinely in flight for the OLD item is not cancelled — there is
      // nothing upstream to cancel (ROADMAP C2.2) — but its answer is dropped by
      // the generation guard, and clearing the latch lets the new item's lane be
      // expanded straight away.
      laneInFlight.delete(lane);
    }
    paint();
    // Sequential, not `Promise.all`, for the same reason as the mount-time
    // chain below: `loadRelated` reads the header synchronously and must not
    // run until `loadHeader` has assigned it.
    await loadHeader();
    await loadRelated();
  }

  /**
   * Invokes a lane's agent. The ONLY sender of `agent-run` — called both from
   * a lane's toggle-open (first expand) and from `renderLaneBody`'s Re-run
   * button — so the `laneInFlight` guard here is what protects both paths at
   * once.
   */
  async function sendAgentRun(lane: AgentLane): Promise<void> {
    if (laneInFlight.has(lane)) {
      return;
    }
    if (!laneCanRun(lane, laneContext())) {
      // A lane missing its input renders its own reason and never asks. Without
      // this the message would go out, `isAgentRunRequest` would reject it as
      // malformed, and the user would be told the transport failed rather than
      // that they selected three paragraphs.
      return;
    }
    const gen = generation;
    laneInFlight.add(lane);
    // Optimistic: show progress immediately rather than leaving the lane
    // blank for a first expand, or leaving a stale failure message and its
    // Re-run button on screen for the whole round trip of a Re-run click.
    // Overwritten the moment the real response lands, a few lines down — this
    // placeholder `runId` is never read anywhere: `renderLaneBody`'s `running`
    // arm only ever checks `state.kind`.
    laneState[lane] = { kind: "running", runId: "" };
    paint();
    let res: unknown;
    try {
      res = await sendMessage({
        kind: "agent-run",
        lane,
        pageUrl: pinnedUrl,
        ...laneRequestInput(lane, laneContext()),
      });
    } catch {
      if (closed || gen !== generation) {
        // Checked BEFORE the delete below: a `reread` already cleared this
        // lane's OLD entry (see `reread`) and a fresh toggle may since have
        // added a NEW one for a genuinely in-flight run. Deleting here
        // unconditionally would clear that newer run's latch instead of this
        // stale one's, defeating the guard `laneInFlight` exists to be.
        return;
      }
      laneInFlight.delete(lane);
      laneState[lane] = { kind: "failed", reason: "unreachable" };
      paint();
      return;
    }
    if (closed || gen !== generation) {
      // See `closed`'s own doc comment: a response landing after teardown
      // must not repaint a detached body or start a fresh poll timer that
      // `stopAgentPolls` has already run past. A re-read bumping `generation`
      // is the same hazard for a panel that stays mounted but has moved on to
      // a different item — this is the guard `reread`'s own `clearLanePoll`
      // relies on to make a poll already in flight harmless (see `reread`).
      // The `laneInFlight` delete below is skipped for the same reason as the
      // `catch` arm above: this stale response must not clear a newer run's
      // latch.
      return;
    }
    laneInFlight.delete(lane);
    if (!isAgentStateResponse(res)) {
      laneState[lane] = { kind: "failed", reason: "server_error" };
      paint();
      return;
    }
    laneState[lane] = res.state;
    paint();
    if (res.state.kind === "running") {
      scheduleLanePoll(lane);
    }
  }

  /** A lane's <details> toggle listener. Only the FIRST expand (state still
   *  `collapsed`) invokes: once it has moved on (`running`/`done`/`failed`),
   *  collapsing and re-expanding just shows what's already known — re-running
   *  a `done` lane would waste a model call, and a `failed` lane's own remedy
   *  is its Re-run button, not a silent auto-retry on toggle. */
  function onLaneToggle(lane: AgentLane, open: boolean): void {
    laneOpen[lane] = open;
    if (!open || laneState[lane].kind !== "collapsed") {
      return;
    }
    sendAgentRun(lane).catch(() => undefined);
  }

  /** Stops every lane's poll timer, clears the navigation-check interval, and
   *  marks this panel closed — called on panel teardown. Clearing
   *  `navCheckTimer` here is not incidental: it is the only thing standing
   *  between a closed panel and a 2 Hz (`NAV_CHECK_MS`) `checkNavigation` loop
   *  that would otherwise keep messaging the worker forever with nothing left
   *  to paint into. The worker's own poll of the gateway is untouched: it
   *  survives this panel closing by design. Setting `closed` here (not just
   *  clearing pending timers) is what stops an invoke or poll already in
   *  flight from starting a brand-new timer once its response lands — see
   *  `closed`'s own doc comment. */
  function stopAgentPolls(): void {
    closed = true;
    for (const lane of AGENT_LANES) {
      clearLanePoll(lane);
    }
    if (navCheckTimer !== undefined) {
      clearInterval(navCheckTimer);
      navCheckTimer = undefined;
    }
  }

  /** Each repaint (resolve/related landing, a lane's own state changing, …)
   *  rebuilds every <details> from scratch — read the live open/closed state
   *  before replacing it, so a lane the user toggled doesn't spring back to its
   *  previous state. */
  function readOpenState(): void {
    const open = body.querySelector<HTMLDetailsElement>('[data-lane="related"]');
    if (open !== null) {
      relatedExpanded = open.open;
    }
    for (const lane of AGENT_LANES) {
      const el = body.querySelector<HTMLDetailsElement>(`[data-lane="${lane}"]`);
      if (el !== null) {
        laneOpen[lane] = el.open;
      }
    }
  }

  /** `renderShell`/`renderLane` build a fresh <details> every repaint — attach
   *  this repaint's toggle listeners after the fact rather than threading a
   *  callback through `Lane`, which every OTHER lane (including "related")
   *  does not need. `attachLaneToggle` (above) is what filters out the
   *  synthetic "toggle" a fresh, already-expanded element queues on its own
   *  — this loop only wires it to this lane's own handler.
   *
   *  A `pollLane` answer of `collapsed` for a lane the user has open is
   *  converted to `failed`/`stale` before it is ever stored (see `pollLane`
   *  above), so that specific path can no longer reach `onLaneToggle`'s own
   *  `kind === "collapsed"` invoke condition while a lane sits open — but
   *  `attachLaneToggle`'s suppression is the general-purpose one underneath
   *  it, independent of whatever the caller's state happens to be. */
  function attachLaneToggles(): void {
    for (const lane of AGENT_LANES) {
      const el = body.querySelector<HTMLDetailsElement>(`[data-lane="${lane}"]`);
      if (el === null) {
        continue;
      }
      attachLaneToggle(el, (open) => onLaneToggle(lane, open));
    }
  }

  function paint(): void {
    readOpenState();
    const shown = shownHeader();
    // Which lanes render is `lanesFor` (lane-input.ts), against the context
    // assembled just below. Two gates, one per kind of lane:
    //
    // A PAGE lane needs the pinned page's surface to be one it belongs on, and
    // the header to name a subject: `resolved` (one indexed item), `service` (a
    // dashboard, no item at all), or `chosen` — the candidate the user picked out
    // of an ambiguous answer. `chosen` counts NOW, and did not before: the picked
    // id travels with `agent-run` (messages.ts) and `resolveForAgent` honours it
    // after verifying it against the candidate set, so the lanes answer about the
    // item the header names instead of refusing with `not_resolved` under a
    // header that had just named it — see ROADMAP C2.5. There is still nothing to
    // ask about on a miss, an error, or an ambiguous answer nobody has picked
    // from.
    //
    // A TERM lane needs only a term, and consults none of the above.
    //
    // The surface kind comes from `pinnedRecognition`, not from the header: the
    // `resolved` HeaderState carries only the human surface LINE ("GitHub PR ·
    // acme/web #482"), not the typed kind.
    const surfaceKind = pinnedRecognition?.ok === true ? pinnedRecognition.kind : null;
    const laneCtx = laneContext();
    // Hoisted out of the `render` arrow below rather than written inline inside it.
    // Inline it was a fourth nested function — map callback -> render -> run callback —
    // which tripped Sonar's nesting-depth rule (`S2004`) and, more to the point, buried
    // "what happens when the user hits run" three indents inside a list literal.
    const runLane =
      (lane: AgentLane): (() => void) =>
      () => {
        sendAgentRun(lane).catch(() => undefined);
      };
    const agentLanes: Lane[] = lanesFor(laneCtx).map((lane) => ({
      id: lane,
      title: laneTitle(lane),
      expanded: laneOpen[lane],
      render: (doc: Document) =>
        // A lane that cannot run renders its reason here, locally, and sends
        // nothing — the only lane in this panel that is shown precisely so it can
        // say why it will not ask.
        laneCanRun(lane, laneCtx)
          ? renderLaneBody(doc, laneState[lane], runLane(lane))
          : renderError(doc, termRefusal()),
    }));
    // No related lane on a dashboard: `/v1/clips/related` keyed on a dashboard's
    // title and URL returns noise dressed as recall. The related REQUEST is still
    // sent — after the resolve, once the recognition is known — its answer is
    // simply not rendered here.
    //
    // On a dashboard, whether the agent lanes render at all is gated on the
    // connector's health (`gatePolicy`): three lanes that can only ever come back
    // empty read as "you have no work", not as "Nimbus cannot ask this connector
    // anything". `shown.kind === "service"` whenever `surfaceKind === "home"` —
    // see `headerFrom` — so the empty-array arm below is exhaustive in practice,
    // never a silent drop of lanes for a page that has some other header.
    const homeLanes = shown.kind === "service" && gatePolicy(shown.connector.state).lanes;
    const lanes: Lane[] =
      surfaceKind === "home"
        ? homeLanes
          ? agentLanes
          : []
        : [
            { id: "related", title: "Related", expanded: relatedExpanded, render: relatedBody },
            ...agentLanes,
          ];
    const navAwayState = navAway
      ? {
          pinnedRef: pinnedRecognition?.ok === true ? pinnedRecognition.ref : null,
          onReread: () => {
            reread().catch(() => undefined);
          },
        }
      : undefined;
    const fetchPreviewState =
      fetchPreview === null
        ? undefined
        : { target: fetchPreview, onSend: confirmFetch, onCancel: cancelFetchPreview };
    const capturePreviewState =
      capturePreview === null || pendingCapture === null
        ? undefined
        : { preview: capturePreview, onSend: confirmCapture, onCancel: cancelCapturePreview };
    body.replaceChildren(
      renderShell(
        document,
        {
          header: shown,
          lanes,
          ...(navAwayState === undefined ? {} : { navAway: navAwayState }),
          ...(fetchPreviewState === undefined ? {} : { fetchPreview: fetchPreviewState }),
          ...(capturePreviewState === undefined ? {} : { capturePreview: capturePreviewState }),
          ...(captureRefusal === null ? {} : { captureRefusal }),
        },
        (c) => {
          chosen = c;
          paint();
          // The user just picked an item out of an ambiguous answer — Related
          // was last run (if at all) with no item to query, or against a
          // different candidate entirely. Re-run it now that `shownHeader()`
          // names the chosen item, same detached/fail-closed style as the
          // mount-time call above.
          loadRelated().catch(() => undefined);
        },
        (action) => {
          handleFetchAction(action).catch(() => undefined);
        },
        // The SAME function for both controls — a re-capture is the identical
        // flow (see `sendCapture`'s own doc comment), not a second one.
        runCapture,
        runCapture,
      ),
    );
    attachLaneToggles();
  }

  async function loadHeader(): Promise<void> {
    const gen = generation;
    let res: unknown;
    try {
      res = await sendMessage({
        kind: "resolve",
        pageUrl: pinnedUrl,
        title: document.title,
      });
    } catch {
      if (gen !== generation) {
        // A re-read moved this panel on to a different page while this resolve
        // was in flight — the error belongs to the page nobody is describing
        // anymore, and the re-read's own loadHeader call owns `header` now.
        return;
      }
      header = { kind: "error", surface: null, message: "Couldn't connect to Nimbus." };
      fetchState = null;
      paint();
      return;
    }
    if (gen !== generation) {
      return;
    }
    if (isResolveResponse(res)) {
      // The identity of the page this panel describes, from the same response the
      // header is built from — never a second recognition of its own.
      pinnedRecognition = res.recognition;
    }
    // Taken ONCE per repaint here, not re-read per rendered line — see the
    // `resolved` state's `nowMs` doc comment in panel-view.ts.
    header = headerFrom(res, Date.now(), fetchSent);
    // A settled answer other than "still a miss" replaces whatever fetch state
    // was showing — this is how `indexed` (via `sendFetch` below, which
    // re-resolves rather than rendering the fetch response) and any other
    // definitive outcome let the normal path render. A miss leaves `fetchState`
    // in place; see its doc comment for why.
    if (header.kind !== "not-indexed") {
      fetchState = null;
    }
    // A capture success message (set by `sendCapturedClip`) stays on screen
    // through an ORDINARY re-resolve — on the unrecognised-page path that
    // message is the flow's only confirmation (see `sendCapturedClip`'s own
    // doc comment: `handleResolve`'s recognise gate means that re-resolve can
    // never produce anything richer), so clearing it on every settle would
    // erase the one confirmation that path can ever show. It clears only once
    // the settled header is something RICHER the user can act on instead:
    // `captured` (item, freshness, "Update this copy"), `resolved` (an
    // ordinary indexed item), `chosen` (a candidate already picked — see
    // `shownHeader`; `headerFrom` itself never produces this kind, but the
    // list stays total over every acted-on state on principle), `ambiguous`
    // (a chooser to pick from) or `needs-scope` (the pairing needs a grant).
    // Without `ambiguous` here, a post-save re-resolve landing on a candidate
    // chooser would leave the sticky "Saved a copy of …" line permanently
    // covering it — a chooser the user could then never reach.
    if (
      header.kind === "captured" ||
      header.kind === "resolved" ||
      header.kind === "chosen" ||
      header.kind === "ambiguous" ||
      header.kind === "needs-scope"
    ) {
      captureState = null;
    }
    paint();
  }

  /**
   * Sends a fetch for this panel instance. Guarded by `fetchSent` — "an
   * outbound provider request may be in flight" (see its doc comment) — so a
   * stray extra call can't fire a second outbound request while one might
   * still be running.
   *
   * This normally means one fetch for the panel's life: `fetchSent` latches
   * `true` below, before the request goes out, and stays `true`. The one
   * exception is `rate-limited`, cleared back to `false` below because that
   * outcome means no outbound call happened — so a second call through here
   * is exactly as safe as the first.
   */
  async function sendFetch(): Promise<void> {
    if (fetchSent || header.kind !== "not-indexed") {
      return;
    }
    const gen = generation;
    const { surface, product } = header;
    fetchSent = true;
    fetchState = { kind: "fetching", surface, product };
    paint();
    let res: unknown;
    try {
      res = await sendMessage({ kind: "fetch", pageUrl: pinnedUrl });
    } catch {
      if (gen !== generation) {
        // A re-read moved this panel on while the fetch was in flight — this
        // page's fetch state is no longer what the panel describes.
        return;
      }
      fetchState = { kind: "error", surface, message: "Couldn't connect to Nimbus." };
      paint();
      return;
    }
    if (gen !== generation) {
      return;
    }
    if (isFetchResponse(res) && res.ok && res.outcome.kind === "indexed") {
      // The fetch response carries only {status:"indexed", itemId} — no title,
      // url or modified_at — so the panel cannot build a `resolved` header from
      // it directly. Re-send resolve and let the normal path render.
      fetchState = null;
      await loadHeader();
      return;
    }
    const outcomeHeader = fetchOutcomeHeader(res, surface, product);
    if (outcomeHeader.kind === "fetch-retry" && outcomeHeader.reason === "rate-limited") {
      // Returned before any outbound call happens (see fetchOutcomeHeader's
      // rate-limited branch) — nothing is in flight, so this is not the
      // condition `fetchSent` guards against. Clear it so "Try again" sends a
      // genuinely fresh fetch instead of silently doing nothing.
      fetchSent = false;
    }
    fetchState = outcomeHeader;
    paint();
  }

  /**
   * The confirm preview's Send control. Clears `fetchPreview`, then runs the
   * ordinary `sendFetch` — UNCHANGED, including its own `fetchSent` latch and
   * every guard/comment on it. This is the one and only path that actually
   * sends the outbound request; opening the preview never does.
   */
  function confirmFetch(): void {
    fetchPreview = null;
    sendFetch().catch(() => undefined);
  }

  /**
   * The confirm preview's Cancel control. Clears `fetchPreview` and repaints
   * back to the ordinary header — deliberately does NOT touch `fetchSent`.
   * Declining once must leave the Fetch button exactly as usable as it was
   * before the click that opened the preview; latching here would turn "no
   * thanks" into "never again" for this panel.
   */
  function cancelFetchPreview(): void {
    fetchPreview = null;
    paint();
  }

  /**
   * `renderShell`'s `onFetch` callback. `"resolve"` re-checks via a normal
   * resolve — used by the recovery button on `fetch-retry` states; it is a
   * read against our own gateway, not an outbound provider request, so it
   * needs no confirm step. `"fetch"` — reached from both the initial "Fetch
   * this from X" button and a rate-limited "Try again" click — no longer
   * sends anything itself: it NAMES the target and opens the confirm preview
   * (`fetchPreview`), and only `confirmFetch` (Send, above) goes on to call
   * `sendFetch`. Never conflate `"resolve"` with `"fetch"`: a `still-working`
   * retry that opened a fetch preview (or, worse, sent one) would defeat the
   * one-fetch-per-panel rule.
   */
  async function handleFetchAction(action: "fetch" | "resolve"): Promise<void> {
    if (action === "resolve") {
      await loadHeader();
      return;
    }
    // The surface KIND (`SurfaceKind`, e.g. "pr") comes from `pinnedRecognition`,
    // not from `header` — same reasoning as `paint()`'s own `surfaceKind` above:
    // the `not-indexed` HeaderState carries only the human surface LINE, not the
    // typed kind `FetchTarget` needs.
    const surfaceKind = pinnedRecognition?.ok === true ? pinnedRecognition.kind : null;
    if (header.kind !== "not-indexed" || surfaceKind === null) {
      return;
    }
    fetchPreview = { product: header.product, surface: surfaceKind, url: pinnedUrl };
    paint();
  }

  /**
   * Sends a capture for this panel's pinned page — the last resort offered
   * once `offersCapture` says the gateway has nothing better to try — and,
   * once it has one, hands the result to `sendCapturedClip`. Mirrors
   * `sendFetch` exactly: one latch (`capturing`), a `captureState` override
   * that wins in `shownHeader()`, a `generation` re-check after every
   * `await`, and one `paint()` per transition — so every in-flight step has a
   * visible status line, which matters most with the 1.3 preview switched
   * OFF, where there is no confirm step in between.
   *
   * The ONLY sender of `capture` — reached from BOTH the initial "Save a copy
   * to Nimbus" offer and the captured header's "Update this copy" button
   * (`runCapture` below passes this same function to both). Ingest upserts on
   * the canonicalised URL (`POST /v1/clips`), so a re-capture through this
   * one function refreshes the one item rather than creating a second — there
   * is no second flow for "Update this copy" to run.
   */
  async function sendCapture(): Promise<void> {
    if (capturing) {
      return;
    }
    const gen = generation;
    const surface = captureSurface();
    capturing = true;
    // A fresh attempt retires whatever refusal the LAST one left on screen —
    // see `captureRefusal`'s own doc comment for why nothing else clears it.
    captureRefusal = null;
    captureState = { kind: "error", surface, message: "Capturing this page…" };
    paint();
    let res: unknown;
    try {
      res = await sendMessage({ kind: "capture", pageUrl: pinnedUrl });
    } catch {
      if (gen !== generation) {
        // A re-read moved this panel on while the capture was in flight —
        // this page's capture is no longer what the panel describes.
        return;
      }
      captureState = null;
      captureRefusal = "Couldn't connect to Nimbus.";
      capturing = false;
      paint();
      return;
    }
    if (gen !== generation) {
      return;
    }
    if (!isCaptureResponse(res)) {
      captureState = null;
      captureRefusal = "Couldn't read Nimbus's answer.";
      capturing = false;
      paint();
      return;
    }
    if (!res.ok) {
      captureState = null;
      captureRefusal = CAPTURE_MESSAGES[res.reason];
      capturing = false;
      paint();
      return;
    }
    pendingCapture = res.capture;
    if (res.preview === null) {
      // The user switched the 1.3 confirm off — send the clip immediately,
      // with no confirm step in between.
      captureState = null;
      await sendCapturedClip();
      return;
    }
    // Awaiting the user's own Send/Cancel — not yet an attempt, so
    // `captureState` clears back to null exactly like `fetchState` staying
    // null while `fetchPreview` is up: the status lines above describe
    // genuine network activity, and there is none while this box is on
    // screen.
    captureState = null;
    capturePreview = res.preview;
    paint();
  }

  /**
   * Sends the clip for `pendingCapture` — reached either directly from
   * `sendCapture` (preview off) or from the confirm preview's Send control
   * (preview on, via `confirmCapture` below). On success, clears every
   * capture field and re-resolves: the RE-RESOLVE, not this response, is what
   * turns the header into the `captured` arm (`headerFrom` reads
   * `isCapturedCopy` off a resolve outcome, and a clip response carries no
   * item at all to build one from).
   */
  async function sendCapturedClip(): Promise<void> {
    if (pendingCapture === null) {
      return;
    }
    const gen = generation;
    const surface = captureSurface();
    const capture = pendingCapture;
    captureState = { kind: "error", surface, message: "Saving to Nimbus…" };
    paint();
    let res: unknown;
    try {
      res = await sendMessage({ kind: "clip", capture, tags: [] });
    } catch {
      if (gen !== generation) {
        return;
      }
      captureState = null;
      captureRefusal = "Couldn't connect to Nimbus.";
      capturing = false;
      paint();
      return;
    }
    if (gen !== generation) {
      return;
    }
    if (!isClipResponse(res)) {
      captureState = null;
      captureRefusal = "Couldn't read Nimbus's answer.";
      capturing = false;
      paint();
      return;
    }
    if (!res.ok) {
      // Mirrors popup.ts's own wording for the identical `ClipResponse` shape
      // (see its `send()`): `rate_limited` is checked BEFORE the generic
      // `queued` case so it never reads as "Nimbus is down", and `queued`
      // itself must not read as a failure — the clip was NOT dropped, it is
      // sitting in the offline queue and will be retried.
      //
      // A queued outcome stays on `captureState`, same as the terminal
      // success line below — the clip was not dropped, so there is nothing to
      // retry and no reason to hide the header behind it. Only a genuine,
      // NON-queued failure is the refusal Finding 1 is about: it goes to
      // `captureRefusal` instead, so the header — and its capture offer —
      // stays reachable for a retry rather than stranding the panel.
      const queued = res.reason === "rate_limited" || res.queued === true;
      const message = queued ? queuedClipMessage(res.reason) : "Couldn't save this copy to Nimbus.";
      if (queued) {
        captureState = { kind: "error", surface, message };
      } else {
        captureState = null;
        captureRefusal = message;
      }
      capturing = false;
      paint();
      return;
    }
    // A save produces its own visible confirmation, independent of the
    // re-resolve below. On the primary target for this feature — a page with
    // no configured connector at all — `handleResolve` never calls the
    // gateway for a URL it cannot recognise (its own `!recognition.ok`
    // short-circuit), so the richer `captured` header this panel would
    // otherwise wait for is UNREACHABLE there: without this line, the
    // `await loadHeader()` below would settle back to the exact pre-click
    // "Save a copy" offer, and a successful save would look like nothing
    // happened. This says only that a copy was saved — never that it is
    // indexed or connector-backed, which on this path it is not.
    captureState = {
      kind: "error",
      surface,
      message: `Saved a copy of “${capture.title}” to Nimbus.`,
    };
    pendingCapture = null;
    capturePreview = null;
    capturing = false;
    paint();
    await loadHeader();
  }

  /**
   * The capture confirm preview's Send control. Clears `capturePreview`, then
   * runs the ordinary `sendCapturedClip` — UNCHANGED — the one and only path
   * that actually posts the clip; opening the preview never does. Mirrors
   * `confirmFetch` exactly.
   */
  function confirmCapture(): void {
    capturePreview = null;
    sendCapturedClip().catch(() => undefined);
  }

  /**
   * The capture confirm preview's Cancel control. Mirrors `cancelFetchPreview`:
   * declining must leave the offer exactly as usable as before it was ever
   * clicked, so this clears every capture field — INCLUDING `capturing` —
   * rather than latching "no thanks" into "never again" for this panel.
   */
  function cancelCapturePreview(): void {
    pendingCapture = null;
    capturePreview = null;
    capturing = false;
    paint();
  }

  /** `renderShell`'s `onCapture`/`onRecapture` callback — the SAME function
   *  passed for both controls (see `sendCapture`'s own doc comment for why a
   *  re-capture is not a second flow). */
  function runCapture(): void {
    sendCapture().catch(() => undefined);
  }

  /**
   * Take in a selection: the one the panel found live on the page when it
   * mounted, or one a context-menu entry handed to an already-open panel.
   *
   * `define` runs the lane immediately — the user asked a question, and an
   * answer is the gesture's whole point. `related` does not: the term becomes
   * visible to the panel (so the lane appears, collapsed) but nobody asked for a
   * definition, and spending an agent run on an unasked question is how ambient
   * UI earns a reputation for noise. `null` intent is the mount snapshot, which
   * asks for nothing at all.
   */
  function applySelection(text: string, intent: PanelSelection["intent"] | null): void {
    term = termStateFrom(text);
    if (intent === "define") {
      // Expanded from here rather than by the user's click, so the run has to be
      // started explicitly: `attachLaneToggle` deliberately swallows the
      // synthetic toggle a freshly-rendered open <details> fires, which is what
      // stops a repaint from re-invoking every open lane.
      laneOpen.glossary = true;
      paint();
      sendAgentRun("glossary").catch(() => undefined);
      return;
    }
    paint();
    if (intent === "related") {
      loadRelated(text).catch(() => undefined);
    }
  }

  /**
   * @param selection - Overrides the live page selection. The menu path must
   * pass it: the user's next click is usually into this panel, and clicking into
   * the panel collapses the page selection, so by the time an open panel acts on
   * a menu entry `window.getSelection()` may already read empty. `readContext`
   * remains the source on mount, when the selection is still live.
   */
  async function loadRelated(selection?: string): Promise<void> {
    const gen = generation;
    let res: unknown;
    // The item this panel's header names — `resolved`, or the candidate the
    // user picked out of an ambiguous answer. Reusing `shownHeader()` means the
    // lane can never be about a different item than the header above it. Hoisted
    // above the `try` so the success branch below can filter it back out of the
    // gateway's own results (see that branch's own comment for why).
    const shown = shownHeader();
    const itemId = shownItemId(shown);
    try {
      const context = readContext();
      res = await sendMessage({
        kind: "related",
        ...context,
        ...(itemId === undefined ? {} : { itemId }),
        ...(selection === undefined ? {} : { selection }),
      });
    } catch {
      if (gen !== generation) {
        // A re-read moved this panel on while this request was in flight — the
        // re-read's own loadRelated call owns `relatedBody` now.
        return;
      }
      relatedBody = (doc) => renderError(doc, "Couldn't connect to Nimbus.");
      paint();
      return;
    }
    if (gen !== generation) {
      return;
    }
    if (!isRelatedResponse(res)) {
      relatedBody = (doc) => renderError(doc, "Unexpected response.");
    } else if (res.ok) {
      // Defends the old-gateway skew case: a gateway older than this feature
      // ignores `itemId` entirely and applies no exclusion of its own, and the
      // query is this item's own title — which matches this item best of all.
      // Filtering here makes the gateway's own `excludeId` (clip-related.ts)
      // belt-and-braces rather than the sole guard against the page listing
      // itself as its own top related result.
      const items: RelatedHit[] =
        itemId === undefined ? res.items : res.items.filter((h) => h.id !== itemId);
      const nowMs = Date.now();
      relatedBody = (doc) => renderHits(doc, items, nowMs);
    } else {
      const message = RELATED_MESSAGES[res.reason] ?? "Couldn't fetch related items.";
      relatedBody = (doc) => renderError(doc, message);
    }
    paint();
  }

  navCheckTimer = setInterval(() => {
    checkNavigation().catch(() => undefined);
  }, NAV_CHECK_MS);

  return {
    paint,
    loadHeader,
    loadRelated,
    stopPolling: stopAgentPolls,
    checkNavigation,
    applySelection,
  };
}

function mount(): void {
  const host = document.createElement("div") as NimbusHost;
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;

  const panel = document.createElement("section");
  panel.className = "nimbus-related";
  // A non-modal landmark, NOT role="dialog": the user reads the page alongside the
  // panel, so focus is intentionally not trapped (a trap would fight that).
  panel.setAttribute("role", "complementary");
  panel.setAttribute("aria-label", "Related items in Nimbus");

  const header = document.createElement("header");
  header.className = "nimbus-related__header";
  const heading = document.createElement("h1");
  heading.className = "nimbus-related__heading";
  heading.textContent = "Related in Nimbus";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "nimbus-related__close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Close");
  header.append(heading, close);

  const body = document.createElement("div");
  body.className = "nimbus-related__body";
  const view = createPanel(body);
  view.paint();

  panel.append(header, body);
  root.append(style, panel);
  document.documentElement.append(host);

  // One AbortController detaches every listener on teardown — no orphans on toggle.
  const controller = new AbortController();
  const { signal } = controller;
  const teardown = (): void => {
    controller.abort();
    view.stopPolling();
    host.remove();
  };
  host.__nimbusClose = teardown;
  host.__nimbusSelection = (selection) => {
    view.applySelection(selection.text, selection.intent);
  };
  close.addEventListener("click", teardown, { signal });
  // Capture phase + stopPropagation so host apps (Docs/Jira/GitHub) don't also act on Esc.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        teardown();
      }
    },
    { signal, capture: true },
  );
  // popstate covers back/forward, which the interval would otherwise only notice
  // up to NAV_CHECK_MS later. It does NOT cover pushState — that is what the
  // interval is for (see NAV_CHECK_MS).
  window.addEventListener(
    "popstate",
    () => {
      view.checkNavigation().catch(() => undefined);
    },
    { signal },
  );
  // The interval skips hidden tabs, so this is what makes the notice correct at
  // the moment the user switches back and looks at the panel.
  document.addEventListener(
    "visibilitychange",
    () => {
      view.checkNavigation().catch(() => undefined);
    },
    { signal },
  );

  // A selection live on the page at mount is one the panel can see, so it takes
  // it: the glossary lane appears, collapsed, naming the term. No intent, so
  // nothing is asked — this is the convenience path, not the contract. The
  // context menu is the reliable one, because a click into the panel collapses
  // the page selection and this read would then find nothing.
  const selected = window.getSelection()?.toString() ?? "";
  if (selected !== "") {
    view.applySelection(selected, null);
  }

  // Land keyboard/screen-reader users inside the panel (focus only — no trap).
  close.focus();
  // Header now GATES Related: `loadRelated` reads `shownHeader()` — which is
  // only meaningful once `header` has been assigned — SYNCHRONOUSLY, before its
  // own first `await`, so firing the two in parallel sent every related request
  // with no `itemId` at all (the header was still `{kind:"loading"}`). Chained
  // instead of run side by side — one extra loopback round-trip before Related
  // starts, in exchange for Related actually being about the item the header
  // names. `loadHeader` never rejects (it catches its own send failure and
  // paints an error header), so this `.then` is reached on every mount; the
  // `.catch` below is fail-closed insurance, same as every other detached call
  // in this codebase (see service-worker.ts): there is no console in src/ and
  // nowhere to report an unexpected rejection, so swallowing it beats an
  // unhandled rejection in the host page.
  view
    .loadHeader()
    .then(() => view.loadRelated())
    .catch(() => undefined);
}

// Self-toggle entry: an existing panel closes via its own teardown (aborting its
// listeners); otherwise mount a fresh one.
const existing = document.getElementById(HOST_ID) as NimbusHost | null;
if (existing !== null) {
  if (existing.__nimbusClose !== undefined) {
    existing.__nimbusClose();
  } else {
    existing.remove();
  }
} else {
  mount();
}
