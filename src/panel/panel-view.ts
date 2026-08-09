// src/panel/panel-view.ts
// Pure DOM builders for the related-items panel. Every gateway-provided string is
// written via textContent (never innerHTML) — the indexed content is
// attacker-influenceable, so plain-text rendering is the XSS backstop.
import { formatAge } from "../shared/freshness.ts";
import type {
  RelatedHit,
  ResolveCandidate,
  ResolvedItem,
  ResolveMatchKind,
} from "../shared/types.ts";

/** Returns the parsed href when the scheme is http or https; null otherwise.
 *  Rejects javascript:, data:, vbscript:, relative paths, and malformed URLs. */
function safeHttpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
}

export function renderError(doc: Document, message: string): HTMLElement {
  const p = doc.createElement("p");
  p.className = "nimbus-related__status";
  p.textContent = message;
  return p;
}

export function renderHit(doc: Document, hit: RelatedHit): HTMLElement {
  const item = doc.createElement("li");
  item.className = "nimbus-related__item";

  const href = hit.url !== null ? safeHttpUrl(hit.url) : null;

  let title: HTMLElement;
  if (href !== null) {
    const link = doc.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = hit.title;
    title = link;
  } else {
    const span = doc.createElement("span");
    span.textContent = hit.title;
    title = span;
  }
  title.classList.add("nimbus-related__title");

  const badge = doc.createElement("span");
  badge.className = "nimbus-related__badge";
  badge.textContent = hit.service;

  const snippet = doc.createElement("p");
  snippet.className = "nimbus-related__snippet";
  snippet.textContent = hit.snippet;

  item.append(title, badge, snippet);
  return item;
}

export function renderHits(doc: Document, items: RelatedHit[]): HTMLElement {
  if (items.length === 0) {
    return renderError(doc, "No related items found.");
  }
  const list = doc.createElement("ul");
  list.className = "nimbus-related__list";
  for (const hit of items) {
    list.append(renderHit(doc, hit));
  }
  return list;
}

/**
 * What the panel header says. One state per outcome — never a silent blank.
 *
 * NOTE: `loading` carries no surface line. The design spec's header table lists a
 * "recognised, resolving" state, but that state cannot occur on the client:
 * recognition and resolution are decided together in the service worker and
 * arrive in ONE response, so the panel goes straight from `loading` to a settled
 * state. This is a direct consequence of the spec's own one-round-trip decision.
 */
export type HeaderState =
  | { readonly kind: "loading" }
  | { readonly kind: "unrecognised" }
  | {
      readonly kind: "resolved";
      readonly surface: string;
      readonly item: ResolvedItem;
      readonly matchKind: ResolveMatchKind;
      /**
       * Captured once, when the resolve response lands — NOT re-read per repaint.
       * So the age is frozen at load: a panel left open for ten minutes keeps
       * saying "indexed 3 min ago".
       *
       * That is acceptable HERE and only here, because nothing in this plan
       * repaints a `resolved` header — the one repaint trigger is choosing an
       * ambiguous candidate, and the `chosen` arm renders no freshness at all.
       * If a future lane ever repaints a resolved header, make this a render-time
       * parameter instead of state; a clock reading stored in a state object goes
       * stale by construction.
       */
      readonly nowMs: number;
    }
  /**
   * A candidate the USER picked out of an ambiguous answer. Distinct from
   * `resolved` because a candidate carries no `modified_at`: rendering it as
   * resolved would mean inventing a freshness, which is precisely the invisible
   * staleness this header exists to avoid.
   */
  | { readonly kind: "chosen"; readonly surface: string; readonly candidate: ResolveCandidate }
  | {
      readonly kind: "ambiguous";
      readonly surface: string;
      readonly candidates: readonly ResolveCandidate[];
      readonly truncated: boolean;
    }
  | { readonly kind: "not-indexed"; readonly surface: string }
  /** A 403. The token predates the `resolve` scope; the OWNER grants it. */
  | { readonly kind: "needs-scope"; readonly surface: string }
  | { readonly kind: "error"; readonly surface: string | null; readonly message: string };

/** A collapsible section of the panel. Phase C2 adds why/impact/expert here. */
export interface Lane {
  readonly id: string;
  readonly title: string;
  readonly expanded: boolean;
  readonly render: (doc: Document) => HTMLElement;
}

export interface PanelState {
  readonly header: HeaderState;
  readonly lanes: readonly Lane[];
}

function line(doc: Document, className: string, text: string): HTMLElement {
  const el = doc.createElement("p");
  el.className = className;
  el.textContent = text;
  return el;
}

