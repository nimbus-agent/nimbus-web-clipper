// src/background/agent-run-store.ts
// Persistence for agent-lane runs, so a run outlives the panel: expand a lane,
// close the panel, and the brief is waiting on reopen.
//
// The guarded read and the single-writer lock both come from keyed-store.ts,
// which brief-run-store.ts shares: stored data is external input, to be
// filtered through a guard and never cast; and the SW is single-threaded but
// not single-task, so two `putRun` calls in flight together (both lanes
// expanded on one item; a poll's `done` landing while a fresh lane-start writes
// `running`) would otherwise read the same snapshot and the second write would
// silently clobber the first.
import { storageSet } from "../browser/storage.ts";
import { isAgentError, isScopeGap } from "../shared/messages.ts";
import { AGENT_LANES, type AgentLane, type LaneState } from "../shared/types.ts";
import { createWriteChain, readGuarded } from "./keyed-store.ts";

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

/**
 * How many of `MAX_STORED_RUNS` may be TERM entries at once.
 *
 * The reason is an asymmetry in cardinality, not a worry about bursts. Item and
 * service subjects are bounded by what the user visits — a handful of pull
 * requests, five connectors. A term is bounded only by what can be selected,
 * which is every substring of every page. Terms are the one subject that can
 * grow without limit, so they are the one subject that needs a limit of its own.
 *
 * Without it the unbounded subject evicts the bounded ones, which is backwards:
 * a PR brief is expensive to regenerate and tied to work in progress, while a
 * term lookup is cheap and usually asked once. The TOTAL is unchanged — holding
 * more than the gateway retains would cache briefs it has already evicted.
 */
export const MAX_STORED_TERM_RUNS = 6;

/**
 * What a run is ABOUT.
 *
 * `item` is C2.1's shape: a lane answering about one indexed item. `service` is
 * C2.3's: a lane answering about a whole connector, which has no item to key on.
 * `term` is the glossary lane's: a lane answering about a word the user selected,
 * which belongs to no page and no connector at all.
 *
 * A discriminated union rather than a synthetic string like "service:bitbucket"
 * because upstream item ids are already `${service}:${externalId}`
 * (packages/gateway/src/index/item-key.ts), so a synthetic key would share a
 * namespace SHAPE with real ids — confusable by inspection, and one connector
 * rename away from being ambiguous in fact. The `term` arm is what stops a second
 * term silently replaying the first term's answer, which is precisely the failure
 * the union was built to prevent.
 */
export type RunSubject =
  | { readonly kind: "item"; readonly id: string }
  | { readonly kind: "service"; readonly service: string }
  | { readonly kind: "term"; readonly term: string }
  /**
   * A source file. Keyed by repo AND coordinate, because two files in one
   * repository — and the same path in two repositories — are different subjects,
   * and a key that dropped either would serve one file's run for the other.
   */
  | { readonly kind: "file"; readonly repo: string; readonly refAndPath: string };

export interface StoredRun {
  readonly subject: RunSubject;
  readonly lane: AgentLane;
  readonly runId: string;
  readonly state: LaneState;
  readonly expiresAtMs: number;
}

// Keyed by `${kind}\u0000${value}\u0000${lane}` and a separator that cannot occur
// in any of the three parts, so neither an item id that looks like a lane name
// nor a service id equal to some item id can collide. UNCHANGED from the
// pre-subject store: keep the escape sequence, never a literal control
// character typed into source.
const KEY_SEP = "\u0000";

function subjectValue(subject: RunSubject): string {
  if (subject.kind === "item") {
    return subject.id;
  }
  if (subject.kind === "service") {
    return subject.service;
  }
  // Both halves, joined by the same separator the key uses: a repo alone would
  // collide every file in it, and a coordinate alone would collide the same path
  // across repositories.
  return subject.kind === "file" ? `${subject.repo}${KEY_SEP}${subject.refAndPath}` : subject.term;
}

