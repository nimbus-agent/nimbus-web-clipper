import { buildClipPayload } from "../shared/clip.ts";
import type { ConnectorHealth } from "../shared/connector-health.ts";
import { DISCOVERY_CANDIDATES, type ProbeResult, pickReachable } from "../shared/discovery.ts";
import { isLoopbackOrigin } from "../shared/gateway.ts";
import type {
  AgentRunRequest,
  AgentStateRequest,
  AgentStateResponse,
  CaptureRequest,
  CaptureResponse,
  ClipRequest,
  ClipResponse,
  ConnectionResponse,
  DiscoverResponse,
  FetchRequest,
  FetchResponse,
  PairRequest,
  PairResponse,
  QueueRemoveRequest,
  QueueResponse,
  QueueRetryRequest,
  RecogniseRequest,
  RecognitionResponse,
  RelatedRequest,
  RelatedResponse,
  ResolveRequest,
  ResolveResponse,
} from "../shared/messages.ts";
import { buildClipPreview } from "../shared/preview.ts";
import { enqueue, type QueuedClip, removeFromQueue, toView } from "../shared/queue.ts";
import { recognise } from "../shared/recognise/index.ts";
import { PRODUCT_SERVICE_ID } from "../shared/recognise/registry.ts";
import { buildRelatedQuery, type RelatedQuery } from "../shared/related.ts";
import {
  type AgentError,
  type AgentLane,
  type ClipPostResult,
  type ConfiguredOrigin,
  type Connection,
  type FetchError,
  type FetchOutcome,
  type FileResolution,
  LANE_RULES,
  type LaneState,
  laneBelongsOnSurface,
  type PairError,
  type RelatedError,
  type RelatedHit,
  type ResolveCandidate,
  type ResolveError,
  type ResolveOutcome,
  type ScopeGap,
  type SurfaceKind,
} from "../shared/types.ts";
import type { RunSubject, StoredRun } from "./agent-run-store.ts";
import { type AgentRoster, needsItemArm, offeredLanes } from "./agents-capability.ts";
import type { CaptureOutcome } from "./capture-tab.ts";

export interface CaptureDeps {
  readonly captureTab: (tabId: number, expectedUrl: string) => Promise<CaptureOutcome>;
  readonly previewEnabled: () => Promise<boolean>;
  readonly now: () => number;
}

/**
 * Capture the panel's pinned page and, if the user still wants the 1.3 confirm,
 * build the preview for it. Ingest is NOT done here: the panel sends the existing
 * `clip` request on Send, so there stays exactly one path that turns a
 * CaptureResult into an outbound clip.
 */
export async function handleCapture(
  deps: CaptureDeps,
  req: CaptureRequest,
  tabId: number,
): Promise<CaptureResponse> {
  const out = await deps.captureTab(tabId, req.pageUrl);
  if (!out.ok) {
    return { kind: "capture", ok: false, reason: out.reason };
  }
  const enabled = await deps.previewEnabled();
  if (!enabled) {
    return { kind: "capture", ok: true, capture: out.capture, preview: null };
  }
  const preview = buildClipPreview(
    buildClipPayload(out.capture, [], deps.now()),
    out.capture.canonicalRejected,
  );
  return { kind: "capture", ok: true, capture: out.capture, preview };
}

export interface PairDeps {
  readonly confirmPair: (
    origin: string,
    code: string,
  ) => Promise<{ ok: true; token: string; label: string } | { ok: false; reason: PairError }>;
  readonly setConnection: (c: Connection) => Promise<void>;
  /** Cached briefs belong to the gateway that produced them — see clearRuns. */
  readonly clearRuns: () => Promise<void>;
  readonly nowMs: () => number;
}

export interface ClipDeps {
  readonly getConnection: () => Promise<Connection | null>;
  readonly postClip: (
    origin: string,
    token: string,
    payload: ReturnType<typeof buildClipPayload>,
  ) => Promise<ClipPostResult>;
  readonly updateQueue: (mutator: (q: QueuedClip[]) => QueuedClip[]) => Promise<QueuedClip[]>;
  readonly nowMs: () => number;
}

export async function handlePair(deps: PairDeps, req: PairRequest): Promise<PairResponse> {
  if (!isLoopbackOrigin(req.origin)) {
    return { kind: "pair", ok: false, reason: "bad_origin" };
  }
  const r = await deps.confirmPair(req.origin, req.code);
  if (!r.ok) {
    // Intentional: a failed re-pair (e.g. wrong code) leaves any existing working
    // connection untouched — we overwrite it only on a confirmed new token.
    return { kind: "pair", ok: false, reason: r.reason };
  }
  await deps.setConnection({
    origin: req.origin,
    token: r.token,
    label: r.label,
    pairedAt: deps.nowMs(),
  });
  // A confirmed new token may be a different gateway than the one that produced
  // any cached briefs — a cached brief belongs to the gateway that produced it,
  // the same reason unpair clears (see handleUnpair). But the pairing itself is
  // the user-visible outcome here, already durably stored above — a stale cache
  // is a lesser problem than telling the user pairing failed when it worked, so
  // a `clearRuns` rejection must not fail this call. `setConnection`'s own
  // errors are NOT swallowed; only this best-effort cleanup is.
  await deps.clearRuns().catch(() => undefined);
  return { kind: "pair", ok: true, label: r.label };
}

export async function handleClip(deps: ClipDeps, req: ClipRequest): Promise<ClipResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "clip", ok: false, reason: "not_paired" };
  }
  const payload = buildClipPayload(req.capture, req.tags, deps.nowMs());
  const r = await deps.postClip(conn.origin, conn.token, payload);
  if (r.ok) {
    return { kind: "clip", ok: true, status: r.status, bookmarked: !req.capture.readableFound };
  }
  // Transient failures are queued and retried; 400/413 are terminal and are not.
  if (r.reason === "unreachable" || r.reason === "server_error" || r.reason === "rate_limited") {
    await deps.updateQueue((q) => enqueue(q, { payload, queuedAt: deps.nowMs(), attempts: 0 }));
    return { kind: "clip", ok: false, reason: r.reason, queued: true };
  }
  return { kind: "clip", ok: false, reason: r.reason };
}

