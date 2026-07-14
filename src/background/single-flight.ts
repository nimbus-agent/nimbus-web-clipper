// Coalesce concurrent calls to a no-arg async action: while one run is in flight,
// further calls return the SAME in-flight promise instead of starting another. Used
// to stop overlapping BACKGROUND queue drains (the periodic alarm tick and the
// cold-start drain can fire together on a fresh service-worker wake) from posting the
// same clips twice. The in-flight slot clears once the run settles — success or
// failure — so the next call starts fresh.
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight !== null) {
      return inFlight;
    }
    const run = fn().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  };
}
