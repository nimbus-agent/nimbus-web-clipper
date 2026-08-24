// MV3 background service worker / Firefox event page. Owns the bearer token and all
// gateway I/O; the popup, options page, and injected panel reach it via messages. It
// also owns the offline retry queue: it drains on a chrome.alarms tick (the alarm is
// live only while the queue is non-empty), on startup, and on popup retries, and it
// keeps the toolbar badge in sync with the pending count.
import { setBadgeBackground, setBadgeCount, setBadgeText } from "../browser/action.ts";
import { addAlarmListener, clearAlarm, ensureAlarm, rearmAlarm } from "../browser/alarms.ts";
import { addCommandListener } from "../browser/commands.ts";
import { addMenuClickListener, createMenu, removeAllMenus } from "../browser/context-menus.ts";
import { hasOrigin } from "../browser/permissions.ts";
import { addInstalledListener, addMessageListener } from "../browser/runtime.ts";
import {
  deliverSelection,
  injectPanel,
  runCapture,
  showCue,
  showToast,
} from "../browser/scripting.ts";
import {
  activeTab,
  addNavigationListener,
  addTabClosedListener,
  listCandidateTabs,
  type TabNavigation,
  tabUrl,
} from "../browser/tabs.ts";
import {
  isAgentRunRequest,
  isAgentStateRequest,
  isBriefStartRequest,
  isCaptureRequest,
  isClipRequest,
  isConnectionStatusRequest,
  isCueOpenRequest,
  isDiscoverRequest,
  isEgressProveRequest,
  isEgressVerifyRequest,
  isEgressWindowRequest,
  isFetchRequest,
  isPairRequest,
  isPassageClearRequest,
  isPassageDropRequest,
  isQueueListRequest,
  isQueueRemoveRequest,
  isQueueRetryRequest,
  isRecogniseRequest,
  isRelatedRequest,
  isResolveRequest,
  isUnpairRequest,
} from "../shared/messages.ts";
import { removeGroup, removePassage } from "../shared/passage.ts";
import type { AgentError, AgentLane, LaneState, Recognition } from "../shared/types.ts";
import {
  AGENT_RUN_CACHE_TTL_MS,
  clearRuns,
  type RunSubject,
  type StoredRun,
  getRun as storeGetRun,
  listRunning as storeListRunning,
  putRun as storePutRun,
} from "./agent-run-store.ts";
import { type AmbientDeps, decideAmbient } from "./ambient.ts";
import { getAmbientHosts } from "./ambient-prefs.ts";
import { createBrief, feedBriefSource, getBrief, runBrief, saveBrief } from "./brief-client.ts";
import {
  type BriefDeps,
  type BriefState,
  handleBriefPoll,
  handleBriefSave,
  handleBriefStart,
  handleBriefTabs,
} from "./brief-handlers.ts";
import { appendLogEntry, clearLog, readLog, updateLogEntry } from "./brief-log-store.ts";
import { clearBriefRuns, getBriefRun, listBriefRuns, putBriefRun } from "./brief-run-store.ts";
import { captureTab } from "./capture-tab.ts";
import { getQueue, updateQueue } from "./clip-queue-store.ts";
import {
  clearConnection,
  getConnection,
  markClipSuccess,
  markStale,
  setConnection,
} from "./connection-store.ts";
import { listEgress, proveEgressWindow, verifyEgress } from "./egress-client.ts";
import {
  type EgressDeps,
  handleEgressProve,
  handleEgressVerify,
  handleEgressWindow,
} from "./egress-handlers.ts";
import { showFeedback } from "./feedback.ts";
import {
  confirmPair,
  fetchItem,
  getAgentRun,
  invokeAgent,
  postClip,
  postRelated,
  probeHealth,
  resolveItem,
} from "./gateway-client.ts";
import {
  handleAgentRun,
  handleAgentState,
  handleCapture,
  handleClip,
  handleConnectionStatus,
  handleDiscover,
  handleFetch,
  handlePair,
  handleQueueList,
  handleQueueRemove,
  handleQueueRetry,
  handleRecognise,
  handleRelated,
  handleResolve,
  handleUnpair,
} from "./handlers.ts";
import { menuAction, registerMenus } from "./menus.ts";
import { getOrigins } from "./origin-store.ts";
import { collectPassage, type PassageCollectDeps } from "./passage-collect.ts";
import { getPassages, updatePassages } from "./passage-store.ts";
import { isPreviewEnabled } from "./preview-pref.ts";
import { type FlushDeps, flushQueue } from "./queue-flush.ts";
import { type QuickClipDeps, quickClip } from "./quick-clip.ts";
import { clearPause, getPauseUntil, setPauseUntil } from "./rate-limit-pause.ts";
import { singleFlight } from "./single-flight.ts";

const FLUSH_ALARM = "flush-clip-queue";

/**
 * The EVICTION NET, not the poll cadence.
 *
 * `chrome.alarms` has a ONE-MINUTE floor and agent runs finish in SECONDS, so an
 * alarm-driven poll would turn a two-second answer into a sixty-second wait. The
 * real cadence is the in-worker timer below, which runs while the worker is alive.
 * This alarm exists only so a run whose worker was evicted mid-flight is still
 * picked up and completed.
 */
export const AGENT_POLL_ALARM = "nimbus-agent-poll";
const POLL_START_MS = 500;
const POLL_MAX_MS = 2_000;

// The one place the rate-limit pause is written — and, for the same reason, the
// one place `stale` is set for EVERY clip path. Wrapping this seam — rather than
// threading a dependency through handleClip and flushQueue — keeps both of those
// pure and means a 429 or a 401 from ANY path (interactive clip, quick-clip, or
// the queue drain) is handled once. `clipDeps` and `flushDeps` both go through
// this single function, which is what makes it the right seam: the message
// router's `respond` wrap (below) catches only the routes it fronts — the panel
// lanes — and never sees quick-clip or the background drain at all. A storage
// failure here must never fail the clip itself.
const postClipPaced: FlushDeps["postClip"] = async (origin, token, payload) => {
  const r = await postClip(origin, token, payload);
  if (r.ok) {
    await endPause().catch(() => undefined);
  } else if (r.reason === "rate_limited") {
    await setPauseUntil(Date.now() + (r.retryAfterMs ?? 60_000)).catch(() => undefined);
  } else if (r.reason === "unauthorized") {
    await markStale().catch(() => undefined);
  }
  return r;
};

