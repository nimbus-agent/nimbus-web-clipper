// src/background/brief-client.ts
// The five routes of the research-briefs surface, and nothing else.
//
// Split from gateway-client.ts rather than added to it: that file is already 648
// lines across six routes, and these five share a path prefix, an error
// vocabulary and a rate-limit bucket that none of the others do.
//
// The `briefs` scope is LEGACY (`clips/api-scopes.ts`), so a 403 here is the
// uncommon case rather than the first thing a pre-scopes token hits — but it is
// still parsed into a scopeGap, because a token minted after scopes exist can
// have been narrowed by the owner.

import type { BriefSourceBody, BriefSourceDecl } from "../shared/brief.ts";
import { type BriefReport, isBriefReport } from "../shared/brief-report.ts";
import { endpointUrl } from "../shared/gateway.ts";

/** Create/run/save share the gateway's `brief` bucket; feeding has its own. */
const BRIEF_TIMEOUT_MS = 10_000;
/** Synthesis is the long one — the poll, not the run trigger, waits it out. */
const BRIEF_POLL_TIMEOUT_MS = 15_000;

export type BriefError =
  | "unreachable"
  | "unauthorized"
  | "insufficient_scope"
  | "not_found"
  | "expired"
  | "busy"
  | "rate_limited"
  | "server_error";

/**
 * A refused feed. Both arrive as `413 payload_too_large` and differ only in
 * `detail`, which is why they are one reason with a discriminating field rather
 * than two reasons: the status code alone cannot tell them apart.
 */
export type FeedRefusal = "source_too_large" | "run_capacity";

export type ScopeGap = { required: string; granted: string[] };

type FetchLike = typeof fetch;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function parseScopeGap(body: unknown): ScopeGap | null {
  if (!isObject(body) || typeof body["required"] !== "string") {
    return null;
  }
  const granted = body["granted"];
  if (!Array.isArray(granted) || !granted.every((g) => typeof g === "string")) {
    return null;
  }
  return { required: body["required"], granted: [...granted] };
}

function briefUrl(origin: string, id?: string, action?: string): string {
  const base = endpointUrl(origin, "briefs");
  if (id === undefined) {
    return base;
  }
  const tail = action === undefined ? "" : `/${action}`;
  return `${base}/${encodeURIComponent(id)}${tail}`;
}