export interface RelatedDeps {
  readonly getConnection: () => Promise<Connection | null>;
  readonly postRelated: (
    origin: string,
    token: string,
    query: RelatedQuery,
  ) => Promise<{ ok: true; items: RelatedHit[] } | { ok: false; reason: RelatedError }>;
}

export async function handleRelated(
  deps: RelatedDeps,
  req: RelatedRequest,
): Promise<RelatedResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "related", ok: false, reason: "not_paired" };
  }
  const r = await deps.postRelated(conn.origin, conn.token, buildRelatedQuery(req));
  if (!r.ok) {
    return { kind: "related", ok: false, reason: r.reason };
  }
  return { kind: "related", ok: true, items: r.items };
}

export interface RecogniseDeps {
  readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]>;
}

/**
 * Classify a page URL. The whole handler — no connection read, no gateway call,
 * no token.
 *
 * It is `handleResolve`'s first line, exposed on its own so the panel's
 * navigation watcher can ask "is the tab still showing the item my header names?"
 * without asking the gateway anything. The panel cannot answer that itself: the
 * configured origins live in the worker, and shipping them into a content script
 * would expose the user's internal hostnames to save a message that costs no
 * network.
 */
export async function handleRecognise(
  deps: RecogniseDeps,
  req: RecogniseRequest,
): Promise<RecognitionResponse> {
  return {
    kind: "recognition",
    ok: true,
    recognition: recognise(req.pageUrl, await deps.getOrigins()),
  };
}

/**
 * Read the stored pairing.
 *
 * Every gateway-touching Deps surface below needs it, and it is spelled once so
 * a change to what a connection carries cannot reach some of them and not
 * others.
 */
type GetConnection = () => Promise<{ origin: string; token: string; label: string } | null>;

/**
 * Resolve a page URL to an indexed item.
 *
 * One signature for the two Deps surfaces that take it. It was written out
 * twice, and the two copies had ALREADY drifted in spelling — one wrote the 403
 * detail inline as `{ required, granted }`, the other as `RawScopeGap` — which
 * is how a real divergence starts.
 */
type ResolveItem = (
  origin: string,
  token: string,
  pageUrl: string,
) => Promise<
  | { ok: true; outcome: ResolveOutcome }
  | { ok: false; reason: ResolveError; scopeGap?: RawScopeGap }
>;

export interface ResolveDeps {
  readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]>;
  readonly getConnection: GetConnection;
  readonly resolveItem: ResolveItem;
  /**
   * Resolve a `file` recognition's forge coordinate against the reader's local
   * checkout. Mirrors `resolveItem`'s shape — same three failure-vs-success arms —
   * but answers a different question: an item lookup never touches a filesystem.
   */
  readonly resolveFile: (
    origin: string,
    token: string,
    service: string,
    repo: string,
    refAndPath: string,
  ) => Promise<
    | { ok: true; resolution: FileResolution }
    | { ok: false; reason: ResolveError; scopeGap?: RawScopeGap }
  >;
  /**
   * Health for the gateway at `origin`, or null when it could not be read.
   *
   * NOTE the shape: the store (connector-health-store.ts) exports
   * `readConnectorHealth(deps, origin, nowMs)`, but the dep declared HERE takes the
   * origin alone. The store's own deps and the clock are bound once in
   * `service-worker.ts`, the single place real implementations are wired, so a
   * handler test injects a one-argument fake and never has to know the store exists.
   */
  readonly readConnectorHealth: (
    origin: string,
  ) => Promise<ReadonlyMap<string, ConnectorHealth> | null>;
  /**
   * What the paired gateway publishes it can do. Bound in `service-worker.ts`;
   * a handler test injects a fake and never learns the module exists — the same
   * shape `readConnectorHealth` above already takes.
   */
  readonly readAgentRoster: (origin: string, token: string) => Promise<AgentRoster>;
}

/**
 * Recognise the page, then resolve it to at most one indexed item.
 *
 * The recognition rides on BOTH arms of the response on purpose: a gateway
 * failure must not erase the fact that we know what page this is, or the panel
 * would drop back to "unrecognised" the moment the gateway hiccups.
 */
/**
 * One connector's health, from a read that may have failed.
 *
 * The two arms are NOT the same answer, and conflating them cost this gate its most
 * common case:
 *
 * - `null` — the read itself failed (404 from a gateway too old to serve the route,
 *   unreachable, timed out, malformed body). We could not ask, so we do not gate:
 *   `unknown` renders exactly the panel a client without this gate renders.
 * - a map that omits this connector — the read SUCCEEDED and the gateway has nothing
 *   recorded for it. That is `not_configured`, and it is the ordinary state of a
 *   connector nobody has set up. Upstream's own single-connector accessor
 *   (`getConnectorHealth`) answers `not_configured` for exactly this missing row, and
 *   `engine/connector-health-caveat.ts` consumes it that way; `getAllConnectorHealth`
 *   selects `FROM sync_state`, whose only production insert is inside
 *   `transitionHealth`, so a connector the scheduler never touched has no row to list.
 *
 * The residual risk is `PRODUCT_SERVICE_ID` drifting from upstream's connector ids: a
 * wrong id would read as "never synced" rather than as three lanes. That is not worse
 * — with a wrong id those lanes answer nothing either way — and it surfaces the drift
 * instead of hiding it.
 */
function connectorStateFor(
  health: ReadonlyMap<string, ConnectorHealth> | null,
  serviceId: string,
): ConnectorHealth {
  if (health === null) {
    return { state: "unknown" };
  }
  return health.get(serviceId) ?? { state: "not_configured" };
}

