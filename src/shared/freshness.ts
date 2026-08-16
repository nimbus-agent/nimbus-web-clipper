const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * How long ago an item was last MODIFIED, in words.
 *
 * `modifiedAtMs` is the item's own last-modified time as its source system
 * reports it — for a synced pull request that is GitHub's `updated_at`, not the
 * moment Nimbus wrote the row. The two are unrelated: a targeted fetch can index
 * a PR in under a second and still be told it was last touched three days ago.
 *
 * So callers must not label this "Indexed …". The panel says "Updated …".
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
    // Deliberately inlined rather than routed through `plural`, unlike hour/day
    // below: this bucket always reads "N min ago" — the fixed abbreviation
    // "min", never pluralised to "mins" and never expanded to "minute(s)" the
    // way `plural` would. Don't "fix" this into `plural(n, "min")` (→ "1 mins")
    // or `plural(n, "minute")` (→ "1 minute ago") — both change the copy.
    return `${Math.floor(age / MINUTE_MS)} min ago`;
  }
  if (age < DAY_MS) {
    return plural(Math.floor(age / HOUR_MS), "hour");
  }
  return plural(Math.floor(age / DAY_MS), "day");
}
