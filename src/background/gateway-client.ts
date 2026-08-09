import type { ClipPayload } from "../shared/clip.ts";
import { endpointUrl, type GatewayEndpoint } from "../shared/gateway.ts";
import { isRelatedHit, type RelatedQuery } from "../shared/related.ts";
import {
  type ClipPostResult,
  type PairError,
  RESOLVE_MATCH_KINDS,
  type RelatedError,
  type RelatedHit,
  type ResolveCandidate,
  type ResolvedItem,
  type ResolveError,
  type ResolveMatchKind,
  type ResolveOutcome,
} from "../shared/types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const PAIR_TIMEOUT_MS = 5_000;
const CLIP_TIMEOUT_MS = 10_000;
const RELATED_TIMEOUT_MS = 8_000;
const RESOLVE_TIMEOUT_MS = 8_000;

const DEFAULT_RETRY_AFTER_MS = 60_000; // the gateway's full rate-limit window
const MAX_RETRY_AFTER_MS = 120_000;

/**
 * Parse a `Retry-After` delta-seconds header into ms.
 *
 * Strict digits only. We deliberately do NOT accept the HTTP-date form: the only
 * writer is the loopback gateway (no proxy or CDN can interpose), and resolving a
 * date would depend on the browser and gateway clocks agreeing — the very thing
 * that makes `X-RateLimit-Reset` unusable here. Anything unparseable waits out the
 * full window; anything absurd is clamped so a bad header cannot wedge the queue.
 */
export function parseRetryAfterMs(header: string | null): number {
  if (header === null || !/^\d+$/.test(header.trim())) {
    return DEFAULT_RETRY_AFTER_MS;
  }
  return Math.min(Number(header.trim()) * 1000, MAX_RETRY_AFTER_MS);
}

