const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * How stale an indexed item is, in words.
 *
 * `nowMs` is injected rather than read from the clock so this stays pure and
 * testable — and so the panel takes one timestamp per repaint instead of a
 * different one per line.
 *
 * A future `modifiedAtMs` reads as "just now": the gateway's clock and the
 * browser's can disagree by a little, and "in 3 minutes" would be a nonsense
 * answer to "how fresh is this?".
 */
export function formatAge(modifiedAtMs: number, nowMs: number): string {
  const age = nowMs - modifiedAtMs;
  if (age < MINUTE_MS) {
    return "just now";
  }
  if (age < HOUR_MS) {
    return `${Math.floor(age / MINUTE_MS)} min ago`;
  }
  if (age < DAY_MS) {
    return plural(Math.floor(age / HOUR_MS), "hour");
  }
  return plural(Math.floor(age / DAY_MS), "day");
}
