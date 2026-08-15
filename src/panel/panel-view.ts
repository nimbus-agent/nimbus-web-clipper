// src/panel/panel-view.ts
// Pure DOM builders for the related-items panel. Every gateway-provided string is
// written via textContent (never innerHTML) — the indexed content is
// attacker-influenceable, so plain-text rendering is the XSS backstop.
import { formatAge } from "../shared/freshness.ts";
import { buildFetchPreview } from "../shared/preview.ts";
import { renderPreview } from "../shared/preview-view.ts";
import { scopeCommand } from "../shared/scope-command.ts";
import type {
  FetchTarget,
  LaneState,
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

/** What a connector's indexed items ARE, for the dashboard scope line. The
 *  lanes answer across the whole connector, so this noun is a claim about
 *  coverage — a wrong one reads as a promise the answer does not keep. */
const PRODUCT_CORPUS: Record<Product, string> = {
  bitbucket: "Bitbucket repositories",
  github: "GitHub repositories",
  gitlab: "GitLab projects",
  jenkins: "Jenkins builds",
  jira: "Jira projects",
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
  /**
   * A recognised page with NO indexed item, and that is correct rather than a
   * failure: a product's own dashboard. Deliberately not `not-indexed`, which
   * describes a page that should have resolved and didn't — and which offers a
   * fetch button that would propose indexing a dashboard as an item.
   */
  | { readonly kind: "service"; readonly surface: string; readonly product: Product }
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
  /**
   * Set while the tab has navigated to a DIFFERENT indexed item than the one this
   * panel describes. Rendered between the header and the lanes, so it coexists
   * with every `HeaderState` arm rather than competing with them.
   *
   * `pinnedRef` names the item the panel is still about — one line that attributes
   * every lane below it, which is why the lanes stay live and unstyled: they
   * answer about the pinned item, exactly as the header says. Null when the
   * pinned page was unrecognised and so has no ref.
   *
   * A callback on the state follows `Lane.render` above, rather than growing
   * `renderShell` a fifth positional argument.
   */
  readonly navAway?: { readonly pinnedRef: string | null; readonly onReread: () => void };
  /**
   * The pending "about to fetch" confirm target — set the moment the Fetch
   * button (or a rate-limited Try again) is clicked, cleared on Send or
   * Cancel. Rendered INSTEAD of `header`, in the same
   * `nimbus-related__header-state` box `renderHeader` itself would occupy —
   * the same precedence `fetchState` already has over `header` one level up
   * in the caller, for the same reason: a targeted fetch is an I13 WRITE (the
   * gateway reaching out to a configured provider under the user's stored
   * credential), so the target must be named and agreed to before the request
   * goes out, not after.
   */
  readonly fetchPreview?: {
    readonly target: FetchTarget;
    readonly onSend: () => void;
    readonly onCancel: () => void;
  };
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

/**
 * Appends the two-line "can't {resolve,fetch} pages yet" + fix-it-command
 * guidance shared by the `needs-scope` and `fetch-blocked`/`needs-fetch-scope`
 * arms below. `lead` carries the one thing that differs between them (which
 * route the pairing lacks); the fallback-command logic must stay identical
 * between both callers — the null-fallback convention documented at each call
 * site — so it lives here once instead of twice in lockstep.
 */
function appendScopeGuidance(
  doc: Document,
  box: HTMLElement,
  lead: string,
  scopeGap: ScopeGap | null,
): void {
  box.append(line(doc, "nimbus-related__status", lead));
  // Null when the 403 carried no detail, OR when the device label is not safe to
  // put in a shell command. Both fall back to guidance that names the tool
  // without pretending to know the exact invocation.
  const cmd = scopeGap === null ? null : scopeCommand(scopeGap);
  box.append(
    line(
      doc,
      "nimbus-related__status",
      cmd === null
        ? "Grant it on the gateway: run nimbus clip status to find this device, then nimbus clip scopes."
        : `Grant it on the gateway: ${cmd}`,
    ),
  );
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

  if (state.kind === "service") {
    // The scope line, not the host. Stripped of the item link, the freshness
    // line and the fetch button, this header would otherwise be a bare product
    // name — and the scope is the one fact needed to read the lanes correctly:
    // `{service}` spans the whole connector, so the answer covers every indexed
    // instance, not the one in the address bar.
    box.append(
      line(
        doc,
        "nimbus-related__status",
        `Nimbus can answer across all indexed ${PRODUCT_CORPUS[state.product]}.`,
      ),
    );
    return box;
  }

  if (state.kind === "resolved") {
    box.append(candidateLine(doc, state.item));
    box.append(
      line(
        doc,
        "nimbus-related__status",
        // "Updated", NOT "Indexed". `modifiedAt` is the ITEM's last-modified time
        // as the source system reports it — for a synced PR that is GitHub's own
        // `updated_at`, which can be days old on a row written seconds ago. Saying
        // "Indexed 3 days ago" about an item just fetched is a false claim, and it
        // is the kind this header exists to avoid making.
        //
        // The mislabel survived unit tests and a manual pass because every fixture
        // used a web CLIP, whose `modified_at` IS its clip time — so "Indexed" was
        // accurate by coincidence until the first connector-sourced item appeared.
        `Updated ${formatAge(state.item.modifiedAt, state.nowMs)}`,
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
    appendScopeGuidance(doc, box, "This pairing can't resolve pages yet.", state.scopeGap);
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
    appendScopeGuidance(doc, box, "This pairing can't fetch pages yet.", state.scopeGap);
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
        // A second, stable class beside the shared `nimbus-related__action` —
        // this is the one control a confirm preview's own Send/Cancel controls
        // (see `renderFetchPreview` below) could otherwise be confused with by
        // a selector that picks "the first button" rather than this one by
        // class. See that function's own doc comment.
        doc,
        "nimbus-related__action nimbus-related__fetch",
        `Fetch this from ${PRODUCT_NAMES[state.product]}`,
        () => onFetch?.("fetch"),
      ),
    );
  }
  return box;
}

/**
 * The "about to fetch" confirm step — names the target rather than asking a
 * bare "Fetch this item?", because a targeted fetch is an I13 WRITE: the
 * gateway reaches out to a configured provider under the user's own stored
 * credential, and the user is authorising THAT, not merely answering yes/no.
 *
 * Built from `buildFetchPreview`/`renderPreview` (`shared/preview.ts` /
 * `shared/preview-view.ts`) — the same preview machinery the popup's clip
 * confirm uses, so the two previews can never describe an outbound request
 * differently from each other or from the request actually sent.
 *
 * Rendered into a `nimbus-related__header-state` box — the SAME class
 * `renderHeader` itself uses for its box — so every existing selector scoped
 * to `.nimbus-related__header-state` keeps finding the panel's one primary
 * action, confirm step included.
 *
 * Send and Cancel are built with `actionButton`, exactly like every other
 * panel control (`type="button"`, `textContent`, `addEventListener` — never
 * hand-rolled), and given their OWN stable classes
 * (`nimbus-related__fetch-send` / `nimbus-related__fetch-cancel`), distinct
 * from `nimbus-related__fetch` above and from the generic
 * `nimbus-related__action` — a test (or a future control) that means "the
 * Send button" must never be able to land on the Fetch button or on Cancel by
 * picking "the first button" instead. Stacked full-width via
 * `nimbus-related__fetch-actions` (own CSS in panel-in-page.ts's STYLES),
 * never side by side: this is a narrow right-edge overlay, the same reason
 * the candidate chooser (`nimbus-related__candidates`) stacks its own
 * buttons, and a confirm step's own controls are the last ones that should
 * end up truncated or cramped.
 */
export function renderFetchPreview(
  doc: Document,
  target: FetchTarget,
  onSend: () => void,
  onCancel: () => void,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-related__header-state";
  box.append(renderPreview(doc, buildFetchPreview(target)));
  const actions = doc.createElement("div");
  actions.className = "nimbus-related__fetch-actions";
  actions.append(
    actionButton(doc, "nimbus-related__fetch-send", "Send", onSend),
    actionButton(doc, "nimbus-related__fetch-cancel", "Cancel", onCancel),
  );
  box.append(actions);
  return box;
}

/**
 * Renders the body of one agent lane — never the shared "related" lane, which
 * keeps its own `relatedBody` render path.
 *
 * Re-run is offered for five of the ten `AgentError` reasons — `not_paired`,
 * `stale`, `unreachable`, `server_error`, `agent_failed` — and withheld for the
 * other five (`unauthorized`, `insufficient_scope`, `unsupported`,
 * `not_resolved`, `no_term`).
 *
 * `stale`/`unreachable`/`server_error` are transport-level blips, and
 * `agent_failed` means the run reached the agent and it could not answer (which a
 * retry may well do differently — it is NOT `server_error`, because the call
 * itself worked). `not_paired` is the one whose remedy is on ANOTHER surface and
 * still keeps the button: pairing happens in Options, but the retry belongs here,
 * and the copy names pairing first so the button is never the whole instruction —
 * see its branch below. The five without a button need a different fix elsewhere
 * AND have nothing here to retry into (re-authenticate, grant a scope, index the
 * page, select a term, or a gateway that has the agents surface at all) — a
 * Re-run there would just fail identically.
 */
export function renderLaneBody(doc: Document, state: LaneState, onRerun?: () => void): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-related__lane-body";

  if (state.kind === "collapsed") {
    // Never requested yet — nothing to say. The lane's own summary label is the
    // only UI here until the caller (Task 8) triggers a run.
    return box;
  }

  if (state.kind === "running") {
    box.append(line(doc, "nimbus-related__status", "Working…"));
    return box;
  }

  if (state.kind === "done") {
    const pre = doc.createElement("pre");
    pre.className = "nimbus-related__brief";
    // textContent, NEVER innerHTML, and never a markdown-to-HTML pass.
    //
    // This string is the agent's brief. On a gateway with an LLM configured it is
    // MODEL OUTPUT, and it renders inside a Shadow DOM overlaying the user's
    // authenticated session on github.com. Parsing it would be a direct XSS path
    // from whatever the model emitted.
    //
    // The cost is real and accepted: no headings, no bold, no clickable links. A
    // safe renderer (allow-listed subset, or a sanitiser) is a separate,
    // deliberate decision — not something to add here because the output looks
    // plain.
    pre.textContent = state.brief;
    box.append(pre);
    return box;
  }

  // state.kind === "failed" from here on.
  if (state.reason === "not_paired") {
    // This is a LIVE gap, not a leftover: `resolveForAgent` (handlers.ts) reads
    // the connection itself and short-circuits with its own `not_paired` the
    // moment there is none, so this reason is PRODUCED by the user being
    // unpaired right now. Reachable because the panel's header resolved while a
    // pairing existed and the pairing went away afterwards (unpaired in Options,
    // storage cleared) — the lane's run or poll is the first thing to find out.
    //
    // A cached `not_paired` from an EARLIER pairing exists in the store (the
    // worker's poll writes one when it wakes with no connection), but it cannot
    // realistically surface: `handleAgentRun` re-invokes on any `failed` state
    // rather than replaying it, and `handleAgentState` only reaches the cache
    // when a connection exists — which would mean re-pairing inside the panel's
    // ~1s poll gap. So there is exactly one state to be true about, and one
    // string for it.
    //
    // It keeps a Re-run button, unlike the other refusal reasons below, because
    // the remedy is on another surface but the retry is HERE: once the user
    // pairs in Options, `handleAgentRun`'s cache short-circuit covers only
    // `running`/`done` (Task 6), so this Re-run genuinely re-invokes and now
    // succeeds. The copy names pairing first so the button is never the whole
    // instruction.
    box.append(
      line(
        doc,
        "nimbus-related__status",
        "Nimbus isn't paired with this browser. Pair in Options, then re-run.",
      ),
    );
    box.append(actionButton(doc, "nimbus-related__action", "Re-run", () => onRerun?.()));
    return box;
  }
  if (state.reason === "unauthorized") {
    box.append(
      line(doc, "nimbus-related__status", "Nimbus rejected this pairing. Re-pair in Options."),
    );
    return box;
  }
  if (state.reason === "insufficient_scope") {
    appendScopeGuidance(doc, box, "This pairing can't run agents yet.", state.scopeGap ?? null);
    return box;
  }
  if (state.reason === "unsupported") {
    // A claim about the GATEWAY (404: unknown agent, or no agents surface at
    // all) — never reused for `not_resolved`, which is a condition of the page.
    box.append(line(doc, "nimbus-related__status", "This Nimbus gateway can't run agents yet."));
    return box;
  }
  if (state.reason === "not_resolved") {
    // A condition of the PAGE (unrecognised, or a resolve miss/ambiguous
    // answer) — never reused for `unsupported`, which blames the gateway.
    //
    // When is this visible? Lanes render ONLY under a `resolved` header
    // (panel-in-page.ts), so this reason always appears beneath a header that
    // names a single item — yet `handleAgentRun`/`handleAgentState` re-resolve
    // the page themselves, later and independently, and that second answer
    // disagreed: the item was re-indexed or removed, the resolve now comes back
    // ambiguous or a miss, or the recogniser gate now rejects the URL (a
    // recognised surface removed in Options since the panel opened).
    //
    // The wording must therefore hold for all THREE sub-cases `resolveForAgent`
    // collapses into this reason (see handlers.ts): unrecognised,
    // not-indexed/unresolvable, and AMBIGUOUS. On an ambiguous re-resolve the
    // page IS indexed — under several items — so "Nimbus hasn't indexed this
    // page yet." would be false, and it would contradict the resolved header
    // still on screen above. Do not "clarify" this back to an
    // indexed/not-indexed claim; say only what is true in all three cases.
    box.append(
      line(doc, "nimbus-related__status", "Nimbus couldn't pin this page to one indexed item."),
    );
    return box;
  }
  if (state.reason === "no_term") {
    // A term lane asked to run with no term. The panel materialises a term lane
    // only once a term exists, so this is not reachable from this UI — it is the
    // honest answer to a forged or stale message, and it says what is missing
    // rather than blaming the page as `not_resolved` would.
    //
    // No Re-run: the button would re-send the same term-less request. The remedy
    // is a selection, which is not a control this lane can offer.
    box.append(
      line(doc, "nimbus-related__status", "Select a word or phrase first — this lane needs one."),
    );
    return box;
  }
  if (state.reason === "stale") {
    box.append(line(doc, "nimbus-related__status", "This run is gone — re-run it."));
    box.append(actionButton(doc, "nimbus-related__action", "Re-run", () => onRerun?.()));
    return box;
  }
  if (state.reason === "unreachable") {
    box.append(line(doc, "nimbus-related__status", "Couldn't connect to Nimbus."));
    box.append(actionButton(doc, "nimbus-related__action", "Re-run", () => onRerun?.()));
    return box;
  }
  if (state.reason === "server_error") {
    // The CALL failed here — distinct from `agent_failed` below, where the call
    // succeeded and the agent itself could not answer.
    box.append(line(doc, "nimbus-related__status", "Nimbus had an error running this lane."));
    box.append(actionButton(doc, "nimbus-related__action", "Re-run", () => onRerun?.()));
    return box;
  }

  // Exhaustiveness backstop: every other `AgentError` member returns above, so
  // `state.reason` here must be narrowed to exactly `agent_failed`. If a future
  // member is added to `AGENT_ERRORS` without a branch handling it above,
  // `state.reason` stops narrowing to `never` and this line fails to compile —
  // instead of the new reason silently falling through to a blank lane.
  //
  // Returns `box` here, NOT `state.reason` — `isAgentStateResponse`
  // (messages.ts) validates `reason` against `AGENT_ERRORS` before this
  // function ever sees a `LaneState`, so this branch should be unreachable in
  // practice. But `renderLaneBody` is typed to return `HTMLElement`, and
  // `details.append(...)` accepts a plain string just as happily as a node —
  // if that guard ever grew a hole, returning the never-typed value directly
  // (as the sibling backstop in `renderHeader` above does) would put a raw
  // reason CODE on screen as the lane body instead of failing loudly. The
  // `satisfies never` below still does its compile-time job — a future unhandled
  // `AgentError` member fails to typecheck here exactly as before.
  if (state.reason !== "agent_failed") {
    // `satisfies never` rather than an unused `const _never: never` plus `void` to
    // silence it: identical exhaustiveness check, no throwaway binding, and nothing
    // for a reader to mistake for a discarded call.
    state.reason satisfies never;
    return box;
  }
  // The run reached the agent and it could not answer — the CALL succeeded, so
  // this must not read like `server_error` above.
  box.append(line(doc, "nimbus-related__status", "The agent couldn't finish this run."));
  if (state.detail !== undefined) {
    // textContent, never parsed — this is free text from the gateway, same
    // no-parsing rule as the brief above, and for the same reason.
    box.append(line(doc, "nimbus-related__status", state.detail));
  }
  box.append(actionButton(doc, "nimbus-related__action", "Re-run", () => onRerun?.()));
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

/**
 * The "you've moved on" notice. Coexists with every `HeaderState` arm — see
 * `PanelState.navAway` — so it is rendered by `renderShell` as a sibling of the
 * header, never as a branch inside `renderHeader`.
 */
function renderNavAway(
  doc: Document,
  navAway: { readonly pinnedRef: string | null; readonly onReread: () => void },
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-related__navaway";
  // The panel's subject no longer matches the tab, and nothing else announces it.
  box.setAttribute("role", "status");
  box.append(line(doc, "nimbus-related__navaway-lead", "You've moved on."));
  box.append(
    line(
      doc,
      "nimbus-related__status",
      navAway.pinnedRef === null
        ? "This panel is still about the page you opened it on."
        : `This panel is still about ${navAway.pinnedRef}.`,
    ),
  );
  box.append(actionButton(doc, "nimbus-related__action", "Re-read page", navAway.onReread));
  return box;
}

export function renderShell(
  doc: Document,
  state: PanelState,
  onChoose?: (c: ResolveCandidate) => void,
  onFetch?: (action: "fetch" | "resolve") => void,
): HTMLElement {
  const shell = doc.createElement("div");
  shell.className = "nimbus-related__shell";
  shell.append(
    state.fetchPreview !== undefined
      ? renderFetchPreview(
          doc,
          state.fetchPreview.target,
          state.fetchPreview.onSend,
          state.fetchPreview.onCancel,
        )
      : renderHeader(doc, state.header, onChoose, onFetch),
  );
  if (state.navAway !== undefined) {
    shell.append(renderNavAway(doc, state.navAway));
  }
  for (const lane of state.lanes) {
    shell.append(renderLane(doc, lane));
  }
  return shell;
}
