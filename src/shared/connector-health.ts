// What the gateway says about one connector, and what the panel should do about it.
// Pure: no chrome.*, no fetch. The wire body is `unknown` until this guard has run.

/** Upstream's seven, plus this client's `unknown` for an unreadable or unrecognised answer. */
export const CONNECTOR_STATES = [
  "healthy",
  "not_configured",
  "degraded",
  "error",
  "rate_limited",
  "unauthenticated",
  "paused",
  "unknown",
] as const;

export type ConnectorState = (typeof CONNECTOR_STATES)[number];

export interface ConnectorHealth {
  readonly state: ConnectorState;
  /** From `lastSuccessfulSync`. Absent when the connector has never synced, or
   *  when the value did not parse — never guessed. */
  readonly lastSuccessfulSyncMs?: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const KNOWN: ReadonlySet<string> = new Set(CONNECTOR_STATES);

/**
 * Narrows `GET /v1/connectors`' body into one entry per connector.
 *
 * Returns null only when the body is not the documented envelope at all. A single
 * malformed ROW is skipped instead — one bad row must not cost the user every other
 * connector's status.
 *
 * `lastError` is read and DISCARDED, deliberately: it is free-form upstream text
 * headed for an injected page DOM, and an error string can carry a URL with a
 * credential in it.
 */
export function parseConnectorHealth(body: unknown): ReadonlyMap<string, ConnectorHealth> | null {
  if (!isObject(body) || !Array.isArray(body["data"])) {
    return null;
  }
  const out = new Map<string, ConnectorHealth>();
  for (const row of body["data"]) {
    if (!isObject(row)) {
      continue;
    }
    const id = row["connectorId"];
    const state = row["state"];
    if (typeof id !== "string" || id === "" || typeof state !== "string") {
      continue;
    }
    // An unrecognised state is `unknown`, not a refusal: upstream may add an eighth
    // state, and a client that threw on it would take the panel down with it.
    const known: ConnectorState =
      KNOWN.has(state) && state !== "unknown" ? (state as ConnectorState) : "unknown";
    const syncedAt = row["lastSuccessfulSync"];
    const ms = typeof syncedAt === "string" ? Date.parse(syncedAt) : Number.NaN;
    out.set(id, Number.isNaN(ms) ? { state: known } : { state: known, lastSuccessfulSyncMs: ms });
  }
  return out;
}
