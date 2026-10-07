import { describe, expect, test } from "vitest";
import { UNRECOGNISED_GAP } from "../../src/shared/deploy.ts";
import {
  ACTIVITY_METRICS,
  DAY_MS,
  DEFAULT_RANGE,
  DELIVERY_KEYS,
  DELIVERY_ROWS,
  DORA_RANGES,
  doraPagePath,
  isDoraRangeId,
  isStatsMetricId,
  MAX_BUCKETS,
  parseDoraMetrics,
  parseGap,
  parseStatsSeries,
  RANGES,
  STATS_METRIC_IDS,
} from "../../src/shared/dora.ts";

const value = (over: Record<string, unknown> = {}) => ({
  value: 1.4,
  unit: "deploys_per_day",
  sample: 42,
  gap: null,
  ...over,
});

const envelope = (over: Record<string, unknown> = {}) => ({
  service: "web",
  since_ms: 1_700_000_000_000,
  computed_at: "2026-10-07T09:00:00.000Z",
  metrics: {
    deployment_frequency: value(),
    lead_time_for_changes: value({ unit: "seconds_median", value: 7200 }),
    change_failure_rate: value({ unit: "ratio", value: 0.095 }),
    mttr: value({ unit: "seconds_median", value: null, sample: 0, gap: "no_pagerduty_mapping" }),
  },
  ...over,
});

const point = (i: number, over: Record<string, unknown> = {}) => ({
  start_ms: i * 7 * DAY_MS,
  end_ms: (i + 1) * 7 * DAY_MS,
  value: 1,
  unit: "deploys_per_day",
  sample: 5,
  gap: null,
  ...over,
});

const series = (over: Record<string, unknown> = {}) => ({
  metric: "deployment-frequency",
  service: "web",
  window: { since_ms: 0, until_ms: 13 * 7 * DAY_MS },
  bucket_ms: 7 * DAY_MS,
  points: Array.from({ length: 13 }, (_, i) => point(i)),
  ...over,
});

describe("RANGES", () => {
  test.each(DORA_RANGES)(
    "%s divides exactly, fits the bucket ceiling, and sends a valid since",
    (id) => {
      const r = RANGES[id];
      expect(r.windowMs % r.bucketMs).toBe(0);
      expect(r.windowMs / r.bucketMs).toBeLessThanOrEqual(MAX_BUCKETS);
      expect(r.since).toMatch(/^\d+d$/);
      const days = Number(r.since.slice(0, -1));
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(365);
      // The headline and the trend must cover the same window.
      expect(days * DAY_MS).toBe(r.windowMs);
    },
  );

  test("is exactly the three week-aligned ranges the spec names", () => {
    expect(RANGES["4w"]).toMatchObject({ label: "4 weeks", since: "28d", bucketMs: 2 * DAY_MS });
    expect(RANGES["13w"]).toMatchObject({ label: "13 weeks", since: "91d", bucketMs: 7 * DAY_MS });
    expect(RANGES["26w"]).toMatchObject({
      label: "26 weeks",
      since: "182d",
      bucketMs: 14 * DAY_MS,
    });
    expect(DEFAULT_RANGE).toBe("13w");
  });

  test("isDoraRangeId accepts the list and nothing else", () => {
    for (const id of DORA_RANGES) expect(isDoraRangeId(id)).toBe(true);
    for (const bad of ["30d", "4W", "", "13w ", 13, null, undefined])
      expect(isDoraRangeId(bad)).toBe(false);
  });
});

describe("metric ids", () => {
  test("every delivery row pairs with a real stats metric, and activity is the two extras", () => {
    for (const key of DELIVERY_KEYS) expect(STATS_METRIC_IDS).toContain(DELIVERY_ROWS[key]);
    expect(DELIVERY_ROWS.lead_time_for_changes).toBe("lead-time");
    expect([...ACTIVITY_METRICS]).toEqual(["pr-merges", "incidents-opened"]);
  });

  test("isStatsMetricId rejects strings outside the list", () => {
    expect(isStatsMetricId("mttr")).toBe(true);
    for (const bad of ["lead_time_for_changes", "MTTR", "dora", 1])
      expect(isStatsMetricId(bad)).toBe(false);
  });
});

describe("parseGap", () => {
  test("null is no gap, a known string is itself, an unknown string degrades, a wrong type is a violation", () => {
    expect(parseGap(null)).toBeNull();
    expect(parseGap("low_sample")).toBe("low_sample");
    expect(parseGap("github_only_merge_data")).toBe("github_only_merge_data");
    expect(parseGap("a_reason_from_the_future")).toBe(UNRECOGNISED_GAP);
    expect(parseGap(3)).toBeUndefined();
    expect(parseGap({})).toBeUndefined();
  });
});

