// src/panel/panel-view.ts
// Pure DOM builders for the related-items panel. Every gateway-provided string is
// written via textContent (never innerHTML) — the indexed content is
// attacker-influenceable, so plain-text rendering is the XSS backstop.
import { offersCapture } from "../shared/capture-offer.ts";
import { type ConnectorHealth, gatePolicy } from "../shared/connector-health.ts";
import { formatAge } from "../shared/freshness.ts";
import { buildFetchPreview, type ClipPreview, type FetchPreview } from "../shared/preview.ts";
import { renderPreview } from "../shared/preview-view.ts";
import { productCorpus, productName } from "../shared/recognise/registry.ts";
import { safeHttpUrl } from "../shared/safe-url.ts";
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
import { renderGaps, renderProvenance } from "./findings/shared-view.ts";
import { renderWhyFindings } from "./findings/why-view.ts";
import { groupHits, humaniseType } from "./related-groups.ts";

export function renderError(doc: Document, message: string): HTMLElement {
  const p = doc.createElement("p");
  p.className = "nimbus-related__status";
  p.textContent = message;
  return p;
}

export function renderHit(doc: Document, hit: RelatedHit, nowMs: number): HTMLElement {
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
  item.append(title);

  // The kind chip and the age line are both OPTIONAL by design: a gateway older
  // than the projection sends neither, and an absent chip is quieter than a chip
  // that says nothing. The service badge is gone from the row — the group
  // heading above already names it once, and repeating it per row was the
  // clutter that made this list hard to scan.
  const kind = humaniseType(hit.type);
  if (kind !== null) {
    const chip = doc.createElement("span");
    chip.className = "nimbus-related__kind";
    chip.textContent = kind;
    item.append(chip);
  }

  if (hit.snippet !== "") {
    const snippet = doc.createElement("p");
    snippet.className = "nimbus-related__snippet";
    snippet.textContent = hit.snippet;
    item.append(snippet);
  }

  if (hit.modifiedAt !== undefined) {
    const age = doc.createElement("p");
    age.className = "nimbus-related__age";
    // "Updated", never "Indexed" — this is the item's own last-modified time as
    // its source reports it. Same word the header uses, deliberately.
    age.textContent = `Updated ${formatAge(hit.modifiedAt, nowMs)}`;
    item.append(age);
  }

  return item;
}

