// src/background/http-json.ts
// What every gateway client in this folder does to an exchange before it trusts
// anything in it: bound it with a timeout, read the body without throwing, and —
// for a bearer-authed, scoped route — map the statuses every such route shares,
// the 403's scope detail included. Plus the one step that detail takes next: the
// handlers attaching the device label to it.
//
// `gateway-client.ts`, `egress-client.ts` and `brief-client.ts` each carried
// their own copy of the parsers. Two of the `parseScopeGap` copies were
// byte-identical and the third differed only in spelling (`.every()` versus a
// loop) — three parsers for ONE wire shape, which is the drift class this repo
// has already been bitten by once as `isResolvedItem`. The status ladder went the
// same way: the 403 arm was spelled out by hand in eight functions across four
// clients, and `deploy-client.ts`'s service resolve copied `egress-client.ts`'s
// whole read, timer and all.
//
// The scope gap is the one that matters most. Its output is rendered into a
// pasteable `nimbus clip scopes <label> --set <scopes>` command, and `--set`
// REPLACES the token's scope set — so a gap parsed from a partial body would
// build a command that silently REVOKES scopes the token already has. Nothing
// short of the full shape may produce one.

import { isObject } from "../shared/is-object.ts";
import type { ScopeGap } from "../shared/types.ts";

/** Every client here takes its `fetch` injected, so a test can stand in for it. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Run `exchange` under an abort timer that stays armed until `exchange` settles,
 * and is cleared then — on success, on failure, and after the abort itself.
 *
 * WHAT the timeout bounds is whatever the callback awaits, and the two shapes in
 * this folder differ on purpose. A callback that returns the bare `Response`
 * (`gateway-client.ts`'s request cores, `brief-client.ts`'s `send`) bounds the
 * wait for HEADERS only. One that also reads the body (`scopedGet`, the agent
 * roster read, the public deploy reads) bounds the whole exchange, so a gateway
 * that answers 200 and then hangs its body stream is still cut off.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  exchange: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await exchange(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The body, or `null` when there isn't one that parses.
 *
 * A gateway behind a proxy can answer HTML on an error, and a killed connection
 * can truncate a body mid-object. Neither may throw out of a route's `await`:
 * every caller here is reached from a `void`-ed handler, where a rejection
 * surfaces as an unhandled rejection rather than a reason the user can act on.
 */
export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * The gateway's raw 403 detail, as its body carries it.
 *
 * Deliberately NOT `shared/types.ts`'s `ScopeGap`, which also carries the device
 * `label`: the label is client-side state the 403 body cannot carry, and a client
 * module has no business knowing it. A handler — the only layer holding a
 * `Connection` — widens it with {@link withLabel}.
 */
export type RawScopeGap = { required: string; granted: string[] };

/** The gateway's raw 403 detail, or `null` if the body is not exactly that. */
export function parseScopeGap(v: unknown): RawScopeGap | null {
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
 * Widen the gateway's raw two-field gap into the `ScopeGap` the views need.
 *
 * The device label is what lets `scopeCommand` build a pasteable
 * `nimbus clip scopes <label> --set …`. Absent stays absent: a refusal whose 403
 * carried no detail gets no gap, never a fabricated one.
 */
export function withLabel(label: string, gap: RawScopeGap | undefined): ScopeGap | undefined {
  return gap === undefined ? undefined : { label, ...gap };
}

/** A 403 from a scoped route: the token lacks a scope the route requires. */
export type ScopeRefusal = { ok: false; reason: "insufficient_scope"; scopeGap?: RawScopeGap };

/**
 * The 403 arm every scoped route shares.
 *
 * `insufficient_scope` is reported either way — LEGACY_SCOPES is
 * `["clip", "briefs"]`, so a browser paired before scopes existed lands here on
 * its first `resolve`/`fetch`/`agents`/`egress` request, and folding that into
 * `server_error` would blame the gateway for a grant the owner simply has not made
 * yet. The gap rides along only when the body is exactly the gateway's detail;
 * absent or malformed, it is omitted and the view falls back to generic guidance
 * rather than inventing a command.
 */
export async function scopeRefusal(res: Response): Promise<ScopeRefusal> {
  const gap = parseScopeGap(await readJson(res));
  return gap === null
    ? { ok: false, reason: "insufficient_scope" }
    : { ok: false, reason: "insufficient_scope", scopeGap: gap };
}

export type ScopedRouteFailure =
  | { ok: false; reason: "unauthorized" | "unsupported" | "server_error" }
  | ScopeRefusal;

/**
 * The statuses every bearer-authed, scoped route maps the same way, and the
 * fallback for every status a route does not name: 401 → `unauthorized`, 403 →
 * {@link scopeRefusal}, 404 → `unsupported` (a gateway that does not serve the
 * route at all), anything else → `server_error`.
 *
 * Call it LAST. A route checks its own success status first, and then any status
 * it gives a meaning of its own — resolve-file's 404 is an answer, a run poll's
 * 404/410 is `stale`, an invoke's 429 is `busy` — so those never fall through to
 * the generic arms here.
 */
export async function scopedRouteFailure(res: Response): Promise<ScopedRouteFailure> {
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 403) {
    return await scopeRefusal(res);
  }
  if (res.status === 404) {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: false, reason: "server_error" };
}

export type ScopedReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "unreachable" | "rate_limited" }
  | ScopedRouteFailure;

/**
 * One bearer GET, one status ladder, one parse — the shape of a scoped READ
 * (the four egress-ledger reads and the service resolve).
 *
 * Every route that uses it differs only in its URL, its timeout and how it reads
 * a 200, so the ladder lives once and a new route cannot map its statuses
 * differently from its siblings. A 200 whose body `parse` rejects is
 * `server_error`, never a default.
 *
 * The timer stays ARMED across the body read and is cleared only once this
 * function is done. Clearing it as soon as the headers arrive would leave a
 * gateway that answers 200 and then hangs its body stream un-timed-out — the page
 * would wait forever on a read that the timeout was supposed to bound.
 *
 * The 429 arm is carried even for a route that is not rate-limited today: the
 * gateway has an `HttpWriteRateLimiter` and does answer 429 on at least one route
 * (`/v1/egress/prove`), and a client that cannot represent the status would report
 * it as `server_error` and say something false.
 */
export async function scopedGet<T>(
  url: string,
  token: string,
  timeoutMs: number,
  parse: (body: unknown) => T | null,
  doFetch: FetchLike,
): Promise<ScopedReadResult<T>> {
  return await withTimeout(timeoutMs, async (signal): Promise<ScopedReadResult<T>> => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal,
      });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (res.status === 200) {
      const value = parse(await readJson(res));
      return value === null ? { ok: false, reason: "server_error" } : { ok: true, value };
    }
    if (res.status === 429) {
      return { ok: false, reason: "rate_limited" };
    }
    return await scopedRouteFailure(res);
  });
}
