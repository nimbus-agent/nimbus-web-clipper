import { buildClipPayload } from "../shared/clip.ts";
import { isLoopbackOrigin } from "../shared/gateway.ts";
import type {
  AgentRunRequest,
  AgentStateRequest,
  AgentStateResponse,
  ClipRequest,
  ClipResponse,
  ConnectionResponse,
  FetchRequest,
  FetchResponse,
  PairRequest,
  PairResponse,
  QueueRemoveRequest,
  QueueResponse,
  QueueRetryRequest,
  RelatedRequest,
  RelatedResponse,
  ResolveRequest,
  ResolveResponse,
} from "../shared/messages.ts";
import { enqueue, type QueuedClip, removeFromQueue, toView } from "../shared/queue.ts";
import { recognise } from "../shared/recognise.ts";
import { buildRelatedQuery, type RelatedQuery } from "../shared/related.ts";
import type {
  AgentError,
  AgentLane,
  ClipPostResult,
  ConfiguredOrigin,
  Connection,
  FetchError,
  FetchOutcome,
  PairError,
  RelatedError,
  RelatedHit,
  ResolvedItem,
  ResolveError,
  ResolveOutcome,
} from "../shared/types.ts";
import type { StoredRun } from "./agent-run-store.ts";

export interface PairDeps {
  readonly confirmPair: (
    origin: string,
    code: string,
  ) => Promise<{ ok: true; token: string; label: string } | { ok: false; reason: PairError }>;
  readonly setConnection: (c: Connection) => Promise<void>;
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

export interface ResolveDeps {
  readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]>;
  readonly getConnection: () => Promise<{ origin: string; token: string; label: string } | null>;
  readonly resolveItem: (
    origin: string,
    token: string,
    pageUrl: string,
  ) => Promise<
    | { ok: true; outcome: ResolveOutcome }
    | { ok: false; reason: ResolveError; scopeGap?: { required: string; granted: string[] } }
  >;
}

/**
 * Recognise the page, then resolve it to at most one indexed item.
 *
 * The recognition rides on BOTH arms of the response on purpose: a gateway
 * failure must not erase the fact that we know what page this is, or the panel
 * would drop back to "unrecognised" the moment the gateway hiccups.
 */
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
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "resolve", ok: false, recognition, reason: "not_paired" };
  }
  const r = await deps.resolveItem(conn.origin, conn.token, recognition.resolveUrl);
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
  return { kind: "resolve", ok: true, recognition, outcome: r.outcome };
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

/** The result of a call to `invokeAgent`, without the wire's `busy` reason — the
 *  retry loop below absorbs `busy` and never lets it escape as a lane state. */
type InvokeResult =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly reason: AgentError };

export interface AgentRunDeps {
  readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]>;
  readonly getConnection: () => Promise<{ origin: string; token: string } | null>;
  readonly resolveItem: (
    origin: string,
    token: string,
    pageUrl: string,
  ) => Promise<
    | { ok: true; outcome: ResolveOutcome }
    | { ok: false; reason: ResolveError; scopeGap?: { required: string; granted: string[] } }
  >;
  readonly invokeAgent: (
    origin: string,
    token: string,
    agent: AgentLane,
    params: unknown,
  ) => Promise<
    | { ok: true; runId: string }
    | { ok: false; reason: AgentError; scopeGap?: { required: string; granted: string[] } }
    | { ok: false; reason: "busy"; retryAfterMs: number }
  >;
  readonly getRun: (itemId: string, lane: AgentLane) => Promise<StoredRun | null>;
  readonly putRun: (run: Omit<StoredRun, "expiresAtMs">) => Promise<void>;
}

export interface AgentStateDeps {
  readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]>;
  readonly getConnection: () => Promise<{ origin: string; token: string } | null>;
  readonly resolveItem: AgentRunDeps["resolveItem"];
  readonly getRun: (itemId: string, lane: AgentLane) => Promise<StoredRun | null>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `busy` (429) is a normal, brief condition — upstream sizes `Retry-After` at one
 * second because a run slot frees when a run FINISHES, in seconds. So this backs
 * off by exactly that long and retries ONCE. A second `busy` within that window
 * means genuine contention, not something a longer wait would fix, and the lane's
 * own re-run affordance covers it from here — so it reports `server_error` rather
 * than backing off again or surfacing `busy` (which is not a member of AgentError).
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
  return second.ok ? second : { ok: false, reason: "server_error" };
}

