// src/background/queue-flush.ts
// Drains the offline queue: posts each pending clip and removes it on success.
// An entry leaves the queue ONLY on success — failures are marked and kept. The
// token is re-read from the connection here (never stored in the queue). Each
// outcome is applied as a delta through the serialized updateQueue, so a concurrent
// popup remove is never clobbered by the flush's own write.
import type { ClipPayload } from "../shared/clip.ts";
import { markAttempt, type QueuedClip, removeFromQueue } from "../shared/queue.ts";
import type { ClipError, Connection } from "../shared/types.ts";

export interface FlushDeps {
  readonly getConnection: () => Promise<Connection | null>;
  readonly getQueue: () => Promise<QueuedClip[]>;
  readonly updateQueue: (mutator: (q: QueuedClip[]) => QueuedClip[]) => Promise<QueuedClip[]>;
  readonly postClip: (
    origin: string,
    token: string,
    payload: ClipPayload,
  ) => Promise<{ ok: true; status: "created" | "updated" } | { ok: false; reason: ClipError }>;
}

export async function flushQueue(
  deps: FlushDeps,
  opts: { url?: string; manual?: boolean } = {},
): Promise<{ remaining: number }> {
  const conn = await deps.getConnection();
  const queue = await deps.getQueue();
  if (conn === null) {
    return { remaining: queue.length };
  }

  const snapshot = queue.filter((e) => {
    if (opts.url !== undefined) {
      return e.payload.url === opts.url;
    }
    // An automatic flush skips entries that already failed with invalid_request or
    // payload_too_large — a 400/413 won't self-fix, so only an explicit user retry
    // (manual) attempts them.
    if (
      opts.manual !== true &&
      (e.lastReason === "invalid_request" || e.lastReason === "payload_too_large")
    ) {
      return false;
    }
    return true;
  });

  for (const entry of snapshot) {
    const r = await deps.postClip(conn.origin, conn.token, entry.payload);
    if (r.ok) {
      await deps.updateQueue((q) => removeFromQueue(q, entry.payload.url));
      continue;
    }
    await deps.updateQueue((q) => markAttempt(q, entry.payload.url, r.reason));
    if (r.reason === "unreachable" || r.reason === "unauthorized") {
      break; // gateway down or token dead — no point trying the rest this round
    }
    // server_error / invalid_request / payload_too_large: keep the entry, continue
    // to the next (the last two are skipped by the next automatic flush)
  }

  return { remaining: (await deps.getQueue()).length };
}
