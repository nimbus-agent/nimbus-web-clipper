// src/background/deploy-client.ts
// The deploy-readiness reads (C10), and nothing else.
//
// Split from gateway-client.ts on the egress-client.ts precedent. Three of the
// four reads here are UNAUTHENTICATED — `fetchPreflight`, `fetchItemBranch` and
// the two DORA reads sit on the gateway's public read-only table, so they send
// no bearer header and their error vocabulary (`DeployError`) has no 403, no
// scope gap and no `nimbus clip scopes` remedy.
//
// `fetchServiceResolution` is NOT one of them (C10.3). It is a bearer read under
// the `resolve` scope with the full sibling vocabulary, and it carries its own
// result type rather than widening `DeployError` — a 403 on a public route would
// be a contradiction, and one shared union would make that unrepresentable
// difference invisible.

import type { DeployPreflightResult, ServiceResolution } from "../shared/deploy.ts";
import { parseDeployPreflight, parseServiceResolution, sendableId } from "../shared/deploy.ts";
import {
  type DoraMetricsResult,
  type DoraRangeId,
  parseDoraMetrics,
  parseStatsSeries,
  RANGES,
  type StatsMetricId,
  type StatsReadFailure,
  type StatsSeries,
} from "../shared/dora.ts";
import { endpointUrl } from "../shared/gateway.ts";
import { isObject } from "../shared/is-object.ts";
import { MAX_BRANCH_LEN, MAX_SERVICE_ID_LEN } from "../shared/services.ts";
import { type RawScopeGap, readJson, scopedGet, withTimeout } from "./http-json.ts";

/** Reads over a local index; short enough that a wedged gateway does not hang
 *  the section behind it. */
const DEPLOY_TIMEOUT_MS = 10_000;

/** The gateway's bounds are enforced BEFORE sending, so a request that cannot
 *  succeed is never round-tripped — but the numbers themselves come from
 *  `src/shared/services.ts`, which is the one place they are written down. The
 *  guard that reads a stored binding and the client that sends one must agree
 *  by construction, not by two files happening to say 64. */
const DEFAULT_MAX_FINDINGS = 10;

export type DeployError = "unreachable" | "server_error" | "malformed";

export type DeployResult<T> = { ok: true; value: T } | { ok: false; reason: DeployError };

type FetchLike = typeof fetch;

