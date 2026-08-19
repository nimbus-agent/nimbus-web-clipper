// The browser-side record of what this extension caused to leave the machine.
//
// This exists because the gateway's egress ledger does NOT cover it.
// `THIS_BINARY_COVERAGE.model` is `none` (egress/egress-coverage.ts) — the
// `model` source type is declared but its appender has not landed — and
// `agent-brief-egress.ts` covers `agents.*` briefs, which is a different route
// from `/v1/briefs`. So `nimbus prove` shows nothing for a brief's synthesis,
// and without this the only disclosure (`Report.synthesis`) dies with the run's
// 30-minute TTL.
//
// C4.1's caution — read the gateway's record rather than keep a private one that
// could quietly disagree — is right wherever a gateway record exists. Here none
// does, and a local record cannot disagree with a record that was never written.

/**
 * Entries are ~200 bytes, so a cap in the hundreds costs well under a megabyte
 * and makes eviction a theoretical path rather than a routine one.
 *
 * Deliberately unrelated to the gateway's `MAX_RETAINED_TERMINAL_RUNS` (16):
 * that bounds how many finished runs the gateway holds for GET/save, and tying
 * an egress record to a server-side memory budget would shrink it for no reason.
 */
export const MAX_LOG_ENTRIES = 500;

export type BriefLogEntry = {
  readonly runId: string;
  /** When `/run` was accepted — the moment of egress, not when the report arrived. */
  readonly at: number;
  readonly question: string;
  readonly sourceCount: number;
  readonly truncatedCount: number;
  /** Absent until the report arrives; absent forever on a run that failed. */
  readonly model?: string;
  readonly remote?: boolean;
  readonly failed?: boolean;
  /** A pointer that may dangle — see `evictLog`. */
  readonly savedItemId?: string;
  /**
   * Whether this run also searched the gateway's index.
   *
   * Optional so entries written before this field remain valid — an old entry is
   * the only evidence anywhere that its egress happened, and a guard that
   * rejected it would destroy the record this module exists to keep.
   */
  readonly usedIndex?: boolean;
  /**
   * How many DISTINCT indexed items the report drew on — one clip cited in three
   * findings is one. Written by `countIndexHits` when the report arrives, so it
   * is absent until then and absent forever on a run that failed.
   */
  readonly indexHits?: number;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isBriefLogEntry(v: unknown): v is BriefLogEntry {
  return (
    isObject(v) &&
    typeof v["runId"] === "string" &&
    typeof v["at"] === "number" &&
    typeof v["question"] === "string" &&
    typeof v["sourceCount"] === "number" &&
    typeof v["truncatedCount"] === "number" &&
    (v["model"] === undefined || typeof v["model"] === "string") &&
    (v["remote"] === undefined || typeof v["remote"] === "boolean") &&
    (v["failed"] === undefined || typeof v["failed"] === "boolean") &&
    (v["savedItemId"] === undefined || typeof v["savedItemId"] === "string") &&
    (v["usedIndex"] === undefined || typeof v["usedIndex"] === "boolean") &&
    (v["indexHits"] === undefined || typeof v["indexHits"] === "number")
  );
}

/**
 * Trim to `cap`, evicting SAVED entries before unsaved ones.
 *
 * This is the opposite of the intuitive rule and it is deliberate. A saved
 * brief's disclosure is durable upstream — `brief-save.ts` persists `synthesis`
 * as its own metadata field on the `research_brief` item — so dropping a saved
 * run's entry loses a pointer, not the record. An unsaved run's entry is the
 * only evidence anywhere that the egress happened. Within each group, oldest
 * goes first.
 */
export function evictLog(entries: readonly BriefLogEntry[], cap: number): BriefLogEntry[] {
  if (entries.length <= cap) {
    return [...entries];
  }
  const byAge = [...entries].sort((a, b) => a.at - b.at);
  const order = [
    ...byAge.filter((e) => e.savedItemId !== undefined),
    ...byAge.filter((e) => e.savedItemId === undefined),
  ];
  const doomed = new Set(order.slice(0, entries.length - cap).map((e) => e.runId));
  return entries.filter((e) => !doomed.has(e.runId));
}