function makeKey(subject: RunSubject, lane: AgentLane): string {
  return `${subject.kind}${KEY_SEP}${subjectValue(subject)}${KEY_SEP}${lane}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isRunSubject(v: unknown): v is RunSubject {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "item") {
    return typeof v["id"] === "string";
  }
  if (v["kind"] === "term") {
    return typeof v["term"] === "string";
  }
  return v["kind"] === "service" && typeof v["service"] === "string";
}

function isAgentLane(v: unknown): v is AgentLane {
  return typeof v === "string" && (AGENT_LANES as readonly string[]).includes(v);
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
    // `reason` is required; `scopeGap` and `detail` are each optional and, when
    // present, must be well-formed — storage is external input (a hand-edited
    // or partially-written value), exactly like the SW→panel boundary this
    // mirrors. Reuses `isScopeGap` rather than a second hand-rolled copy — the
    // predicate-vs-type drift class that already shipped once as
    // `isResolvedItem`.
    return (
      isAgentError(v["reason"]) &&
      (v["scopeGap"] === undefined || isScopeGap(v["scopeGap"])) &&
      (v["detail"] === undefined || typeof v["detail"] === "string")
    );
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
    isRunSubject(v["subject"]) &&
    isAgentLane(v["lane"]) &&
    typeof v["runId"] === "string" &&
    isLaneState(v["state"]) &&
    typeof v["expiresAtMs"] === "number" &&
    typeof v["writtenAtMs"] === "number"
  );
}

/** Read the whole store, discarding anything that fails the guard. */
function readAll(): Promise<Record<string, StoredEntry>> {
  return readGuarded(STORE_KEY, isStoredEntry);
}

/** Strip the internal `writtenAtMs` bookkeeping field before it crosses the
 *  public `StoredRun` boundary — callers (soon: a message to the panel) must
 *  never see it. */
function toStoredRun(entry: StoredEntry): StoredRun {
  const { subject, lane, runId, state, expiresAtMs } = entry;
  return { subject, lane, runId, state, expiresAtMs };
}

export async function getRun(
  subject: RunSubject,
  lane: AgentLane,
  nowMs: number,
): Promise<StoredRun | null> {
  const all = await readAll();
  const found = all[makeKey(subject, lane)];
  if (found === undefined || found.expiresAtMs <= nowMs) {
    return null;
  }
  return toStoredRun(found);
}

// Single-writer lock — see keyed-store.ts for the pattern and the reasoning.
const exclusively = createWriteChain();

/**
 * The cap is enforced on WRITE, not only on read: `putRun` evicts before
 * writing, so the store can never exceed MAX_STORED_RUNS entries at any moment.
 * That is what makes a startup cleanup sweep unnecessary — the worst resting
 * state is MAX_STORED_RUNS stale entries, each dropped the moment it is read.
 */
export function putRun(run: StoredRun, nowMs: number): Promise<void> {
  return exclusively(async () => {
    const all = await readAll();
    const key = makeKey(run.subject, run.lane);
    const entries = Object.entries(all).filter(([k]) => k !== key);
    entries.push([key, { ...run, writtenAtMs: nowMs }]);
    // Oldest write survives longest against the cap; evict by writtenAtMs, not
    // by incidental object-key insertion order.
    entries.sort(([, a], [, b]) => a.writtenAtMs - b.writtenAtMs);
    // Terms are evicted against their OWN budget first, before the global cap is
    // consulted at all — see MAX_STORED_TERM_RUNS. Doing it in this order is the
    // whole point: an over-budget term must displace the oldest term, never the
    // oldest item, however recently that term was written.
    let termCount = entries.filter(([, e]) => e.subject.kind === "term").length;
    while (termCount > MAX_STORED_TERM_RUNS) {
      const oldestTerm = entries.findIndex(([, e]) => e.subject.kind === "term");
      entries.splice(oldestTerm, 1);
      termCount -= 1;
    }
    while (entries.length > MAX_STORED_RUNS) {
      entries.shift();
    }
    await storageSet(STORE_KEY, Object.fromEntries(entries));
  });
}

/**
 * Drop every cached run. Called on unpair: a cached brief is an answer from ONE
 * gateway, and the next pairing may be a different one. A service subject makes
 * this sharp — `{kind:"service", service:"github"}` is identical on every
 * gateway, so without this a lane could replay another gateway's answer for the
 * rest of the TTL.
 */
export function clearRuns(): Promise<void> {
  return exclusively(async () => {
    await storageSet(STORE_KEY, {});
  });
}

export async function listRunning(nowMs: number): Promise<StoredRun[]> {
  const all = await readAll();
  return Object.values(all)
    .filter((run) => run.state.kind === "running" && run.expiresAtMs > nowMs)
    .map(toStoredRun);
}
