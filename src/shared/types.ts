import type { CanonicalRejection } from "./canonical.ts";

/**
 * The page's own account of itself, as sent in `POST /v1/clips`'s `source`
 * object. The shape is the GATEWAY's — `ClipSource` in
 * `packages/gateway/src/clips/clip-ingest.ts`, shipped in gateway 2.12.0 — and
 * the two must not drift. An older gateway accepts the clip and drops this
 * silently; there is no error to detect it by.
 *
 * `publishedAt` is epoch ms, normalised HERE rather than upstream: the page
 * hands over whatever string it put in `article:published_time`, and parsing
 * arbitrary date formats belongs where the messy input is, not on a locked
 * contract. See `parsePublishedAt`.
 */
export interface ClipSource {
  readonly author?: string;
  readonly publishedAt?: number;
  readonly siteName?: string;
  readonly lang?: string;
  /**
   * Absolutised and scheme-checked, never origin-checked — see `safeHttpUrl`.
   * The gateway stores it unvalidated on purpose, so any consumer that RENDERS
   * it owes it a scheme check of its own.
   */
  readonly leadImage?: string;
}

export interface CaptureResult {
  readonly url: string;
  readonly canonicalUrl?: string;
  /**
   * Set INSTEAD of `canonicalUrl` when the page declared one and it was
   * refused — see `resolveCanonical`. Carried so the pre-send preview can say
   * that we overrode the page's own declaration, rather than doing it silently.
   * Never sent to the gateway; `ClipPayload` is the wire shape and does not
   * have this field.
   */
  readonly canonicalRejected?: CanonicalRejection;
  /**
   * PAGE-CONTROLLED and unbounded at this point — it comes back from a script
   * running in the page, and a hostile page can overwrite `__nimbusCapture`
   * and return anything. `buildClipPayload` rebuilds it from the five known
   * fields under the gateway's own caps before anything is sent, previewed or
   * queued; nothing may forward this object as it stands.
   */
  readonly source?: ClipSource;
  readonly title: string;
  readonly mode: "article" | "selection";
  readonly body: string;
  readonly readableFound: boolean;
}

export interface Connection {
  readonly origin: string;
  readonly token: string;
  readonly label: string;
  readonly pairedAt: number;
  /**
   * When a clip last succeeded against this gateway. OPTIONAL because pairings
   * made before this shipped do not have it — absent means "no clip yet", which
   * is also true of a fresh pairing, so no migration is needed.
   */
  readonly lastClipAt?: number;
  /**
   * The gateway has rejected this token (401). Surfaced as "needs re-pairing",
   * which is the one thing a user can act on and cannot guess: a revoked token
   * and a stopped gateway look identical from the outside.
   */
  readonly stale?: boolean;
}

export type PairError = "pairing_failed" | "bad_origin" | "unreachable" | "server_error";
export type ClipError =
  | "not_paired"
  | "unauthorized"
  | "invalid_request"
  | "payload_too_large"
  | "rate_limited"
  | "unreachable"
  | "server_error";

/**
 * The result of a clip POST. Shared by the fetch seam, the clip handler and the
 * queue flush so the optional `retryAfterMs` cannot drift between three copies.
 * Only ever set alongside `reason: "rate_limited"`.
 */
export type ClipPostResult =
  | { readonly ok: true; readonly status: "created" | "updated" }
  | { readonly ok: false; readonly reason: ClipError; readonly retryAfterMs?: number };

export interface RelatedHit {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly snippet: string;
  readonly url: string | null;
  /**
   * The connector's item kind — `pr`, `issue`, `ci_run`, … OPTIONAL because a
   * gateway older than the projection sends none, and an extension updates on a
   * different schedule than the gateway it talks to. Absent renders no chip; it
   * is never a reason to reject the hit.
   *
   * An OPEN vocabulary: connectors add kinds freely, so nothing may switch
   * exhaustively over it. See `humaniseType` in `panel/related-groups.ts`.
   */
  readonly type?: string;
  /** Epoch ms, renamed from the wire's `modified_at` at the HTTP boundary
   *  (`gateway-client.ts`) so the wire shape stops at the parser — the same
   *  treatment `ResolvedItem.modifiedAt` already gets. Optional for the same
   *  reason as `type`. */
  readonly modifiedAt?: number;
}

export type RelatedError = "not_paired" | "unauthorized" | "unreachable" | "server_error";

/** The three feedback states a quick-clip toast can show. */
export type ToastVariant = "success" | "offline" | "error";

export interface ToastState {
  readonly variant: ToastVariant;
  readonly text: string;
}

