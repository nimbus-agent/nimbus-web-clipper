// src/background/keyed-store.ts
// The two things a persisted keyed store in this worker needs, in one place.
//
// Before this module, `readGuarded` existed in two copies (agent-run-store,
// brief-run-store) and `createWriteChain` in five — those two plus
// brief-log-store, clip-queue-store and passage-store. The two run stores now
// import both from here. The other three still hold their own chain, and that is
// the honest state: `readGuarded` does not fit them at all (they persist an
// ARRAY, not a keyed record), and each carries a different write-failure policy —
// the clip queue drops its oldest entry under storage pressure, the passage store
// refuses so the user can act on it, the disclosure log evicts to
// MAX_LOG_ENTRIES. So this is the pattern's named home, not yet its only copy.
//
// That mattered more than the line count: each copy
// carries a subtlety that is invisible if you get it wrong. `readGuarded`
// DISCARDS entries rather than throwing, because storage is external input — a
// hand-edited or partially-written value must not take the whole store down
// with it. And `createWriteChain` re-arms the lock with `.catch(() => undefined)`
// after every call, because a rejected link left un-caught wedges the chain
// forever: every later write would await a promise that never settles, and the
// store would go silently read-only for the life of the worker.
import { storageGet } from "../browser/storage.ts";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Read a whole keyed store, keeping only the entries that pass `isEntry`.
 *
 * A value that fails is dropped, not repaired and not thrown on: the caller's
 * guard is the boundary between "what this store wrote" and "whatever is in
 * chrome.storage right now", and those are not the same thing.
 */
export async function readGuarded<T>(
  storeKey: string,
  isEntry: (v: unknown) => v is T,
): Promise<Record<string, T>> {
  const raw = await storageGet(storeKey);
  if (!isObject(raw)) {
    return {};
  }
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isEntry(value)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A single-writer lock for one store.
 *
 * The service worker is single-threaded but not single-task: two read-modify-
 * write cycles in flight together (a poll's `done` landing while a fresh lane
 * start writes `running`; an alarm flush and a popup message) would otherwise
 * both read the same snapshot, and the second write would silently clobber the
 * first. Each call runs after the previous one has settled.
 *
 * One chain per call to this function, so stores do not serialise against each
 * other — a wedged or slow write to one store must not stall another.
 */
export function createWriteChain(): <T>(work: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work);
    // Keep the lock chain alive whether or not this call resolved or rejected.
    chain = next.catch(() => undefined);
    return next;
  };
}
