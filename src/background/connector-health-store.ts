// src/background/connector-health-store.ts
// Caches `getConnectors` (gateway-client.ts) so one sitting makes one request.
//
// This is a DEDUPE, not a memory. Sixty seconds, and its only job is to
// collapse one sitting's reads into one request — not to remember an answer
// across sittings. The sequence that matters is remedial: a user told a
// connector is unconfigured leaves, configures it, and comes back. Their next
// panel open must reflect that, so the TTL is short and never raised for
// efficiency.
//
// A failed read (`null` — "could not tell") is never cached: caching it would
// keep a panel ungated for a minute after the gateway came back, which reads
// exactly like the failure the gate exists to catch.
//
// Persisted to `chrome.storage.local`, mirroring `agent-run-store.ts`'s
// conventions: stored data is external input, filtered through a guard and
// never cast, and a value that fails the guard is a cache miss — discarded,
// not repaired. Persistence is what lets a cached answer survive the worker
// being evicted between one panel open and the next within the same TTL
// window; it is not what makes the cache remember across sittings — the TTL
// bounds that regardless of whether the worker stayed alive.
import { storageGet, storageSet } from "../browser/storage.ts";
import {
  CONNECTOR_STATES,
  type ConnectorHealth,
  type ConnectorState,
} from "../shared/connector-health.ts";
import type { getConnectors } from "./gateway-client.ts";
import { singleFlight } from "./single-flight.ts";

const STORE_KEY = "connectorHealth";

/**
 * Sixty seconds. The cache exists to fold one sitting's reads into one
 * request, not to remember an answer across sittings — do not raise this for
 * efficiency; see the module doc for why that would be the wrong trade.
 */
export const CONNECTOR_HEALTH_TTL_MS = 60_000;

export interface HealthDeps {
  readonly getConnectors: typeof getConnectors;
}

interface CachedHealth {
  readonly origin: string;
  readonly fetchedAtMs: number;
  readonly entries: ReadonlyArray<readonly [string, ConnectorHealth]>;
}

/**
 * `chrome.storage` is external input — a hand-edited or half-written value
 * must not crash the worker. A value that fails this is treated as a cache
 * miss: discarded, not repaired.
 */
function isCachedHealth(v: unknown): v is CachedHealth {
  if (typeof v !== "object" || v === null) return false;
  const rec = v as Record<string, unknown>;
  if (typeof rec["origin"] !== "string" || typeof rec["fetchedAtMs"] !== "number") return false;
  if (!Number.isFinite(rec["fetchedAtMs"]) || !Array.isArray(rec["entries"])) return false;
  return rec["entries"].every((pair) => {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "object" ||
      pair[1] === null
    ) {
      return false;
    }
    const health = pair[1] as { state?: unknown; lastSuccessfulSyncMs?: unknown };
    if (!CONNECTOR_STATES.includes(health.state as ConnectorState)) {
      return false;
    }
    return (
      health.lastSuccessfulSyncMs === undefined ||
      (typeof health.lastSuccessfulSyncMs === "number" &&
        Number.isFinite(health.lastSuccessfulSyncMs))
    );
  });
}

// `singleFlight` holds ONE in-flight slot for the whole module — wrapping the
// read in it directly would hand a concurrent read for a different gateway
// origin the first origin's health (reachable during a re-pair with a panel
// open). So the slot is keyed by origin: one single-flighted reader per
// origin, created on first use for that origin.
//
// The entry is removed once its request settles, not kept forever: a reader
// closes over the `deps` of whichever call created it, and in production that
// is always the same `getConnectors` reference, so keeping it would cost
// nothing — but it would also grow one entry per origin ever seen for the
// life of the worker, and pin to a stale closure the moment a caller ever
// passes different deps (as every test here does). Evicting on settle keeps
// the map's job to exactly "coalesce reads that overlap in time".
const inFlightByOrigin = new Map<
  string,
  () => Promise<ReadonlyMap<string, ConnectorHealth> | null>
>();

function readerFor(
  deps: HealthDeps,
  origin: string,
): () => Promise<ReadonlyMap<string, ConnectorHealth> | null> {
  const existing = inFlightByOrigin.get(origin);
  if (existing !== undefined) return existing;
  const reader = singleFlight(async () => {
    try {
      return await deps.getConnectors(origin);
    } finally {
      inFlightByOrigin.delete(origin);
    }
  });
  inFlightByOrigin.set(origin, reader);
  return reader;
}

/**
 * A cached entry is used only when its `origin` matches AND it was fetched
 * less than `CONNECTOR_HEALTH_TTL_MS` ago. Anything else — no entry, a
 * different origin, an expired one, or one that fails `isCachedHealth` — is a
 * cache miss: fetch, and on success (never on `null`) persist the fresh
 * answer.
 */
export async function readConnectorHealth(
  deps: HealthDeps,
  origin: string,
  nowMs: number,
): Promise<ReadonlyMap<string, ConnectorHealth> | null> {
  // A rejected read (quota, a transient Firefox failure) must not propagate: it
  // would reject `readConnectorHealth`, then `handleResolve`, then surface the
  // whole resolve as a `server_error` — turning the gate into a new way for an
  // otherwise-working panel to break. Treat it as a cache miss instead.
  const cached = await storageGet(STORE_KEY).catch(() => undefined);
  if (
    isCachedHealth(cached) &&
    cached.origin === origin &&
    nowMs - cached.fetchedAtMs < CONNECTOR_HEALTH_TTL_MS
  ) {
    return new Map(cached.entries);
  }

  const result = await readerFor(deps, origin)();
  if (result === null) {
    return null;
  }

  const toStore: CachedHealth = {
    origin,
    fetchedAtMs: nowMs,
    entries: Array.from(result.entries()),
  };
  // A failed write is non-fatal: the fetch already succeeded, so the fetched
  // map is still a correct answer even though this sitting won't get to reuse
  // it from storage. Losing the persist must not lose the answer.
  await storageSet(STORE_KEY, toStore).catch(() => undefined);
  return result;
}
