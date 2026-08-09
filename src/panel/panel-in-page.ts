// src/panel/panel-in-page.ts
// Injected as dist/<target>/panel.js. Self-toggling: re-injection closes an open
// panel. Mounts a Shadow-DOM overlay (inlined styles — no web_accessible_resources),
// reads the page context, asks the SW for related items, and renders them.
import { sendMessage } from "../browser/runtime.ts";
import { isRelatedResponse, isResolveResponse } from "../shared/messages.ts";
import { surfaceLine } from "../shared/recognise.ts";
import type { RelatedHit, ResolveCandidate } from "../shared/types.ts";
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

function headerFrom(res: unknown, nowMs: number): HeaderState {
  if (!isResolveResponse(res)) {
    return { kind: "error", surface: null, message: "Couldn't read Nimbus's answer." };
  }
  const surface = surfaceLine(res.recognition);
  if (!res.ok) {
    // `insufficient_scope` is NOT an error: the route works, the owner just has
    // not granted this device the scope. It gets its own state so the panel can
    // say what to run instead of blaming Nimbus.
    if (res.reason === "insufficient_scope" && surface !== null) {
      return { kind: "needs-scope", surface };
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
  return { kind: "not-indexed", surface };
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
    // A chosen candidate renders via `chosen`, never `resolved` — candidates carry
    // no `modifiedAt`, and `resolved` would demand one.
    const shown: HeaderState =
      chosen !== null && header.kind === "ambiguous"
        ? { kind: "chosen", surface: header.surface, candidate: chosen }
        : header;
    body.replaceChildren(
      renderShell(document, { header: shown, lanes }, (c) => {
        chosen = c;
        paint();
      }),
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
      paint();
      return;
    }
    // Taken ONCE per repaint here, not re-read per rendered line — see the
    // `resolved` state's `nowMs` doc comment in panel-view.ts.
    header = headerFrom(res, Date.now());
    paint();
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