/**
 * The lanes this gateway can serve here, as the ok-arm field — or nothing at all.
 *
 * Spread into the response (`...offeredFor(...)`) rather than returned as a
 * possibly-`undefined` property, because `exactOptionalPropertyTypes` is on: an
 * explicit `offeredLanes: undefined` is a different type from an absent key, and
 * the wire wants the key absent.
 */
async function offeredFor(
  deps: Pick<ResolveDeps, "readAgentRoster">,
  origin: string,
  token: string,
  kind: SurfaceKind,
): Promise<{ offeredLanes?: readonly AgentLane[] }> {
  const offered = offeredLanes(await deps.readAgentRoster(origin, token), kind);
  return offered === null ? {} : { offeredLanes: offered };
}

export async function handleResolve(
  deps: ResolveDeps,
  req: ResolveRequest,
): Promise<ResolveResponse> {
  const recognition = recognise(req.pageUrl, await deps.getOrigins());
  if (!recognition.ok) {
    // Nothing to ask the gateway about — and no request is made. `fetchable:false`
    // because an unrecognised page is not a fetch candidate either.
    return {
      kind: "resolve",
      ok: true,
      recognition,
      outcome: { kind: "not-indexed", fetchable: false },
    };
  }
  // Read BEFORE the home branch, on purpose: this is a `chrome.storage` read,
  // not a gateway call, so it does not break the "a dashboard never triggers a
  // resolve request" rule below — it only decides which no-gateway answer an
  // unpaired user gets. Without this ordering, an unpaired dashboard would
  // report a home page's normal `service` header instead of the `not_paired`
  // guidance every other recognised surface shows unpaired (see
  // `resolveForAgent`, which checks this first for the same reason). Do not
  // "optimise" this back below the home branch.
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "resolve", ok: false, recognition, reason: "not_paired" };
  }
  if (recognition.kind === "home") {
    // A dashboard has no indexed item, so there is still no resolve call — but there
    // IS now exactly one gateway read: the connector's health, which decides whether
    // the service lanes can answer at all. Absent that, three lanes run against a
    // connector nobody configured and return nothing, which reads as "you have no
    // work" rather than "Nimbus is not connected to this". The outcome below is
    // otherwise INERT: `headerFrom` (panel-in-page.ts) branches on `recognition.kind`
    // before it reads an outcome, so a home page never renders as a miss. It is
    // filled in only because `ResolveResponse`'s ok arm requires one — the same
    // synthetic the unrecognised branch above already uses. `fetchable:false` keeps
    // the C3.1 button away from a page that is not a fetch candidate.
    // CONCURRENT, on purpose. The connector's health and the agent roster are two
    // independent gateway reads — neither one's request depends on the other's
    // answer — and awaiting them in sequence would add the roster's 10s bound on
    // top of the health read before the panel gets a header. `decideAmbient`
    // (ambient.ts) calls this on every recognised navigation and discards the
    // roster entirely, so that latency lands on the ambient cue too, where it
    // makes the cue likelier to be suppressed as "navigated" on a slow gateway.
    // What must NOT move: both reads carry the bearer token, so both stay below
    // the `getConnection()` null check above. Unpaired means no request at all.
    const [health, offered] = await Promise.all([
      deps.readConnectorHealth(conn.origin),
      offeredFor(deps, conn.origin, conn.token, recognition.kind),
    ]);
    const connector = connectorStateFor(health, PRODUCT_SERVICE_ID[recognition.product]);
    return {
      kind: "resolve",
      ok: true,
      recognition,
      outcome: { kind: "not-indexed", fetchable: false },
      connector,
      ...offered,
    };
  }
  if (recognition.kind === "file") {
    // No resolve call, and none is possible: a source file is not a connector item.
    // The gateway maps the coordinate to the reader's own checkout instead — see
    // `resolveForAgent`'s own `file` branch for the fuller version of this reasoning
    // (a different function answering a different question: what a LANE is about,
    // not what the PANEL shows).
    //
    // CONCURRENT with the roster read for the same reason as the home branch above:
    // `offeredFor` reads nothing the probe produces, and serialising them would put
    // the roster's 10s bound behind the probe's 8s one before a header can render.
    // Neither read may move above the `getConnection()` check above: both carry the
    // bearer token.
    const coordinate = recognition.forgeFile;
    const [probe, offered] = await Promise.all([
      coordinate === undefined
        ? // A `file` recognition without its coordinate is a recogniser bug, not a
          // page condition — nothing to probe and nothing to claim. Guarding on
          // `forgeFile !== undefined` at the `recognition.kind` check instead would
          // let this case fall through to `deps.resolveItem` below, sending a forge
          // blob URL to the item resolver — the exact trap Task 3 closed.
          Promise.resolve({ ok: true as const, resolution: { kind: "unsupported" as const } })
        : deps.resolveFile(
            conn.origin,
            conn.token,
            PRODUCT_SERVICE_ID[recognition.product],
            coordinate.repo,
            coordinate.refAndPath,
          ),
      offeredFor(deps, conn.origin, conn.token, recognition.kind),
    ]);
    // A refused SCOPE travels the same path `resolveItem`'s 403 already does, below —
    // that is what reaches the panel's `needs-scope` header and the `nimbus clip
    // scopes` command it prints. The label comes from the connection, which only
    // this layer holds.
    if (!probe.ok && probe.reason === "insufficient_scope") {
      return probe.scopeGap === undefined
        ? { kind: "resolve", ok: false, recognition, reason: probe.reason }
        : {
            kind: "resolve",
            ok: false,
            recognition,
            reason: probe.reason,
            scopeGap: { label: conn.label, ...probe.scopeGap },
          };
    }
    // Every OTHER refusal is silent: the page is still recognised, the header still
    // renders, and we claim nothing about a file we could not ask about.
    return {
      kind: "resolve",
      ok: true,
      recognition,
      outcome: { kind: "not-indexed", fetchable: false },
      file: probe.ok ? probe.resolution : { kind: "unsupported" },
      ...offered,
    };
  }
  // Concurrent for the same reason as the home branch above: `offeredFor` reads
  // nothing the resolve produces, and serialising them would put the roster's 10s
  // bound behind the resolve's 8s one before a header can render. The cost is one
  // extra local GET on a resolve that fails — a loopback request the panel would
  // have made a moment later anyway — and that is the right trade against doubling
  // the worst-case wait on every recognised page. Neither read may move above the
  // `getConnection()` check: both carry the bearer token.
  const [r, offered] = await Promise.all([
    deps.resolveItem(conn.origin, conn.token, recognition.resolveUrl),
    offeredFor(deps, conn.origin, conn.token, recognition.kind),
  ]);
  if (!r.ok) {
    return r.scopeGap === undefined
      ? { kind: "resolve", ok: false, recognition, reason: r.reason }
      : {
          kind: "resolve",
          ok: false,
          recognition,
          reason: r.reason,
          scopeGap: { label: conn.label, ...r.scopeGap },
        };
  }
  return {
    kind: "resolve",
    ok: true,
    recognition,
    outcome: r.outcome,
    ...offered,
  };
}

