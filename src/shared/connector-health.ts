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

export interface GatePolicy {
  /** Render the service lanes at all? */
  readonly lanes: boolean;
  /** One short sentence shown above them, or instead of them. `%s` is replaced with
   *  the product's display name by the caller — the noun lives at the call site, not
   *  in this pure module. */
  readonly note: string | null;
}

/**
 * What the panel does about one connector's state.
 *
 * The three-way split is the point. `degraded`, `rate_limited` and `paused` still run
 * the lanes: syncing is impaired but the indexed items are real, so the answers are
 * real and merely possibly missing the newest. The three that withhold cannot answer
 * at all, and each says something different — upstream keeps `not_configured` and
 * `unauthenticated` apart deliberately (never-had-a-credential versus
 * credential-rejected), and collapsing them is what made an upstream bug take an hour.
 *
 * No note names a command: `/v1/connectors` carries no remedy string, and inventing
 * one is the failure `parseScopeGap` already refuses.
 *
 * This table says nothing about the sync-age line: that further exception —
 * `unknown` renders no age line even when the row carried a `lastSuccessfulSync` —
 * lives in `appendServiceHeader` (`src/panel/panel-view.ts`), not here.
 */
const POLICIES: Record<ConnectorState, GatePolicy> = {
  healthy: { lanes: true, note: null },
  // Silent and ungated: an older gateway, or one that answered in a way this client
  // does not recognise, loses the gate rather than the feature — and is not nagged.
  unknown: { lanes: true, note: null },
  degraded: {
    lanes: true,
    note: "Nimbus's last sync of %s was degraded, so recent items may be missing.",
  },
  rate_limited: {
    lanes: true,
    note: "%s is rate-limiting Nimbus, so recent items may be missing.",
  },
  paused: { lanes: true, note: "Syncing %s is paused, so recent items may be missing." },
  // "never synced", NOT "you have not set this up": upstream returns this state for a
  // missing sync_state row, which is also what a connector configured a minute ago
  // looks like until its first tick. Say what is known.
  not_configured: {
    lanes: false,
    note: "Nimbus has never synced %s, so there is nothing to answer from yet.",
  },
  unauthenticated: {
    lanes: false,
    note: "Nimbus's credential for %s was rejected, so it cannot read your items.",
  },
  error: {
    lanes: false,
    note: "Nimbus's last sync of %s failed, so anything since then is missing.",
  },
};

export function gatePolicy(state: ConnectorState): GatePolicy {
  return POLICIES[state];
}

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
