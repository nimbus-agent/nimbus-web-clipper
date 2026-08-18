// src/background/brief-log-store.ts
// Append-only persistence for the disclosure log. Same seam, guard and
// single-writer chain as brief-run-store.ts.
import { storageGet, storageSet } from "../browser/storage.ts";
import {
  type BriefLogEntry,
  evictLog,
  isBriefLogEntry,
  MAX_LOG_ENTRIES,
} from "../shared/brief-log.ts";

const STORE_KEY = "briefLog";

async function readAllEntries(): Promise<BriefLogEntry[]> {
  const raw = await storageGet(STORE_KEY);
  return Array.isArray(raw) ? raw.filter(isBriefLogEntry) : [];
}

export function readLog(): Promise<BriefLogEntry[]> {
  return readAllEntries();
}

let chain: Promise<unknown> = Promise.resolve();

export function appendLogEntry(entry: BriefLogEntry): Promise<void> {
  const next = chain.then(async () => {
    const all = await readAllEntries();
    await storageSet(STORE_KEY, evictLog([...all, entry], MAX_LOG_ENTRIES));
  });
  chain = next.catch(() => undefined);
  return next;
}

/** Patch one entry. An unknown `runId` is a no-op — never a fabricated row. */
export function updateLogEntry(runId: string, patch: Partial<BriefLogEntry>): Promise<void> {
  const next = chain.then(async () => {
    const all = await readAllEntries();
    await storageSet(
      STORE_KEY,
      all.map((e) => (e.runId === runId ? { ...e, ...patch } : e)),
    );
  });
  chain = next.catch(() => undefined);
  return next;
}

/**
 * The user's own control, and the ONLY thing that empties this.
 *
 * Deliberately not called on unpair: unlike a cached report, this is a record of
 * something that already happened, and a new pairing does not make a past egress
 * un-happen.
 */
export function clearLog(): Promise<void> {
  const next = chain.then(async () => {
    await storageSet(STORE_KEY, []);
  });
  chain = next.catch(() => undefined);
  return next;
}