export function renderHits(doc: Document, items: RelatedHit[], nowMs: number): HTMLElement {
  if (items.length === 0) {
    return renderError(doc, "No related items found.");
  }
  const wrapper = doc.createElement("div");
  wrapper.className = "nimbus-related__groups";
  for (const group of groupHits(items)) {
    const head = doc.createElement("p");
    head.className = "nimbus-related__group-head";
    // The count is what makes an all-one-service result read as a real answer
    // rather than as a truncation.
    head.textContent = `${group.service} · ${String(group.hits.length)}`;
    const list = doc.createElement("ul");
    list.className = "nimbus-related__list";
    for (const hit of group.hits) {
      list.append(renderHit(doc, hit, nowMs));
    }
    wrapper.append(head, list);
  }
  return wrapper;
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
      /**
       * A copy the user captured, not connector data. Reached by capturing just
       * now OR by opening the panel on a page captured weeks ago — the panel
       * cannot tell the two apart and must not try, because presenting an old
       * copy as connector data is the dishonesty this arm exists to prevent.
       *
       * NO surface line: an unrecognised page has no recognition to source one
       * from, and its absence is part of the honesty.
       */
      readonly kind: "captured";
      readonly item: ResolvedItem;
      /** Frozen at the moment the header was built, like `resolved`'s own age. */
      readonly ageNowMs: number;
    }
  /**
   * A recognised page with NO indexed item, and that is correct rather than a
   * failure: a product's own dashboard. Deliberately not `not-indexed`, which
   * describes a page that should have resolved and didn't — and which offers a
   * fetch button that would propose indexing a dashboard as an item.
   */
  | {
      readonly kind: "service";
      readonly surface: string;
      readonly product: Product;
      /** Gates the agent lanes below and drives the caveat/withheld copy in this
       *  header — see `gatePolicy`. Never carries `lastError`: that is free-form
       *  upstream text bound for a page DOM and is discarded before this arrives
       *  (see `parseConnectorHealth`'s own doc comment). */
      readonly connector: ConnectorHealth;
      /** Frozen at header-build time, exactly like `resolved`'s own `nowMs` —
       *  so the "Synced … ago" line does not jitter across repaints. */
      readonly nowMs: number;
    }
  /**
   * A recognised source file. Deliberately NOT `not-indexed`, for the same reason
   * `service` is not: `offersCapture` returns true there when `fetchable` is false,
   * which would put "Save a copy to Nimbus" under a miss — and a clipped blob page
   * gives Nimbus neither a checkout nor an indexed repository.
   *
   * `banner` carries the miss sentence, and is ABSENT on a hit and on an older
   * gateway — the panel says nothing it cannot back.
   */
  | { readonly kind: "file"; readonly surface: string; readonly banner?: string }
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
  /**
   * The pending "about to save a copy" confirm target — set once `capture`
   * has answered with a preview to show (the 1.3 pref, read in the worker),
   * cleared on Send or Cancel. Rendered INSTEAD of `header`, in the same box
   * `renderHeader` itself would occupy — the identical precedence
   * `fetchPreview` already has above, and for the same reason: a captured
   * clip is an outbound write (`POST /v1/clips`), so what it contains must be
   * named and agreed to before it goes out, not after.
   */
  readonly capturePreview?: {
    readonly preview: ClipPreview;
    readonly onSend: () => void;
    readonly onCancel: () => void;
  };
  /**
   * A capture refusal — the panel could not read the page, the tab moved on,
   * the page yielded nothing capturable, or the save itself failed. Rendered
   * as its own line BENEATH the header (see `renderShell`), never in place of
   * it: unlike `header`'s own `error` arm, which replaces everything, a
   * refusal must leave the header — and, on every state that can reach this
   * flow, its still-live "Save a copy to Nimbus" offer — on screen so the
   * user has something to retry. See `captureRefusal` in panel-in-page.ts for
   * the full reasoning and the one outcome (a queued clip) that is
   * deliberately NOT routed here.
   */
  readonly captureRefusal?: string;
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

/**
 * The `service` arm of {@link renderHeader} — a product's own dashboard.
 *
 * `gatePolicy` decides what the connector's state permits: a healthy or `unknown`
 * connector gets no caveat, plus the scope line and — for `healthy` only, when the
 * gateway supplied one — the sync age; `unknown` never gets an age line even when
 * the gateway supplied one (see below) — it covers both an older gateway and an
 * unreadable answer, and neither is nagged.
 * `degraded`/`rate_limited`/`paused` keep the scope line (the lanes below still
 * run) and add a caveat, plus the sync age when the gateway supplied one — the
 * age is what tells the reader whether "recent items may be missing" means
 * minutes or a fortnight. The three withheld states drop the scope line
 * entirely — the lanes below do not run, so claiming Nimbus "can answer" would
 * be false — and render only the one honest sentence, with no age line even
 * when the gateway supplied one: dating a sync whose answers are being
 * withheld invites the reader to think some answer is still available.
 */
