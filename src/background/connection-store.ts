import { storageGet, storageRemove, storageSet } from "../browser/storage.ts";
import type { Connection } from "../shared/types.ts";

const CONNECTION_KEY = "connection";

export function isConnection(v: unknown): v is Connection {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>)["origin"] === "string" &&
    typeof (v as Record<string, unknown>)["token"] === "string" &&
    typeof (v as Record<string, unknown>)["label"] === "string" &&
    typeof (v as Record<string, unknown>)["pairedAt"] === "number"
  );
}

export async function getConnection(): Promise<Connection | null> {
  const value = await storageGet(CONNECTION_KEY);
  return isConnection(value) ? value : null;
}

/**
 * ONE serialised chain for every write to the connection key.
 *
 * The read-modify-write helpers below are the obvious reason: a clip success and
 * a 401 arriving together would both read the pre-change record, and the second
 * write would drop the first one's edit — the same lost-update guard
 * `options.ts`'s `mutateOrigins` applies to the origin list.
 *
 * The NON-obvious reason is why `setConnection` and `clearConnection` go through
 * it as well. They replace the whole record, and their callers are `handlePair`
 * and `handleUnpair`. A queue flush that 401s while the user is re-pairing would
 * otherwise interleave as: `mutate` reads the OLD record → `setConnection` writes
 * the NEW one → `mutate` writes back its transform of the old one. The fresh
 * token is silently reverted to the dead one it just replaced, and the user is
 * told to re-pair a browser they have just re-paired. Narrow window, severe
 * outcome, and it costs one shared chain to close.
 *
 * In-memory only, and that is sufficient: the chain orders overlapping writes
 * within one service-worker lifetime, and MV3 runs exactly one service-worker
 * instance. Across an eviction there is no chain — and no concurrency either,
 * because there is no other writer alive to race with.
 */
let writes: Promise<void> = Promise.resolve();

function enqueue(op: () => Promise<void>): Promise<void> {
  writes = writes.catch(() => undefined).then(op);
  return writes;
}

/**
 * Read-modify-write the stored connection, or do nothing when there is none.
 *
 * `transform` returns a NEW object (`{ ...c, stale: true }`); it must never
 * mutate its argument in place, since callers elsewhere may hold the record it
 * was handed.
 */
function mutate(transform: (c: Connection) => Connection): Promise<void> {
  return enqueue(async () => {
    const current = await getConnection();
    if (current === null) {
      return;
    }
    await storageSet(CONNECTION_KEY, transform(current));
  });
}

/** A successful clip proves the token works, so it also clears `stale`. */
export function markClipSuccess(nowMs: number): Promise<void> {
  return mutate((c) => ({ ...c, lastClipAt: nowMs, stale: false }));
}

export function markStale(): Promise<void> {
  return mutate((c) => ({ ...c, stale: true }));
}

export function setConnection(c: Connection): Promise<void> {
  return enqueue(() => storageSet(CONNECTION_KEY, c));
}

export function clearConnection(): Promise<void> {
  return enqueue(() => storageRemove(CONNECTION_KEY));
}