/** `title` for a candidate; `title` + freshness for a resolved item. */
function candidateLine(doc: Document, c: ResolveCandidate): HTMLElement {
  const href = c.url !== null ? safeHttpUrl(c.url) : null;
  if (href === null) {
    return line(doc, "nimbus-related__header-item", c.title);
  }
  const wrapper = doc.createElement("p");
  wrapper.className = "nimbus-related__header-item";
  const link = doc.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = c.title;
  wrapper.append(link);
  return wrapper;
}

function chooser(
  doc: Document,
  candidates: readonly ResolveCandidate[],
  onChoose: ((c: ResolveCandidate) => void) | undefined,
): HTMLElement {
  const list = doc.createElement("ul");
  list.className = "nimbus-related__candidates";
  for (const c of candidates) {
    const li = doc.createElement("li");
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "nimbus-related__candidate";
    // textContent, never innerHTML — this string comes from the gateway.
    button.textContent = c.title;
    if (onChoose !== undefined) {
      button.addEventListener("click", () => onChoose(c));
    }
    li.append(button);
    list.append(li);
  }
  return list;
}

export function renderHeader(
  doc: Document,
  state: HeaderState,
  onChoose?: (c: ResolveCandidate) => void,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-related__header-state";

  if (state.kind === "loading") {
    box.append(line(doc, "nimbus-related__status", "Checking Nimbus…"));
    return box;
  }
  if (state.kind === "unrecognised") {
    box.append(
      line(doc, "nimbus-related__surface", "Not a recognised Nimbus surface"),
      line(
        doc,
        "nimbus-related__status",
        "Add this site under Recognised surfaces in Options to recognise it.",
      ),
    );
    return box;
  }
  // Handled whole rather than folded into the shared tail below: `surface` is
  // nullable only on this arm, and splitting it would leave the tail unable to
  // narrow it to a string.
  if (state.kind === "error") {
    if (state.surface !== null) {
      box.append(line(doc, "nimbus-related__surface", state.surface));
    }
    box.append(line(doc, "nimbus-related__status", state.message));
    return box;
  }

  box.append(line(doc, "nimbus-related__surface", state.surface));

  if (state.kind === "resolved") {
    box.append(candidateLine(doc, state.item));
    box.append(
      line(
        doc,
        "nimbus-related__status",
        `Indexed ${formatAge(state.item.modifiedAt, state.nowMs)}`,
      ),
    );
    // Only rung 3 gets a hedge. Rungs 1 and 2 differ by query params, which carry
    // no identity on any surface the recogniser matches; rung 3 got here by
    // discarding path segments, so it may be the parent of the page, not the page.
    if (state.matchKind === "path_trimmed") {
      box.append(
        line(doc, "nimbus-related__status", "Closest match — this page's exact URL isn't indexed."),
      );
    }
    return box;
  }

  if (state.kind === "chosen") {
    box.append(candidateLine(doc, state.candidate));
    return box;
  }

  if (state.kind === "ambiguous") {
    if (state.truncated) {
      // Upstream deliberately sends an EMPTY list when it would have to truncate:
      // a shortened menu implies the right answer is on it. Say so instead.
      box.append(
        line(
          doc,
          "nimbus-related__status",
          "Too many matches to choose from — open the item in Nimbus.",
        ),
      );
      return box;
    }
    box.append(line(doc, "nimbus-related__status", "Several indexed items match this page:"));
    box.append(chooser(doc, state.candidates, onChoose));
    return box;
  }

  if (state.kind === "needs-scope") {
    box.append(
      line(doc, "nimbus-related__status", "This pairing can't resolve pages yet."),
      line(
        doc,
        "nimbus-related__status",
        "Grant it on the gateway: nimbus clip scopes <label> --set clip,briefs,resolve",
      ),
    );
    return box;
  }

  box.append(line(doc, "nimbus-related__status", "Not indexed."));
  return box;
}

export function renderLane(doc: Document, lane: Lane): HTMLElement {
  const details = doc.createElement("details");
  details.className = "nimbus-related__lane";
  details.dataset["lane"] = lane.id;
  details.open = lane.expanded;
  const summary = doc.createElement("summary");
  summary.className = "nimbus-related__lane-title";
  summary.textContent = lane.title;
  details.append(summary, lane.render(doc));
  return details;
}

export function renderShell(
  doc: Document,
  state: PanelState,
  onChoose?: (c: ResolveCandidate) => void,
): HTMLElement {
  const shell = doc.createElement("div");
  shell.className = "nimbus-related__shell";
  shell.append(renderHeader(doc, state.header, onChoose));
  for (const lane of state.lanes) {
    shell.append(renderLane(doc, lane));
  }
  return shell;
}
