// Pure presentational helper for the Options connection panel. Formats the
// paired-since date deterministically (en-US, UTC) so it is unit-testable without
// locale/timezone flakiness.
export function formatPairedSince(pairedAt: number): string {
  return new Date(pairedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