/** The timer bounds the body read too, exactly as `scopedGet`'s does. */
async function getJson(url: string, doFetch: FetchLike): Promise<DeployResult<unknown>> {
  return await withTimeout(DEPLOY_TIMEOUT_MS, async (signal): Promise<DeployResult<unknown>> => {
    let res: Response;
    try {
      res = await doFetch(url, { method: "GET", signal });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (!res.ok) {
      return { ok: false, reason: "server_error" };
    }
    return { ok: true, value: await readJson(res) };
  });
}

export async function fetchPreflight(
  origin: string,
  service: string,
  targetRef: string,
  doFetch: FetchLike,
  maxFindings: number = DEFAULT_MAX_FINDINGS,
): Promise<DeployResult<DeployPreflightResult>> {
  if (service.length < 1 || service.length > MAX_SERVICE_ID_LEN) {
    return { ok: false, reason: "malformed" };
  }
  if (targetRef.length < 1 || targetRef.length > MAX_BRANCH_LEN) {
    return { ok: false, reason: "malformed" };
  }
  const qs = new URLSearchParams({
    service,
    target_ref: targetRef,
    max_findings: String(maxFindings),
  }).toString();
  const res = await getJson(`${endpointUrl(origin, "preflightDeploy")}?${qs}`, doFetch);
  if (!res.ok) {
    return res;
  }
  const parsed = parseDeployPreflight(res.value);
  return parsed === null ? { ok: false, reason: "malformed" } : { ok: true, value: parsed };
}

/**
 * The branch this item is on, or `null` when the index does not hold one.
 *
 * Returns ONLY the branch. `GET /v1/items/{id}` answers the full row including
 * `body`; nothing but this string may leave this function, because its caller
 * hands the result to a content script.
 *
 * An absent item, an item with no `metadata`, and an item whose metadata has no
 * branch are all `value: null` rather than failures: none of them is an error,
 * and all three end the same way — §4.3's ladder falls through to the binding's
 * `defaultBranch`.
 */
export async function fetchItemBranch(
  origin: string,
  itemId: string,
  doFetch: FetchLike,
): Promise<DeployResult<string | null>> {
  const url = `${endpointUrl(origin, "items")}/${encodeURIComponent(itemId)}`;
  const res = await getJson(url, doFetch);
  if (!res.ok) {
    return res;
  }
  if (!isObject(res.value)) {
    return { ok: false, reason: "malformed" };
  }
  const data = res.value["data"];
  if (!isObject(data)) {
    return { ok: true, value: null };
  }
  // `metadata` is a JSON TEXT column upstream. Some readers hand it back parsed
  // and some as the raw string; accept both rather than betting on one.
  const raw = data["metadata"];
  let meta: unknown = raw;
  if (typeof raw === "string") {
    try {
      meta = JSON.parse(raw);
    } catch {
      return { ok: true, value: null };
    }
  }
  if (!isObject(meta)) {
    return { ok: true, value: null };
  }
  const branch = meta["branch"];
  return { ok: true, value: typeof branch === "string" && branch !== "" ? branch : null };
}

/**
 * The full sibling vocabulary, unlike `DeployError` — see this file's header.
 * The egress reads' vocabulary, member for member, because both are read through
 * the same `scopedGet` ladder rather than naming the same statuses twice.
 */
export type ServiceResolveError =
  | "unauthorized"
  | "insufficient_scope"
  | "unsupported"
  | "rate_limited"
  | "unreachable"
  | "server_error";

export type ServiceResolveResult =
  | { ok: true; value: ServiceResolution }
  | { ok: false; reason: ServiceResolveError; scopeGap?: RawScopeGap };

/**
 * Which Nimbus service claims `urn`, as the gateway sees it.
 *
 * Deliberately NOT routed through this file's `getJson`: that helper sends no
 * authorization header and collapses every non-200 to `server_error`, which
 * would erase exactly the 403 this route exists to report actionably. It is the
 * shared scoped read instead — the egress reads' ladder, timer and all, including
 * the 429 arm this route does not answer today.
 */
export async function fetchServiceResolution(
  origin: string,
  token: string,
  urn: string,
  doFetch: FetchLike,
): Promise<ServiceResolveResult> {
  const qs = new URLSearchParams({ repo: urn }).toString();
  const url = `${endpointUrl(origin, "servicesResolve")}?${qs}`;
  return await scopedGet(url, token, DEPLOY_TIMEOUT_MS, parseServiceResolution, doFetch);
}

/**
 * The headline envelope for one range (C10.2). Public route, so `getJson`'s
 * three-outcome ladder is the whole vocabulary — an unknown service is not a
 * 400 here but a 200 whose metrics all carry `unknown_service`.
 */
export async function fetchDoraMetrics(
  origin: string,
  service: string,
  range: DoraRangeId,
  doFetch: FetchLike,
): Promise<DeployResult<DoraMetricsResult>> {
  if (!sendableId(service)) {
    return { ok: false, reason: "malformed" };
  }
  const qs = new URLSearchParams({ service, since: RANGES[range].since }).toString();
  const res = await getJson(`${endpointUrl(origin, "metricsDora")}?${qs}`, doFetch);
  if (!res.ok) {
    return res;
  }
  const parsed = parseDoraMetrics(res.value, service);
  return parsed === null ? { ok: false, reason: "malformed" } : { ok: true, value: parsed };
}

export type StatsResult =
  | { ok: true; value: StatsSeries }
  | { ok: false; reason: StatsReadFailure };

/**
 * One metric's series for one range. NOT routed through `getJson`, which
 * collapses every non-2xx into `server_error`: upstream's 404 means "this
 * gateway predates the route" and its 400 means "refused", and the page renders
 * the two differently (spec §6.2).
 */
export async function fetchStatsSeries(
  origin: string,
  service: string,
  range: DoraRangeId,
  metric: StatsMetricId,
  doFetch: FetchLike,
): Promise<StatsResult> {
  if (!sendableId(service)) {
    return { ok: false, reason: "malformed" };
  }
  const r = RANGES[range];
  const qs = new URLSearchParams({
    service,
    metric,
    window_ms: String(r.windowMs),
    bucket_ms: String(r.bucketMs),
  }).toString();
  const url = `${endpointUrl(origin, "metricsStats")}?${qs}`;
  return await withTimeout(DEPLOY_TIMEOUT_MS, async (signal): Promise<StatsResult> => {
    let res: Response;
    try {
      res = await doFetch(url, { method: "GET", signal });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (res.status === 404) return { ok: false, reason: "unsupported" };
    if (res.status === 400) return { ok: false, reason: "refused" };
    if (!res.ok) return { ok: false, reason: "server_error" };
    const body = await readJson(res);
    // `readJson` swallows an abort into `null`; a timeout mid-body is a gateway
    // that stopped answering, not one that answered nonsense.
    if (signal.aborted) return { ok: false, reason: "unreachable" };
    const parsed = parseStatsSeries(body, service, metric);
    return parsed === null ? { ok: false, reason: "malformed" } : { ok: true, value: parsed };
  });
}
