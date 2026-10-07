// src/shared/dora.ts
// The DORA page's wire vocabulary (C10.2): the ranges it may ask for, the six
// metrics, the gap reasons, and the parsers for both public routes.
//
// Pure — no chrome.*, no fetch. The worker and the page both import it, which
// is the point: the range the page labels and the range the worker requests
// are one table, so they cannot disagree.

import { sendableId, UNRECOGNISED_GAP } from "./deploy.ts";
import { isObject } from "./is-object.ts";

export const DAY_MS = 86_400_000;

/** Upstream `stats-buckets.ts`' ceiling. Arithmetic footgun protection there;
 *  a parse bound here — a reply longer than any request could produce is not
 *  a reply to us. */
export const MAX_BUCKETS = 400;

export const DORA_RANGES = ["4w", "13w", "26w"] as const;
export type DoraRangeId = (typeof DORA_RANGES)[number];

export interface DoraRange {
  readonly label: string;
  /** The `/v1/metrics/dora` `since` — the same window as `windowMs`. */
  readonly since: string;
  readonly windowMs: number;
  readonly bucketMs: number;
  /** "13 weekly points" */
  readonly adjective: string;
  /** "4 of 13 weeks" */
  readonly bucketNoun: string;
}

/**
 * Week-aligned on purpose. Upstream splits the window backward from now and
 * lets the OLDEST bucket absorb any remainder, so a bucket that does not divide
 * the window draws a short first point — a false dip on a count metric. Every
 * row here divides exactly, which `dora.test.ts` asserts. The point count is
 * deliberately not stored: it is `windowMs / bucketMs`.
 */
export const RANGES: Record<DoraRangeId, DoraRange> = {
  "4w": {
    label: "4 weeks",
    since: "28d",
    windowMs: 28 * DAY_MS,
    bucketMs: 2 * DAY_MS,
    adjective: "2-day",
    bucketNoun: "2-day periods",
  },
  "13w": {
    label: "13 weeks",
    since: "91d",
    windowMs: 91 * DAY_MS,
    bucketMs: 7 * DAY_MS,
    adjective: "weekly",
    bucketNoun: "weeks",
  },
  "26w": {
    label: "26 weeks",
    since: "182d",
    windowMs: 182 * DAY_MS,
    bucketMs: 14 * DAY_MS,
    adjective: "2-week",
    bucketNoun: "2-week periods",
  },
};

export const DEFAULT_RANGE: DoraRangeId = "13w";

export function isDoraRangeId(v: unknown): v is DoraRangeId {
  return typeof v === "string" && (DORA_RANGES as readonly string[]).includes(v);
}

export const STATS_METRIC_IDS = [
  "deployment-frequency",
  "lead-time",
  "change-failure-rate",
  "mttr",
  "pr-merges",
  "incidents-opened",
] as const;
export type StatsMetricId = (typeof STATS_METRIC_IDS)[number];

export function isStatsMetricId(v: unknown): v is StatsMetricId {
  return typeof v === "string" && (STATS_METRIC_IDS as readonly string[]).includes(v);
}

export const DELIVERY_KEYS = [
  "deployment_frequency",
  "lead_time_for_changes",
  "change_failure_rate",
  "mttr",
] as const;
export type DoraMetricKey = (typeof DELIVERY_KEYS)[number];

/**
 * The two routes name the same four metrics differently — snake_case keys in
 * the headline envelope, kebab-case ids on the trend route, and
 * `lead_time_for_changes` is `lead-time` there. A `Record` over the envelope's
 * keys, so a fifth DORA metric upstream is a type error here rather than a row
 * that never renders.
 */
export const DELIVERY_ROWS: Record<DoraMetricKey, StatsMetricId> = {
  deployment_frequency: "deployment-frequency",
  lead_time_for_changes: "lead-time",
  change_failure_rate: "change-failure-rate",
  mttr: "mttr",
};

/** The two count metrics `/v1/metrics/stats` adds; no headline route has them. */
export const ACTIVITY_METRICS = [
  "pr-merges",
  "incidents-opened",
] as const satisfies readonly StatsMetricId[];
export type ActivityMetricId = (typeof ACTIVITY_METRICS)[number];

export const DORA_GAPS = [
  "unknown_service",
  "no_pagerduty_mapping",
  "no_repos",
  "no_deployment_data",
  "low_sample",
  "approximate_lead_time",
  "mixed_source",
] as const;

export const STATS_GAPS = [
  ...DORA_GAPS,
  "github_only_merge_data",
  "incidents_missing_opened_at",
] as const;
export type KnownGap = (typeof STATS_GAPS)[number];

/** `UNRECOGNISED_GAP` is client-only, never on the wire — see its doc in deploy.ts. */
export type StatsGap = KnownGap | typeof UNRECOGNISED_GAP | null;

/**
 * `undefined` means a SHAPE violation (the caller rejects the envelope); an
 * unknown STRING is a newer vocabulary and degrades to `UNRECOGNISED_GAP`.
 * One parser for both routes: a headline citing a stats-only reason is still
 * a reason, not a malformed body.
 */