function appendServiceHeader(
  doc: Document,
  box: HTMLElement,
  state: Extract<HeaderState, { kind: "service" }>,
): void {
  const policy = gatePolicy(state.connector.state);
  if (policy.lanes) {
    // The scope line, not the host. Stripped of the item link, the freshness
    // line and the fetch button, this header would otherwise be a bare product
    // name — and the scope is the one fact needed to read the lanes correctly:
    // `{service}` spans the whole connector, so the answer covers every indexed
    // instance, not the one in the address bar.
    box.append(
      line(
        doc,
        "nimbus-related__status",
        `Nimbus can answer across all indexed ${productCorpus(state.product)}.`,
      ),
    );
  }
  if (policy.note !== null) {
    box.append(
      line(doc, "nimbus-related__status", policy.note.replace("%s", productName(state.product))),
    );
  }
  // `unknown` never gets an age line, even when the gateway happened to include
  // `lastSuccessfulSync` on the row that produced it: `unknown` covers both an
  // older gateway AND an unrecognised eighth state that carried a real
  // timestamp, and the byte-identical-to-today guarantee that state exists for
  // must not depend on which fields the far end happened to send.
  if (
    policy.lanes &&
    state.connector.state !== "unknown" &&
    state.connector.lastSuccessfulSyncMs !== undefined
  ) {
    box.append(
      line(
        doc,
        "nimbus-related__status",
        `Synced ${formatAge(state.connector.lastSuccessfulSyncMs, state.nowMs)}`,
      ),
    );
  }
}

/**
 * The `resolved` arm of {@link renderHeader}, which carries more lines than any other
 * and is the reason that function was over the cognitive-complexity gate (Sonar
 * `S3776`). Extracted verbatim; rendering is unchanged.
 */
function appendResolvedHeader(
  doc: Document,
  box: HTMLElement,
  state: Extract<HeaderState, { kind: "resolved" }>,
): void {
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
}

/**
 * The `fetch-blocked` arm of {@link renderHeader} — three terminal reasons, each with its
 * own wording. Extracted to bring `renderHeader` under the cognitive-complexity gate
 * (Sonar `S3776`) WITHOUT collapsing its `if`-chain into a lookup table: that chain is what
 * narrows `state` for the exhaustiveness backstop at the end, and a table would trade a
 * compile-time guarantee for a lint number.
 */
function appendFetchBlocked(
  doc: Document,
  box: HTMLElement,
  state: Extract<HeaderState, { kind: "fetch-blocked" }>,
): void {
  if (state.reason === "unfetchable") {
    box.append(line(doc, "nimbus-related__status", "Nimbus can't fetch this page."));
    return;
  }
  if (state.reason === "not-configured") {
    // Terminal on purpose: retrying will never work, so this arm stays
    // distinct rather than collapsing into generic guidance with a button.
    box.append(
      line(
        doc,
        "nimbus-related__status",
        `No ${productName(state.product)} connector is configured on your gateway.`,
      ),
    );
    return;
  }
  // needs-fetch-scope. Names the `fetch` scope, not `resolve` — someone who
  // granted `resolve` earlier still cannot fetch, and repeating the `resolve`
  // advice would be a dead end. Same null-fallback convention as `needs-scope`:
  // an unsafe label or scope name leaks neither the label nor `--set`.
  appendScopeGuidance(doc, box, "This pairing can't fetch pages yet.", state.scopeGap);
}

/**
 * The `fetch-retry` arm of {@link renderHeader}. Same reason for existing as
 * {@link appendFetchBlocked}.
 */
