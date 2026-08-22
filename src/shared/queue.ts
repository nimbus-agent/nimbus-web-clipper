// The offline retry queue's data model and pure operations. Every op is a
// QueuedClip[] -> QueuedClip[] transform so it composes as a mutator passed to the
// serialized updateQueue in clip-queue-store (each write applies to fresh state).
import { type ClipPayload, isSourceShape } from "./clip.ts";
import type { ClipError } from "./types.ts";

export interface QueuedClip {
  readonly payload: ClipPayload;
  readonly queuedAt: number;
  readonly attempts: number;
  readonly lastReason?: ClipError;
}

/** What the popup sees — the (potentially large) body is never sent to the popup. */
export interface QueuedClipView {
  readonly url: string;
  readonly title: string;
  readonly queuedAt: number;
  readonly attempts: number;
  readonly lastReason?: ClipError;
}

/** Bound the queue so storage and serialization stay cheap. */
export const MAX_QUEUE = 50;

/** Replace-by-URL (dedup, last-write-wins) then evict the oldest over the cap. */
export function enqueue(queue: QueuedClip[], entry: QueuedClip): QueuedClip[] {
  const deduped = queue.filter((e) => e.payload.url !== entry.payload.url);
  deduped.push(entry);
  return deduped.length > MAX_QUEUE ? deduped.slice(deduped.length - MAX_QUEUE) : deduped;
}

export function removeFromQueue(queue: QueuedClip[], url: string): QueuedClip[] {
  return queue.filter((e) => e.payload.url !== url);
}

export function markAttempt(queue: QueuedClip[], url: string, reason: ClipError): QueuedClip[] {
  return queue.map((e) =>
    e.payload.url === url ? { ...e, attempts: e.attempts + 1, lastReason: reason } : e,
  );
}

export function toView(entry: QueuedClip): QueuedClipView {
  return {
    url: entry.payload.url,
    title: entry.payload.title,
    queuedAt: entry.queuedAt,
    attempts: entry.attempts,
    ...(entry.lastReason !== undefined ? { lastReason: entry.lastReason } : {}),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isClipPayload(v: unknown): v is ClipPayload {
  return (
    isObject(v) &&
    typeof v["url"] === "string" &&
    (v["canonicalUrl"] === undefined || typeof v["canonicalUrl"] === "string") &&
    typeof v["title"] === "string" &&
    (v["mode"] === "article" || v["mode"] === "selection") &&
    typeof v["body"] === "string" &&
    Array.isArray(v["tags"]) &&
    v["tags"].every((t) => typeof t === "string") &&
    typeof v["capturedAt"] === "number" &&
    // Shallow, and here that is load-bearing rather than merely consistent:
    // `clip-queue-store.ts` reads the queue as `value.filter(isQueuedClip)`, so
    // a rung that rejected an off-shape MEMBER would not drop the field — it
    // would discard the whole clip the user saved while offline.
    (v["source"] === undefined || isSourceShape(v["source"]))
  );
}

export function isQueuedClip(v: unknown): v is QueuedClip {
  return (
    isObject(v) &&
    isClipPayload(v["payload"]) &&
    typeof v["queuedAt"] === "number" &&
    typeof v["attempts"] === "number" &&
    (v["lastReason"] === undefined || typeof v["lastReason"] === "string")
  );
}