export interface FetchDeps {
  readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]>;
  readonly getConnection: () => Promise<Connection | null>;
  readonly fetchItem: (
    origin: string,
    token: string,
    pageUrl: string,
  ) => Promise<
    | { ok: true; outcome: FetchOutcome }
    | { ok: false; reason: FetchError; scopeGap?: { required: string; granted: string[] } }
  >;
}

/**
 * A targeted fetch causes an OUTBOUND request to a provider under the user's
 * stored credential. The recogniser is therefore a hard gate here, exactly as it
 * is for resolve — and for a stronger reason: resolve reads the local index,
 * this one leaves the machine. No gateway call happens on this branch either
 * way; unlike `handleResolve`, an unrecognised page has no `not-indexed`
 * outcome to report a `fetchable` flag on, so it settles as `unfetchable` —
 * a client-side "can't fetch this", not a gateway error.
 */
export async function handleFetch(deps: FetchDeps, req: FetchRequest): Promise<FetchResponse> {
  const recognition = recognise(req.pageUrl, await deps.getOrigins());
  if (!recognition.ok) {
    return { kind: "fetch", ok: true, recognition, outcome: { kind: "unfetchable" } };
  }
  if (recognition.kind === "home") {
    // Defence in depth on an OUTBOUND path: the fetch button never renders for
    // a dashboard (it only appears on the `not-indexed` header arm, which
    // `handleResolve` never reaches for a home page), so this is unreachable
    // through the UI today. It is guarded anyway, for the same reason
    // `handleResolve` refuses a home page before touching the gateway — a
    // dashboard is not a fetch candidate, and this is the one path where
    // getting that wrong costs an outbound request under the user's stored
    // credential, not just a wasted local read.
    return { kind: "fetch", ok: true, recognition, outcome: { kind: "unfetchable" } };
  }
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "fetch", ok: false, recognition, reason: "not_paired" };
  }
  const r = await deps.fetchItem(conn.origin, conn.token, recognition.resolveUrl);
  if (!r.ok) {
    return r.scopeGap === undefined
      ? { kind: "fetch", ok: false, recognition, reason: r.reason }
      : {
          kind: "fetch",
          ok: false,
          recognition,
          reason: r.reason,
          scopeGap: { label: conn.label, ...r.scopeGap },
        };
  }
  return { kind: "fetch", ok: true, recognition, outcome: r.outcome };
}

/** A scope gap as the gateway's 403 body carries it — before the device label
 *  (only `handlers.ts` holds a `Connection`) is attached. */
type RawScopeGap = { readonly required: string; readonly granted: string[] };

/** The result of a call to `invokeAgent`, without the wire's `busy` reason — the
 *  retry loop below absorbs `busy` and never lets it escape as a lane state. */
type InvokeResult =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly reason: AgentError; readonly scopeGap?: RawScopeGap };

export interface AgentRunDeps {
  readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]>;
  readonly getConnection: GetConnection;
  readonly resolveItem: ResolveItem;
  readonly invokeAgent: (
    origin: string,
    token: string,
    agent: AgentLane,
    params: unknown,
  ) => Promise<
    | { ok: true; runId: string }
    | { ok: false; reason: AgentError; scopeGap?: RawScopeGap }
    | { ok: false; reason: "busy"; retryAfterMs: number }
  >;
  readonly getRun: (subject: RunSubject, lane: AgentLane) => Promise<StoredRun | null>;
  readonly putRun: (run: Omit<StoredRun, "expiresAtMs">) => Promise<void>;
}

export interface AgentStateDeps {
  readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]>;
  readonly getConnection: GetConnection;
  readonly resolveItem: AgentRunDeps["resolveItem"];
  readonly getRun: (subject: RunSubject, lane: AgentLane) => Promise<StoredRun | null>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `busy` (429) is a normal, brief condition — upstream sizes `Retry-After` at one
 * second because a run slot frees when a run FINISHES, in seconds. So this backs
 * off by exactly that long and retries ONCE.
 *
 * A second `busy` within that window means genuine contention, not something a
 * longer wait would fix, and the lane's own re-run affordance covers it from
 * here — so THAT specific case reports `server_error` rather than backing off
 * again or surfacing `busy` (which is not a member of `AgentError`). Any OTHER
 * failure on the retry is the real answer and must be reported as itself:
 * collapsing e.g. a 403 to `server_error` would strip its `scopeGap` and tell
 * the user Nimbus is broken when they need to grant a scope.
 */
async function invokeWithRetry(
  deps: AgentRunDeps,
  origin: string,
  token: string,
  lane: AgentLane,
  params: unknown,
): Promise<InvokeResult> {
  const first = await deps.invokeAgent(origin, token, lane, params);
  if (first.ok || first.reason !== "busy") {
    return first;
  }
  await delay(first.retryAfterMs);
  const second = await deps.invokeAgent(origin, token, lane, params);
  if (second.ok) {
    return second;
  }
  return second.reason === "busy" ? { ok: false, reason: "server_error" } : second;
}