function appendFetchRetry(
  doc: Document,
  box: HTMLElement,
  state: Extract<HeaderState, { kind: "fetch-retry" }>,
  onFetch?: (action: "fetch" | "resolve") => void,
): void {
  if (state.reason === "rate-limited") {
    // rate_limited is returned before any outbound call happens, so retrying
    // is safe to send as a fresh fetch.
    box.append(line(doc, "nimbus-related__status", "Rate limited — try again shortly."));
    box.append(actionButton(doc, "nimbus-related__action", "Try again", () => onFetch?.("fetch")));
    return;
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
}

/**
 * The `captured` arm of {@link renderHeader}: a copy the user saved, not
 * connector data. Renders NO surface line — an unrecognised page has no
 * recognition to source one from, and that absence is part of the honesty
 * this arm exists to tell. Reuses the exact `Updated <age>` wording the
 * `resolved` arm uses, so two freshness claims in one panel can never word
 * the same fact differently.
 */
function appendCapturedHeader(
  doc: Document,
  box: HTMLElement,
  state: Extract<HeaderState, { kind: "captured" }>,
  onRecapture: (() => void) | undefined,
): void {
  box.append(candidateLine(doc, state.item));
  box.append(
    line(
      doc,
      "nimbus-related__status",
      `Updated ${formatAge(state.item.modifiedAt, state.ageNowMs)}`,
    ),
  );
  box.append(
    line(doc, "nimbus-related__status", "This is a copy you saved, not data from a connector."),
  );
  box.append(
    actionButton(doc, "nimbus-related__recapture", "Update this copy", () => onRecapture?.()),
  );
}

/**
 * Appends the "Save a copy to Nimbus" offer whenever `offersCapture(state)`
 * says the gateway has nothing left to try. Always appended AFTER the
 * caller's own content for that state — never substituted for it — so, in
 * particular, the `unrecognised` arm's "add this site" hint stays above it: a
 * real connector still beats a scrape.
 */
function appendCaptureOffer(
  doc: Document,
  box: HTMLElement,
  state: HeaderState,
  onCapture: (() => void) | undefined,
): void {
  if (!offersCapture(state)) {
    return;
  }
  box.append(
    actionButton(
      doc,
      "nimbus-related__action nimbus-related__capture",
      "Save a copy to Nimbus",
      () => onCapture?.(),
    ),
  );
}

/**
 * The `error` arm of {@link renderHeader}. Handled whole rather than folded into
 * the shared surface line: `surface` is nullable only on this arm, and splitting
 * it would leave the shared tail unable to narrow it to a string.
 */
function appendErrorHeader(
  doc: Document,
  box: HTMLElement,
  state: Extract<HeaderState, { kind: "error" }>,
): void {
  if (state.surface !== null) {
    box.append(line(doc, "nimbus-related__surface", state.surface));
  }
  box.append(line(doc, "nimbus-related__status", state.message));
}

/**
 * The `ambiguous` arm of {@link renderHeader}. Same reason for existing as
 * {@link appendFetchBlocked}.
 */
function appendAmbiguousHeader(
  doc: Document,
  box: HTMLElement,
  state: Extract<HeaderState, { kind: "ambiguous" }>,
  onChoose?: (c: ResolveCandidate) => void,
): void {
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
    return;
  }
  box.append(line(doc, "nimbus-related__status", "Several indexed items match this page:"));
  box.append(chooser(doc, state.candidates, onChoose));
}

/**
 * The `not-indexed` arm of {@link renderHeader}. Same reason for existing as
 * {@link appendFetchBlocked}.
 */
function appendNotIndexed(
  doc: Document,
  box: HTMLElement,
  state: Extract<HeaderState, { kind: "not-indexed" }>,
  onFetch?: (action: "fetch" | "resolve") => void,
): void {
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
        `Fetch this from ${productName(state.product)}`,
        () => onFetch?.("fetch"),
      ),
    );
  }
}

