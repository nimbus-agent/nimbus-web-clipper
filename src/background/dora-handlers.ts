// The DORA page's two reads (C10.2): pure decision logic with injected deps,
// like deploy-handlers.ts. Both routes are public, so only the gateway's
// ADDRESS is needed from the pairing — the token is never read here.

import type {
  DoraMetricsRequest,
  DoraMetricsResponse,
  MetricsStatsRequest,
  MetricsStatsResponse,
} from "../shared/messages.ts";
import { fetchDoraMetrics, fetchStatsSeries } from "./deploy-client.ts";
import type { DeployDeps } from "./deploy-handlers.ts";

export type DoraDeps = Pick<DeployDeps, "getConnection" | "doFetch">;

export async function handleDoraMetrics(
  req: DoraMetricsRequest,
  deps: DoraDeps,
): Promise<DoraMetricsResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "dora-metrics", ok: false, reason: "unreachable" };
  }
  const res = await fetchDoraMetrics(conn.origin, req.serviceId, req.range, deps.doFetch);
  return res.ok
    ? { kind: "dora-metrics", ok: true, result: res.value }
    : { kind: "dora-metrics", ok: false, reason: res.reason };
}

export async function handleMetricsStats(
  req: MetricsStatsRequest,
  deps: DoraDeps,
): Promise<MetricsStatsResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "metrics-stats", ok: false, reason: "unreachable" };
  }
  const res = await fetchStatsSeries(
    conn.origin,
    req.serviceId,
    req.range,
    req.metric,
    deps.doFetch,
  );
  return res.ok
    ? { kind: "metrics-stats", ok: true, series: res.value }
    : { kind: "metrics-stats", ok: false, reason: res.reason };
}
