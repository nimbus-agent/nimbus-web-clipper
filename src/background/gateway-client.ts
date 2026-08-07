import type { ClipPayload } from "../shared/clip.ts";
import { endpointUrl, type GatewayEndpoint } from "../shared/gateway.ts";
import { isResolvedItem } from "../shared/messages.ts";
import { isRelatedHit, type RelatedQuery } from "../shared/related.ts";
import type {
  ClipPostResult,
  PairError,
  RelatedError,
  RelatedHit,
  ResolvedItem,
  ResolveError,
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

/**
 * Resolve a canonical URL to at most one indexed item.
 *
 * PROPOSED route — see shared/gateway.ts#PROPOSED_PATHS. The 404 mapping is
 * load-bearing: a MISS is a 200 with `item: null`, while an ABSENT ROUTE is a
 * 404. Keeping them distinct is what lets this ship before the gateway has the
 * route and flip to live with no code change.
 */
export async function postResolve(
  origin: string,
  token: string,
  canonicalUrl: string,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true; item: ResolvedItem | null } | { ok: false; reason: ResolveError }> {
  let res: Response;
  try {
    res = await postJson(
      doFetch,
      origin,
      "resolve",
      { canonicalUrl },
      { authorization: `Bearer ${token}` },
      RESOLVE_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    if (!isObject(data)) {
      return { ok: false, reason: "server_error" };
    }
    if (data["item"] === null) {
      return { ok: true, item: null };
    }
    if (isResolvedItem(data["item"])) {
      return { ok: true, item: data["item"] };
    }
    return { ok: false, reason: "server_error" };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 404) {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: false, reason: "server_error" };
}
