// src/background/agent-run-store.ts
// Persistence for agent-lane runs, so a run outlives the panel: expand a lane,
// close the panel, and the brief is waiting on reopen. Modelled on
// clip-queue-store.ts — same storageGet/storageSet seam through
// src/browser/storage.ts, same rule that stored data is external input to be
// filtered through a guard and never cast, AND the same single-writer chain:
// the SW is single-threaded but not single-task, so two `putRun` calls in
// flight together (both lanes expanded on one item; a poll's `done` landing
// while a fresh lane-start writes `running`) would otherwise read the same
// snapshot and the second write would silently clobber the first.
import { storageGet, storageSet } from "../browser/storage.ts";
import { AGENT_LANES, type AgentError, type AgentLane, type LaneState } from "../shared/types.ts";

const STORE_KEY = "agentRuns";

/**
 * Mirrors the gateway's `AGENT_RUN_TTL_MS` (agent-runs/agent-run-store.ts), not a
 * number chosen here. A cached brief must never outlive the run it came from: the
 * gateway drops runs at ten minutes and does NOT refresh on access, so anything we
 * hold past that is unre-pollable.
 */
export const AGENT_RUN_CACHE_TTL_MS = 10 * 60_000;

/**
 * Deliberately the gateway's own `MAX_RETAINED_TERMINAL_AGENT_RUNS`. Holding more
 * would cache briefs the gateway has already evicted; holding fewer would discard
 * ones still live upstream. Two lanes per item spans eight recent items.
 */
export const MAX_STORED_RUNS = 16;

export interface StoredRun {
  readonly itemId: string;
  readonly lane: AgentLane;
  readonly runId: string;
  readonly state: LaneState;
  readonly expiresAtMs: number;
}

// Keyed by `${itemId}\u0000${lane}` — a separator that cannot occur in either
// half — so an item id containing what looks like a lane name can never collide
// with a real item/lane pair.
const KEY_SEP = "\u0000";

function makeKey(itemId: string, lane: AgentLane): string {
  return `${itemId}${KEY_SEP}${lane}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isAgentLane(v: unknown): v is AgentLane {
  return typeof v === "string" && (AGENT_LANES as readonly string[]).includes(v);
}

const AGENT_ERRORS = [
  "not_paired",
  "unauthorized",
  "insufficient_scope",
  "unsupported",
  "stale",
  "unreachable",
  "server_error",
] as const satisfies readonly AgentError[];

function isAgentError(v: unknown): v is AgentError {
  return typeof v === "string" && (AGENT_ERRORS as readonly string[]).includes(v);
}

function isLaneState(v: unknown): v is LaneState {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "collapsed") {
    return true;
  }
  if (v["kind"] === "running") {
    return typeof v["runId"] === "string";
  }
  if (v["kind"] === "done") {
    return typeof v["brief"] === "string";
  }
  if (v["kind"] === "failed") {
    return isAgentError(v["reason"]);
  }
  return false;
}

// Stored alongside each run so eviction can order by actual write time rather
// than lean on plain-object key insertion order as a proxy for it.
interface StoredEntry extends StoredRun {
  readonly writtenAtMs: number;
}

function isStoredEntry(v: unknown): v is StoredEntry {
  return (
    isObject(v) &&
    typeof v["itemId"] === "string" &&
    isAgentLane(v["lane"]) &&
    typeof v["runId"] === "string" &&
    isLaneState(v["state"]) &&
    typeof v["expiresAtMs"] === "number" &&
    typeof v["writtenAtMs"] === "number"
  );
}

/** Read the whole store, discarding anything that fails the guard. Storage is
 *  external input: a hand-edited or partially-written value must not throw. */
async function readAll(): Promise<Record<string, StoredEntry>> {
  const raw = await storageGet(STORE_KEY);
  if (!isObject(raw)) {
    return {};
  }
  const out: Record<string, StoredEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isStoredEntry(value)) {
      out[key] = value;
    }
  }
  return out;
}

/** Strip the internal `writtenAtMs` bookkeeping field before it crosses the
 *  public `StoredRun` boundary — callers (soon: a message to the panel) must
 *  never see it. */
function toStoredRun(entry: StoredEntry): StoredRun {
  const { itemId, lane, runId, state, expiresAtMs } = entry;
  return { itemId, lane, runId, state, expiresAtMs };
}

export async function getRun(
  itemId: string,
  lane: AgentLane,
  nowMs: number,
): Promise<StoredRun | null> {
  const all = await readAll();
  const found = all[makeKey(itemId, lane)];
  if (found === undefined || found.expiresAtMs <= nowMs) {
    return null;
  }
  return toStoredRun(found);
}

// Single-writer chain — see clip-queue-store.ts's `chain` for the identical
// pattern and the reasoning: the SW is single-threaded but not single-task, so
// concurrent callers awaiting storage would otherwise read the same snapshot
// and clobber each other's write.
let chain: Promise<unknown> = Promise.resolve();

/**
 * The cap is enforced on WRITE, not only on read: `putRun` evicts before
 * writing, so the store can never exceed MAX_STORED_RUNS entries at any moment.
 * That is what makes a startup cleanup sweep unnecessary — the worst resting
 * state is MAX_STORED_RUNS stale entries, each dropped the moment it is read.
 */
export function putRun(run: StoredRun, nowMs: number): Promise<void> {
  const next = chain.then(async () => {
    const all = await readAll();
    const key = makeKey(run.itemId, run.lane);
    const entries = Object.entries(all).filter(([k]) => k !== key);
    entries.push([key, { ...run, writtenAtMs: nowMs }]);
    // Oldest write survives longest against the cap; evict by writtenAtMs, not
    // by incidental object-key insertion order.
    entries.sort(([, a], [, b]) => a.writtenAtMs - b.writtenAtMs);
    while (entries.length > MAX_STORED_RUNS) {
      entries.shift();
    }
    await storageSet(STORE_KEY, Object.fromEntries(entries));
  });
  // Keep the lock chain alive whether or not this call resolved or rejected.
  chain = next.catch(() => undefined);
  return next;
}

export async function listRunning(nowMs: number): Promise<StoredRun[]> {
  const all = await readAll();
  return Object.values(all)
    .filter((run) => run.state.kind === "running" && run.expiresAtMs > nowMs)
    .map(toStoredRun);
}
