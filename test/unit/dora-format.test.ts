import { describe, expect, test } from "vitest";
import {
  formatDuration,
  formatValue,
  GAP_SENTENCE,
  gapSummary,
  seriesTotal,
  trendSummary,
} from "../../src/dora/dora-format.ts";
import { UNRECOGNISED_GAP } from "../../src/shared/deploy.ts";
import { RANGES, STATS_GAPS, type StatsPoint } from "../../src/shared/dora.ts";

const p = (
  value: number | null,
  gap: StatsPoint["gap"] = null,
  unit = "deploys_per_day",
): StatsPoint => ({
  start_ms: 0,
  end_ms: 1,
  value,
  unit,
  sample: value === null ? 0 : 5,
  gap,
});

describe("formatValue — spec §5.2's table", () => {
  test.each([
    [1.4, "deploys_per_day", "1.4 / day"],
    [0.05, "deploys_per_day", "0.05 / day"],
    [0, "deploys_per_day", "0.0 / day"],
    [0.042, "ratio", "4.2%"],
    [0, "ratio", "0.0%"],
    [1, "ratio", "100.0%"],
    [7, "merges", "7"],
    [3, "incidents", "3"],
    [45, "seconds_median", "45s median"],
    [1080, "seconds_median", "18m median"],
    [15_120, "seconds_median", "4h 12m median"],
    [216_000, "seconds_median", "2d 12h median"],
  ])("%d %s → %s", (v, unit, out) => {
    expect(formatValue(v, unit)).toBe(out);
  });

  test("an unknown unit prints the raw number and the unit, never throws", () => {
    expect(formatValue(3, "per_fortnight")).toBe("3 per_fortnight");
  });
});

describe("formatDuration", () => {
  test("drops a zero second unit rather than printing it", () => {
    expect(formatDuration(2 * 86_400 + 300)).toBe("2d");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(3600)).toBe("1h");
  });
});

describe("GAP_SENTENCE", () => {
  test("has a non-empty sentence for every reason, including the client-only one", () => {
    for (const gap of [...STATS_GAPS, UNRECOGNISED_GAP] as const) {
      expect(GAP_SENTENCE[gap].length).toBeGreaterThan(10);
    }
  });

  test("low_sample covers a count metric's zero without claiming one", () => {
    expect(GAP_SENTENCE.low_sample).toBe(
      "Too few events to report a value (none, or fewer than three).",
    );
  });
});

describe("gapSummary", () => {
  test("lists each distinct gap once with its count, most frequent first", () => {
    const pts = [
      p(null, "low_sample"),
      p(1),
      p(null, "low_sample"),
      p(2, "github_only_merge_data"),
    ];
    expect(gapSummary(pts)).toEqual([
      { gap: "low_sample", count: 2 },
      { gap: "github_only_merge_data", count: 1 },
    ]);
  });
});

describe("seriesTotal", () => {
  test("sums the non-null buckets and reports coverage", () => {
    expect(seriesTotal([p(2), p(null, "low_sample"), p(3)])).toEqual({
      total: 5,
      reported: 2,
      of: 3,
    });
  });

  test("an all-null series has no total — never zero", () => {
    expect(seriesTotal([p(null, "low_sample"), p(null, "low_sample")])).toEqual({
      total: null,
      reported: 0,
      of: 2,
    });
  });
});

describe("trendSummary", () => {
  test("names the cadence, the coverage and the range of values", () => {
    const pts = [p(0.8), p(null, "low_sample"), p(1.7)];
    expect(trendSummary(pts, RANGES["13w"])).toBe(
      "3 weekly points, 2 with values, 0.8 / day to 1.7 / day",
    );
  });

  test("an all-null series says so", () => {
    expect(trendSummary([p(null, "low_sample")], RANGES["4w"])).toBe(
      "1 2-day point, none with values",
    );
  });

  test("mixed units get no range rather than a cross-unit comparison", () => {
    const pts = [p(60, null, "seconds_median"), p(1, null, "merges")];
    expect(trendSummary(pts, RANGES["13w"])).toBe("2 weekly points, 2 with values");
  });
});