/**
 * What the ambient cue says. Both fields come from the pure recogniser
 * (`Recognition.label` / `.ref`), never from page-controlled DOM — but they are
 * rendered with textContent regardless, because the ref is derived from a URL
 * the page's own history API can write.
 */
export interface CueState {
  readonly label: string;
  readonly ref: string;
}

/**
 * Every product whose pages the client can recognise, as data.
 *
 * The array is the source and `Product` is derived from it, not the other way
 * round: `origins.ts` needs the ids at RUNTIME to validate a stored entry, and a
 * hand-written second copy of a union is the drift this slice exists to delete.
 * Keep it `as const` — widening to `string[]` silently widens `Product` to
 * `string` and every `Record<Product, …>` exhaustiveness check with it.
 */
export const PRODUCT_IDS = [
  "bitbucket",
  "circleci",
  "github",
  "gitlab",
  "jenkins",
  "jira",
] as const;

/** A product whose pages the client can recognise. */
export type Product = (typeof PRODUCT_IDS)[number];

/**
 * What kind of item a recognised page is.
 *
 * `home` is the odd one out and deliberately so: it is a page the recogniser
 * knows and that has NO indexed item — a product's own dashboard. It exists
 * because the service-scoped agents (`catchup`/`decisions`/`ownership`) answer
 * about a whole connector, so they need a page whose scope matches that answer.
 * See LANE_RULES below.
 */
export type SurfaceKind = "pr" | "build" | "issue" | "home";

/**
 * An origin whose pages may be recognised, declared by the user (or built in for
 * the SaaS hosts). `origin` is scheme + host [+ port] plus an OPTIONAL path
 * prefix — "https://bitbucket.org" or "https://corp.example/jenkins" — because
 * self-hosted instances commonly sit behind a reverse proxy on a sub-path.
 *
 * NOTE: this is a PAGE origin, unrelated to the loopback gateway origin validated
 * by shared/gateway.ts. The two must never share a validator.
 */
export interface ConfiguredOrigin {
  readonly origin: string;
  readonly product: Product;
}

/**
 * What a targeted fetch is ABOUT — the three facts a user needs before agreeing
 * to have the gateway reach out on their behalf. Assembled by the panel from the
 * recognition it already holds; no new gateway read.
 */
export interface FetchTarget {
  readonly product: Product;
  readonly surface: SurfaceKind;
  readonly url: string;
}

/** The result of classifying a page URL. Resolution is at most one item. */
export type Recognition =
  | {
      readonly ok: true;
      readonly product: Product;
      readonly kind: SurfaceKind;
      /** Human header text, e.g. "Bitbucket PR". */
      readonly label: string;
      /** Short identity for the header, e.g. "acme/web #482". */
      readonly ref: string;
      /**
       * The URL sent to the gateway as the resolution key: the address-bar URL with
       * identity normalisation only. The gateway owns canonicalisation — see
       * shared/recognise/index.ts.
       */
      readonly resolveUrl: string;
    }
  | { readonly ok: false; readonly reason: "unknown-host" | "unrecognised-path" };

/**
 * How confidently the gateway matched our URL — its match ladder, in order:
 * exact key, then the key with all query params dropped, then up to three
 * trimmed trailing path segments (packages/gateway/src/index/resolve-by-url.ts).
 *
 * `path_trimmed` is a WEAKER claim than the other two and must never be rendered
 * with equal confidence: the ladder reached it by discarding part of the URL.
 *
 * Single-sourced here: both wire validators (gateway-client.ts's parser,
 * messages.ts's SW→panel guard) read `RESOLVE_MATCH_KINDS` rather than each
 * declaring their own literal list, so the type and its two validators cannot
 * drift apart — adding a match kind here adds it to both validators for free,
 * instead of typechecking green while both silently rejected the new arm.
 */
export const RESOLVE_MATCH_KINDS = ["exact", "query_stripped", "path_trimmed"] as const;
export type ResolveMatchKind = (typeof RESOLVE_MATCH_KINDS)[number];

/** One indexed item, metadata only. Resolve is a resolver — reading is a separate route. */
export interface ResolveCandidate {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
}

/**
 * A resolved item. `modifiedAt` is epoch ms, renamed from the wire's `modified_at`
 * at the HTTP boundary (gateway-client.ts) so the wire shape stops at the parser.
 *
 * A CANDIDATE has no `modifiedAt` — the gateway does not send one for candidates.
 * That asymmetry is deliberate and load-bearing: it is why choosing a candidate
 * cannot render as `resolved` (see HeaderState's `chosen` arm).
 */
export interface ResolvedItem extends ResolveCandidate {
  readonly modifiedAt: number;
}