// Clearing the stored pause is not enough on its own: the flush alarm is still on
// the delayed schedule armed for that pause, and ensureAlarm deliberately won't
// touch an alarm that already exists. Drop it on the transition so the next
// syncQueueState re-creates the plain periodic one.
async function endPause(): Promise<void> {
  if (await clearPause()) {
    await clearAlarm(FLUSH_ALARM);
  }
}

const flushDeps = {
  getConnection,
  getQueue,
  updateQueue,
  postClip: postClipPaced,
  pausedUntilMs: getPauseUntil,
  nowMs: () => Date.now(),
};

// Background drains (the periodic alarm and the cold-start drain) can fire together on
// a fresh wake; coalescing them through one in-flight guard stops the same clips being
// POSTed twice. The popup retry path stays direct — it is user-initiated and may carry
// a specific url / manual flag, and its writes are already serialized by updateQueue.
const backgroundFlush = singleFlight(() => flushQueue(flushDeps).then(syncQueueState));

// Reconcile the toolbar badge and the flush alarm with the current queue length:
// the alarm exists only while there is work to do (no idle wakeups). While a
// rate-limit pause is active the alarm is re-armed to fire at the gateway's own
// reset time instead of an arbitrary point in the fixed one-minute cadence.
//
// Invariant: the pause gate in flushQueue is the AUTHORITY; this alarm is only a
// wakeup hint. Concurrent callers can therefore race here harmlessly — an alarm
// armed from slightly stale state at worst fires early, and the gate no-ops it.
// (While paused, the re-armed delay also shrinks monotonically, so repeated calls
// cannot push the alarm out indefinitely.)
async function syncQueueState(): Promise<void> {
  const n = (await getQueue()).length;
  await setBadgeCount(n);
  if (n === 0) {
    await clearAlarm(FLUSH_ALARM);
    return;
  }
  const remainingMs = (await getPauseUntil()) - Date.now();
  if (remainingMs > 0) {
    // Chrome honours a 30s floor (values under 0.5 are ignored and warn), so a
    // shorter Retry-After rounds up. An early or late tick is harmless — the pause
    // gate in flushQueue no-ops it.
    rearmAlarm(FLUSH_ALARM, Math.max(0.5, remainingMs / 60_000), 1);
    return;
  }
  await ensureAlarm(FLUSH_ALARM, 1);
}

// One clip pipeline for both entry points: the popup's `clip` message and the
// quick-clip (context menu / hotkey) route go through the same handler deps.
const clipDeps = { getConnection, postClip: postClipPaced, updateQueue, nowMs: () => Date.now() };

// The pure handlers work with a domain-shaped run (no `expiresAtMs`); this is the
// one place "now" is read and the TTL applied, mirroring how postClipPaced wraps
// postClip with the side effects handleClip itself stays free of.
const agentStoreDeps = {
  getRun: (subject: RunSubject, lane: AgentLane) => storeGetRun(subject, lane, Date.now()),
};

const agentRunDeps = {
  getOrigins,
  getConnection,
  resolveItem,
  invokeAgent,
  ...agentStoreDeps,
  // Persisting a `running` state is also the ONE place a run starts being polled:
  // wrapping the seam here (rather than threading a "start polling" call through
  // handleAgentRun) keeps the pure handler free of the side effect, exactly as
  // postClipPaced wraps postClip above.
  putRun: async (run: Omit<StoredRun, "expiresAtMs">): Promise<void> => {
    const stored: StoredRun = { ...run, expiresAtMs: Date.now() + AGENT_RUN_CACHE_TTL_MS };
    await storePutRun(stored, Date.now());
    if (stored.state.kind === "running") {
      await ensureAlarm(AGENT_POLL_ALARM, 1).catch(() => undefined);
      startAgentPollLoop(stored);
    }
  },
};

const agentStateDeps = { getOrigins, getConnection, resolveItem, ...agentStoreDeps };

// Runs currently being polled by an in-worker loop, keyed by runId. Lets the
// alarm's resume skip a run already being handled locally: unlike the eviction
// case the alarm exists for, Chrome fires a periodic alarm whether or not the
// worker was actually evicted, so without this guard every minute-tick would
// spawn a second, uncoordinated backoff loop for the same still-running run.
// A fresh worker start (real eviction, or this module reloading in tests) means
// an empty Set — exactly the case the alarm needs to be ABLE to resume into.
const activeAgentPolls = new Set<string>();

/**
 * Bumped whenever the pairing changes (a successful pair, or unpair) — see
 * `clearRunsAndBumpGeneration` below, the one place this is incremented.
 *
 * Defends against a poll outliving the pairing it started under: `clearRuns()`
 * empties the store, but a `tickAgentPoll` already awaiting `getConnection` or
 * `getAgentRun` completes AFTER that clear and would otherwise `putRun` a brief
 * from the gateway the browser has just left, silently repopulating the store
 * `clearRuns` just emptied. A poll captures this counter when it starts and
 * re-checks it after every await; a mismatch means the pairing moved on under
 * it, so it drops the run from `activeAgentPolls` and writes nothing — not even
 * a terminal `failed` state, which would be exactly the same kind of write this
 * exists to stop.
 *
 * Deliberately a plain module-level integer, not a new abstraction — the
 * simplest thing that lets a poll tell "my pairing" from "the current one".
 */
let pairingGeneration = 0;

/**
 * The wire's `failed` status is a NORMAL terminal outcome — the transport
 * worked and the gateway is healthy, the agent itself just could not produce
 * an answer — so it maps to `agent_failed`, never `server_error` (that reason
 * is reserved for a genuinely failed CALL). `failureReason` is the gateway's
 * own free-text explanation of why, and is OPTIONAL on the wire (upstream
 * omits the key entirely rather than sending an empty one); carried through as
 * `detail` when it is present and non-blank, omitted (never `detail:
 * undefined`) otherwise. `scopeGap`, when present, needs the device label
 * attached — only `service-worker.ts` holds a `Connection`, mirroring how
 * `handlers.ts` attaches it elsewhere.
 */
function terminalLaneState(
  result:
    | { readonly ok: true; readonly status: "done"; readonly brief: string }
    | { readonly ok: true; readonly status: "failed"; readonly failureReason?: string }
    | {
        readonly ok: false;
        readonly reason: AgentError;
        readonly scopeGap?: { readonly required: string; readonly granted: string[] };
      },
  label: string,
): LaneState {
  if (result.ok) {
    if (result.status === "done") {
      return { kind: "done", brief: result.brief };
    }
    return result.failureReason === undefined || result.failureReason.trim() === ""
      ? { kind: "failed", reason: "agent_failed" }
      : { kind: "failed", reason: "agent_failed", detail: result.failureReason };
  }
  return result.scopeGap === undefined
    ? { kind: "failed", reason: result.reason }
    : { kind: "failed", reason: result.reason, scopeGap: { label, ...result.scopeGap } };
}

