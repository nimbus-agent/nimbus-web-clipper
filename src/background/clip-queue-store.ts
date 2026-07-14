// src/background/clip-queue-store.ts
// The offline queue's persistence. Exposes a read (getQueue) and a *serialized*
// read-modify-write (updateQueue). The SW is single-threaded but not single-task:
// an alarm flush and a popup message both await storage and would otherwise clobber
// each other. updateQueue chains every mutation on a module-level promise so each
// runs against freshly-read state — the single-writer guarantee.
import { storageGet, storageSet } from "../browser/storage.ts";
import { isQueuedClip, type QueuedClip } from "../shared/queue.ts";

const QUEUE_KEY = "clipQueue";

export async function getQueue(): Promise<QueuedClip[]> {
  const value = await storageGet(QUEUE_KEY);
  return Array.isArray(value) ? value.filter(isQueuedClip) : [];
}

let chain: Promise<unknown> = Promise.resolve();

export function updateQueue(mutator: (q: QueuedClip[]) => QueuedClip[]): Promise<QueuedClip[]> {
  const next = chain.then(async () => {
    const current = await getQueue();
    let desired = mutator(current);
    try {
      await storageSet(QUEUE_KEY, desired);
    } catch {
      // Quota fail-safe: if this write grew the queue, drop the oldest entry and
      // retry once. If it still fails (or wasn't a growth), surface by throwing —
      // the prior persisted queue is left intact (we never wrote a partial array).
      if (desired.length > current.length && desired.length > 1) {
        desired = desired.slice(1);
        await storageSet(QUEUE_KEY, desired);
      } else {
        throw new Error("clip queue write failed");
      }
    }
    return desired;
  });
  // Keep the lock chain alive whether or not this call resolved or rejected.
  chain = next.catch(() => undefined);
  return next;
}
