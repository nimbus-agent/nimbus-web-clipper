// src/background/egress-client.ts
// The four egress-ledger reads, and nothing else.
//
// Split from gateway-client.ts on the brief-client.ts precedent: that file is
// already 648 lines across six routes, and these four share a path prefix, a
// scope and an error vocabulary none of the others do.
//
// The `egress` scope is NOT in the gateway's LEGACY_SCOPES, so 403 is the FIRST
// thing every already-paired browser hits here. Folding it into server_error
// would blame the gateway for a grant the owner has simply not made yet — and
// the remedy is `nimbus clip scopes`, in place, not a re-pair.

import type { EgressError, EgressProof, EgressVerdict, EgressWindow } from "../shared/egress.ts";
import { parseEgressWindow } from "../shared/egress.ts";
import { endpointUrl, type GatewayEndpoint } from "../shared/gateway.ts";

/** Reads over a local index. Long enough for a 1000-row page, short enough that
 *  a wedged gateway does not hang the page behind it. */
const EGRESS_TIMEOUT_MS = 10_000;

/**
 * The gateway's raw 403 detail.
 *
 * Deliberately NOT `shared/types.ts`'s `ScopeGap`, which also carries the device
 * `label`: the label is client-side state this module has no business knowing.
 * `egress-handlers.ts` widens it, exactly as `handlers.ts` does for resolve and
 * fetch.
 */
export type RawScopeGap = { required: string; granted: string[] };

export type EgressResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: EgressError; scopeGap?: RawScopeGap };

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

function parseScopeGap(v: unknown): RawScopeGap | null {
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
 * One GET, one status ladder, one parse.
 *
 * Every route here differs only in its endpoint, its query and how it reads a
 * 200 — so the ladder lives once, and a new route cannot accidentally map its
 * statuses differently from its siblings.
 */
async function read<T>(
  origin: string,
  token: string,
  endpoint: GatewayEndpoint,
  query: Record<string, string>,
  parse: (body: unknown) => T | null,
  doFetch: FetchLike,
): Promise<EgressResult<T>> {
  const qs = new URLSearchParams(query).toString();
  const url = qs === "" ? endpointUrl(origin, endpoint) : `${endpointUrl(origin, endpoint)}?${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EGRESS_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch {
      return { ok: false, reason: "unreachable" };
    }

    // The timer stays ARMED across the body read, and is cleared in the outer
    // `finally` once this function is done. Clearing it as soon as the headers
    // arrive would leave a gateway that answers 200 and then hangs its body
    // stream un-timed-out — the page would wait forever on a read that the
    // timeout was supposed to bound.
    if (res.status === 200) {
      const value = parse(await readJson(res));
      return value === null ? { ok: false, reason: "server_error" } : { ok: true, value };
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
    if (res.status === 429) {
      return { ok: false, reason: "rate_limited" };
    }
    return { ok: false, reason: "server_error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Present numbers only. An absent option must not become the string "undefined". */
function intQuery(opts: Record<string, number | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts)) {
    if (value !== undefined) {
      out[key] = String(value);
    }
  }
  return out;
}

export async function listEgress(
  origin: string,
  token: string,
  opts: { since?: number; until?: number; limit?: number; before?: number },
  doFetch: FetchLike = fetch,
): Promise<EgressResult<EgressWindow>> {
  return await read(origin, token, "egress", intQuery(opts), parseEgressWindow, doFetch);
}

export async function getEgressHead(
  origin: string,
  token: string,
  doFetch: FetchLike = fetch,
): Promise<EgressResult<{ head: string; count: number }>> {
  return await read(
    origin,
    token,
    "egressHead",
    {},
    (body) =>
      isObject(body) && typeof body["head"] === "string" && typeof body["count"] === "number"
        ? { head: body["head"], count: body["count"] }
        : null,
    doFetch,
  );
}

export async function verifyEgress(
  origin: string,
  token: string,
  doFetch: FetchLike = fetch,
): Promise<EgressResult<EgressVerdict>> {
  return await read(
    origin,
    token,
    "egressVerify",
    {},
    (body) => {
      // An absent `ok` is server_error, never a default of "intact": this is the
      // one claim the page may not make without evidence.
      if (!isObject(body) || typeof body["ok"] !== "boolean") {
        return null;
      }
      const brokenAt = body["brokenAt"];
      const verifiedRows = body["verifiedRows"];
      const reason = body["reason"];
      return {
        intact: body["ok"],
        brokenAt: typeof brokenAt === "number" && Number.isInteger(brokenAt) ? brokenAt : null,
        verifiedRows:
          typeof verifiedRows === "number" && Number.isInteger(verifiedRows) ? verifiedRows : 0,
        reason: typeof reason === "string" ? reason : null,
      };
    },
    doFetch,
  );
}

export async function proveEgressWindow(
  origin: string,
  token: string,
  opts: { since?: number; until?: number },
  doFetch: FetchLike = fetch,
): Promise<EgressResult<EgressProof>> {
  return await read(
    origin,
    token,
    "egressProve",
    intQuery(opts),
    (body) => {
      // The gateway also returns `completeness` and `verify`. Reading only what
      // this client uses means a later upstream addition cannot break the parse.
      if (
        !isObject(body) ||
        typeof body["digest"] !== "string" ||
        typeof body["sigB64"] !== "string" ||
        typeof body["pubkeyB64"] !== "string" ||
        typeof body["rowsTotal"] !== "number" ||
        typeof body["rowsTruncated"] !== "boolean"
      ) {
        return null;
      }
      return {
        digest: body["digest"],
        sigB64: body["sigB64"],
        pubkeyB64: body["pubkeyB64"],
        rowsTotal: body["rowsTotal"],
        rowsTruncated: body["rowsTruncated"],
      };
    },
    doFetch,
  );
}