/** The reason the loop is STILL GOING as of the last tick — i.e. what it would
 *  mean to give up right now. `"running"` covers both "never polled yet" and
 *  "the gateway keeps saying running": either way, hitting expiry with no
 *  failure ever observed means the run outlived its own TTL, and `stale` is
 *  the honest answer (re-issue is exactly what `stale` means). A transient
 *  `unreachable`/`server_error` carries forward as itself, so giving up at
 *  expiry reports the failure actually observed, not an invented one. */
type PollContinueReason = "running" | "unreachable" | "server_error";

/** True once `pairingGeneration` has moved on from the value a poll captured
 *  when it started — see that counter's own doc comment. */
function pairingChangedSince(generation: number): boolean {
  return generation !== pairingGeneration;
}

/**
 * One poll attempt, right now (no delay). `running` and a transient
 * `unreachable`/`server_error` both reschedule via `scheduleAgentPoll` — the
 * run keeps its slot in `activeAgentPolls` while looping. Every other outcome
 * (`done`, the wire's `failed`, or any other `AgentError` — `unauthorized`,
 * `insufficient_scope`, `stale`, …) is terminal: it is written to the store and
 * the loop stops. A `stale` result is terminal like the rest and, per the
 * `AGENT_ERRORS` doc comment, must never trigger a fresh invoke on its own —
 * only an explicit `agent-run` (a lane expand or Re-run) may do that.
 *
 * BOTH give-up paths — expiry, and no connection to poll with — persist a
 * terminal state rather than returning silently. Silently leaving `running` in
 * the store is what C2.1's "never a silent empty lane" done-when exists to
 * rule out: `handleAgentState` would keep answering the CACHED `running` state
 * until the TTL lapsed, then fall back to `collapsed` — a spinner that quietly
 * becomes an empty lane, having told the user nothing.
 */
async function tickAgentPoll(
  run: StoredRun,
  delayMs: number,
  lastReason: PollContinueReason,
  generation: number,
): Promise<void> {
  // Checked BEFORE the expiry give-up below on purpose: that path also writes
  // (a terminal `stale`/`unreachable`/`server_error` state), and a poll whose
  // pairing has moved on must not write ANYTHING — see pairingGeneration's doc
  // comment.
  if (pairingChangedSince(generation)) {
    activeAgentPolls.delete(run.runId);
    return;
  }
  if (run.expiresAtMs <= Date.now()) {
    activeAgentPolls.delete(run.runId);
    await agentRunDeps.putRun({
      subject: run.subject,
      lane: run.lane,
      runId: run.runId,
      state: { kind: "failed", reason: lastReason === "running" ? "stale" : lastReason },
    });
    return;
  }
  const conn = await getConnection();
  // Re-checked after every await in this function, not only at entry: the
  // whole point is a pairing change that happens WHILE one of these is in
  // flight.
  if (pairingChangedSince(generation)) {
    activeAgentPolls.delete(run.runId);
    return;
  }
  if (conn === null) {
    // No connection to poll with: unlike a transient gateway failure, waiting
    // it out buys nothing — only the user re-pairing can fix this, and Re-run
    // (task 6's own handlers.ts change) is exactly what lets them retry once
    // they have.
    activeAgentPolls.delete(run.runId);
    await agentRunDeps.putRun({
      subject: run.subject,
      lane: run.lane,
      runId: run.runId,
      state: { kind: "failed", reason: "not_paired" },
    });
    return;
  }
  const result = await getAgentRun(conn.origin, conn.token, run.runId);
  if (pairingChangedSince(generation)) {
    activeAgentPolls.delete(run.runId);
    return;
  }
  if (result.ok && result.status === "running") {
    scheduleAgentPoll(run, Math.min(POLL_MAX_MS, delayMs * 1.5), "running", generation);
    return;
  }
  if (!result.ok && (result.reason === "unreachable" || result.reason === "server_error")) {
    scheduleAgentPoll(run, Math.min(POLL_MAX_MS, delayMs * 1.5), result.reason, generation);
    return;
  }
  activeAgentPolls.delete(run.runId);
  await agentRunDeps.putRun({
    subject: run.subject,
    lane: run.lane,
    runId: run.runId,
    state: terminalLaneState(result, conn.label),
  });
}

/** Schedule the NEXT poll attempt after `delayMs`. Real `setTimeout`, not
 *  `chrome.alarms` — see `AGENT_POLL_ALARM`'s doc comment for why. `generation`
 *  is the pairing generation the run was started under, carried forward
 *  unchanged from tick to tick — see `pairingGeneration`'s doc comment. */
function scheduleAgentPoll(
  run: StoredRun,
  delayMs: number,
  lastReason: PollContinueReason,
  generation: number,
): void {
  setTimeout(() => {
    tickAgentPoll(run, delayMs, lastReason, generation).catch(() => {
      activeAgentPolls.delete(run.runId);
    });
  }, delayMs);
}

/** Start the in-worker loop for a freshly-persisted `running` run. Idempotent
 *  per runId via `activeAgentPolls` — see its own doc comment. Captures the
 *  CURRENT pairing generation: this run belongs to whichever pairing is live
 *  right now. */
function startAgentPollLoop(run: StoredRun): void {
  if (activeAgentPolls.has(run.runId)) {
    return;
  }
  activeAgentPolls.add(run.runId);
  scheduleAgentPoll(run, POLL_START_MS, "running", pairingGeneration);
}

/**
 * The alarm's job: pick up whatever `listRunning` says is still going — which,
 * after a real eviction, is EVERYTHING (the module-local `activeAgentPolls` was
 * wiped along with the rest of module state) — and poll each ONCE, immediately
 * (no artificial delay: we don't know how long the worker was gone). A run
 * already tracked in `activeAgentPolls` is skipped, not double-polled — see its
 * doc comment. Clears the alarm once nothing is left running, so a periodic
 * alarm does not wake the worker forever for no reason.
 */
async function resumeAgentPolls(): Promise<void> {
  const running = await storeListRunning(Date.now());
  await Promise.all(
    running
      .filter((run) => !activeAgentPolls.has(run.runId))
      .map((run) => {
        activeAgentPolls.add(run.runId);
        // Captures the CURRENT pairing generation, same as startAgentPollLoop —
        // a resumed run is tracked against whichever pairing is live right now.
        return tickAgentPoll(run, POLL_START_MS, "running", pairingGeneration).catch(() => {
          activeAgentPolls.delete(run.runId);
        });
      }),
  );
  if ((await storeListRunning(Date.now())).length === 0) {
    await clearAlarm(AGENT_POLL_ALARM).catch(() => undefined);
  }
}

