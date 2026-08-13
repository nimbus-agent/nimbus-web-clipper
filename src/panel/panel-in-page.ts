// src/panel/panel-in-page.ts
// Injected as dist/<target>/panel.js. Self-toggling: re-injection closes an open
// panel. Mounts a Shadow-DOM overlay (inlined styles — no web_accessible_resources),
// reads the page context, asks the SW for related items, and renders them.
import { sendMessage } from "../browser/runtime.ts";
import {
  isAgentStateResponse,
  isFetchResponse,
  isRecognitionResponse,
  isRelatedResponse,
  isResolveResponse,
} from "../shared/messages.ts";
import { sameItem, surfaceLine } from "../shared/recognise.ts";
import {
  AGENT_LANES,
  type AgentLane,
  LANE_SURFACES,
  type LaneState,
  type Product,
  type Recognition,
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

/**
 * The two C2 agent lanes' summary labels — each phrased as the question its
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
  impact: "What breaks if it lands",
  expert: "Who should review it",
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
.nimbus-related__navaway { padding: 10px 16px 12px; border-bottom: 1px solid var(--nimbus-border); }
.nimbus-related__navaway .nimbus-related__status { padding: 2px 0 4px; }
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
  checkNavigation: () => Promise<void>;
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
  // Resolve and related land at different times and each triggers a full repaint,
  // so a lane the user collapsed in between would spring back open. Read the live
  // <details> state before replacing it and carry it into the next render.
  let relatedExpanded = true;

  // --- Agent lanes (impact/expert) ---------------------------------------
  //
  // Per-lane state, seeded to `collapsed` — "never opened" — for the life of
  // this panel. Rendered ONLY when the header is `resolved` AND the pinned
  // page's surface is listed in `LANE_SURFACES` — see the gate in paint()
  // below. Not on `chosen`: that state is reachable only from an ambiguous
  // resolve, and the handler re-resolves and refuses anything that is not
  // `found`, so a lane there could never succeed. Deferred as ROADMAP C2.5.
  const laneState: Record<AgentLane, LaneState> = {
    impact: { kind: "collapsed" },
    expert: { kind: "collapsed" },
    catchup: { kind: "collapsed" },
    decisions: { kind: "collapsed" },
    ownership: { kind: "collapsed" },
  };
  // Whether each lane's own <details> is open, carried across repaints exactly
  // like `relatedExpanded` above.
  const laneOpen: Record<AgentLane, boolean> = {
    impact: false,
    expert: false,
    catchup: false,
    decisions: false,
    ownership: false,
  };
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
    const gen = generation;
    let res: unknown;
    try {
      res = await sendMessage({ kind: "agent-state", lane, pageUrl: pinnedUrl });
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
    await Promise.all([loadHeader(), loadRelated()]);
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
      res = await sendMessage({ kind: "agent-run", lane, pageUrl: pinnedUrl });
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
    // The two agent lanes ask a question about ONE resolved item, on a surface
    // where that question applies — see LANE_SURFACES (shared/types.ts). There is
    // nothing to ask about on a miss, an error, or an ambiguous answer, and
    // nothing worth asking `impact` about on a build or an issue.
    //
    // `chosen` is deliberately NOT included, even though the user has by then
    // pinned down which item this page is. `agent-run` carries only
    // `{lane, pageUrl}` (messages.ts), so `handleAgentRun` re-runs the resolve
    // itself — and on an ambiguous page that second resolve is ambiguous again,
    // which `resolveForAgent` refuses with `not_resolved` (handlers.ts).
    // Rendering the lanes here would put "Nimbus couldn't pin this page to one
    // indexed item." under a header naming the item the user just picked, with no
    // Re-run to escape it. Lanes on a chosen candidate need the picked id carried
    // through `agent-run` — see ROADMAP C2.5.
    //
    // The surface kind comes from `pinnedRecognition`, not from the header: the
    // `resolved` HeaderState carries only the human surface LINE ("GitHub PR ·
    // acme/web #482"), not the typed kind.
    const surfaceKind = pinnedRecognition?.ok === true ? pinnedRecognition.kind : null;
    const agentLanes: Lane[] =
      shown.kind === "resolved" && surfaceKind !== null
        ? AGENT_LANES.filter((lane) => LANE_SURFACES[lane].includes(surfaceKind)).map((lane) => ({
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
    const navAwayState = navAway
      ? {
          pinnedRef: pinnedRecognition?.ok === true ? pinnedRecognition.ref : null,
          onReread: () => {
            reread().catch(() => undefined);
          },
        }
      : undefined;
    body.replaceChildren(
      renderShell(
        document,
        {
          header: shown,
          lanes,
          ...(navAwayState === undefined ? {} : { navAway: navAwayState }),
        },
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
    const gen = generation;
    let res: unknown;
    try {
      res = await sendMessage({ kind: "related", ...readContext() });
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
      const items: RelatedHit[] = res.items;
      relatedBody = (doc) => renderHits(doc, items);
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
