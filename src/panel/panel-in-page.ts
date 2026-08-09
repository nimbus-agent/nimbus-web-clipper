// src/panel/panel-in-page.ts
// Injected as dist/<target>/panel.js. Self-toggling: re-injection closes an open
// panel. Mounts a Shadow-DOM overlay (inlined styles — no web_accessible_resources),
// reads the page context, asks the SW for related items, and renders them.
import { sendMessage } from "../browser/runtime.ts";
import { isFetchResponse, isRelatedResponse, isResolveResponse } from "../shared/messages.ts";
import { surfaceLine } from "../shared/recognise.ts";
import type { Product, RelatedHit, ResolveCandidate } from "../shared/types.ts";
import { type HeaderState, type Lane, renderError, renderHits, renderShell } from "./panel-view.ts";

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
// remaining `FetchError` reasons, mirroring `RESOLVE_MESSAGES` above.
const FETCH_MESSAGES: Record<string, string> = {
  not_paired: "Pair with Nimbus in Options to fetch this page.",
  unauthorized: "Nimbus rejected this pairing. Re-pair in Options.",
  unsupported: "This Nimbus gateway can't fetch pages yet.",
  unreachable: "Couldn't connect to Nimbus.",
  server_error: "Nimbus had an error fetching this page.",
};

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
.nimbus-related__status { padding: 16px; color: var(--nimbus-muted); }
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
 * `res.recognition` rides on both arms, mirroring `headerFrom`. When it comes
 * back not-ok, this maps to `unrecognised` rather than falling into
 * `FETCH_MESSAGES`. That specifically routes around a defect in
 * `handleFetch` (background/handlers.ts): it answers an unrecognised page
 * with `{reason:"server_error"}` instead of a clean outcome, unlike
 * `handleResolve`'s equivalent path. Left as `server_error` here it would
 * render "Nimbus had an error" — blaming the gateway for a client-side
 * condition. It is unreachable in practice (the fetch button only renders on
 * an already-recognised miss), but this guard means it can never render that
 * way if it ever were.
 */
function fetchOutcomeHeader(res: unknown, surface: string, product: Product): HeaderState {
  if (!isFetchResponse(res)) {
    return { kind: "error", surface, message: "Couldn't read Nimbus's answer." };
  }
  if (surfaceLine(res.recognition) === null) {
    return { kind: "unrecognised" };
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

  function paint(): void {
    const open = body.querySelector<HTMLDetailsElement>('[data-lane="related"]');
    if (open !== null) {
      relatedExpanded = open.open;
    }
    const lanes: Lane[] = [
      { id: "related", title: "Related", expanded: relatedExpanded, render: relatedBody },
    ];
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

  return { paint, loadHeader, loadRelated };
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