/**
 * The eviction net for brief runs — NOT the poll cadence.
 *
 * Same split as {@link AGENT_POLL_ALARM}: `chrome.alarms` has a one-minute floor
 * while the live cadence is a `setTimeout` backoff, so this only resumes runs
 * whose worker died. The floor matters more here than for agent lanes, because
 * synthesis over up to 4 MB of source text can genuinely outlast a worker.
 */
export const BRIEF_POLL_ALARM = "nimbus-brief-poll";

/** Slower ceiling than the agent lanes' `POLL_MAX_MS`: synthesis over up to 4 MB
 *  of source text runs for tens of seconds, so backing off further costs nothing
 *  on loopback and saves a lot of pointless polls. */
const BRIEF_POLL_MAX_MS = 5_000;

/** Brief runs being polled by an in-worker loop, keyed by run id. Mirrors
 *  `activeAgentPolls`: without it the alarm's resume double-polls a run whose
 *  `setTimeout` loop is alive, since Chrome fires a periodic alarm whether or
 *  not the worker died. */
const activeBriefPolls = new Set<string>();

const briefDeps: BriefDeps = {
  now: () => Date.now(),
  listTabs: listCandidateTabs,
  origins: getOrigins,
  capture: (tabId, expectedUrl) =>
    captureTab({ tabUrl, runCapture }, tabId, "article", expectedUrl),
  passages: getPassages,
  // BY IDENTITY, page by page: each fed passage is dropped by the instant it was
  // captured, through the same `removePassage` the composer's per-passage remove
  // uses. Dropping the whole group would also destroy anything the user
  // collected while the run was still feeding, which never left — see
  // `FedPassages`.
  forgetPassages: async (fed) => {
    for (const { url, ats } of fed) {
      await updatePassages((all) => ({
        ok: true,
        all: ats.reduce((rest, at) => removePassage(rest, url, at), all),
      }));
    }
  },
  connection: async () => {
    const conn = await getConnection();
    return conn === null ? null : { origin: conn.origin, token: conn.token };
  },
  client: { createBrief, feedBriefSource, runBrief, getBrief, saveBrief },
  store: { get: getBriefRun, put: putBriefRun },
  log: { append: appendLogEntry, update: updateLogEntry },
  onState: (state) => {
    broadcastBriefState(state);
  },
};

/**
 * Push a state to the brief page if it is open, and keep the loop alive.
 *
 * A broadcast with no listener rejects ("Receiving end does not exist"), which
 * is the normal case with the page closed — swallowed, because the store is
 * still correct and reopening the page reads it.
 */
function broadcastBriefState(state: BriefState): void {
  chrome.runtime.sendMessage({ kind: "brief-state", state }).catch(() => undefined);
  if (state.kind === "running") {
    startBriefPollLoop(state.id);
  }
}

function scheduleBriefPoll(id: string, delayMs: number, generation: number): void {
  setTimeout(() => {
    tickBriefPoll(id, delayMs, generation).catch(() => {
      activeBriefPolls.delete(id);
    });
  }, delayMs);
}

/** One poll, then either reschedule or stop. Honours `pairingGeneration` for the
 *  same reason `tickAgentPoll` does: a poll that outlives its pairing must write
 *  nothing, not even a terminal state. */
async function tickBriefPoll(id: string, delayMs: number, generation: number): Promise<void> {
  if (pairingChangedSince(generation)) {
    activeBriefPolls.delete(id);
    return;
  }
  const state = await handleBriefPoll(briefDeps, id);
  if (pairingChangedSince(generation)) {
    activeBriefPolls.delete(id);
    return;
  }
  if (state.kind === "running") {
    scheduleBriefPoll(id, Math.min(delayMs * 2, BRIEF_POLL_MAX_MS), generation);
    return;
  }
  activeBriefPolls.delete(id);
  chrome.runtime.sendMessage({ kind: "brief-state", state }).catch(() => undefined);
  await disarmBriefAlarmIfIdle();
}

/** Start the in-worker loop for a run now `running`. Idempotent per id, and the
 *  one place the eviction net is armed. */
function startBriefPollLoop(id: string): void {
  if (activeBriefPolls.has(id)) {
    return;
  }
  activeBriefPolls.add(id);
  ensureAlarm(BRIEF_POLL_ALARM, 1).catch(() => undefined);
  scheduleBriefPoll(id, POLL_START_MS, pairingGeneration);
}

/**
 * Clear the alarm ONLY when nothing is left running.
 *
 * Clearing whenever *a* run reaches a terminal state would disarm the net for a
 * second brief still in flight — and two can overlap, since the gateway allows
 * three concurrent runs.
 */
async function disarmBriefAlarmIfIdle(): Promise<void> {
  const runs = await listBriefRuns(Date.now()).catch(() => []);
  if (runs.some((r) => r.phase.kind === "running")) {
    return;
  }
  await clearAlarm(BRIEF_POLL_ALARM).catch(() => undefined);
}

/** The alarm's job: after a real eviction `activeBriefPolls` was wiped with the
 *  rest of module state, so poll every still-running brief once, immediately. */
async function resumeBriefPolls(): Promise<void> {
  const running = (await listBriefRuns(Date.now())).filter((r) => r.phase.kind === "running");
  await Promise.all(
    running
      .filter((run) => !activeBriefPolls.has(run.id))
      .map((run) => {
        activeBriefPolls.add(run.id);
        return tickBriefPoll(run.id, POLL_START_MS, pairingGeneration).catch(() => {
          activeBriefPolls.delete(run.id);
        });
      }),
  );
  await disarmBriefAlarmIfIdle();
}

/**
 * The egress-ledger reads. No writer, deliberately — see egress-handlers.ts.
 */
const egressDeps: EgressDeps = {
  getConnection,
  listEgress,
  verifyEgress,
  proveEgressWindow,
};

/**
 * The three ledger kinds, narrowed off the raw message by prefix.
 *
 * A prefix check plus a fan-out, exactly like `isBriefMessage` below and for the
 * same reason: the router is at Sonar's cognitive-complexity cap (S3776, 15), so
 * these three kinds arrive through ONE branch and are re-narrowed by their real
 * guards inside the fan-out.
 */
type EgressMessage = { readonly kind: string };

