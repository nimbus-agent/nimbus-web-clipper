// src/background/egress-handlers.ts
// The egress-ledger reads as pure orchestration over injected deps.
//
// A sub-router's worth of work kept out of service-worker.ts on purpose: that
// router is already at Sonar's cognitive-complexity cap (S3776, 15), which is
// why the brief protocol lives in brief-handlers.ts too. The worker gains one
// branch that delegates here.
//
// There is deliberately NO writer on EgressDeps. Nothing in this client may
// persist a ledger row: a local copy is exactly the private log the design
// forbids, because it could quietly disagree with `nimbus prove`.

import { type EgressPartition, partitionRows } from "../shared/egress.ts";
import type {
  EgressProveRequest,
  EgressProveResponse,
  EgressVerifyRequest,
  EgressVerifyResponse,
  EgressWindowRequest,
  EgressWindowResponse,
} from "../shared/messages.ts";
import type { Connection } from "../shared/types.ts";
import type * as egressClient from "./egress-client.ts";

export interface EgressDeps {
  readonly getConnection: () => Promise<Connection | null>;
  readonly listEgress: typeof egressClient.listEgress;
  readonly verifyEgress: typeof egressClient.verifyEgress;
  readonly proveEgressWindow: typeof egressClient.proveEgressWindow;
}

/**
 * Widen the gateway's raw two-field gap into the `ScopeGap` the views need.
 *
 * The device label is client-side state, so the handler is what adds it — the
 * 403 body cannot carry it. Same shape as `handlers.ts` does for resolve and
 * fetch, and it is what lets `scopeCommand` build a pasteable command.
 */
function withLabel(
  label: string,
  gap: { required: string; granted: string[] } | undefined,
): { label: string; required: string; granted: string[] } | undefined {
  return gap === undefined ? undefined : { label, ...gap };
}

export async function handleEgressWindow(
  deps: EgressDeps,
  req: EgressWindowRequest,
): Promise<EgressWindowResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "egress-window", ok: false, reason: "not_paired" };
  }
  const opts = req.before === undefined ? {} : { before: req.before };
  const res = await deps.listEgress(conn.origin, conn.token, opts);
  if (!res.ok) {
    const scopeGap = withLabel(conn.label, res.scopeGap);
    return scopeGap === undefined
      ? { kind: "egress-window", ok: false, reason: res.reason }
      : { kind: "egress-window", ok: false, reason: res.reason, scopeGap };
  }
  // The label comes from the stored connection, never from the requesting page:
  // a page-supplied label would let a content script claim another client's rows.
  const partition: EgressPartition = partitionRows(res.value.rows, conn.label);
  return {
    kind: "egress-window",
    ok: true,
    partition,
    rowsTotal: res.value.rowsTotal,
    rowsTruncated: res.value.rowsTruncated,
  };
}

export async function handleEgressVerify(
  deps: EgressDeps,
  _req: EgressVerifyRequest,
): Promise<EgressVerifyResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "egress-verify", ok: false, reason: "not_paired" };
  }
  const res = await deps.verifyEgress(conn.origin, conn.token);
  if (!res.ok) {
    const scopeGap = withLabel(conn.label, res.scopeGap);
    return scopeGap === undefined
      ? { kind: "egress-verify", ok: false, reason: res.reason }
      : { kind: "egress-verify", ok: false, reason: res.reason, scopeGap };
  }
  // A broken chain is an ANSWER, not a transport failure — `ok: true` carrying a
  // false verdict. The page must be able to tell "could not check" from
  // "checked, and it is broken".
  return { kind: "egress-verify", ok: true, verdict: res.value };
}

export async function handleEgressProve(
  deps: EgressDeps,
  req: EgressProveRequest,
): Promise<EgressProveResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "egress-prove", ok: false, reason: "not_paired" };
  }
  const opts = {
    ...(req.since === undefined ? {} : { since: req.since }),
    ...(req.until === undefined ? {} : { until: req.until }),
  };
  const res = await deps.proveEgressWindow(conn.origin, conn.token, opts);
  if (!res.ok) {
    const scopeGap = withLabel(conn.label, res.scopeGap);
    return scopeGap === undefined
      ? { kind: "egress-prove", ok: false, reason: res.reason }
      : { kind: "egress-prove", ok: false, reason: res.reason, scopeGap };
  }
  return { kind: "egress-prove", ok: true, proof: res.value };
}