/**
 * What a lane needs before it can invoke. Three success arms, because a lane is
 * about one of three things: an indexed ITEM (C2.1), a whole SERVICE (C2.3), or
 * a TERM the user selected (C2.3's deferred glossary lane).
 *
 * The service arm exists precisely so the home path can skip the resolve call —
 * there is no item to resolve, and a dashboard URL sent to `resolve` would come
 * back `unresolvable`, reporting a miss for a page that was never meant to hit.
 * The term arm skips more than that: see `resolveForAgent` below.
 */
type ResolveForAgent =
  | {
      readonly ok: true;
      readonly scope: "item";
      readonly origin: string;
      readonly token: string;
      readonly label: string;
      /** The URL sent to `resolve` — the same one `impact` is given. */
      readonly resolveUrl: string;
      /**
       * `ResolveCandidate`, NOT `ResolvedItem`: this arm now also carries a
       * candidate the user picked out of an ambiguous answer, and a candidate
       * has no `modifiedAt` — the gateway does not send one. Typing the field as
       * the narrower shape is what stops anything downstream reading a freshness
       * that, on the picked-candidate path, does not exist. Only `id` and
       * `title` are read (`subjectFor`, `agentParams`), so nothing is lost.
       */
      readonly item: ResolveCandidate;
      /**
       * The recognised surface this item was found on.
       *
       * The scope says WHERE the input comes from — one indexed item, on every one
       * of these surfaces. It does not say which ARM carries it, and those diverge:
       * a `pr` page sends `prUrl` / `fileOrPrUrl` / `topicOrFile`, arms every
       * released gateway serves; an `issue` or an `incident` sends `itemUrl`, which
       * arrived in 7.5.0. `agentParams` is therefore keyed by lane AND surface —
       * the completion of the generalisation `LANE_RULES` already made, in the one
       * place that still read a lane alone.
       */
      readonly surface: SurfaceKind;
    }
  | {
      readonly ok: true;
      readonly scope: "service";
      readonly origin: string;
      readonly token: string;
      readonly label: string;
      readonly service: string;
    }
  | {
      readonly ok: true;
      readonly scope: "term";
      readonly origin: string;
      readonly token: string;
      readonly label: string;
      readonly term: string;
    }
  | {
      readonly ok: true;
      readonly scope: "file";
      readonly origin: string;
      readonly token: string;
      readonly label: string;
      /**
       * The forge coordinate, straight off recognition. NO resolve call is made on
       * this arm and none is possible: a source file is not a connector item, so
       * there is no indexed row to resolve to, no miss to recover from, and no
       * targeted fetch that could ever create one. The gateway maps the coordinate
       * to the reader's own checkout — this client does not know their filesystem
       * and must not guess at it.
       */
      readonly service: string;
      readonly repo: string;
      readonly refAndPath: string;
    }
  | { readonly ok: false; readonly reason: AgentError; readonly scopeGap?: ScopeGap };

/**
 * The fields of an `agent-run`/`agent-state` request this prefix reads. Both
 * request types satisfy it structurally, so the prefix takes the request itself
 * rather than a growing list of positional arguments — the third and fourth
 * (`itemId`, `term`) are optional and easy to transpose at a call site.
 */
type LaneInvocation = Pick<AgentRunRequest, "lane" | "pageUrl" | "itemId" | "term">;

/**
 * Work out what a lane is about — exactly the shared prefix `handleAgentRun` and
 * `handleAgentState` both need: for a page lane, the recogniser gate (no gateway
 * call for a page we cannot classify) and the item id a lane is cached under;
 * for a term lane, neither.
 *
 * `not_resolved` is a condition of the PAGE — unrecognised, or a resolve
 * miss/ambiguous answer — never of the gateway; it must not be confused with
 * `unsupported`, which means the gateway itself has no agents surface.
 */
/**
 * The term-lane half of {@link resolveForAgent}, which shares no step with the page
 * half — no recogniser gate, no resolve call, no `Recognition` — so it reads better as
 * its own function than as a 35-line early branch. Extracted to bring
 * `resolveForAgent` back under the cognitive-complexity gate (Sonar `S3776`); the
 * behaviour and the return shapes are unchanged.
 *
 * Both omissions are deliberate rather than an optimisation.
 *
 * The recogniser gate exists to decide which page URLs may reach the gateway at all.
 * `POST /v1/agents/glossary` takes `{ term }` — no URL, no item — so this path sends no
 * page URL, and the reason for the gate does not apply to it. Gating anyway would
 * confine definitions to the surfaces a connector already covers, when the term you
 * most need defined is on the unfamiliar internal wiki that has no connector at all.
 *
 * Skipping the resolve call also means this lane works on a pairing that never received
 * the `resolve` scope — like the service lanes, it needs only `agents`.
 */
async function resolveTermLane(
  deps: Pick<AgentStateDeps, "getConnection">,
  req: LaneInvocation,
): Promise<ResolveForAgent> {
  if (req.term === undefined) {
    // Unreachable from the shipped UI: the panel materialises a glossary lane
    // only once a term exists, so it never sends one without. Reachable from a
    // forged message, and answered honestly rather than borrowing
    // `not_resolved`, which would blame the page for a missing input.
    return { ok: false, reason: "no_term" };
  }
  const termConn = await deps.getConnection();
  if (termConn === null) {
    return { ok: false, reason: "not_paired" };
  }
  return {
    ok: true,
    scope: "term",
    origin: termConn.origin,
    token: termConn.token,
    label: termConn.label,
    term: req.term,
  };
}