function isEgressMessage(v: unknown): v is EgressMessage {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const kind = (v as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.startsWith("egress-");
}

async function routeEgressMessage(message: EgressMessage): Promise<unknown> {
  if (isEgressWindowRequest(message)) {
    return await handleEgressWindow(egressDeps, message);
  }
  if (isEgressVerifyRequest(message)) {
    return await handleEgressVerify(egressDeps, message);
  }
  if (isEgressProveRequest(message)) {
    return await handleEgressProve(egressDeps, message);
  }
  return { kind: message.kind, ok: false, reason: "server_error" };
}

/**
 * The six brief kinds, narrowed off the raw message.
 *
 * `id` is optional and only read by the two kinds that carry one; every other
 * field a caller might send is ignored. `brief-start`'s payload gets the real
 * guard (`isBriefStartRequest`) inside the fan-out, since it is the one that
 * drives injection.
 */
type BriefMessage = {
  readonly kind:
    | "brief-tabs"
    | "brief-start"
    | "brief-state"
    | "brief-save"
    | "brief-log"
    | "brief-log-clear";
  readonly id?: string;
};

function isBriefMessage(v: unknown): v is BriefMessage {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const kind = (v as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !kind.startsWith("brief-")) {
    return false;
  }
  const id = (v as { id?: unknown }).id;
  return id === undefined || typeof id === "string";
}

/**
 * Fan-out for the six brief message kinds.
 *
 * A separate function, not six branches in the router: that function is already
 * at fourteen branches and needed `openPanelForCue` extracted to stay under
 * Sonar's cognitive-complexity cap (S3776, 15).
 */
async function routeBriefMessage(message: BriefMessage): Promise<unknown> {
  if (message.kind === "brief-tabs") {
    return handleBriefTabs(briefDeps);
  }
  if (message.kind === "brief-start") {
    return isBriefStartRequest(message)
      ? handleBriefStart(briefDeps, message)
      : ({ kind: "failed", reason: "invalid_request" } satisfies BriefState);
  }
  if (message.kind === "brief-save") {
    const id = message.id;
    return id === undefined
      ? ({ kind: "failed", reason: "invalid_request" } satisfies BriefState)
      : handleBriefSave(briefDeps, id);
  }
  if (message.kind === "brief-log") {
    return { entries: await readLog() };
  }
  if (message.kind === "brief-log-clear") {
    await clearLog();
    return { ok: true };
  }
  if (message.kind === "brief-state") {
    const id = message.id;
    return { run: id === undefined ? null : await getBriefRun(id, Date.now()) };
  }
  return { kind: "failed", reason: "unknown_brief_message" } satisfies BriefState;
}

/**
 * The collection's two mutations, narrowed off the raw message.
 *
 * Just the `kind`: unlike `BriefMessage`'s optional `id`, nothing else here is
 * read before the real guards (`isPassageDropRequest` / `isPassageClearRequest`)
 * re-narrow inside the fan-out.
 */
type PassageMessage = {
  readonly kind: "passage-drop" | "passage-clear";
};

/**
 * Is this one of the collection's two mutations?
 *
 * A prefix check like `isBriefMessage`'s, and for the same reason: the router is
 * at Sonar's cognitive-complexity cap, so these two kinds arrive through ONE
 * branch and are re-narrowed by their real guards inside the fan-out.
 */
function isPassageMessage(v: unknown): v is PassageMessage {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const kind = (v as { kind?: unknown }).kind;
  return kind === "passage-drop" || kind === "passage-clear";
}

/**
 * Apply a collection mutation and report whether it stuck.
 *
 * Every path goes through `updatePassages`, the store's one serialized
 * read-modify-write — a menu click collecting a passage and a composer click
 * dropping one can genuinely interleave.
 */
async function routePassageMessage(message: PassageMessage): Promise<{ ok: boolean }> {
  if (isPassageDropRequest(message)) {
    const { url, at } = message;
    const res = await updatePassages((all) => ({
      ok: true,
      // No `at` means the whole page: the row's own remove, not a passage's.
      all: at === undefined ? removeGroup(all, url) : removePassage(all, url, at),
    }));
    return { ok: res.ok };
  }
  if (isPassageClearRequest(message)) {
    const res = await updatePassages(() => ({ ok: true, all: [] }));
    return { ok: res.ok };
  }
  return { ok: false };
}

const quickClipDeps: QuickClipDeps = {
  activeTab,
  runCapture,
  // The badge sync runs AFTER the response is settled, never gating it: the clip may
  // have enqueued (keep the count fresh), but a storage failure while syncing must
  // not turn a successful clip into a silent no-toast. It is still awaited (a
  // returned thenable settles `finally`) so the queue count repaints BEFORE any
  // badge flash — otherwise a late sync would erase the flash.
  clip: (req) =>
    handleClip(clipDeps, req).finally(async () => {
      await syncQueueState().catch(() => undefined);
    }),
  showFeedback: (tabId, state, restricted) =>
    showFeedback(
      { showToast, setBadgeText, restoreBadge: syncQueueState },
      tabId,
      state,
      restricted,
    ),
};

// Reuses the same `tabUrl`/`runCapture` seams `quickClipDeps.runCapture` and
// `captureTab` above already use, with "selection" and no `expectedUrl` — a
// menu click has no pinned page to be wrong about.
const passageCollectDeps: PassageCollectDeps = {
  capture: (tabId) => captureTab({ tabUrl, runCapture }, tabId, "selection"),
  update: updatePassages,
  showFeedback: (tabId, state, restricted) =>
    showFeedback(
      { showToast, setBadgeText, restoreBadge: syncQueueState },
      tabId,
      state,
      restricted,
    ),
  now: () => Date.now(),
};

// Menus are re-registered from scratch (removeAll first) so a reload/upgrade can't
// leave a duplicate id behind — chrome.contextMenus.create throws on a duplicate.
// Single-flighted because on a fresh install the startup sequence and onInstalled
// both register: interleaved removeAll/create pairs could otherwise hit a duplicate
// id and surface an unchecked runtime.lastError.
const registerContextMenus = singleFlight(
  async (): Promise<void> => await registerMenus({ removeAll: removeAllMenus, create: createMenu }),
);

// Both quick-clip routes fail closed like every other listener: the user-visible
// result is the toast/badge, and a rejection here has nowhere to be reported.
addInstalledListener(() => {
  registerContextMenus().catch(() => undefined);
});

/**
 * The ONE way the panel gets opened from INSIDE the service worker. Three
 * in-worker triggers converge here — the hotkey, the context menu's
 * `show-related` branch, and the ambient cue's `openPanelForCue` — so the
 * panel cannot behave differently depending on how it was summoned, which is
 * what C1.5 exists to prevent.
 *
 * The popup is a separate context and cannot reach this function at all — it
 * is its own bundle and calls `injectPanel` directly, then reports its own
 * failure ("Nimbus can't show related on browser system pages") rather than
 * failing silently like the callers below. So the popup's convergence with
 * this function is on *behavior*, not on a shared call site.
 *
 * A restricted page rejects injection; fail closed and silently, because there
 * is no surface to report on when the panel is the surface.
 */
function openPanel(tabId?: number): void {
  if (tabId !== undefined) {
    injectPanel(tabId).catch(() => undefined);
    return;
  }
  activeTab()
    .then((tab) => injectPanel(tab.id))
    .catch(() => undefined);
}

/**
 * The two selection entries: hand the selected text to the panel in the clicked
 * tab, opening one if none is there (`deliverSelection` is what keeps that from
 * toggling an open panel shut).
 *
 * A missing `tabId` cannot be recovered from here. Unlike `openPanel`, which
 * falls back to the active tab, a selection belongs to ONE page — delivering it
 * to whichever tab happens to be active would put a term from one page into a
 * panel describing another. Doing nothing is the honest failure.
 *
 * Empty text falls back to opening the panel plainly: the browser only offers a
 * selection entry when there is a selection, so this is a browser-level
 * surprise, and the panel's own mount-time snapshot is a better guess than a
 * request built on nothing.
 */
function handleSelectionMenu(
  action: "define-selection" | "related-to-selection",
  tabId: number | undefined,
  selectionText: string | undefined,
): void {
  if (tabId === undefined) {
    return;
  }
  if (selectionText === undefined || selectionText === "") {
    openPanel(tabId);
    return;
  }
  const intent = action === "define-selection" ? "define" : "related";
  deliverSelection(tabId, { text: selectionText, intent }).catch(() => undefined);
}

addMenuClickListener((menuItemId, tabId, selectionText) => {
  const action = menuAction(menuItemId);
  if (action === null) {
    return;
  }
  // A switch on the action, not a ternary: a ternary has no exhaustiveness
  // check, so a future MenuAction member (e.g. a link/image clip entry) would
  // fall through the `default` silently rather than failing to compile. The
  // `never` assignment below is what turns "someone added a MenuAction arm
  // and forgot this switch" into a compile error instead of a page quietly
  // getting clipped as an article. This is the action→mode half of the same
  // guarantee `menuAction` already gives the id→action step by returning
  // `null` instead of defaulting — see its own doc comment.
  switch (action) {
    case "show-related":
      // The RIGHT-CLICKED tab, falling back to the active one. A right-click in a
      // non-focused window targets a different tab than tabs.query({active}), and
      // the activeTab grant belongs to the clicked tab — the same reasoning the
      // clip path already documents.
      openPanel(tabId);
      return;
    case "clip-article":
      quickClip(quickClipDeps, "article", tabId).catch(() => undefined);
      return;
    case "clip-selection":
      quickClip(quickClipDeps, "selection", tabId).catch(() => undefined);
      return;
    case "define-selection":
    case "related-to-selection":
      handleSelectionMenu(action, tabId, selectionText);
      return;
    case "add-passage":
      // `tabId` is `number | undefined` here. Early return, never a `!`
      // (`noNonNullAssertion` is an error in this repo) and never the active tab
      // as a fallback: a right-click in a non-focused window targets a different
      // tab than `tabs.query({active})`, and the activeTab grant belongs to the
      // CLICKED tab — the same reasoning the clip path already documents.
      if (tabId === undefined) {
        return;
      }
      collectPassage(passageCollectDeps, tabId).catch(() => undefined);
      return;
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
});

/**
 * Open the panel for a cue click, in the tab the BROWSER says the message came
 * from — never a tab id from the message itself. The cue runs in the page, so a
 * payload-supplied tab id would be forgeable on a hostile site; `CueOpenRequest`
 * carries no payload at all for that reason. An undefined tab means the message
 * did not come from a tab (the popup or options page), which nothing here can
 * act on.
 *
 * Lives outside the message listener rather than inline: the listener is a flat
 * router of fourteen branches, and a nested `if` inside one of them costs more
 * cognitive complexity than the branch itself (SonarCloud S3776, which this
 * pushed to 16 against a threshold of 15). The router routes; this decides.
 */
/**
 * The ONE place `pairingGeneration` is bumped: both `handlePair` (on a
 * confirmed new token) and `handleUnpair` call `clearRuns` — never anywhere
 * else — so wrapping this single seam covers both without touching either
 * handler. Bumped BEFORE the (async) clear itself, so the counter moves the
 * moment the pairing changes rather than after `clearRuns`'s own storage write
 * settles.
 */
/**
 * Bump the generation, then drop every cached answer from the gateway the
 * browser is leaving — agent lane briefs AND research-brief runs alike. A stored
 * report is one gateway's answer, and the next pairing may be a different one.
 *
 * The disclosure log is deliberately NOT cleared here: it records egress that
 * already happened, and a change of pairing does not make it un-happen. Only the
 * user's own "Clear this list" empties it.
 */
async function clearRunsAndBumpGeneration(): Promise<void> {
  pairingGeneration += 1;
  await clearRuns();
  await clearBriefRuns().catch(() => undefined);
}

function openPanelForCue(tabId: number | undefined): void {
  if (tabId === undefined) {
    return;
  }
  // Fire-and-forget: no response is sent, the cue does not wait, and the panel
  // appearing is the answer. A restricted page rejects injection — fail closed.
  openPanel(tabId);
}

/**
 * True when a response tells us the gateway rejected our token.
 *
 * Checked in ONE place rather than hooked into each handler: every route that can
 * 401 already reports it the same way, so a single wrap around `respond` cannot
 * drift, and adding a route later gets the behaviour for free.
 */
function carriesUnauthorized(res: unknown): boolean {
  return (
    typeof res === "object" &&
    res !== null &&
    (res as { reason?: unknown }).reason === "unauthorized"
  );
}

addMessageListener((message, rawRespond, sender) => {
  const respond = (res: unknown): void => {
    if (carriesUnauthorized(res)) {
      // Fire-and-forget: the user's answer must not wait on a storage write, and
      // a failed write only means the flag is set on the next 401.
      //
      // `.catch` is REQUIRED, not decoration. `void` does not attach a rejection
      // handler, so a failing `chrome.storage.local.set` here would surface as an
      // unhandled rejection in the service worker — and fail the Vitest run. This
      // is the same `.catch(() => undefined)` the file already uses for its other
      // fire-and-forget calls (`injectPanel`, `endPause`, `ensureAlarm`).
      void markStale().catch(() => undefined);
    }
    rawRespond(res);
  };
  if (isCaptureRequest(message)) {
    const tabId = sender.tabId;
    if (tabId === undefined) {
      // No tab means no page to capture. Fail closed with the same vocabulary the
      // panel already renders rather than inventing a branch for "impossible".
      respond({ kind: "capture", ok: false, reason: "injection-failed" });
      return true;
    }
    handleCapture(
      {
        captureTab: (id, expected) => captureTab({ tabUrl, runCapture }, id, "article", expected),
        previewEnabled: isPreviewEnabled,
        now: () => Date.now(),
      },
      message,
      tabId,
    )
      .then(respond)
      .catch(() => {
        respond({ kind: "capture", ok: false, reason: "injection-failed" });
      });
    return true;
  }
  if (isPairRequest(message)) {
    handlePair(
      {
        confirmPair,
        setConnection,
        clearRuns: clearRunsAndBumpGeneration,
        nowMs: () => Date.now(),
      },
      message,
    )
      .then(respond)
      .catch(() => {
        respond({ kind: "pair", ok: false, reason: "server_error" });
      });
    return true;
  }
  if (isClipRequest(message)) {
    handleClip(clipDeps, message)
      .then(async (res) => {
        if (res.ok) {
          // Same rule as markStale above: `void` alone would leave a rejection
          // unhandled.
          void markClipSuccess(Date.now()).catch(() => undefined);
        }
        await syncQueueState();
        respond(res);
      })
      .catch(() => {
        respond({ kind: "clip", ok: false, reason: "server_error" });
      });
    return true;
  }
  if (isRelatedRequest(message)) {
    handleRelated({ getConnection, postRelated }, message)
      .then(respond)
      .catch(() => {
        respond({ kind: "related", ok: false, reason: "server_error" });
      });
    return true;
  }
  if (isRecogniseRequest(message)) {
    handleRecognise({ getOrigins }, message)
      .then(respond)
      .catch(() => {
        // The recogniser itself cannot throw, so this is the storage read
        // failing. Report THAT — never a fabricated `{ok:false}` recognition,
        // which the watcher could not tell apart from a genuinely unrecognised
        // page and would render as "you navigated away" on a page the user
        // never left.
        respond({ kind: "recognition", ok: false, reason: "server_error" });
      });
    return true;
  }
  if (isResolveRequest(message)) {
    handleResolve({ getConnection, getOrigins, resolveItem }, message)
      .then(respond)
      .catch(() => {
        respond({
          kind: "resolve",
          ok: false,
          recognition: { ok: false, reason: "unknown-host" },
          reason: "server_error",
        });
      });
    return true;
  }
  if (isFetchRequest(message)) {
    handleFetch({ getConnection, getOrigins, fetchItem }, message)
      .then(respond)
      .catch(() => {
        respond({
          kind: "fetch",
          ok: false,
          recognition: { ok: false, reason: "unknown-host" },
          reason: "server_error",
        });
      });
    return true;
  }
  if (isAgentRunRequest(message)) {
    handleAgentRun(agentRunDeps, message)
      .then(respond)
      .catch(() => {
        respond({
          kind: "agent-state",
          lane: message.lane,
          state: { kind: "failed", reason: "server_error" },
        });
      });
    return true;
  }
  if (isAgentStateRequest(message)) {
    handleAgentState(agentStateDeps, message)
      .then(respond)
      .catch(() => {
        respond({
          kind: "agent-state",
          lane: message.lane,
          state: { kind: "failed", reason: "server_error" },
        });
      });
    return true;
  }
  if (isQueueListRequest(message)) {
    handleQueueList({ getQueue })
      .then(respond)
      .catch(() => {
        respond({ kind: "queue", items: [] });
      });
    return true;
  }
  if (isQueueRetryRequest(message)) {
    handleQueueRetry(
      { flush: (opts) => flushQueue(flushDeps, opts).then(() => undefined), getQueue },
      message,
    )
      .then(async (res) => {
        await syncQueueState();
        respond(res);
      })
      .catch(() => {
        respond({ kind: "queue", items: [] });
      });
    return true;
  }
  if (isQueueRemoveRequest(message)) {
    handleQueueRemove({ updateQueue }, message)
      .then(async (res) => {
        await syncQueueState();
        respond(res);
      })
      .catch(() => {
        respond({ kind: "queue", items: [] });
      });
    return true;
  }
  if (isConnectionStatusRequest(message)) {
    handleConnectionStatus({
      getConnection,
      getQueueDepth: async () => (await getQueue()).length,
      probeReachable: (origin) => probeHealth(origin),
    })
      .then(respond)
      .catch(() => {
        respond({ kind: "connection", paired: false });
      });
    return true;
  }
  if (isDiscoverRequest(message)) {
    handleDiscover({ probeReachable: (origin) => probeHealth(origin) })
      .then(respond)
      .catch(() => {
        // A discovery failure is "we did not find one", never an error state —
        // the manual URL field is the fallback and it is always present.
        respond({ kind: "discover", origin: null });
      });
    return true;
  }
  // ONE branch for six kinds — the fan-out lives in `routeBriefMessage` so this
  // router stays under S3776's cap. Placed before the narrower guards below only
  // because its own guard is exact (a `brief-` prefix plus an optional string id).
  // ONE branch for the three ledger reads, same shape and same reason as the
  // brief branch below.
  if (isEgressMessage(message)) {
    routeEgressMessage(message)
      .then(respond)
      .catch(() => {
        // The REQUEST's kind, not a fixed one: each caller narrows on its own
        // discriminant, and an `egress-window` reply to a verify request does
        // not match that request's response union.
        respond({ kind: message.kind, ok: false, reason: "server_error" });
      });
    return true;
  }
  if (isBriefMessage(message)) {
    routeBriefMessage(message)
      .then(respond)
      .catch(() => {
        respond({ kind: "failed", reason: "server_error" });
      });
    return true;
  }
  // ONE branch for the collection's two mutations, same shape and same reason as
  // the brief branch above.
  if (isPassageMessage(message)) {
    routePassageMessage(message)
      .then(respond)
      .catch(() => {
        respond({ ok: false });
      });
    return true;
  }
  if (isUnpairRequest(message)) {
    handleUnpair({ clearConnection, clearRuns: clearRunsAndBumpGeneration })
      .then(respond)
      .catch(() => {
        respond({ kind: "connection", paired: false });
      });
    return true;
  }
  if (isCueOpenRequest(message)) {
    openPanelForCue(sender.tabId);
    return false;
  }
  return false;
});

// The hotkey injects the related panel into the active tab. activeTab is granted on
// the command gesture; a restricted page rejects injection — fail closed silently.
addCommandListener((command) => {
  if (command === "show_related") {
    openPanel();
    return;
  }
  if (command === "clip-page") {
    quickClip(quickClipDeps, "article").catch(() => undefined);
    return;
  }
  if (command === "clip-selection") {
    quickClip(quickClipDeps, "selection").catch(() => undefined);
  }
});

/**
 * The item last cued per tab — the dedupe memory decision 4 asks for: quiet for
 * this item, in this tab, until you navigate to a different one.
 *
 * Deliberately NOT persisted. A service-worker eviction re-cues you once, which
 * is a better failure than a suppression that outlives the reason for it.
 */
const lastCuedByTab = new Map<number, Recognition>();
const ambientTimers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * One in-flight ambient run per tab, as the design spec states — enforced by
 * generation, not by cancellation.
 *
 * The debounce coalesces bursts, but it cannot help once a run has STARTED: a
 * navigation 700ms after another leaves two runs overlapping, and the older one
 * can still land last. Bumping a counter per navigation and checking it after
 * the await means the stale run drops its result instead of racing the fresh one
 * to `showCue`.
 *
 * This is deliberately NOT an AbortController. See the spec's "Deferred, with
 * reasons": caller-side cancellation means threading a signal through
 * `resolveItem` and `handleResolve` — a seam the panel shares — to save a
 * request to 127.0.0.1 whose work the gateway has already begun. Correctness is
 * what matters here, and this is what buys it.
 */
const ambientGeneration = new Map<number, number>();

/** SPA URL rewrites arrive in bursts; one navigation should cost one resolve. */
const AMBIENT_DEBOUNCE_MS = 600;

const ambientDeps: AmbientDeps = {
  // The stored preference alone is not enough: a revoke made from
  // chrome://extensions (rather than through Options) never touches this
  // list, and an out-of-band re-grant would otherwise silently resurrect a
  // preference the user last saw being withdrawn. hasOrigin re-checks against
  // the browser's own grant, which is safe to call here (unlike `request`, it
  // needs no user gesture).
  enabledHosts: async () => {
    const patterns = await getAmbientHosts();
    const granted = await Promise.all(patterns.map(hasOrigin));
    return patterns.filter((_, i) => granted[i] === true);
  },
  getOrigins,
  lastCued: (tabId) => lastCuedByTab.get(tabId),
  resolve: (pageUrl) =>
    handleResolve({ getConnection, getOrigins, resolveItem }, { kind: "resolve", pageUrl }),
  currentUrl: tabUrl,
};

async function runAmbient(nav: TabNavigation, generation: number): Promise<void> {
  const decision = await decideAmbient(ambientDeps, nav);
  // A newer navigation in this tab supersedes this one, whatever it concluded.
  if (ambientGeneration.get(nav.tabId) !== generation) {
    return;
  }
  if (decision.kind !== "show") {
    return;
  }
  // Inject FIRST, remember second: an attempt abandoned by a restricted page
  // must not suppress the cue the next time the user lands on this item.
  await showCue(nav.tabId, decision.cue);
  // Skip the write only when the tab is GONE — addTabClosedListener has already
  // cleared this tab's maps, and re-adding an entry would leak one for a dead
  // tab. A newer navigation superseding this run is NOT a reason to skip: this
  // run genuinely mounted a cue for `decision.recognition`, that fact stays
  // true regardless of what navigated next, and it can never wrongly suppress a
  // later cue for a DIFFERENT item (the dedupe check compares with sameItem).
  if (ambientGeneration.has(nav.tabId)) {
    lastCuedByTab.set(nav.tabId, decision.recognition);
  }
}

addNavigationListener((nav) => {
  const generation = (ambientGeneration.get(nav.tabId) ?? 0) + 1;
  ambientGeneration.set(nav.tabId, generation);
  const pending = ambientTimers.get(nav.tabId);
  if (pending !== undefined) {
    clearTimeout(pending);
  }
  ambientTimers.set(
    nav.tabId,
    setTimeout(() => {
      ambientTimers.delete(nav.tabId);
      // Fails closed like every other listener here: the user-visible result is
      // a cue or nothing, and a rejection has nowhere to be reported.
      runAmbient(nav, generation).catch(() => undefined);
    }, AMBIENT_DEBOUNCE_MS),
  );
});

addTabClosedListener((tabId) => {
  lastCuedByTab.delete(tabId);
  ambientGeneration.delete(tabId);
  const pending = ambientTimers.get(tabId);
  if (pending !== undefined) {
    clearTimeout(pending);
    ambientTimers.delete(tabId);
  }
});

// The periodic alarm drains the queue, then reconciles the badge + alarm lifecycle.
// AGENT_POLL_ALARM is the eviction net for agent runs — see its own doc comment.
addAlarmListener((name) => {
  if (name === FLUSH_ALARM) {
    backgroundFlush().catch(() => undefined);
    return;
  }
  if (name === AGENT_POLL_ALARM) {
    resumeAgentPolls().catch(() => undefined);
    return;
  }
  if (name === BRIEF_POLL_ALARM) {
    resumeBriefPolls().catch(() => undefined);
  }
});

// On startup, run the sequence deterministically (awaited, not three concurrent
// top-level promises): set the badge color, paint the persisted backlog immediately,
// then attempt a drain and reconcile once more. Sequencing avoids a race where the
// initial badge paint could resolve after the post-drain one and show a stale count.
async function runStartupSequence(): Promise<void> {
  await setBadgeBackground("#5b6470").catch(() => undefined);
  await registerContextMenus().catch(() => undefined);
  await syncQueueState().catch(() => undefined);
  await backgroundFlush().catch(() => undefined);
}

// Deliberate fire-and-forget, not a forgotten top-level await (S7785).
// This is an MV3 service worker: a pending top-level await leaves module
// evaluation unresolved, and runStartupSequence ends in a network-bound
// backgroundFlush(), so awaiting here would gate worker startup — and event
// dispatch — on a gateway round-trip that may hang or fail. Every listener
// above is already registered synchronously during evaluation, which is what
// MV3 actually requires; the startup work is deliberately detached from it.
//
// The marker below must stay a TRAILING comment on the reported line: Sonar
// anchors NOSONAR to the issue's own line, so the same marker sitting in this
// block was silently ignored and the issue stayed open on main.
void runStartupSequence(); // NOSONAR
