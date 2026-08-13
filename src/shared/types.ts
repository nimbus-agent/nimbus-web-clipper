export interface CaptureResult {
  readonly url: string;
  readonly canonicalUrl?: string;
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

/** A product whose pages the client can recognise. */
export type Product = "bitbucket" | "github" | "gitlab" | "jenkins" | "jira";

/** What kind of item a recognised page is. */
export type SurfaceKind = "pr" | "build" | "issue";

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
       * shared/recognise.ts.
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
 * The lanes this phase ships, and the agent each maps to.
 *
 * `why` is deliberately ABSENT. `agents.why` takes `{ ref, line? }` where `ref` is
 * a LOCAL filesystem path resolved against configured `[[filesystem.roots]]` and
 * answered by git blame on a local checkout — it answers "why does this line
 * exist", not "why does this change exist", and a browser on a pull-request page
 * has neither the path nor necessarily the repo. The roadmap's C2.1 brief names it
 * (and `whyPeek`, which is HTTP-excluded); both are corrected there.
 */
export const AGENT_LANES = ["impact", "expert"] as const;
export type AgentLane = (typeof AGENT_LANES)[number];

/**
 * Which recognised surfaces each lane belongs on.
 *
 * The panel renders only the lanes whose entry contains the page's recognised
 * `SurfaceKind`. Before this table, lanes were gated on "the page resolved to an
 * item" alone, so a resolved Jira issue offered *What breaks if it lands* and
 * handed the issue URL to `agents.impact` as its `fileOrPrUrl` — a question that
 * does not apply, answered from an input the agent was not built for.
 *
 * Keyed by `AgentLane`, so adding a lane without declaring its surfaces is a type
 * error rather than a lane that silently appears everywhere. Gated on the
 * RECOGNISER's kind — a closed union this repo owns — not on `ResolvedItem.type`,
 * which is a free-form string from the wire.
 */
export const LANE_SURFACES: Record<AgentLane, readonly SurfaceKind[]> = {
  impact: ["pr"],
  expert: ["pr"],
};

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