/**
 * What the gateway writes for a clip it ingested, from
 * `packages/gateway/src/clips/clip-ingest.ts:7-8` (upstream repo `Nimbus`).
 *
 * Duplicated here rather than imported: the gateway is a SEPARATE repository, and
 * this extension ships with no `node_modules` ("bundled, no runtime deps"), so
 * there is nothing to import from and a vendored package would drift the same way
 * a literal does. Roadmap Phase 8 (the Nimbus SDK) is where a genuinely shared
 * constant can live. If upstream renames either value, the captured-copy header
 * silently degrades to the ordinary resolved arm — it does not break, it stops
 * being honest. That is the failure mode to know about.
 */
export const CLIP_SERVICE = "nimbus";
export const CLIP_TYPE = "web_clip";

/** Why a capture could not be produced. Each maps to its own panel line. */
export type CaptureError = "restricted" | "url-changed" | "injection-failed" | "empty";

/**
 * A successful call to the resolve route. All four arms are HTTP 200 — a miss is
 * an answer, not a failure.
 *
 * `not-indexed` carries no service: upstream always sends `service: null` on that
 * arm (resolve-by-url.ts:169), so modelling one would invite the header to promise
 * a name we do not have. `ambiguous` no longer carries one either: the panel names
 * the service from `Recognition`, which it already has, and a second source for the
 * same fact is only a chance for the two to disagree.
 */
export type ResolveOutcome =
  | { readonly kind: "found"; readonly item: ResolvedItem; readonly matchKind: ResolveMatchKind }
  | { readonly kind: "not-indexed"; readonly fetchable: boolean }
  | { readonly kind: "unresolvable"; readonly fetchable: boolean }
  | {
      readonly kind: "ambiguous";
      readonly fetchable: boolean;
      /** EMPTY whenever `truncated` — upstream sends no list rather than a sliced one. */
      readonly candidates: readonly ResolveCandidate[];
      readonly truncated: boolean;
    };

/**
 * `unsupported` is a 404 — this gateway has no resolve route (or the clips seam
 * is off). `insufficient_scope` is a 403 and is the state EVERY browser paired
 * before token scopes hits first: LEGACY_SCOPES is ["clip","briefs"], so an
 * existing token carries no `resolve`. It is separate from `unauthorized`
 * because the fix is different — the owner re-grants the scope, the user does
 * not re-authenticate.
 */
export type ResolveError =
  | "not_paired"
  | "unauthorized"
  | "insufficient_scope"
  | "unsupported"
  | "unreachable"
  | "server_error";

/**
 * What a 403 tells us about a scope the paired token lacks, plus the label needed
 * to name the device in the fix command.
 *
 * `granted` comes from the gateway's own 403 body (`insufficientScopeBody` in
 * ipc/http-route-auth.ts), NOT from a client guess — `--set` replaces the set, so
 * guessing it would strip scopes the token already holds.
 */
export interface ScopeGap {
  readonly label: string;
  readonly required: string;
  readonly granted: readonly string[];
}

/**
 * A successful call to the targeted-fetch route. Every arm is HTTP 200 — upstream
 * is explicit that "a miss is a legitimate answer to a well-formed request, not a
 * client error" (ipc/http-write-routes.ts).
 *
 * The three wire arms `not_found`, `unsupported_url` and `no_targeted_fetch`
 * collapse into `unfetchable`: they differ in WHY the gateway declined but are
 * identical in what the user can do about it, which is nothing. `not_configured`
 * stays separate because C3.1's done-when requires it — an unconfigured connector
 * must "say so plainly instead of retrying".
 *
 * `not-configured` carries no service name because the WIRE carries none (only
 * `no_targeted_fetch` does). The panel names the connector from `Recognition`.
 */
export type FetchOutcome =
  // `itemId` is parsed, guarded and carried through but never read by the
  // panel (the caller re-resolves on `indexed` rather than rendering this
  // field — see `fetchOutcomeHeader`'s doc comment in panel-in-page.ts).
  // Deliberate: requiring it is what makes `{status:"indexed"}` WITHOUT an id
  // fail the parse in gateway-client.ts, rather than silently accepting a
  // malformed 200 as a valid `indexed` outcome.
  | { readonly kind: "indexed"; readonly itemId: string }
  | { readonly kind: "unfetchable" }
  | { readonly kind: "not-configured" }
  | { readonly kind: "rate-limited" };

/**
 * `timeout` is NOT a failure and must never be collapsed into `unreachable`.
 *
 * It means our 30s timer fired: the gateway may still be completing the fetch.
 * Reporting it as a failure would assert something we have not established, and
 * would invite a retry that fires a second outbound provider request for work
 * already done. `unreachable` means the connection itself failed — nothing was
 * sent, and a retry is safe.
 */
