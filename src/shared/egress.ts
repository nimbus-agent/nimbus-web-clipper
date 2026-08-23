// src/shared/egress.ts
// The egress-ledger contract, as pure types and guards.
//
// Every field mirrors a column of the gateway's `egress_ledger` table
// (Nimbus `packages/gateway/src/index/egress-ledger-v44-sql.ts`). The two status
// columns are CHECK-constrained unions upstream, so they are narrowed here
// against a membership list rather than by `typeof === "string"`: a guard wider
// at runtime than its own type is how an unmodelled value reaches a consumer
// that narrowed on a closed union.
//
// Read over `GET /v1/egress` — proposed in Nimbus#1319, under the `egress`
// scope. An older gateway 404s and the client says so; it never renders an
// empty list.

const HITL_STATUSES = ["approved", "not_required", "rejected"] as const;
const RESULT_STATUSES = ["authorized", "blocked"] as const;

export type HitlStatus = (typeof HITL_STATUSES)[number];
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export interface EgressRow {
  readonly id: number;
  readonly timestamp: number;
  readonly sourceType: string;
  /**
   * The caller's device label, when the gateway attributed the row.
   *
   * `null` today for every targeted fetch — `recordSyncEgress` hardcodes it —
   * so an unlabelled row means "this gateway could not say who asked", NOT
   * "nobody asked". Never inferred; see `partitionRows`.
   */
  readonly sourceId: string | null;
  readonly destination: string;
  readonly method: string;
  readonly payloadSummary: string;
  readonly hitlStatus: HitlStatus;
  readonly resultStatus: ResultStatus;
  readonly rowHash: string;
  readonly prevHash: string;
}

/**
 * A page of rows AND the counted totals of the window it came from.
 *
 * The totals are required, not optional: the gateway caps a page, so a count
 * taken from `rows` would under-report — the failure `countOutboundEgress`
 * exists upstream to end.
 */
export interface EgressWindow {
  readonly rows: readonly EgressRow[];
  readonly rowsTotal: number;
  readonly rowsTruncated: boolean;
}

/** The gateway's chain verdict, in its own vocabulary. */
export interface EgressVerdict {
  readonly intact: boolean;
  /** The first row whose hash did not chain, when the walk found one. */
  readonly brokenAt: number | null;
  readonly verifiedRows: number;
  readonly reason: string | null;
}

export interface EgressProof {
  readonly digest: string;
  readonly sigB64: string;
  readonly pubkeyB64: string;
  readonly rowsTotal: number;
  readonly rowsTruncated: boolean;
}

export interface EgressPartition {
  readonly ours: readonly EgressRow[];
  readonly others: readonly EgressRow[];
  readonly unattributable: readonly EgressRow[];
}

export type ActionClass = "targeted-fetch" | "agent-run" | "background-sync" | "other";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isMember<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

const STRING_FIELDS = [
  "sourceType",
  "destination",
  "method",
  "payloadSummary",
  "rowHash",
  "prevHash",
] as const;

export function isEgressRow(v: unknown): v is EgressRow {
  if (!isObject(v)) {
    return false;
  }
  if (typeof v["id"] !== "number" || !Number.isInteger(v["id"])) {
    return false;
  }
  if (typeof v["timestamp"] !== "number" || !Number.isFinite(v["timestamp"])) {
    return false;
  }
  // Present-and-null is a real value here; absent is not. `?? null` would erase
  // that difference and accept a row the gateway never sent.
  if (!("sourceId" in v)) {
    return false;
  }
  const sourceId = v["sourceId"];
  if (sourceId !== null && typeof sourceId !== "string") {
    return false;
  }
  for (const key of STRING_FIELDS) {
    if (typeof v[key] !== "string") {
      return false;
    }
  }
  return isMember(HITL_STATUSES, v["hitlStatus"]) && isMember(RESULT_STATUSES, v["resultStatus"]);
}

export function parseEgressWindow(v: unknown): EgressWindow | null {
  if (!isObject(v) || !Array.isArray(v["rows"])) {
    return null;
  }
  if (typeof v["rowsTotal"] !== "number" || !Number.isInteger(v["rowsTotal"])) {
    return null;
  }
  if (typeof v["rowsTruncated"] !== "boolean") {
    return null;
  }
  const rows: EgressRow[] = [];
  for (const candidate of v["rows"]) {
    // One bad row fails the whole window rather than being dropped: a silently
    // shortened list is indistinguishable from a genuinely quiet gateway.
    if (!isEgressRow(candidate)) {
      return null;
    }
    rows.push(candidate);
  }
  return { rows, rowsTotal: v["rowsTotal"], rowsTruncated: v["rowsTruncated"] };
}

/**
 * Split a window by who caused each row.
 *
 * Membership is exact label match and nothing else. Timing, destination and
 * action class are all deliberately ignored: any of them would let this view
 * claim ownership of a row the ledger does not attribute, which is the one
 * thing this feature exists not to do.
 */
export function partitionRows(rows: readonly EgressRow[], ourLabel: string): EgressPartition {
  const ours: EgressRow[] = [];
  const others: EgressRow[] = [];
  const unattributable: EgressRow[] = [];
  for (const row of rows) {
    if (row.sourceId === null) {
      unattributable.push(row);
    } else if (ourLabel !== "" && row.sourceId === ourLabel) {
      ours.push(row);
    } else {
      others.push(row);
    }
  }
  return { ours, others, unattributable };
}

/**
 * What KIND of action a row records — not who caused it.
 *
 * `method` already separates a fetch someone asked for (`items.fetch`) from a
 * scheduled background sync (`sync.run`) upstream, which is what lets the panel
 * say something useful about fetches before caller attribution lands.
 */
export function actionClass(row: EgressRow): ActionClass {
  if (row.sourceType === "http") {
    return "agent-run";
  }
  if (row.sourceType === "sync") {
    return row.method === "items.fetch" ? "targeted-fetch" : "background-sync";
  }
  return "other";
}