export function renderHeader(
  doc: Document,
  state: HeaderState,
  onChoose?: (c: ResolveCandidate) => void,
  onFetch?: (action: "fetch" | "resolve") => void,
  onCapture?: () => void,
  onRecapture?: () => void,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-related__header-state";

  if (state.kind === "loading") {
    box.append(line(doc, "nimbus-related__status", "Checking Nimbus…"));
    return box;
  }
  if (state.kind === "captured") {
    appendCapturedHeader(doc, box, state, onRecapture);
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
    appendCaptureOffer(doc, box, state, onCapture);
    return box;
  }
  if (state.kind === "error") {
    appendErrorHeader(doc, box, state);
    return box;
  }

  box.append(line(doc, "nimbus-related__surface", state.surface));

  if (state.kind === "service") {
    appendServiceHeader(doc, box, state);
    return box;
  }

  if (state.kind === "file") {
    if (state.banner !== undefined) {
      box.append(line(doc, "nimbus-related__status", state.banner));
    }
    return box;
  }

  if (state.kind === "resolved") {
    appendResolvedHeader(doc, box, state);
    return box;
  }

  if (state.kind === "chosen") {
    box.append(candidateLine(doc, state.candidate));
    return box;
  }

  if (state.kind === "ambiguous") {
    appendAmbiguousHeader(doc, box, state, onChoose);
    return box;
  }

  if (state.kind === "needs-scope") {
    appendScopeGuidance(doc, box, "This pairing can't resolve pages yet.", state.scopeGap);
    return box;
  }

  if (state.kind === "fetching") {
    box.append(line(doc, "nimbus-related__status", `Fetching from ${productName(state.product)}…`));
    return box;
  }

  if (state.kind === "fetch-blocked") {
    appendFetchBlocked(doc, box, state);
    appendCaptureOffer(doc, box, state, onCapture);
    return box;
  }

  if (state.kind === "fetch-retry") {
    appendFetchRetry(doc, box, state, onFetch);
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
  appendNotIndexed(doc, box, state, onFetch);
  appendCaptureOffer(doc, box, state, onCapture);
  return box;
}

/**
 * The shared shape of BOTH confirm steps below — an already-built preview
 * (whatever `renderPreview` accepts) plus Send/Cancel. Extracted because
 * {@link renderFetchPreview} and {@link renderCapturePreview} were the same
 * eleven lines around a different preview builder; this is the eleven lines,
 * once.
 *
 * Rendered into a `nimbus-related__header-state` box — the SAME class
 * `renderHeader` itself uses for its box — so every existing selector scoped
 * to `.nimbus-related__header-state` keeps finding the panel's one primary
 * action, confirm step included.
 *
 * Send and Cancel are built with `actionButton`, exactly like every other
 * panel control (`type="button"`, `textContent`, `addEventListener` — never
 * hand-rolled), and given their OWN stable classes
 * (`nimbus-related__fetch-send` / `nimbus-related__fetch-cancel`), shared by
 * BOTH callers deliberately rather than a parallel pair per caller: both
 * previews confirm one outbound write before it leaves the browser, and a
 * control that means "yes, send this" should not need its own selector per
 * caller — `panel-in-page.ts`'s `clickPreviewSend`/`clickPreviewCancel` test
 * helpers find either one unmodified. Distinct from `nimbus-related__fetch`
 * (the button that opens a fetch preview) and from the generic
 * `nimbus-related__action` — a test (or a future control) that means "the
 * Send button" must never be able to land on the Fetch button or on Cancel by
 * picking "the first button" instead. Stacked full-width via
 * `nimbus-related__fetch-actions` (own CSS in panel-in-page.ts's STYLES),
 * never side by side: this is a narrow right-edge overlay, the same reason
 * the candidate chooser (`nimbus-related__candidates`) stacks its own
 * buttons, and a confirm step's own controls are the last ones that should
 * end up truncated or cramped.
 */
function renderConfirmBox(
  doc: Document,
  preview: ClipPreview | FetchPreview,
  onSend: () => void,
  onCancel: () => void,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-related__header-state";
  box.append(renderPreview(doc, preview));
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
 * The "about to fetch" confirm step — names the target rather than asking a
 * bare "Fetch this item?", because a targeted fetch is an I13 WRITE: the
 * gateway reaches out to a configured provider under the user's own stored
 * credential, and the user is authorising THAT, not merely answering yes/no.
 *
 * Built from `buildFetchPreview` (`shared/preview.ts`) — the same preview
 * machinery the popup's clip confirm uses, so the two previews can never
 * describe an outbound request differently from each other or from the
 * request actually sent.
 */
export function renderFetchPreview(
  doc: Document,
  target: FetchTarget,
  onSend: () => void,
  onCancel: () => void,
): HTMLElement {
  return renderConfirmBox(doc, buildFetchPreview(target), onSend, onCancel);
}

/**
 * The "about to save a copy" confirm step — the last-resort twin of
 * {@link renderFetchPreview} above, over `renderConfirmBox` the same way.
 *
 * `renderPreview` (shared/preview-view.ts) already renders a `ClipPreview`
 * whole — fields, excerpt, and the truncation note — so this needs no field
 * list of its own; it is the same box the popup's own clip confirm renders,
 * built from the same `buildClipPreview`.
 */
export function renderCapturePreview(
  doc: Document,
  preview: ClipPreview,
  onSend: () => void,
  onCancel: () => void,
): HTMLElement {
  return renderConfirmBox(doc, preview, onSend, onCancel);
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
export function renderLaneBody(
  doc: Document,
  state: LaneState,
  nowMs: number,
  onRerun?: () => void,
): HTMLElement {
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
    // The structured view REPLACES the prose body when we have it, and falls
    // back to the prose `<pre>` when we do not — a guard rejection, the storage
    // byte bound, or a lane whose `LaneFindings` arm has not shipped. That
    // fallback is the existing code path, unchanged, and nothing announces it.
    if (state.findings !== undefined) {
      box.append(renderWhyFindings(doc, state.findings, nowMs));
    } else {
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
    }
    // Gaps and provenance are SIBLINGS of findings and render on every lane,
    // including one that fell back to prose. That is the whole reason they are
    // not nested inside `findings`.
    if (state.gaps !== undefined) {
      const gaps = renderGaps(doc, state.gaps);
      if (gaps !== null) {
        box.append(gaps);
      }
    }
    if (state.synthesis !== undefined) {
      box.append(renderProvenance(doc, state.synthesis));
    }
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

/**
 * A capture refusal. Coexists with every `HeaderState` arm, exactly like
 * `renderNavAway` below — rendered by `renderShell` as a sibling of the
 * header, never as a branch inside `renderHeader`, so the header (and its
 * capture offer) is never the thing a refusal replaces.
 *
 * No button of its own, unlike `renderNavAway`: the retry already lives in
 * the header above it — clicking "Save a copy to Nimbus" (or "Update this
 * copy") again is the retry, so this needs nothing but the message.
 */
function renderCaptureRefusal(doc: Document, message: string): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-related__capture-refusal";
  box.setAttribute("role", "status");
  box.append(line(doc, "nimbus-related__status", message));
  return box;
}

/**
 * The one element at the top of the shell: a pending confirm step if there is
 * one — fetch takes precedence over capture, the order the ternary chain this
 * replaced already had — otherwise the header itself.
 */
function renderShellTop(
  doc: Document,
  state: PanelState,
  onChoose?: (c: ResolveCandidate) => void,
  onFetch?: (action: "fetch" | "resolve") => void,
  onCapture?: () => void,
  onRecapture?: () => void,
): HTMLElement {
  if (state.fetchPreview !== undefined) {
    return renderFetchPreview(
      doc,
      state.fetchPreview.target,
      state.fetchPreview.onSend,
      state.fetchPreview.onCancel,
    );
  }
  if (state.capturePreview !== undefined) {
    return renderCapturePreview(
      doc,
      state.capturePreview.preview,
      state.capturePreview.onSend,
      state.capturePreview.onCancel,
    );
  }
  return renderHeader(doc, state.header, onChoose, onFetch, onCapture, onRecapture);
}

export function renderShell(
  doc: Document,
  state: PanelState,
  onChoose?: (c: ResolveCandidate) => void,
  onFetch?: (action: "fetch" | "resolve") => void,
  onCapture?: () => void,
  onRecapture?: () => void,
): HTMLElement {
  const shell = doc.createElement("div");
  shell.className = "nimbus-related__shell";
  shell.append(renderShellTop(doc, state, onChoose, onFetch, onCapture, onRecapture));
  if (state.captureRefusal !== undefined) {
    shell.append(renderCaptureRefusal(doc, state.captureRefusal));
  }
  if (state.navAway !== undefined) {
    shell.append(renderNavAway(doc, state.navAway));
  }
  for (const lane of state.lanes) {
    shell.append(renderLane(doc, lane));
  }
  return shell;
}