export type FetchError =
  | "not_paired"
  | "unauthorized"
  | "insufficient_scope"
  /** 404 — this gateway has no fetch route, or the seam is disabled. */
  | "unsupported"
  | "timeout"
  | "unreachable"
  | "server_error";

/**
 * The lanes this client ships, and the agent each maps to. A member IS the wire
 * agent name — `invokeAgent` passes it straight through as `{agent}` in
 * `POST /v1/agents/{agent}` — so these must be spelled exactly as upstream's
 * handler keys. Order here is render order, and `catchup` is declared first
 * AMONG THE HOME LANES — not first overall — because it is the question a
 * dashboard exists to answer. `why` is declared LAST among the pull-request
 * lanes — appended after `impact` and `expert` rather than leading them,
 * because reordering the two shipped lanes would change what every existing
 * user sees, which this lane's addition has no mandate to do.
 *
 * `preflight`, `premortem`, `whyPeek` and `negotiate` are absent because
 * upstream excludes them from the HTTP surface entirely
 * (HTTP_EXCLUDED_AGENT_METHODS in packages/gateway/src/ipc/agents-rpc.ts).
 * `ghost` and `conflicts` are absent because both require `{ file }` — a local
 * checkout the browser does not have.
 *
 * `glossary` is declared FIRST because order here is render order and it is the
 * only lane the user summons by name: it exists in a panel because they just
 * selected a word and asked what it means, so it leads the answer rather than
 * sitting under two lanes they did not ask for. See `LANE_RULES` below for why
 * it is also the only lane with no surface list.
 */
export const AGENT_LANES = [
  "glossary",
  "impact",
  "expert",
  "why",
  "catchup",
  "decisions",
  "ownership",
] as const;
export type AgentLane = (typeof AGENT_LANES)[number];

/**
 * What a lane needs before it can be asked anything.
 *
 * A discriminated union rather than two parallel tables, because the two arms
 * are genuinely exclusive and each carries a field the other must not have:
 *
 * - `page` — the lane's whole input is derived from the page, so it must declare
 *   which recognised `SurfaceKind`s it belongs on. Every lane through C2.3.
 * - `term` — the lane's input is supplied by the user (a selection), so a
 *   surface list would be meaningless: there is no page property that makes a
 *   term more or less answerable. Declaring `surfaces` on this arm is a type
 *   error, which is the point — it stops a future editor from "fixing" the
 *   asymmetry by pinning glossary to the surfaces that happen to exist today.
 *
 * Keyed by `AgentLane`, so adding a lane without declaring its rule stays a type
 * error rather than a lane that silently appears everywhere — the property C2.3
 * established, now covering both questions instead of one.
 */
export type LaneRule =
  | { readonly input: "page"; readonly surfaces: readonly SurfaceKind[] }
  | { readonly input: "term" };

/**
 * Which lane belongs where, and on what input.
 *
 * Before this table, lanes were gated on "the page resolved to an item" alone,
 * so a resolved Jira issue offered *What breaks if it lands* and handed the
 * issue URL to `agents.impact` as its `fileOrPrUrl` — a question that does not
 * apply, answered from an input the agent was not built for. The surface gate is
 * on the RECOGNISER's kind — a closed union this repo owns — not on
 * `ResolvedItem.type`, which is a free-form string from the wire.
 *
 * Renamed from `LANE_SURFACES`: the value is no longer a surface list, and a
 * name that says otherwise is exactly the drift the table exists to prevent.
 */
export const LANE_RULES: Record<AgentLane, LaneRule> = {
  // No surfaces, and not an omission. `POST /v1/agents/glossary` takes
  // `{ term, limit }` — no URL, no item — so this lane answers on any page the
  // panel opens on, including one the recogniser rejects. The recogniser gate
  // exists to stop page URLs reaching the gateway; this lane sends none, so the
  // reason for the gate does not apply to it. The term you most need defined is
  // usually on the unfamiliar internal wiki that has no connector at all.
  glossary: { input: "term" },
  impact: { input: "page", surfaces: ["pr"] },
  expert: { input: "page", surfaces: ["pr"] },
  // The third review question, and gated identically: `agents.why`'s prUrl arm
  // answers about a change under review, which is a question only a pull request
  // page can pose.
  why: { input: "page", surfaces: ["pr"] },
  // Service-scoped: these answer about a whole connector, so they belong on the
  // one page whose scope is the connector. On an item page they would repeat
  // the same answer for every item on that host.
  catchup: { input: "page", surfaces: ["home"] },
  decisions: { input: "page", surfaces: ["home"] },
  ownership: { input: "page", surfaces: ["home"] },
};

