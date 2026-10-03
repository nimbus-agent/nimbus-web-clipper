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
import { isObject } from "../shared/is-object.ts";
import { type RawScopeGap, scopedGet } from "./http-json.ts";

/** Reads over a local index. Long enough for a 1000-row page, short enough that
 *  a wedged gateway does not hang the page behind it. */
const EGRESS_TIMEOUT_MS = 10_000;

/** `scopeGap` is the gateway's raw detail, label-free — `egress-handlers.ts`
 *  widens it with `withLabel`. */
export type EgressResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: EgressError; scopeGap?: RawScopeGap };

type FetchLike = typeof fetch;

/**
 * One GET, one status ladder, one parse — `http-json.ts`'s `scopedGet`, which
 * owns the ladder and the timer that stays armed across the body read.
 *
 * Every route here differs only in its endpoint, its query and how it reads a
 * 200. Every reason that ladder can report must be an `EgressError`, and that is
 * checked by the compiler rather than by this sentence: a reason the shared
 * ladder gained and `EgressError` lacked would make the `return` below a type
 * error.
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
  return await scopedGet(url, token, EGRESS_TIMEOUT_MS, parse, doFetch);
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