async function send(
  doFetch: FetchLike,
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
  method: "GET" | "POST",
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, {
      method,
      headers:
        body === undefined
          ? { authorization: `Bearer ${token}` }
          : { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** The status→reason mapping shared by every route here. Callers handle 200/403/404 themselves. */
function commonError(status: number): BriefError | null {
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 410) {
    return "expired";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 503) {
    return "busy";
  }
  return null;
}

export async function createBrief(
  origin: string,
  token: string,
  body: { brief: string; sources: BriefSourceDecl[]; useIndex: boolean },
  doFetch: FetchLike = fetch,
): Promise<
  | { ok: true; id: string; expected: number }
  | { ok: false; reason: BriefError; scopeGap?: ScopeGap }
  | { ok: false; reason: "disabled"; hint?: string }
> {
  let res: Response;
  try {
    res = await send(doFetch, briefUrl(origin), token, body, BRIEF_TIMEOUT_MS, "POST");
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    return isObject(data) && typeof data["id"] === "string" && typeof data["expected"] === "number"
      ? { ok: true, id: data["id"], expected: data["expected"] }
      : { ok: false, reason: "server_error" };
  }
  if (res.status === 403) {
    const gap = parseScopeGap(await readJson(res));
    return gap === null
      ? { ok: false, reason: "insufficient_scope" }
      : { ok: false, reason: "insufficient_scope", scopeGap: gap };
  }
  // 404 on CREATE is the seam being off, not a missing run — there is no id yet
  // to be missing. Carry the gateway's own hint rather than inventing copy.
  if (res.status === 404) {
    const data = await readJson(res);
    const hint = isObject(data) && typeof data["hint"] === "string" ? data["hint"] : undefined;
    return hint === undefined
      ? { ok: false, reason: "disabled" }
      : { ok: false, reason: "disabled", hint };
  }
  return { ok: false, reason: commonError(res.status) ?? "server_error" };
}

export async function feedBriefSource(
  origin: string,
  token: string,
  id: string,
  source: BriefSourceBody,
  doFetch: FetchLike = fetch,
): Promise<
  | { ok: true; received: number; expected: number }
  | { ok: false; reason: BriefError }
  | { ok: false; reason: "refused"; detail: FeedRefusal }
> {
  let res: Response;
  try {
    res = await send(
      doFetch,
      briefUrl(origin, id, "sources"),
      token,
      source,
      BRIEF_TIMEOUT_MS,
      "POST",
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    return isObject(data) &&
      typeof data["received"] === "number" &&
      typeof data["expected"] === "number"
      ? { ok: true, received: data["received"], expected: data["expected"] }
      : { ok: false, reason: "server_error" };
  }
  if (res.status === 413) {
    const data = await readJson(res);
    // Default to `source_too_large`, the RECOVERABLE reading: it retries one
    // source, where `run_capacity` stops the whole feed. Guessing the
    // destructive one on an unrecognised detail would abandon sources the
    // gateway never refused.
    const detail: FeedRefusal =
      isObject(data) && data["detail"] === "run_capacity" ? "run_capacity" : "source_too_large";
    return { ok: false, reason: "refused", detail };
  }
  if (res.status === 403) {
    return { ok: false, reason: "insufficient_scope" };
  }
  if (res.status === 404) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: commonError(res.status) ?? "server_error" };
}

export async function runBrief(
  origin: string,
  token: string,
  id: string,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true } | { ok: false; reason: BriefError }> {
  let res: Response;
  try {
    res = await send(
      doFetch,
      briefUrl(origin, id, "run"),
      token,
      undefined,
      BRIEF_TIMEOUT_MS,
      "POST",
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    return { ok: true };
  }
  if (res.status === 403) {
    return { ok: false, reason: "insufficient_scope" };
  }
  if (res.status === 404) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: commonError(res.status) ?? "server_error" };
}

/** The terminal answer a 200 body can carry, or a `server_error` when it is malformed. */
type BriefBody =
  | { ok: true; status: "collecting" | "running" }
  | { ok: true; status: "done"; report: BriefReport }
  | { ok: true; status: "failed"; failureReason?: string }
  | { ok: false; reason: BriefError };

/**
 * Interpret a 200 from `GET /v1/briefs/{id}`.
 *
 * Split out of {@link getBrief} for the same reason `parseAgentRunBody` was
 * split out of `getAgentRun`: every branch here is about the SHAPE of a body,
 * and folding them into the status ladder puts that function over Sonar's
 * cognitive-complexity cap (S3776, 15).
 */
function parseBriefBody(data: unknown): BriefBody {
  if (!isObject(data)) {
    return { ok: false, reason: "server_error" };
  }
  const status = data["status"];
  if (status === "collecting" || status === "running") {
    return { ok: true, status };
  }
  if (status === "done") {
    const report = data["report"];
    return isBriefReport(report)
      ? { ok: true, status: "done", report }
      : { ok: false, reason: "server_error" };
  }
  if (status === "failed") {
    const reason = data["failureReason"];
    return typeof reason === "string"
      ? { ok: true, status: "failed", failureReason: reason }
      : { ok: true, status: "failed" };
  }
  return { ok: false, reason: "server_error" };
}

export async function getBrief(
  origin: string,
  token: string,
  id: string,
  doFetch: FetchLike = fetch,
): Promise<BriefBody> {
  let res: Response;
  try {
    res = await send(doFetch, briefUrl(origin, id), token, undefined, BRIEF_POLL_TIMEOUT_MS, "GET");
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    return parseBriefBody(await readJson(res));
  }
  if (res.status === 403) {
    return { ok: false, reason: "insufficient_scope" };
  }
  if (res.status === 404) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: commonError(res.status) ?? "server_error" };
}

export async function saveBrief(
  origin: string,
  token: string,
  id: string,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true; itemId: string } | { ok: false; reason: BriefError }> {
  let res: Response;
  try {
    res = await send(
      doFetch,
      briefUrl(origin, id, "save"),
      token,
      undefined,
      BRIEF_TIMEOUT_MS,
      "POST",
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    return isObject(data) && typeof data["itemId"] === "string"
      ? { ok: true, itemId: data["itemId"] }
      : { ok: false, reason: "server_error" };
  }
  if (res.status === 403) {
    return { ok: false, reason: "insufficient_scope" };
  }
  if (res.status === 404) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: commonError(res.status) ?? "server_error" };
}
