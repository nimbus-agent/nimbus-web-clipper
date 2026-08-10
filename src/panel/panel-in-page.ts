// src/panel/panel-in-page.ts
// Injected as dist/<target>/panel.js. Self-toggling: re-injection closes an open
// panel. Mounts a Shadow-DOM overlay (inlined styles — no web_accessible_resources),
// reads the page context, asks the SW for related items, and renders them.
import { sendMessage } from "../browser/runtime.ts";
import {
  isAgentStateResponse,
  isFetchResponse,
  isRelatedResponse,
  isResolveResponse,
} from "../shared/messages.ts";
import { surfaceLine } from "../shared/recognise.ts";
import {
  AGENT_LANES,
  type AgentLane,
  type LaneState,
  type Product,
  type RelatedHit,
  type ResolveCandidate,
} from "../shared/types.ts";
import {
  type HeaderState,
  type Lane,
  renderError,
  renderHits,
  renderLaneBody,
  renderShell,
} from "./panel-view.ts";

const HOST_ID = "nimbus-related-host";

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

/** The two C2 agent lanes' summary labels — each phrased as the question its
 *  agent answers, matching the design spec's own naming
 *  (docs/superpowers/specs/2026-08-10-c2-agent-lanes-design.md). */
const LANE_TITLES: Record<AgentLane, string> = {
  impact: "What breaks if it lands",
  expert: "Who should review it",
};

/** How often an OPEN panel re-asks the worker for a running lane's state — a
 *  repaint cadence, not the worker's own poll of the gateway (which lives in
 *  service-worker.ts's tickAgentPoll and keeps running after this panel closes). */