export function parseGap(v: unknown): StatsGap | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  return (STATS_GAPS as readonly string[]).includes(v) ? (v as KnownGap) : UNRECOGNISED_GAP;
}

export interface MetricValue {
  readonly value: number | null;
  readonly unit: string;
  readonly sample: number;
  readonly gap: StatsGap;
}

export interface DoraMetricsResult {
  readonly service: string;
  readonly since_ms: number;
  readonly computed_at: string;
  readonly metrics: Readonly<Record<DoraMetricKey, MetricValue>>;
}

export interface StatsPoint extends MetricValue {
  readonly start_ms: number;
  readonly end_ms: number;
}

export interface StatsSeries {
  readonly metric: StatsMetricId;
  readonly service: string;
  readonly window: { readonly since_ms: number; readonly until_ms: number };
  readonly bucket_ms: number;
  readonly points: readonly StatsPoint[];
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseMetricValue(v: unknown): MetricValue | null {
  if (!isObject(v)) return null;
  const value = v["value"];
  const unit = v["unit"];
  const sample = v["sample"];
  const gap = parseGap(v["gap"]);
  if (value !== null && !finite(value)) return null;
  if (typeof unit !== "string") return null;
  if (!finite(sample) || sample < 0) return null;
  if (gap === undefined) return null;
  return { value, unit, sample, gap };
}

/** Rejects a body for any service but the one asked for — a reply about
 *  another service must never render under this one's name. */
export function parseDoraMetrics(v: unknown, service: string): DoraMetricsResult | null {
  if (!isObject(v) || v["service"] !== service) return null;
  const sinceMs = v["since_ms"];
  const computedAt = v["computed_at"];
  const metrics = v["metrics"];
  if (!finite(sinceMs) || typeof computedAt !== "string" || !isObject(metrics)) return null;
  const out: Partial<Record<DoraMetricKey, MetricValue>> = {};
  for (const key of DELIVERY_KEYS) {
    const parsed = parseMetricValue(metrics[key]);
    if (parsed === null) return null;
    out[key] = parsed;
  }
  const { deployment_frequency, lead_time_for_changes, change_failure_rate, mttr } = out;
  if (
    deployment_frequency === undefined ||
    lead_time_for_changes === undefined ||
    change_failure_rate === undefined ||
    mttr === undefined
  ) {
    return null;
  }
  return {
    service,
    since_ms: sinceMs,
    computed_at: computedAt,
    metrics: { deployment_frequency, lead_time_for_changes, change_failure_rate, mttr },
  };
}

function parsePoint(v: unknown): StatsPoint | null {
  if (!isObject(v)) return null;
  const start = v["start_ms"];
  const end = v["end_ms"];
  if (!finite(start) || !finite(end) || start >= end) return null;
  const mv = parseMetricValue(v);
  if (mv === null) return null;
  return {
    start_ms: start,
    end_ms: end,
    value: mv.value,
    unit: mv.unit,
    sample: mv.sample,
    gap: mv.gap,
  };
}

export function parseStatsSeries(
  v: unknown,
  service: string,
  metric: StatsMetricId,
): StatsSeries | null {
  if (!isObject(v) || v["service"] !== service || v["metric"] !== metric) return null;
  const win = v["window"];
  const bucketMs = v["bucket_ms"];
  const points = v["points"];
  if (!isObject(win) || !finite(win["since_ms"]) || !finite(win["until_ms"])) return null;
  if (!finite(bucketMs) || bucketMs <= 0) return null;
  if (!Array.isArray(points) || points.length > MAX_BUCKETS) return null;
  const parsed: StatsPoint[] = [];
  for (const p of points) {
    const one = parsePoint(p);
    if (one === null) return null;
    parsed.push(one);
  }
  return {
    metric,
    service,
    window: { since_ms: win["since_ms"], until_ms: win["until_ms"] },
    bucket_ms: bucketMs,
    points: parsed,
  };
}

/** What a failed headline read becomes — `getJson`'s ladder, unchanged. */
export const DORA_READ_FAILURES = ["unreachable", "server_error", "malformed"] as const;
export type DoraReadFailure = (typeof DORA_READ_FAILURES)[number];

/**
 * What a failed trend read becomes. Wider than the headline's: upstream gives
 * 404 (route absent — a gateway older than v7.19.0) and 400 (refused) distinct
 * meanings, and the page renders them differently (spec §6.2).
 */
export const STATS_READ_FAILURES = [
  "unreachable",
  "unsupported",
  "refused",
  "server_error",
  "malformed",
] as const;
export type StatsReadFailure = (typeof STATS_READ_FAILURES)[number];

/** The page's own path, relative to the extension root. */
export function doraPagePath(serviceId?: string): string {
  return serviceId === undefined || !sendableId(serviceId)
    ? "dora.html"
    : `dora.html?service=${encodeURIComponent(serviceId)}`;
}
