// src/background/rate-limit-pause.ts
// When the gateway rate-limits a clip (429), we stop flushing until its Retry-After
// has elapsed. The deadline is PERSISTED, not held in memory: an MV3 service worker
// is evicted after ~30s idle and every wake runs the startup drain, so an in-memory
// pause would be lost exactly when it matters.
import { storageGet, storageSet } from "../browser/storage.ts";

const PAUSE_KEY = "clipRateLimitPauseUntil";

/** Epoch ms until which automatic flushes are paused; 0 = not paused. */
export async function getPauseUntil(): Promise<number> {
  const value = await storageGet(PAUSE_KEY);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function setPauseUntil(untilMs: number): Promise<void> {
  await storageSet(PAUSE_KEY, untilMs);
}

/**
 * Drop the pause — a successful clip proves a slot was free, so there is no reason
 * to wait out the remainder. Reads first: this runs after every successful clip and
 * the common case (no pause set) should cost no write.
 *
 * Returns whether a pause was actually cleared. The caller needs that edge, not the
 * state: on the paused → not-paused transition the flush alarm is still armed on
 * the delayed schedule, and it has to be dropped explicitly.
 */
export async function clearPause(): Promise<boolean> {
  if ((await getPauseUntil()) === 0) {
    return false;
  }
  await setPauseUntil(0);
  return true;
}
