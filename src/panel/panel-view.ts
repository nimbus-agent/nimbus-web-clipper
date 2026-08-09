// src/panel/panel-view.ts
// Pure DOM builders for the related-items panel. Every gateway-provided string is
// written via textContent (never innerHTML) — the indexed content is
// attacker-influenceable, so plain-text rendering is the XSS backstop.
import { formatAge } from "../shared/freshness.ts";
import { scopeCommand } from "../shared/scope-command.ts";
import type {
  Product,
  RelatedHit,
  ResolveCandidate,
  ResolvedItem,
  ResolveMatchKind,
  ScopeGap,
} from "../shared/types.ts";

/** One spelling of each product name — mirrors `options/surfaces-view.ts`. */
const PRODUCT_NAMES: Record<Product, string> = {
  bitbucket: "Bitbucket",
  github: "GitHub",
  gitlab: "GitLab",
  jenkins: "Jenkins",
  jira: "Jira",
};

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
       * Captured once, when the resolve response lands (`Date.now()` at that
       * moment) — NOT re-read per repaint. So the age is frozen at load: a panel
       * left open for ten minutes keeps saying "indexed 3 min ago".
       *
       * Repaints of a `resolved` header DO happen — resolve and related are
       * fetched in parallel and land independently (panel-in-page.ts), and
       * `loadRelated()` ends in an unconditional `paint()`, so a `resolved`
       * header is repainted on essentially every panel open, as soon as the
       * related lane settles (often before it, since resolve is usually the
       * faster call). Freezing `nowMs` at response time is exactly what makes
       * those repaints stable: the age line does not jitter (or count up) as
       * the related lane lands or as the panel sits open. If a future lane ever
       * repaints on a TIMER — i.e. calls `paint()` on an interval rather than in
       * response to a new answer — make this a render-time parameter instead of
       * state; a clock reading stored in a state object goes stale by
       * construction and freezing would then hide real staleness.
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
  | {
      readonly kind: "not-indexed";
      readonly surface: string;
      readonly product: Product;
      /** Whether the miss can be turned into a targeted fetch — gates the button. */
      readonly fetchable: boolean;
    }
  /**
   * A 403. The token predates the `resolve` scope; the OWNER grants it.
   * `scopeGap` is null when the 403 body carried no scope detail — the panel then
   * falls back to generic guidance rather than inventing a command.
   */
  | { readonly kind: "needs-scope"; readonly surface: string; readonly scopeGap: ScopeGap | null }
  | { readonly kind: "error"; readonly surface: string | null; readonly message: string }
  /** A targeted fetch is in flight — no action to offer while it runs. */
  | { readonly kind: "fetching"; readonly surface: string; readonly product: Product }
  /**
   * The gateway answered the fetch request but declined it. `scopeGap` follows the
   * same null-means-no-detail convention as `needs-scope`, but for the `fetch`
   * scope specifically — repeating `resolve` guidance here would be a dead end for
   * a token that already has `resolve` but not `fetch`.
   */
  | {
      readonly kind: "fetch-blocked";
      readonly surface: string;
      readonly product: Product;
      readonly reason: "unfetchable" | "not-configured" | "needs-fetch-scope";
      readonly scopeGap: ScopeGap | null;
    }
  /**
   * The fetch attempt did not settle: `rate-limited` never left the client (safe
   * to retry the fetch), `still-working` means our timeout fired but the gateway
   * may still finish — retrying must re-check via resolve, not fire a second
   * outbound provider request.
   */
  | {
      readonly kind: "fetch-retry";
      readonly surface: string;
      readonly reason: "rate-limited" | "still-working";
    };

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

