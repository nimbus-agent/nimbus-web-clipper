// src/background/passage-store.ts
// The passage collection's persistence: a read and a *serialized*
// read-modify-write, the same single-writer shape `clip-queue-store.ts` uses —
// the worker is single-threaded but not single-task, and a menu click and a
// composer read can interleave on this key.
//
// It differs from that store in one deliberate place: a failed write REFUSES.
// The queue drops its oldest entry under storage pressure; a passage exists in
// exactly one place and was put there by hand, so losing one silently is worse
// than a refusal the user can act on immediately.
import { storageGet, storageSet } from "../browser/storage.ts";
import { isPassage, type Passage, type PassageUpdate } from "../shared/passage.ts";

const PASSAGES_KEY = "passages";

export async function getPassages(): Promise<Passage[]> {
  const value = await storageGet(PASSAGES_KEY);
  return Array.isArray(value) ? value.filter(isPassage) : [];
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Apply `mutator` to the freshly-read collection and persist what it returns.
 *
 * A refusal is passed straight back to the caller and nothing is written, so
 * every cap in `addPassage` reaches the user as the toast for that reason.
 */
export function updatePassages(
  mutator: (all: readonly Passage[]) => PassageUpdate,
): Promise<PassageUpdate> {
  const next = chain.then(async (): Promise<PassageUpdate> => {
    const current = await getPassages();
    const desired = mutator(current);
    if (!desired.ok) {
      return desired;
    }
    try {
      await storageSet(PASSAGES_KEY, desired.all);
    } catch {
      // Intentionally not logged (`noConsole`), and intentionally not retried by
      // dropping anything — see the module comment.
      return { ok: false, reason: "storage-full" };
    }
    return desired;
  });
  // Keep the lock chain alive whether or not this call resolved or rejected.
  chain = next.catch(() => undefined);
  return next;
}