async function resolveForAgent(
  deps: Pick<AgentStateDeps, "getOrigins" | "getConnection" | "resolveItem">,
  req: LaneInvocation,
): Promise<ResolveForAgent> {
  const lane = req.lane;
  if (LANE_RULES[lane].input === "term") {
    return await resolveTermLane(deps, req);
  }
  const recognition = recognise(req.pageUrl, await deps.getOrigins());
  if (!recognition.ok) {
    // Nothing to ask the gateway about — the recogniser is the boundary deciding
    // which URLs may reach it at all. No resolve call, no invoke.
    return { ok: false, reason: "not_resolved" };
  }
  // Enforce, in the handler, what `LANE_RULES` already enforces in the panel's
  // render gate: a page lane must belong on the page's recognised surface. The
  // panel never sends a mismatched pair — it renders only lanes `LANE_RULES`
  // allows for the current surface — so this branch is unreachable from the
  // shipped UI. But `agent-run`/`agent-state` arrive from a content script, and
  // their guards (`isAgentRunRequest`/`isAgentStateRequest` in shared/messages.ts)
  // validate only that `lane` is an `AgentLane` and `pageUrl` is a string, never
  // the pairing between them. Cross-boundary data is untrusted here regardless of
  // what the UI would send, so without this check a forged `agent-run` could ask
  // `impact` about a dashboard or `catchup` about a pull request. Placed before
  // any connection read, cache access or invoke — same "no gateway call for a
  // condition of the page" rule the unrecognised-page branch above follows.
  if (!laneBelongsOnSurface(lane, recognition.kind)) {
    return { ok: false, reason: "not_resolved" };
  }
  const conn = await deps.getConnection();
  if (conn === null) {
    return { ok: false, reason: "not_paired" };
  }
  if (recognition.kind === "home") {
    // No resolve call: a dashboard has no indexed item, and `Recognition.product`
    // IS the gateway's connector id, so the only parameter these lanes need is
    // already in hand. This is also why a service lane works on a pairing that
    // never received the `resolve` scope — it needs only `agents`.
    return {
      ok: true,
      scope: "service",
      origin: conn.origin,
      token: conn.token,
      label: conn.label,
      service: PRODUCT_SERVICE_ID[recognition.product],
    };
  }
  if (recognition.kind === "file") {
    // No resolve call, and none is possible: a source file is not a connector item, so
    // there is no indexed row to resolve to and no targeted fetch that could create one.
    // The gateway maps the coordinate to the reader's own checkout — this client does
    // not know their filesystem and must not guess at it.
    //
    // Placed BEFORE the resolveItem call below rather than beside it. Without this
    // branch a file page falls through and sends a forge blob URL to the ITEM resolver,
    // which typechecks, returns a miss, and is silently wrong.
    if (recognition.forgeFile === undefined) {
      // A `file` recognition without its coordinate is a recogniser bug, not a page
      // condition. Refused rather than guessed at.
      return { ok: false, reason: "not_resolved" };
    }
    return {
      ok: true,
      scope: "file",
      origin: conn.origin,
      token: conn.token,
      label: conn.label,
      service: PRODUCT_SERVICE_ID[recognition.product],
      repo: recognition.forgeFile.repo,
      refAndPath: recognition.forgeFile.refAndPath,
    };
  }
  const resolved = await deps.resolveItem(conn.origin, conn.token, recognition.resolveUrl);
  if (!resolved.ok) {
    return resolved.scopeGap === undefined
      ? { ok: false, reason: resolved.reason }
      : {
          ok: false,
          reason: resolved.reason,
          scopeGap: { label: conn.label, ...resolved.scopeGap },
        };
  }
  // The picked-candidate path (C2.5). An ambiguous page is the one case where the
  // user has told the panel something it could not work out for itself, and
  // before this the answer was thrown away one control later: the panel would
  // send `agent-run`, this function would re-resolve, get `ambiguous` a second
  // time, and refuse — putting "couldn't pin this page to one indexed item" under
  // a header naming the item the user had just picked.
  //
  // The id is honoured ONLY if it appears in the candidate set THIS resolve
  // produced. It arrives from a content script, so an id the gateway never
  // offered is refused exactly like any other unverified cross-boundary value —
  // and re-checking against a fresh resolve costs nothing here, because the
  // resolve had to happen anyway to reach this line.
  if (resolved.outcome.kind === "ambiguous" && req.itemId !== undefined) {
    const picked = resolved.outcome.candidates.find((c) => c.id === req.itemId);
    if (picked === undefined) {
      return { ok: false, reason: "not_resolved" };
    }
    return {
      ok: true,
      scope: "item",
      origin: conn.origin,
      token: conn.token,
      label: conn.label,
      resolveUrl: recognition.resolveUrl,
      item: picked,
      surface: recognition.kind,
    };
  }
  if (resolved.outcome.kind !== "found") {
    // A miss (not-indexed / unresolvable / ambiguous with nothing picked) means
    // there is no single item to ask about — refuse rather than guess.
    return { ok: false, reason: "not_resolved" };
  }
  return {
    ok: true,
    scope: "item",
    origin: conn.origin,
    token: conn.token,
    label: conn.label,
    resolveUrl: recognition.resolveUrl,
    item: resolved.outcome.item,
    surface: recognition.kind,
  };
}

/**
 * The gateway validates this body verbatim, so each agent gets exactly what it
 * accepts: `impact` takes the page's PR URL; `expert` on a pull request free text
 * to match against indexed titles (the repo name would parse too, but answers a
 * broader question — the same people for every PR in the repo); `why` on a pull
 * request the same page PR URL as `impact`, under the param name its `prUrl` arm
 * declares; `why`, `expert` and `ownership` on an issue or an incident the page
 * URL under `itemUrl`, upstream's `requireUrlArm`; and `catchup`, `decisions` and
 * `ownership` on a dashboard the connector id alone.
 *
 * No `sinceMs`, `minConfidence` or `limit` is sent. The gateway owns those
 * defaults and re-reads its config per call, so a client-side knob would only
 * be a second place for the same number to disagree.
 */
/** The param shapes `agentParams` actually produces — one per lane family
 *  (service, term, file, and the four item-scope shapes below). Giving the
 *  function this as an explicit return type, instead of `unknown`, is what
 *  makes the switch's exhaustiveness a compile error rather than a runtime
 *  backstop: see the comment on the switch below. */
