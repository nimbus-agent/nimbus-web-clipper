// src/background/brief-run-store.ts
// Persistence for a brief run, so closing the page does not lose it.
//
// Modelled on agent-run-store.ts: same storageGet/storageSet seam, same rule
// that stored data is external input to be filtered through a guard and never
// cast, and the same single-writer chain — the SW is single-threaded but not
// single-task, so two `putBriefRun` calls in flight together would otherwise
// read the same snapshot and the second would clobber the first.
//
// WHAT IS NOT HERE IS THE POINT: no source bodies. `BriefSource.body` is
// ephemeral by contract ("never written to disk"), and this client must not hold
// what the gateway refuses to hold. Only the declared url/title the user already
// chose, the question they asked, and the phase.
import { storageGet, storageSet } from "../browser/storage.ts";
import { type BriefReport, isBriefReport } from "../shared/brief-report.ts";

const STORE_KEY = "briefRuns";

/**
 * Mirrors the gateway's `DEFAULT_RUN_TTL_MS` (briefs/brief-constants.ts), not a
 * number chosen here — and upstream does NOT refresh it on access, so anything
 * held past it is unre-pollable and unsaveable.
 */
export const BRIEF_RUN_TTL_MS = 30 * 60_000;

/** Deliberately the gateway's own `MAX_RETAINED_TERMINAL_RUNS`. */
export const MAX_STORED_BRIEFS = 16;

export type BriefPhase =
  | { readonly kind: "feeding"; readonly received: number; readonly expected: number }
  | { readonly kind: "running" }
  | { readonly kind: "done"; readonly report: BriefReport; readonly savedItemId?: string }
  | { readonly kind: "failed"; readonly reason: string };

export type StoredBrief = {
  readonly id: string;
  readonly question: string;
  readonly declared: readonly { readonly url: string; readonly title: string }[];
  readonly phase: BriefPhase;
  readonly expiresAtMs: number;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isDeclared(v: unknown): v is { url: string; title: string } {
  return isObject(v) && typeof v["url"] === "string" && typeof v["title"] === "string";
}

function isPhase(v: unknown): v is BriefPhase {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "feeding") {
    return typeof v["received"] === "number" && typeof v["expected"] === "number";
  }
  if (v["kind"] === "running") {
    return true;
  }
  if (v["kind"] === "done") {
    // Reuses `isBriefReport` rather than a second hand-rolled copy — the
    // predicate-vs-type drift class that already shipped once as
    // `isResolvedItem`.
    return (
      isBriefReport(v["report"]) &&
      (v["savedItemId"] === undefined || typeof v["savedItemId"] === "string")
    );
  }
  return v["kind"] === "failed" && typeof v["reason"] === "string";
}

// Stored alongside each run so eviction can order by actual write time rather
// than lean on plain-object key insertion order as a proxy for it.
interface StoredEntry extends StoredBrief {
  readonly writtenAtMs: number;
}

function isStoredEntry(v: unknown): v is StoredEntry {
  return (
    isObject(v) &&
    typeof v["id"] === "string" &&
    typeof v["question"] === "string" &&
    Array.isArray(v["declared"]) &&
    v["declared"].every(isDeclared) &&
    isPhase(v["phase"]) &&
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

/** Strip the internal `writtenAtMs` bookkeeping before it crosses the public
 *  `StoredBrief` boundary — callers (and the page) must never see it. */
function toStoredBrief(entry: StoredEntry): StoredBrief {
  const { id, question, declared, phase, expiresAtMs } = entry;
  return { id, question, declared, phase, expiresAtMs };
}

export async function getBriefRun(id: string, nowMs: number): Promise<StoredBrief | null> {
  const all = await readAll();
  const found = all[id];
  if (found === undefined || found.expiresAtMs <= nowMs) {
    return null;
  }
  return toStoredBrief(found);
}

// Single-writer chain — see clip-queue-store.ts's `chain` for the identical
// pattern and the reasoning.
let chain: Promise<unknown> = Promise.resolve();

/**
 * The cap is enforced on WRITE, not only on read: this evicts before writing, so
 * the store can never exceed MAX_STORED_BRIEFS entries at any moment.
 */
export function putBriefRun(run: StoredBrief, nowMs: number): Promise<void> {
  const next = chain.then(async () => {
    const all = await readAll();
    const entries = Object.entries(all).filter(([k]) => k !== run.id);
    entries.push([run.id, { ...run, writtenAtMs: nowMs }]);
    // Oldest write survives longest against the cap; evict by writtenAtMs, not
    // by incidental object-key insertion order.
    entries.sort(([, a], [, b]) => a.writtenAtMs - b.writtenAtMs);
    while (entries.length > MAX_STORED_BRIEFS) {
      entries.shift();
    }
    await storageSet(STORE_KEY, Object.fromEntries(entries));
  });
  chain = next.catch(() => undefined);
  return next;
}

export async function listBriefRuns(nowMs: number): Promise<StoredBrief[]> {
  const all = await readAll();
  return Object.values(all)
    .filter((r) => r.expiresAtMs > nowMs)
    .map(toStoredBrief);
}

/**
 * Drop every stored run. Called on unpair and on a confirmed re-pair: a report
 * is ONE gateway's answer, and the next pairing may be a different one.
 *
 * Deliberately NOT applied to the disclosure log, which records something that
 * already happened and does not un-happen when the pairing changes.
 */
export function clearBriefRuns(): Promise<void> {
  const next = chain.then(async () => {
    await storageSet(STORE_KEY, {});
  });
  chain = next.catch(() => undefined);
  return next;
}