/**
 * Does this page-derived lane belong on this surface?
 *
 * Always false for a term lane — not because a term lane is unwelcome on the
 * surface, but because the question is the wrong one to ask about it. Callers
 * deciding what to render must branch on `LANE_RULES[lane].input` first; this
 * helper is the answer for the `page` arm alone, and answering `false` rather
 * than throwing keeps the two call sites (the panel's render gate and the
 * handler's forged-message check) from each inventing their own default.
 */
export function laneBelongsOnSurface(lane: AgentLane, kind: SurfaceKind): boolean {
  const rule = LANE_RULES[lane];
  return rule.input === "page" && rule.surfaces.includes(kind);
}

/**
 * What one lane is doing. `collapsed` is also the state of a lane never opened.
 *
 * The run route's `findings` field is deliberately NOT modelled on the `done`
 * arm below. Upstream types it `unknown` — "the shape is per-agent" — and
 * nothing in the panel renders it; the resolve slice already had to prune
 * exactly such a per-item catch-all. Recorded here so a future reader editing
 * this type alone has the reasoning: add `findings` back only alongside a
 * concrete renderer for it, never as a passthrough `unknown`.
 */
export type LaneState =
  | { readonly kind: "collapsed" }
  | { readonly kind: "running"; readonly runId: string }
  | { readonly kind: "done"; readonly brief: string }
  | {
      readonly kind: "failed";
      readonly reason: AgentError;
      /**
       * Present only on `insufficient_scope`, and only when the gateway's 403
       * carried the detail. `panel-view.ts` builds the exact
       * `nimbus clip scopes … --set …` command from it via `scopeCommand`;
       * absent, it falls back to generic guidance rather than inventing one.
       */
      readonly scopeGap?: ScopeGap;
      /**
       * The gateway's own explanation, present only on `agent_failed` and only
       * when the run carried one. Free text from the gateway — Task 7 renders it
       * with `textContent`, never parsed, exactly as it does the brief.
       */
      readonly detail?: string;
    };

/**
 * `stale` collapses the poll's 404 and 410. Upstream distinguishes them —
 * unknown-or-lost-to-restart vs known-and-expired — but states the client response
 * to both is to re-issue, never to keep waiting. One state, one "Re-run".
 *
 * There is no `busy`: a 429 is handled inside the client by backing off for
 * `Retry-After` and retrying. Upstream sized that header at one second precisely
 * because a slot frees when a run finishes, in seconds. Surfacing it would report
 * a normal condition as a failure.
 *
 * Single-sourced here, same shape as `RESOLVE_MATCH_KINDS` and `AGENT_LANES`:
 * `agent-run-store.ts`'s storage guard reads `AGENT_ERRORS` rather than
 * declaring its own literal list, so the type and its guard cannot drift apart —
 * `satisfies readonly AgentError[]` on a hand-duplicated list does NOT check
 * exhaustiveness, so adding a member there but not here would typecheck green
 * while silently dropping any stored run carrying the new reason on read.
 */
export const AGENT_ERRORS = [
  "not_paired",
  "unauthorized",
  "insufficient_scope",
  // 404 — unknown agent, or this gateway has no agents surface.
  "unsupported",
  // There is no single indexed item for this page to ask an agent about — the
  // page is unrecognised, or it resolved to a miss/ambiguous answer. A
  // condition of the PAGE, never of the gateway: reporting it as `unsupported`
  // would say "this gateway can't run agents yet" about a gateway that runs
  // them fine.
  "not_resolved",
  /**
   * A lane whose `LANE_RULES` entry is `{input:"term"}` was asked to run with no
   * term. Unreachable from the shipped UI — the panel materialises a term lane
   * only once a term exists — so this exists for the same reason the handler's
   * surface check does: `agent-run` arrives from a content script, and a forged
   * or stale one deserves an honest answer rather than a borrowed
   * `not_resolved`, which would blame the page for a missing input the page was
   * never the source of.
   */
  "no_term",
  "stale",
  "unreachable",
  "server_error",
  /**
   * The run reached a terminal `failed` status: the transport worked and the
   * gateway is healthy, but the agent could not produce an answer. Distinct from
   * `server_error`, which means the CALL failed. Upstream separates these
   * deliberately — see the `failureReason`, NOT `error` comment on the run route
   * in the gateway's http-server.ts — so that a normal outcome is not misread as
   * a transport error. Carries `detail` when the gateway explained why.
   */
  "agent_failed",
] as const;
export type AgentError = (typeof AGENT_ERRORS)[number];
