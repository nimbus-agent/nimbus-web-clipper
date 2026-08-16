import type { ClipPayload } from "../shared/clip.ts";
import { endpointUrl, type GatewayEndpoint, isLoopbackOrigin } from "../shared/gateway.ts";
import { isRelatedHit, type RelatedQuery } from "../shared/related.ts";
import {
  type AgentError,
  type AgentLane,
  type ClipPostResult,
  type FetchError,
  type FetchOutcome,
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
const FETCH_TIMEOUT_MS = 30_000;
const AGENT_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 800;

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

/**
 * The URL-taking core of a POST. Extracted so routes with a path parameter
 * (`/v1/agents/{agent}`) can supply a caller-built URL while everything else
 * keeps going through `postJson`'s `GatewayEndpoint` lookup — one timeout/abort
 * implementation, not a parallel one for agents.
 */
async function postJsonAt(
  doFetch: FetchLike,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(
  doFetch: FetchLike,
  origin: string,
  endpoint: GatewayEndpoint,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  return postJsonAt(doFetch, endpointUrl(origin, endpoint), body, headers, timeoutMs);
}

/** The URL-taking core of a GET — see `postJsonAt`'s doc comment. */
async function getJsonAt(
  doFetch: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, {
      method: "GET",
      headers,
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
  const qs = new URLSearchParams(query).toString();
  return getJsonAt(doFetch, `${endpointUrl(origin, endpoint)}?${qs}`, headers, timeoutMs);
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

/**
 * Is a Nimbus gateway answering on this origin?
 *
 * The only tokenless call this client makes. That is exactly why the loopback
 * check is repeated here rather than assumed: every other route carries a bearer
 * token and inherits the origin discipline of the stored connection, so this must
 * not become the one place I6 is enforced more loosely. Today `DISCOVERY_CANDIDATES`
 * is a frozen constant and the check cannot fail — it is asserted anyway, for
 * whoever makes that list configurable.
 *
 * Returns a plain boolean: a probe has exactly two outcomes the caller can act
 * on, and any richer result would tempt a caller into treating "the gateway said
 * something odd" as "the gateway is up".
 */
export async function probeHealth(origin: string, doFetch: FetchLike = fetch): Promise<boolean> {
  if (!isLoopbackOrigin(origin)) {
    return false;
  }
  let res: Response;
  try {
    res = await getJsonAt(doFetch, endpointUrl(origin, "health"), {}, HEALTH_TIMEOUT_MS);
  } catch {
    // Connection refused, DNS failure, or the 800ms abort. All mean "not here".
    return false;
  }
  if (!res.ok) {
    return false;
  }
  // Shape-check the body: something else listening on 7474 can return 200.
  //
  // `readJson` is deliberately OUTSIDE the try above, and that is safe: it is
  // total — it catches its own `res.json()` rejection and returns null
  // (gateway-client.ts:119-125), so a non-JSON body from whatever else is on
  // this port yields `null` here, not a throw. Do not widen the try to cover it;
  // a catch that can never fire reads as a real failure mode to the next person.
  const data = await readJson(res);
  return isObject(data) && data["status"] === "ok";
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
  return {
    kind: "ambiguous",
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
): Promise<
  | { ok: true; outcome: ResolveOutcome }
  | { ok: false; reason: ResolveError; scopeGap?: { required: string; granted: string[] } }
> {
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
    const body = await readJson(res);
    const gap = parseScopeGap(body);
    return gap === null
      ? { ok: false, reason: "insufficient_scope" }
      : { ok: false, reason: "insufficient_scope", scopeGap: gap };
  }
  if (res.status === 404) {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: false, reason: "server_error" };
}

/** The 403 body's scope detail. Absent or malformed => omit it; the panel then
 *  falls back to generic guidance rather than inventing a command. */
function parseScopeGap(v: unknown): { required: string; granted: string[] } | null {
  if (!isObject(v) || typeof v["required"] !== "string" || !Array.isArray(v["granted"])) {
    return null;
  }
  const granted: string[] = [];
  for (const s of v["granted"]) {
    if (typeof s !== "string") {
      return null;
    }
    granted.push(s);
  }
  return { required: v["required"], granted };
}

/**
 * True for the abort our own timeout raises. Kept narrow deliberately: anything
 * else — DNS, connection refused, a killed service worker — is `unreachable`,
 * and the two must not be confused (see FetchError's doc comment).
 */
function isAbortError(err: unknown): boolean {
  return isObject(err) && err["name"] === "AbortError";
}

function parseFetchBody(data: unknown): FetchOutcome | null {
  if (!isObject(data) || typeof data["status"] !== "string") {
    return null;
  }
  const status = data["status"];
  if (status === "indexed") {
    return typeof data["itemId"] === "string" ? { kind: "indexed", itemId: data["itemId"] } : null;
  }
  if (status === "not_found" || status === "unsupported_url" || status === "no_targeted_fetch") {
    return { kind: "unfetchable" };
  }
  if (status === "not_configured") {
    return { kind: "not-configured" };
  }
  if (status === "rate_limited") {
    return { kind: "rate-limited" };
  }
  return null;
}

/**
 * `POST /v1/items/fetch` — a WRITE under the `fetch` scope. Upstream models it as
 * an explicit write, not a read with side effects, because it causes an OUTBOUND
 * request to a configured provider under the user's stored credential. Nothing in
 * this client may call it without a user gesture behind it.
 */
export async function fetchItem(
  origin: string,
  token: string,
  pageUrl: string,
  doFetch: FetchLike = fetch,
): Promise<
  | { ok: true; outcome: FetchOutcome }
  | { ok: false; reason: FetchError; scopeGap?: { required: string; granted: string[] } }
> {
  let res: Response;
  try {
    res = await postJson(
      doFetch,
      origin,
      "itemsFetch",
      { url: pageUrl },
      { authorization: `Bearer ${token}` },
      FETCH_TIMEOUT_MS,
    );
  } catch (err) {
    return { ok: false, reason: isAbortError(err) ? "timeout" : "unreachable" };
  }
  if (res.status === 200) {
    const outcome = parseFetchBody(await readJson(res));
    return outcome === null ? { ok: false, reason: "server_error" } : { ok: true, outcome };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 403) {
    const gap = parseScopeGap(await readJson(res));
    return gap === null
      ? { ok: false, reason: "insufficient_scope" }
      : { ok: false, reason: "insufficient_scope", scopeGap: gap };
  }
  if (res.status === 404) {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: false, reason: "server_error" };
}

/** `POST /v1/agents/{agent}` — invoke, returning a run id to poll. */
export async function invokeAgent(
  origin: string,
  token: string,
  agent: AgentLane,
  params: unknown,
  doFetch: FetchLike = fetch,
): Promise<
  | { ok: true; runId: string }
  | { ok: false; reason: AgentError; scopeGap?: { required: string; granted: string[] } }
  | { ok: false; reason: "busy"; retryAfterMs: number }
> {
  let res: Response;
  try {
    res = await postJsonAt(
      doFetch,
      `${endpointUrl(origin, "agents")}/${encodeURIComponent(agent)}`,
      params,
      { authorization: `Bearer ${token}` },
      AGENT_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 202) {
    const data = await readJson(res);
    return isObject(data) && typeof data["runId"] === "string"
      ? { ok: true, runId: data["runId"] }
      : { ok: false, reason: "server_error" };
  }
  if (res.status === 429) {
    return {
      ok: false,
      reason: "busy",
      retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
    };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 403) {
    const gap = parseScopeGap(await readJson(res));
    return gap === null
      ? { ok: false, reason: "insufficient_scope" }
      : { ok: false, reason: "insufficient_scope", scopeGap: gap };
  }
  if (res.status === 404) {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: false, reason: "server_error" };
}

/** The terminal answer a 200 body can carry, or a `server_error` when it is malformed. */
type AgentRunBody =
  | { ok: true; status: "running" }
  | { ok: true; status: "done"; brief: string }
  | { ok: true; status: "failed"; failureReason?: string }
  | { ok: false; reason: AgentError };

/**
 * Interpret the body of a 200 from `GET /v1/agents/runs/{id}`.
 *
 * Split out of {@link getAgentRun} so that function stays under the
 * cognitive-complexity gate (Sonar `S3776`): every branch here is about the SHAPE of a
 * successful response, while its caller is about HTTP status. Behaviour is unchanged.
 */
function parseAgentRunBody(data: unknown): AgentRunBody {
  if (!isObject(data)) {
    return { ok: false, reason: "server_error" };
  }
  if (data["status"] === "running") {
    return { ok: true, status: "running" };
  }
  // A `done` run with no brief is malformed — rendering an empty lane would
  // violate the phase's "never a silent empty lane" rule.
  if (data["status"] === "done") {
    return typeof data["brief"] === "string"
      ? { ok: true, status: "done", brief: data["brief"] }
      : { ok: false, reason: "server_error" };
  }
  if (data["status"] === "failed") {
    if (data["failureReason"] === undefined) {
      return { ok: true, status: "failed" };
    }
    return typeof data["failureReason"] === "string"
      ? { ok: true, status: "failed", failureReason: data["failureReason"] }
      : { ok: false, reason: "server_error" };
  }
  // Unknown status: never treated as a terminal answer.
  return { ok: false, reason: "server_error" };
}

/**
 * `GET /v1/agents/runs/{id}` — poll a run. 404 (unknown) and 410 (expired) both
 * collapse to `stale`: upstream distinguishes unknown-or-lost-to-restart from
 * known-and-expired, but the client's answer to both is to re-issue, never to
 * keep waiting — see `AgentError`'s doc comment.
 */
export async function getAgentRun(
  origin: string,
  token: string,
  runId: string,
  doFetch: FetchLike = fetch,
): Promise<
  | { ok: true; status: "running" }
  | { ok: true; status: "done"; brief: string }
  // `failureReason` is OPTIONAL, not always present: upstream builds the body as
  // `...(run.error === null ? {} : { failureReason: run.error })`
  // (ipc/http-server.ts), so an absent one is a well-formed "the run failed, no
  // explanation given" — not a malformed response. Only a PRESENT-but-non-string
  // value is malformed (falls through to `server_error` below).
  | { ok: true; status: "failed"; failureReason?: string }
  | { ok: false; reason: AgentError; scopeGap?: { required: string; granted: string[] } }
> {
  let res: Response;
  try {
    res = await getJsonAt(
      doFetch,
      `${endpointUrl(origin, "agentRuns")}/${encodeURIComponent(runId)}`,
      { authorization: `Bearer ${token}` },
      AGENT_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    return parseAgentRunBody(await readJson(res));
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 403) {
    const gap = parseScopeGap(await readJson(res));
    return gap === null
      ? { ok: false, reason: "insufficient_scope" }
      : { ok: false, reason: "insufficient_scope", scopeGap: gap };
  }
  if (res.status === 404 || res.status === 410) {
    return { ok: false, reason: "stale" };
  }
  return { ok: false, reason: "server_error" };
}