type AgentParams =
  | { service: string }
  | { term: string }
  | { fileOrPrUrl: string }
  | { prUrl: string }
  | { topicOrFile: string }
  /** `why` / `expert` / `ownership`'s item arm, upstream `requireUrlArm`. Mutually
   *  exclusive with `prUrl`, `topicOrFile` and `service` — sending two is a -32602. */
  | { itemUrl: string }
  /** The forge coordinate, unsplit — `requireFileParam`'s forge arm upstream. */
  | { service: string; repo: string; refAndPath: string };

function agentParams(lane: AgentLane, resolved: ResolveForAgent & { ok: true }): AgentParams {
  if (resolved.scope === "service") {
    return { service: resolved.service };
  }
  if (resolved.scope === "file") {
    // Straight through, unsplit. The gateway maps this to the reader's own checkout
    // (`resolveFileByRemote`); splitting the ref from the path here is impossible
    // without the repository's branch list, and inventing a local path is not this
    // client's business.
    //
    // Every lane on a `file` surface takes the same shape, so this returns before the
    // per-lane switch below rather than adding five identical cases to it.
    return {
      service: resolved.service,
      repo: resolved.repo,
      refAndPath: resolved.refAndPath,
    };
  }
  if (resolved.scope === "term") {
    // `{ term }` and nothing else. `agents.glossary` also accepts `limit`, and
    // omitting it follows the same rule as the lanes above: the gateway owns its
    // defaults and re-reads config per call, so a client-side knob would only be
    // a second place for the same number to disagree.
    return { term: resolved.term };
  }
  // `resolved.scope === "item"` from here. Switched over the lane, and — for the
  // three lanes that answer on more than one surface — over the surface too. The
  // previous shape's fallthrough handed `expert`'s `topicOrFile` to whatever lane
  // was not `impact` or `why`, which was correct only by coincidence; this is the
  // case it was coincidental about.
  //
  // There is deliberately no `default` arm. `AgentParams` does not include
  // `undefined`, so a missing case is a compile error (TS2366) rather than a
  // runtime `never` assertion — the exhaustiveness check lives in the return type.
  // Do not "helpfully" add a `default:` back.
  // `needsItemArm` (agents-capability.ts), NOT a second surface list written out
  // here. It is the same predicate `offeredLanes` gates the floor on, and the two
  // must agree by construction: a pair floored there and sent `prUrl` here would
  // withhold a lane on one gateway and send the wrong arm on another.
  const itemArm = needsItemArm(lane, resolved.surface);
  switch (lane) {
    case "impact":
      // Never widened past `pr` (`LANE_RULES`): its non-PR arm answers about a
      // FILE, not an item, so an issue URL would be the wrong question.
      return { fileOrPrUrl: resolved.resolveUrl };
    case "why":
      return itemArm ? { itemUrl: resolved.resolveUrl } : { prUrl: resolved.resolveUrl };
    case "ownership":
      // Unreachable on `pr` — `LANE_RULES` gives ownership `home`, `issue` and
      // `incident` only, and `home` returns at the `service` branch far above.
      return { itemUrl: resolved.resolveUrl };
    case "glossary":
    case "catchup":
    case "decisions":
    case "expert":
      // Two facts, one case.
      //
      // `glossary`, `catchup` and `decisions` are unreachable here:
      // `LANE_RULES[lane].input` routes `glossary` to `resolveTermLane` (scope
      // `"term"`) and the two remaining service lanes to the `kind === "home"`
      // branch (scope `"service"`) above, so `resolveForAgent` never returns
      // `scope: "item"` for any of them. They are grouped onto `expert`'s
      // REACHABLE case rather than given a dead one of their own — the value they
      // would need if one ever did land here is the one `expert` returns, and a
      // case of their own would be a permanently-uncovered line under a new-code
      // coverage gate. The grouping does not weaken the exhaustiveness proof: a
      // real new item-scope lane still needs its own case, or its name is left
      // unhandled and the switch stops being exhaustive.
      //
      // `expert` itself: on `pr` this stays `topicOrFile`, and that is a deliberate
      // hold rather than an oversight. Switching it would make `expert`/`pr` an
      // item-arm pair, and the version floor would then withhold from every gateway
      // that does not yet publish a version a lane that works today. The title arm
      // answers a broader question than the label promises; trading a working lane
      // for a sharper one is a change to make once the floor is commonly met, not
      // at its introduction. On an `issue` or an `incident` there is no such
      // history to protect, so those take the item arm.
      return itemArm ? { itemUrl: resolved.resolveUrl } : { topicOrFile: resolved.item.title };
  }
}

/** The cache key for a lane: the item, the service, or the term it is about. */
function subjectFor(resolved: ResolveForAgent & { ok: true }): RunSubject {
  if (resolved.scope === "service") {
    return { kind: "service", service: resolved.service };
  }
  if (resolved.scope === "term") {
    return { kind: "term", term: resolved.term };
  }
  if (resolved.scope === "file") {
    return { kind: "file", repo: resolved.repo, refAndPath: resolved.refAndPath };
  }
  return { kind: "item", id: resolved.item.id };
}

/** Build the response for a `failed` lane, attaching the scope gap only when
 *  one is present — never a fabricated one. */
function failedResponse(
  lane: AgentLane,
  reason: AgentError,
  scopeGap?: ScopeGap,
): AgentStateResponse {
  const state: LaneState =
    scopeGap === undefined ? { kind: "failed", reason } : { kind: "failed", reason, scopeGap };
  return { kind: "agent-state", lane, state };
}

/**
 * Expand a lane: resolve the page first (the item id keys the cache, the title
 * feeds `expert`), return any cached NON-`collapsed` state without invoking —
 * re-invoking a `running` or `done` lane would be a second agent run and, on a
 * gateway with an LLM configured, a second model call for one question — then
 * invoke and persist `{kind:"running", runId}`.
 */