const AGENT_POLL_MS = 1_000;

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
.nimbus-related__badge {
  display: inline-block;
  margin: 4px 0;
  padding: 1px 6px;
  font-size: 11px;
  border-radius: 4px;
  background: var(--nimbus-border);
  color: var(--nimbus-muted);
}
.nimbus-related__snippet { margin: 4px 0 0; color: var(--nimbus-muted); }
.nimbus-related__status { padding: 16px; color: var(--nimbus-muted); overflow-wrap: anywhere; }
.nimbus-related__shell { display: flex; flex-direction: column; }
.nimbus-related__header-state { padding: 12px 16px; border-bottom: 1px solid var(--nimbus-border); }
.nimbus-related__header-state .nimbus-related__status { padding: 4px 0 0; }
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
`;

interface NimbusHost extends HTMLElement {
  __nimbusClose?: () => void;
}

function readContext(): { title: string; canonicalUrl?: string; selection: string } {
  const canonical =
    document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? undefined;
  const selection = window.getSelection()?.toString() ?? "";
  return {
    title: document.title,
    ...(canonical !== undefined && canonical !== "" ? { canonicalUrl: canonical } : {}),
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
  const outcome = res.outcome;
  if (outcome.kind === "found") {
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
 * One panel's state and the two loads that fill it. Resolve and related are
 * fetched in PARALLEL and land independently: a slow or failing resolve must
 * never keep the related lane from appearing.
 *
 * State lives in this closure rather than at module level. Each injection of
 * panel.js re-evaluates the bundle in a fresh scope, so module-level `let` would
 * not actually leak between mounts — but a closure needs no reset step, and it
 * makes "this response belongs to that panel" structural instead of incidental.
 */
function createPanel(body: HTMLElement): {
  paint: () => void;
  loadHeader: () => Promise<void>;
  loadRelated: () => Promise<void>;
  stopPolling: () => void;
} {
  let header: HeaderState = { kind: "loading" };
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
  // Resolve and related land at different times and each triggers a full repaint,
  // so a lane the user collapsed in between would spring back open. Read the live
  // <details> state before replacing it and carry it into the next render.
  let relatedExpanded = true;

  // --- Agent lanes (impact/expert) ---------------------------------------
  //
  // Per-lane state, seeded to `collapsed` — "never opened" — for the life of
  // this panel. Only rendered while the header names a single resolved item
  // (`resolved`/`chosen`) — see `showAgentLanes` in paint() below.
  const laneState: Record<AgentLane, LaneState> = {
    impact: { kind: "collapsed" },
    expert: { kind: "collapsed" },
  };
  // Whether each lane's own <details> is open, carried across repaints exactly
  // like `relatedExpanded` above.
  const laneOpen: Record<AgentLane, boolean> = { impact: false, expert: false };
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
    let res: unknown;
    try {
      res = await sendMessage({ kind: "agent-state", lane, pageUrl: window.location.href });
    } catch {
      // The worker itself is unreachable — nothing to retry against here; the
      // next lane toggle or Re-run will find out again. Leave the last known
      // state on screen rather than guessing a new one.
      return;
    }
    if (closed) {
      // The panel was torn down while this poll was in flight. There's
      // nothing left to repaint, and scheduling another tick would poll — and,
      // via handleAgentState's own resolve call, hit the gateway — forever on
      // a panel that no longer exists. See `closed`'s own doc comment.
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
   * Invokes a lane's agent. The ONLY sender of `agent-run` — called both from
   * a lane's toggle-open (first expand) and from `renderLaneBody`'s Re-run
   * button — so the `laneInFlight` guard here is what protects both paths at
   * once.
   */
  async function sendAgentRun(lane: AgentLane): Promise<void> {
    if (laneInFlight.has(lane)) {
      return;
    }
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
      res = await sendMessage({ kind: "agent-run", lane, pageUrl: window.location.href });
    } catch {
      laneInFlight.delete(lane);
      if (closed) {
        return;
      }
      laneState[lane] = { kind: "failed", reason: "unreachable" };
      paint();
      return;
    }
    laneInFlight.delete(lane);
    if (closed) {
      // See `closed`'s own doc comment: a response landing after teardown
      // must not repaint a detached body or start a fresh poll timer that
      // `stopAgentPolls` has already run past.
      return;
    }
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

  /** Stops every lane's poll timer and marks this panel closed — called on
   *  panel teardown. The worker's own poll of the gateway is untouched: it
   *  survives this panel closing by design. Setting `closed` here (not just
   *  clearing pending timers) is what stops an invoke or poll already in
   *  flight from starting a brand-new timer once its response lands — see
   *  `closed`'s own doc comment. */
  function stopAgentPolls(): void {
    closed = true;
    for (const lane of AGENT_LANES) {
      clearLanePoll(lane);
    }
  }

  function paint(): void {
    const open = body.querySelector<HTMLDetailsElement>('[data-lane="related"]');
    if (open !== null) {
      relatedExpanded = open.open;
    }
    // Each repaint (resolve/related landing, a lane's own state changing, …)
    // rebuilds every <details> from scratch — read the live open/closed state
    // before replacing it, same as `relatedExpanded` above, so a lane the user
    // toggled doesn't spring back to its previous state.
    for (const lane of AGENT_LANES) {
      const el = body.querySelector<HTMLDetailsElement>(`[data-lane="${lane}"]`);
      if (el !== null) {
        laneOpen[lane] = el.open;
      }
    }
    // `fetchState` wins whenever it is set — see its doc comment above for why a
    // recovery resolve that is still a miss must not displace it. A chosen
    // candidate renders via `chosen`, never `resolved` — candidates carry no
    // `modifiedAt`, and `resolved` would demand one.
    const shown: HeaderState =
      fetchState !== null
        ? fetchState
        : chosen !== null && header.kind === "ambiguous"
          ? { kind: "chosen", surface: header.surface, candidate: chosen }
          : header;
    // The two agent lanes ask a question about ONE resolved item — there is
    // nothing to ask about on a miss, an error, or an ambiguous answer still
    // awaiting a pick. `chosen` counts alongside `resolved`: the user has
    // already pinned down which item this page is, even though it renders
    // without a `modifiedAt`.
    const showAgentLanes = shown.kind === "resolved" || shown.kind === "chosen";
    const agentLanes: Lane[] = showAgentLanes
      ? AGENT_LANES.map((lane) => ({
          id: lane,
          title: LANE_TITLES[lane],
          expanded: laneOpen[lane],
          render: (doc: Document) =>
            // Every rendered lane gets a REAL Re-run handler — never omitted.
            // `renderLaneBody`'s third argument is optional so it can be unit
            // tested without one, but a lane rendered here without it would
            // ship a Re-run button that silently does nothing.
            renderLaneBody(doc, laneState[lane], () => {
              sendAgentRun(lane).catch(() => undefined);
            }),
        }))
      : [];
    const lanes: Lane[] = [
      { id: "related", title: "Related", expanded: relatedExpanded, render: relatedBody },
      ...agentLanes,
    ];
    body.replaceChildren(
      renderShell(
        document,
        { header: shown, lanes },
        (c) => {
          chosen = c;
          paint();
        },
        (action) => {
          handleFetchAction(action).catch(() => undefined);
        },
      ),
    );
    // `renderShell`/`renderLane` build a fresh <details> every repaint — attach
    // this repaint's toggle listeners after the fact rather than threading a
    // callback through `Lane`, which every OTHER lane (including "related")
    // does not need. `attachLaneToggle` (above) is what filters out the
    // synthetic "toggle" a fresh, already-expanded element queues on its own
    // — this loop only wires it to this lane's own handler.
    //
    // A `pollLane` answer of `collapsed` for a lane the user has open is
    // converted to `failed`/`stale` before it is ever stored (see `pollLane`
    // above), so that specific path can no longer reach `onLaneToggle`'s own
    // `kind === "collapsed"` invoke condition while a lane sits open — but
    // `attachLaneToggle`'s suppression is the general-purpose one underneath
    // it, independent of whatever the caller's state happens to be.
    for (const lane of AGENT_LANES) {
      const el = body.querySelector<HTMLDetailsElement>(`[data-lane="${lane}"]`);
      if (el === null) {
        continue;
      }
      attachLaneToggle(el, (open) => onLaneToggle(lane, open));
    }
  }

  async function loadHeader(): Promise<void> {
    let res: unknown;
    try {
      res = await sendMessage({
        kind: "resolve",
        pageUrl: window.location.href,
        title: document.title,
      });
    } catch {
      header = { kind: "error", surface: null, message: "Couldn't connect to Nimbus." };
      fetchState = null;
      paint();
      return;
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
    const { surface, product } = header;
    fetchSent = true;
    fetchState = { kind: "fetching", surface, product };
    paint();
    let res: unknown;
    try {
      res = await sendMessage({ kind: "fetch", pageUrl: window.location.href });
    } catch {
      fetchState = { kind: "error", surface, message: "Couldn't connect to Nimbus." };
      paint();
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
   * `renderShell`'s `onFetch` callback. `"fetch"` sends the (one, ever) targeted
   * fetch; `"resolve"` re-checks via a normal resolve — used by the recovery
   * button on `fetch-retry` states. Never conflate the two: a `still-working`
   * retry that fired a fresh fetch would defeat the one-fetch-per-panel rule.
   */
  async function handleFetchAction(action: "fetch" | "resolve"): Promise<void> {
    if (action === "resolve") {
      await loadHeader();
      return;
    }
    await sendFetch();
  }

  async function loadRelated(): Promise<void> {
    let res: unknown;
    try {
      res = await sendMessage({ kind: "related", ...readContext() });
    } catch {
      relatedBody = (doc) => renderError(doc, "Couldn't connect to Nimbus.");
      paint();
      return;
    }
    if (!isRelatedResponse(res)) {
      relatedBody = (doc) => renderError(doc, "Unexpected response.");
    } else if (res.ok) {
      const items: RelatedHit[] = res.items;
      relatedBody = (doc) => renderHits(doc, items);
    } else {
      const message = RELATED_MESSAGES[res.reason] ?? "Couldn't fetch related items.";
      relatedBody = (doc) => renderError(doc, message);
    }
    paint();
  }

  return { paint, loadHeader, loadRelated, stopPolling: stopAgentPolls };
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

  // Land keyboard/screen-reader users inside the panel (focus only — no trap).
  close.focus();
  // Parallel on purpose — neither request gates the other. Fail closed like every
  // other detached call in this codebase (see service-worker.ts): there is no
  // console in src/ and nowhere to report an unexpected rejection, so swallowing
  // it beats an unhandled rejection in the host page.
  view.loadHeader().catch(() => undefined);
  view.loadRelated().catch(() => undefined);
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
