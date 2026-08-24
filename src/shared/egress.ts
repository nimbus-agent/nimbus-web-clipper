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
// Read over `GET /v1/egress` — shipped in Nimbus#1319, under the `egress`
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
   * `null` means the gateway could not say who asked — NOT that nobody did.
   * A gateway older than caller attribution (Nimbus#1322) writes it for every
   * targeted fetch. Never inferred; see `partitionRows`.
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

const OUTCOME_STATUSES = ["indexed", "not_found", "rate_limited"] as const;

/** How a targeted fetch ended, as the gateway's outcome marker records it. */
export type LedgerOutcomeStatus = (typeof OUTCOME_STATUSES)[number];

export interface LedgerOutcome {
  readonly status: LedgerOutcomeStatus;
  /** Present on `indexed` only — the item the fetch actually landed. */
  readonly itemId?: string;
  /** Present on `not_found` only — the gateway's own miss reason. */
  readonly reason?: string;
}

/**
 * Why a ledger read did not answer.
 *
 * Declared HERE rather than in `background/egress-client.ts` where it is raised:
 * `shared/messages.ts` needs it for the response envelope, and nothing under
 * `src/shared/` may import from `src/background/` — that file is bundled into
 * every page and content script, so the dependency would point the wrong way.
 *
 * `unsupported` is the 404: a gateway that predates the surface. It is distinct
 * from `server_error` because the remedy is "upgrade your gateway", and distinct
 * from an empty list because the client must never present "no route" as "no
 * activity".
 */
export type EgressError =
  | "unreachable"
  | "unauthorized"
  | "insufficient_scope"
  | "unsupported"
  | "rate_limited"
  | "server_error";

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
  // `>= 0`: a ledger id is an AUTOINCREMENT rowid, so a negative one is
  // malformed gateway data, not a row the page should try to render or page from.
  if (typeof v["id"] !== "number" || !Number.isInteger(v["id"]) || v["id"] < 0) {
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
  // A negative total would make `rows.length < rowsTotal` false on a genuinely
  // truncated window, hiding the Older control.
  if (
    typeof v["rowsTotal"] !== "number" ||
    !Number.isInteger(v["rowsTotal"]) ||
    v["rowsTotal"] < 0
  ) {
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
 * `method` separates a fetch someone asked for (`items.fetch`) from a scheduled
 * background sync (`sync.run`) upstream, which is what lets the panel classify a
 * row on a gateway too old to attribute it.
 */
/**
 * Is this row an outcome MARKER rather than an action?
 *
 * Outcome rows are annotations on an action already in the ledger — they have no
 * time, service or kind of their own worth showing, and `actionClass` would
 * otherwise label them "Other" and list them as rows in their own right.
 */
export function isOutcomeRow(row: EgressRow): boolean {
  return row.sourceType === "outcome";
}

/**
 * Read an outcome marker's summary.
 *
 * `null` for anything that does not parse cleanly, and the caller renders that
 * as "not recorded" rather than guessing. Two real cases: the summary is capped
 * at 256 bytes upstream and gains a `…[truncated]` suffix past it, which is not
 * valid JSON; and `status` is a closed union there, so an unrecognised value is
 * malformed data that must not reach a consumer which narrowed on it.
 */
export function parseOutcome(row: EgressRow): LedgerOutcome | null {
  if (!isOutcomeRow(row)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadSummary);
  } catch {
    return null;
  }
  if (!isObject(parsed) || !isMember(OUTCOME_STATUSES, parsed["status"])) {
    return null;
  }
  const itemId = parsed["itemId"];
  const reason = parsed["reason"];
  return {
    status: parsed["status"],
    ...(typeof itemId === "string" ? { itemId } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

/**
 * Separate outcome markers from the actions they describe.
 *
 * The map is keyed by the AUTHORISING row's hash, which the marker carries in
 * `sourceId`. An outcome whose action is not in this page is kept in the map and
 * simply never looked up — the pair routinely straddles a page boundary, because
 * the marker carries a higher id than the row it describes and the read is
 * newest-first, so the marker arrives first.
 */
export function splitOutcomes(rows: readonly EgressRow[]): {
  actions: readonly EgressRow[];
  outcomesByHash: ReadonlyMap<string, LedgerOutcome>;
} {
  const actions: EgressRow[] = [];
  const outcomesByHash = new Map<string, LedgerOutcome>();
  for (const row of rows) {
    if (!isOutcomeRow(row)) {
      actions.push(row);
      continue;
    }
    const outcome = parseOutcome(row);
    // An unparseable marker is dropped rather than recorded as an unknown
    // outcome: absent reads as "not recorded", which is the honest answer.
    if (outcome !== null && row.sourceId !== null) {
      outcomesByHash.set(row.sourceId, outcome);
    }
  }
  return { actions, outcomesByHash };
}

export function actionClass(row: EgressRow): ActionClass {
  if (row.sourceType === "http") {
    return "agent-run";
  }
  if (row.sourceType === "sync") {
    return row.method === "items.fetch" ? "targeted-fetch" : "background-sync";
  }
  return "other";
}