/** Mirrors `chooser`'s button construction: type="button", textContent, addEventListener. */
function actionButton(
  doc: Document,
  className: string,
  text: string,
  onClick: (() => void) | undefined,
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  if (onClick !== undefined) {
    button.addEventListener("click", onClick);
  }
  return button;
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
  onFetch?: (action: "fetch" | "resolve") => void,
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
    box.append(line(doc, "nimbus-related__status", "This pairing can't resolve pages yet."));
    // Null when the 403 carried no detail, OR when the device label is not safe to
    // put in a shell command. Both fall back to guidance that names the tool
    // without pretending to know the exact invocation.
    const cmd = state.scopeGap === null ? null : scopeCommand(state.scopeGap);
    box.append(
      line(
        doc,
        "nimbus-related__status",
        cmd === null
          ? "Grant it on the gateway: run nimbus clip status to find this device, then nimbus clip scopes."
          : `Grant it on the gateway: ${cmd}`,
      ),
    );
    return box;
  }

  if (state.kind === "fetching") {
    box.append(
      line(doc, "nimbus-related__status", `Fetching from ${PRODUCT_NAMES[state.product]}…`),
    );
    return box;
  }

  if (state.kind === "fetch-blocked") {
    if (state.reason === "unfetchable") {
      box.append(line(doc, "nimbus-related__status", "Nimbus can't fetch this page."));
      return box;
    }
    if (state.reason === "not-configured") {
      // Terminal on purpose: retrying will never work, so this arm stays
      // distinct rather than collapsing into generic guidance with a button.
      box.append(
        line(
          doc,
          "nimbus-related__status",
          `No ${PRODUCT_NAMES[state.product]} connector is configured on your gateway.`,
        ),
      );
      return box;
    }
    // needs-fetch-scope. Names the `fetch` scope, not `resolve` — someone who
    // granted `resolve` earlier still cannot fetch, and repeating the `resolve`
    // advice would be a dead end. Same null-fallback convention as `needs-scope`:
    // an unsafe label or scope name leaks neither the label nor `--set`.
    box.append(line(doc, "nimbus-related__status", "This pairing can't fetch pages yet."));
    const cmd = state.scopeGap === null ? null : scopeCommand(state.scopeGap);
    box.append(
      line(
        doc,
        "nimbus-related__status",
        cmd === null
          ? "Grant it on the gateway: run nimbus clip status to find this device, then nimbus clip scopes."
          : `Grant it on the gateway: ${cmd}`,
      ),
    );
    return box;
  }

  if (state.kind === "fetch-retry") {
    if (state.reason === "rate-limited") {
      // rate_limited is returned before any outbound call happens, so retrying
      // is safe to send as a fresh fetch.
      box.append(line(doc, "nimbus-related__status", "Rate limited — try again shortly."));
      box.append(
        actionButton(doc, "nimbus-related__action", "Try again", () => onFetch?.("fetch")),
      );
      return box;
    }
    // still-working: our timeout fired, not a failure — the gateway may still be
    // completing the fetch. The retry must re-check via resolve, never fire a
    // second outbound provider request for work that may already be done.
    box.append(
      line(
        doc,
        "nimbus-related__status",
        "Still working — your gateway may not have finished. Nothing was lost.",
      ),
    );
    box.append(
      actionButton(doc, "nimbus-related__action", "Check again", () => onFetch?.("resolve")),
    );
    return box;
  }

  // Exhaustiveness backstop: every other arm returns above, so `state` here must
  // be narrowed to exactly `not-indexed`. If a future arm is added to
  // `HeaderState` without a branch handling it above, `state` stops narrowing to
  // `never` and this line fails to compile — instead of the new arm silently
  // falling through to "Not indexed." at runtime.
  if (state.kind !== "not-indexed") {
    const _never: never = state;
    return _never;
  }
  box.append(line(doc, "nimbus-related__status", "Not indexed."));
  // The button appears only when the miss is fetchable — otherwise there is
  // nothing to offer.
  if (state.fetchable) {
    box.append(
      actionButton(
        doc,
        "nimbus-related__action",
        `Fetch this from ${PRODUCT_NAMES[state.product]}`,
        () => onFetch?.("fetch"),
      ),
    );
  }
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
  onFetch?: (action: "fetch" | "resolve") => void,
): HTMLElement {
  const shell = doc.createElement("div");
  shell.className = "nimbus-related__shell";
  shell.append(renderHeader(doc, state.header, onChoose, onFetch));
  for (const lane of state.lanes) {
    shell.append(renderLane(doc, lane));
  }
  return shell;
}