export async function handleAgentRun(
  deps: AgentRunDeps,
  req: AgentRunRequest,
): Promise<AgentStateResponse> {
  const resolved = await resolveForAgent(deps, req);
  if (!resolved.ok) {
    return failedResponse(req.lane, resolved.reason, resolved.scopeGap);
  }

  const subject = subjectFor(resolved);
  const cached = await deps.getRun(subject, req.lane);
  // Only `running` and `done` short-circuit. A `failed` state is not an answer, and
  // `agent-run` only arrives from an explicit user action — expanding a lane or
  // pressing Re-run — so re-asking is what the user just asked for. It also self-heals:
  // the moment they grant the missing scope, the next expand succeeds instead of
  // replaying a stale 403 for the rest of the TTL.
  if (cached !== null && (cached.state.kind === "running" || cached.state.kind === "done")) {
    return { kind: "agent-state", lane: req.lane, state: cached.state };
  }

  const params = agentParams(req.lane, resolved);
  const invoked = await invokeWithRetry(deps, resolved.origin, resolved.token, req.lane, params);
  if (!invoked.ok) {
    const scopeGap =
      invoked.scopeGap === undefined ? undefined : { label: resolved.label, ...invoked.scopeGap };
    return failedResponse(req.lane, invoked.reason, scopeGap);
  }
  const state = { kind: "running" as const, runId: invoked.runId };
  await deps.putRun({ subject, lane: req.lane, runId: invoked.runId, state });
  return { kind: "agent-state", lane: req.lane, state };
}

/** Poll a lane's current state. Read-only: never invokes, so it is safe to call
 *  on the panel's own ~1s repaint cadence without spending a run slot. */
export async function handleAgentState(
  deps: AgentStateDeps,
  req: AgentStateRequest,
): Promise<AgentStateResponse> {
  const resolved = await resolveForAgent(deps, req);
  if (!resolved.ok) {
    return failedResponse(req.lane, resolved.reason, resolved.scopeGap);
  }
  const cached = await deps.getRun(subjectFor(resolved), req.lane);
  return { kind: "agent-state", lane: req.lane, state: cached?.state ?? { kind: "collapsed" } };
}

export interface QueueListDeps {
  readonly getQueue: () => Promise<QueuedClip[]>;
}

export async function handleQueueList(deps: QueueListDeps): Promise<QueueResponse> {
  const q = await deps.getQueue();
  return { kind: "queue", items: q.map(toView) };
}

export interface QueueRetryDeps {
  readonly flush: (opts: { url?: string; manual: boolean }) => Promise<void>;
  readonly getQueue: () => Promise<QueuedClip[]>;
}

export async function handleQueueRetry(
  deps: QueueRetryDeps,
  req: QueueRetryRequest,
): Promise<QueueResponse> {
  await deps.flush({ ...(req.url !== undefined ? { url: req.url } : {}), manual: true });
  const q = await deps.getQueue();
  return { kind: "queue", items: q.map(toView) };
}

export interface QueueRemoveDeps {
  readonly updateQueue: (mutator: (q: QueuedClip[]) => QueuedClip[]) => Promise<QueuedClip[]>;
}

export async function handleQueueRemove(
  deps: QueueRemoveDeps,
  req: QueueRemoveRequest,
): Promise<QueueResponse> {
  const q = await deps.updateQueue((qq) => removeFromQueue(qq, req.url));
  return { kind: "queue", items: q.map(toView) };
}

export interface ConnectionStatusDeps {
  readonly getConnection: () => Promise<Connection | null>;
  readonly getQueueDepth: () => Promise<number>;
  readonly probeReachable: (origin: string) => Promise<boolean>;
}

export async function handleConnectionStatus(
  deps: ConnectionStatusDeps,
): Promise<ConnectionResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    // No probe and no queue read: there is no origin to probe, and an unpaired
    // browser has nothing to report. Doing the work anyway would put a network
    // call behind opening Options on a fresh install.
    return { kind: "connection", paired: false };
  }
  const [queueDepth, reachable] = await Promise.all([
    deps.getQueueDepth(),
    deps.probeReachable(conn.origin),
  ]);
  // Explicit field-by-field projection — the token is deliberately omitted so it
  // never crosses the messaging boundary into the Options page.
  return {
    kind: "connection",
    paired: true,
    label: conn.label,
    origin: conn.origin,
    pairedAt: conn.pairedAt,
    ...(conn.lastClipAt === undefined ? {} : { lastClipAt: conn.lastClipAt }),
    queueDepth,
    reachable,
    stale: conn.stale === true,
  };
}

export interface DiscoverDeps {
  readonly probeReachable: (origin: string) => Promise<boolean>;
}

/**
 * Probe the candidates IN ORDER and stop at the first hit.
 *
 * Sequential on purpose — see the design spec. Concurrent probing would always
 * dial a candidate we expect to fail, and needs a tiebreak between two routes to
 * the same gateway that buys nothing.
 */
export async function handleDiscover(deps: DiscoverDeps): Promise<DiscoverResponse> {
  const results: ProbeResult[] = [];
  for (const origin of DISCOVERY_CANDIDATES) {
    // One candidate's failure must never cost the next candidate its turn.
    // `probeHealth` does not throw today, but the guard belongs HERE rather than
    // in the probe: this loop's contract is "try each candidate", and it should
    // hold for any probe implementation, including a future one that throws.
    const reachable = await deps.probeReachable(origin).catch(() => false);
    results.push({ origin, reachable });
    if (reachable) {
      break;
    }
  }
  return { kind: "discover", origin: pickReachable(results) };
}

export interface UnpairDeps {
  readonly clearConnection: () => Promise<void>;
  /** Cached briefs belong to the gateway that produced them — see clearRuns. */
  readonly clearRuns: () => Promise<void>;
}

export async function handleUnpair(deps: UnpairDeps): Promise<ConnectionResponse> {
  await deps.clearConnection();
  await deps.clearRuns();
  return { kind: "connection", paired: false };
}