describe("parseDoraMetrics", () => {
  test("parses a well-formed envelope", () => {
    const r = parseDoraMetrics(envelope(), "web");
    expect(r?.metrics.change_failure_rate.value).toBe(0.095);
    expect(r?.metrics.mttr).toEqual({
      value: null,
      unit: "seconds_median",
      sample: 0,
      gap: "no_pagerduty_mapping",
    });
  });

  test("builds a new object rather than passing the input through", () => {
    const input = { ...envelope(), injected: "x" };
    const r = parseDoraMetrics(input, "web");
    expect(r).not.toBe(input);
    expect(r).not.toHaveProperty("injected");
    expect(r?.metrics.deployment_frequency).not.toHaveProperty("extra");
  });

  test("rejects a computed_at that is not a date", () => {
    expect(parseDoraMetrics(envelope({ computed_at: "yesterday-ish" }), "web")).toBeNull();
    expect(parseDoraMetrics(envelope({ computed_at: "" }), "web")).toBeNull();
  });

  test("rejects an envelope for a different service", () => {
    expect(parseDoraMetrics(envelope({ service: "other" }), "web")).toBeNull();
  });

  test("rejects non-finite numbers, a missing metric, and a wrong-typed gap", () => {
    const bad = envelope();
    expect(parseDoraMetrics({ ...bad, since_ms: Number.NaN }, "web")).toBeNull();
    expect(
      parseDoraMetrics({ ...bad, metrics: { ...bad.metrics, mttr: undefined } }, "web"),
    ).toBeNull();
    expect(
      parseDoraMetrics({ ...bad, metrics: { ...bad.metrics, mttr: value({ gap: 7 }) } }, "web"),
    ).toBeNull();
    expect(
      parseDoraMetrics(
        { ...bad, metrics: { ...bad.metrics, mttr: value({ value: Number.POSITIVE_INFINITY }) } },
        "web",
      ),
    ).toBeNull();
  });

  test("an unknown gap string degrades only that metric", () => {
    const e = envelope();
    const r = parseDoraMetrics(
      { ...e, metrics: { ...e.metrics, mttr: value({ gap: "new_reason" }) } },
      "web",
    );
    expect(r?.metrics.mttr.gap).toBe(UNRECOGNISED_GAP);
    expect(r?.metrics.deployment_frequency.gap).toBeNull();
  });
});

describe("parseStatsSeries", () => {
  test("parses a well-formed series", () => {
    const s = parseStatsSeries(series(), "web", "deployment-frequency");
    expect(s?.points).toHaveLength(13);
    expect(s?.bucket_ms).toBe(7 * DAY_MS);
  });

  test("rejects a series for a different service", () => {
    expect(
      parseStatsSeries(series({ service: "other" }), "web", "deployment-frequency"),
    ).toBeNull();
  });

  test("rejects a series for a different metric", () => {
    expect(parseStatsSeries(series(), "web", "mttr")).toBeNull();
  });

  test("rejects more than MAX_BUCKETS points", () => {
    const points = Array.from({ length: MAX_BUCKETS + 1 }, (_, i) => point(i));
    expect(parseStatsSeries(series({ points }), "web", "deployment-frequency")).toBeNull();
  });

  test("rejects an inverted or empty bucket and a non-finite value", () => {
    expect(
      parseStatsSeries(
        series({ points: [point(0, { end_ms: 0 })] }),
        "web",
        "deployment-frequency",
      ),
    ).toBeNull();
    expect(
      parseStatsSeries(
        series({ points: [point(0, { value: Number.NaN })] }),
        "web",
        "deployment-frequency",
      ),
    ).toBeNull();
  });

  test("does not pass points through", () => {
    const input = series({ points: [{ ...point(0), extra: true }] });
    const s = parseStatsSeries(input, "web", "deployment-frequency");
    expect(s?.points[0]).not.toHaveProperty("extra");
  });
});

describe("doraPagePath", () => {
  test("no id opens the bare page", () => {
    expect(doraPagePath()).toBe("dora.html");
  });

  test("round-trips an id that needs encoding", () => {
    const path = doraPagePath("a b/c&d");
    expect(path).toBe("dora.html?service=a%20b%2Fc%26d");
    expect(new URL(path, "chrome-extension://x/").searchParams.get("service")).toBe("a b/c&d");
  });
});