async function postJson(
  doFetch: FetchLike,
  origin: string,
  endpoint: GatewayEndpoint,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(endpointUrl(origin, endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(
  doFetch: FetchLike,
  origin: string,
  endpoint: GatewayEndpoint,
  query: Record<string, string>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const qs = new URLSearchParams(query).toString();
  try {
    return await doFetch(`${endpointUrl(origin, endpoint)}?${qs}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export async function confirmPair(
  origin: string,
  code: string,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true; token: string; label: string } | { ok: false; reason: PairError }> {
  let res: Response;
  try {
    res = await postJson(doFetch, origin, "pairConfirm", { code }, {}, PAIR_TIMEOUT_MS);
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    if (isObject(data) && typeof data["token"] === "string" && typeof data["label"] === "string") {
      return { ok: true, token: data["token"], label: data["label"] };
    }
    return { ok: false, reason: "server_error" };
  }
  if (res.status === 403) {
    return { ok: false, reason: "pairing_failed" };
  }
  return { ok: false, reason: "server_error" };
}

export async function postClip(
  origin: string,
  token: string,
  payload: ClipPayload,
  doFetch: FetchLike = fetch,
): Promise<ClipPostResult> {
  let res: Response;
  try {
    res = await postJson(
      doFetch,
      origin,
      "ingest",
      payload,
      { authorization: `Bearer ${token}` },
      CLIP_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    if (isObject(data) && (data["status"] === "created" || data["status"] === "updated")) {
      return { ok: true, status: data["status"] };
    }
    return { ok: false, reason: "server_error" };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 400) {
    return { ok: false, reason: "invalid_request" };
  }
  if (res.status === 413) {
    return { ok: false, reason: "payload_too_large" };
  }
  if (res.status === 429) {
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
    };
  }
  return { ok: false, reason: "server_error" };
}

export async function postRelated(
  origin: string,
  token: string,
  query: RelatedQuery,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true; items: RelatedHit[] } | { ok: false; reason: RelatedError }> {
  let res: Response;
  try {
    res = await postJson(
      doFetch,
      origin,
      "related",
      query,
      { authorization: `Bearer ${token}` },
      RELATED_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    if (isObject(data) && Array.isArray(data["items"]) && data["items"].every(isRelatedHit)) {
      return { ok: true, items: data["items"] as RelatedHit[] };
    }
    return { ok: false, reason: "server_error" };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: false, reason: "server_error" };
}

function isMatchKind(v: unknown): v is ResolveMatchKind {
  return typeof v === "string" && (RESOLVE_MATCH_KINDS as readonly string[]).includes(v);
}

/** The wire's candidate shape. Metadata only — resolve never returns a body. */
function parseCandidate(v: unknown): ResolveCandidate | null {
  if (
    !isObject(v) ||
    typeof v["id"] !== "string" ||
    typeof v["service"] !== "string" ||
    typeof v["type"] !== "string" ||
    typeof v["title"] !== "string" ||
    !(v["url"] === null || typeof v["url"] === "string")
  ) {
    return null;
  }
  return {
    id: v["id"],
    service: v["service"],
    type: v["type"],
    title: v["title"],
    url: v["url"],
  };
}

/** A candidate plus freshness. `modified_at` is the ONLY snake_case field on the
 *  wire, and this is the only place it is spelled that way. */
function parseItem(v: unknown): ResolvedItem | null {
  const base = parseCandidate(v);
  if (base === null || !isObject(v) || typeof v["modified_at"] !== "number") {
    return null;
  }
  return { ...base, modifiedAt: v["modified_at"] };
}

/**
 * Narrows a 200 body into one of the four outcomes, or null when the gateway sent
 * something this client does not model.
 *
 * Returning null (=> server_error) rather than a "miss" is deliberate: an
 * unrecognised body must never render as a confident "not indexed".
 */
function parseResolveBody(data: unknown): ResolveOutcome | null {
  if (!isObject(data)) {
    return null;
  }
  if (data["found"] === true) {
    const item = parseItem(data["item"]);
    return item !== null && isMatchKind(data["matchKind"])
      ? { kind: "found", item, matchKind: data["matchKind"] }
      : null;
  }
  if (data["found"] !== false || typeof data["fetchable"] !== "boolean") {
    return null;
  }
  const fetchable = data["fetchable"];
  const reason = data["reason"];
  if (reason === "not_indexed") {
    return { kind: "not-indexed", fetchable };
  }
  if (reason === "unresolvable_url") {
    return { kind: "unresolvable", fetchable };
  }
  if (reason !== "ambiguous" || typeof data["truncated"] !== "boolean") {
    return null;
  }
  const raw = data["candidates"];
  if (!Array.isArray(raw)) {
    return null;
  }
  const candidates: ResolveCandidate[] = [];
  for (const c of raw) {
    const parsed = parseCandidate(c);
    if (parsed === null) {
      return null;
    }
    candidates.push(parsed);
  }
  const service = data["service"];
  // Reject, don't coerce: every other unexpected type in this parser returns
  // null (=> server_error). Silently folding a wire-shape violation into `null`
  // here would make it a plausible-looking value instead of the loud failure it
  // should be.
  if (!(service === null || typeof service === "string")) {
    return null;
  }
  return {
    kind: "ambiguous",
    service,
    fetchable,
    candidates,
    truncated: data["truncated"],
  };
}

/**
 * `GET /v1/items/resolve?url=` — a bearer read under the `resolve` scope.
 *
 * Sends the page URL as the recogniser normalised it and lets the gateway's
 * canonicalizeUrl + match ladder do the rest; this client does no canonicalisation
 * of its own (see shared/recognise.ts).
 *
 * The 403 mapping is the load-bearing one: LEGACY_SCOPES is ["clip","briefs"], so
 * every browser paired before scopes lacks `resolve` and lands here first. Folding
 * it into server_error would blame the gateway for a grant the owner simply has
 * not made yet.
 */
export async function resolveItem(
  origin: string,
  token: string,
  pageUrl: string,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true; outcome: ResolveOutcome } | { ok: false; reason: ResolveError }> {
  let res: Response;
  try {
    res = await getJson(
      doFetch,
      origin,
      "resolve",
      { url: pageUrl },
      { authorization: `Bearer ${token}` },
      RESOLVE_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const outcome = parseResolveBody(await readJson(res));
    return outcome === null ? { ok: false, reason: "server_error" } : { ok: true, outcome };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 403) {
    return { ok: false, reason: "insufficient_scope" };
  }
  if (res.status === 404) {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: false, reason: "server_error" };
}