type ResolveForAgent =
  | {
      readonly ok: true;
      readonly origin: string;
      readonly token: string;
      /** The URL sent to `resolve` — the same one `impact` is given. */
      readonly resolveUrl: string;
      readonly item: ResolvedItem;
    }
  | { readonly ok: false; readonly reason: AgentError };

/**
 * Recognise the page, then resolve it to at most one indexed item — exactly the
 * shared prefix `handleAgentRun` and `handleAgentState` both need: the recogniser
 * gate (no gateway call for a page we cannot classify) and the item id a lane is
 * cached under.
 *
 * There is no `AgentError` member for "recognised but no single item" — a
 * resolve miss and an unrecognised page both settle on `unsupported`: retrying
 * cannot help either one, only visiting an indexed page can.
 */
async function resolveForAgent(
  deps: Pick<AgentStateDeps, "getOrigins" | "getConnection" | "resolveItem">,
  pageUrl: string,
): Promise<ResolveForAgent> {
  const recognition = recognise(pageUrl, await deps.getOrigins());
  if (!recognition.ok) {
    // Nothing to ask the gateway about — the recogniser is the boundary deciding
    // which URLs may reach it at all. No resolve call, no invoke.
    return { ok: false, reason: "unsupported" };
  }
  const conn = await deps.getConnection();
  if (conn === null) {
    return { ok: false, reason: "not_paired" };
  }
  const resolved = await deps.resolveItem(conn.origin, conn.token, recognition.resolveUrl);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }
  if (resolved.outcome.kind !== "found") {
    // A miss (not-indexed / unresolvable / ambiguous) means there is no single
    // item to ask about — refuse rather than guess.
    return { ok: false, reason: "unsupported" };
  }
  return {
    ok: true,
    origin: conn.origin,
    token: conn.token,
    resolveUrl: recognition.resolveUrl,
    item: resolved.outcome.item,
  };
}

/** The gateway validates this body verbatim, so each agent gets exactly what it
 *  accepts: `impact` takes the page's PR URL, `expert` free text to match
 *  against indexed titles (the repo name would parse too, but answers a
 *  broader question — the same people for every PR in the repo). */
function agentParams(lane: AgentLane, resolveUrl: string, item: ResolvedItem): unknown {
  return lane === "impact" ? { fileOrPrUrl: resolveUrl } : { topicOrFile: item.title };
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
  const resolved = await resolveForAgent(deps, req.pageUrl);
  if (!resolved.ok) {
    return {
      kind: "agent-state",
      lane: req.lane,
      state: { kind: "failed", reason: resolved.reason },
    };
  }
  const { origin, token, resolveUrl, item } = resolved;

  const cached = await deps.getRun(item.id, req.lane);
  if (cached !== null && cached.state.kind !== "collapsed") {
    return { kind: "agent-state", lane: req.lane, state: cached.state };
  }

  const params = agentParams(req.lane, resolveUrl, item);
  const invoked = await invokeWithRetry(deps, origin, token, req.lane, params);
  if (!invoked.ok) {
    return {
      kind: "agent-state",
      lane: req.lane,
      state: { kind: "failed", reason: invoked.reason },
    };
  }
  const state = { kind: "running" as const, runId: invoked.runId };
  await deps.putRun({ itemId: item.id, lane: req.lane, runId: invoked.runId, state });
  return { kind: "agent-state", lane: req.lane, state };
}

/** Poll a lane's current state. Read-only: never invokes, so it is safe to call
 *  on the panel's own ~1s repaint cadence without spending a run slot. */
export async function handleAgentState(
  deps: AgentStateDeps,
  req: AgentStateRequest,
): Promise<AgentStateResponse> {
  const resolved = await resolveForAgent(deps, req.pageUrl);
  if (!resolved.ok) {
    return {
      kind: "agent-state",
      lane: req.lane,
      state: { kind: "failed", reason: resolved.reason },
    };
  }
  const cached = await deps.getRun(resolved.item.id, req.lane);
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
}

export async function handleConnectionStatus(
  deps: ConnectionStatusDeps,
): Promise<ConnectionResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "connection", paired: false };
  }
  // Explicit field-by-field projection — the token is deliberately omitted so it
  // never crosses the messaging boundary into the Options page.
  return {
    kind: "connection",
    paired: true,
    label: conn.label,
    origin: conn.origin,
    pairedAt: conn.pairedAt,
  };
}

export interface UnpairDeps {
  readonly clearConnection: () => Promise<void>;
}

export async function handleUnpair(deps: UnpairDeps): Promise<ConnectionResponse> {
  await deps.clearConnection();
  return { kind: "connection", paired: false };
}
