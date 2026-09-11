// src/background/deploy-client.ts
// The deploy-readiness reads (C10), and nothing else.
//
// Split from gateway-client.ts on the egress-client.ts precedent, and for a
// sharper reason than size: these routes are UNAUTHENTICATED. They sit on the
// gateway's public read-only table, so there is no bearer header, no 403, no
// scope gap and no `nimbus clip scopes` remedy. The error vocabulary here is
// deliberately smaller than every sibling client's, and that asymmetry is a
// property of the routes rather than an oversight.

import type { DeployPreflightResult } from "../shared/deploy.ts";
import { parseDeployPreflight } from "../shared/deploy.ts";
import { endpointUrl } from "../shared/gateway.ts";
import { MAX_BRANCH_LEN, MAX_SERVICE_ID_LEN } from "../shared/services.ts";
import { isObject, readJson } from "./http-json.ts";

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

async function getJson(url: string, doFetch: FetchLike): Promise<DeployResult<unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEPLOY_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await doFetch(url, { method: "GET", signal: controller.signal });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (!res.ok) {
      return { ok: false, reason: "server_error" };
    }
    return { ok: true, value: await readJson(res) };
  } finally {
    clearTimeout(timer);
  }
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
