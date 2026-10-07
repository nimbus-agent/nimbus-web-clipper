// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import {
  FOOTNOTE,
  renderActivityRow,
  renderDeliveryRow,
  renderFootnote,
  TREND_FAILED,
} from "../../src/dora/dora-view.ts";
import { DAY_MS, RANGES, type StatsPoint, type StatsSeries } from "../../src/shared/dora.ts";

const R = RANGES["13w"];

const series = (metric: StatsSeries["metric"], points: StatsPoint[]): StatsSeries => ({
  metric,
  service: "web",
  window: { since_ms: 0, until_ms: 91 * DAY_MS },
  bucket_ms: 7 * DAY_MS,
  points,
});

const pt = (value: number | null, gap: StatsPoint["gap"] = null, unit = "merges"): StatsPoint => ({
  start_ms: 0,
  end_ms: 7 * DAY_MS,
  value,
  unit,
  sample: value ?? 0,
  gap,
});

describe("a delivery row", () => {
  test("a null headline is a dash and its sentence — never 0", () => {
    const row = renderDeliveryRow(
      document,
      "mttr",
      {
        kind: "loaded",
        value: { value: null, unit: "seconds_median", sample: 0, gap: "no_pagerduty_mapping" },
      },
      { kind: "loading" },
      R,
    );
    expect(row.querySelector(".dora-row__value")?.textContent).toBe("—");
    expect(row.textContent).toContain("no PagerDuty mapping");
    expect(row.querySelector(".dora-row__value")?.textContent).not.toContain("0");
  });

  test("n= is always shown", () => {
    const row = renderDeliveryRow(
      document,
      "deployment_frequency",
      { kind: "loaded", value: { value: 1.4, unit: "deploys_per_day", sample: 42, gap: null } },
      { kind: "loading" },
      R,
    );
    expect(row.querySelector(".dora-row__value")?.textContent).toBe("1.4 / day");
    expect(row.querySelector(".dora-row__sample")?.textContent).toBe("n=42");
  });

  test("a value with a gap prints both", () => {
    const row = renderDeliveryRow(
      document,
      "deployment_frequency",
      {
        kind: "loaded",
        value: { value: 0.1, unit: "deploys_per_day", sample: 2, gap: "low_sample" },
      },
      { kind: "loading" },
      R,
    );
    expect(row.querySelector(".dora-row__value")?.textContent).toBe("0.1 / day");
    expect(row.textContent).toContain("Too few events");
  });

  test("lists each distinct trend gap once with its coverage", () => {
    const pts = [
      pt(1, null, "ratio"),
      pt(null, "low_sample", "ratio"),
      pt(null, "low_sample", "ratio"),
    ];
    const row = renderDeliveryRow(
      document,
      "change_failure_rate",
      { kind: "loading" },
      { kind: "loaded", series: series("change-failure-rate", pts) },
      R,
    );
    const items = [...row.querySelectorAll(".dora-row__gap")].map((e) => e.textContent);
    expect(items).toEqual([
      "Too few events to report a value (none, or fewer than three). — 2 of 3 weeks",
    ]);
  });

  test("an all-null trend draws no chart, just 'No trend:'", () => {
    const row = renderDeliveryRow(
      document,
      "mttr",
      { kind: "loading" },
      {
        kind: "loaded",
        series: series("mttr", [pt(null, "no_pagerduty_mapping", "seconds_median")]),
      },
      R,
    );
    expect(row.querySelector("svg")).toBeNull();
    expect(row.querySelector(".dora-row__notrend")?.textContent).toMatch(/^No trend: /);
  });

  test("a series-wide gap that is also the headline's gap prints its sentence once", () => {
    const row = renderDeliveryRow(
      document,
      "mttr",
      {
        kind: "loaded",
        value: { value: null, unit: "seconds_median", sample: 0, gap: "no_pagerduty_mapping" },
      },
      {
        kind: "loaded",
        series: series(
          "mttr",
          Array.from({ length: 13 }, () => pt(null, "no_pagerduty_mapping", "seconds_median")),
        ),
      },
      R,
    );
    const sentence = "no PagerDuty mapping";
    expect(row.textContent?.split(sentence)).toHaveLength(2);
    expect(row.querySelector(".dora-row__notrend")?.textContent).toMatch(/^No trend: /);
    expect(row.querySelector(".dora-row__notrend")?.textContent).toMatch(/— 13 of 13 weeks$/);
  });

  test("an all-null series carries its top gap's coverage on the No trend line, once", () => {
    const row = renderActivityRow(
      document,
      "pr-merges",
      {
        kind: "loaded",
        series: series("pr-merges", [pt(null, "low_sample"), pt(null, "low_sample")]),
      },
      R,
    );
    const sentence = "Too few events to report a value";
    expect(row.textContent?.split(sentence)).toHaveLength(2);
    expect(row.querySelector(".dora-row__notrend")?.textContent).toMatch(/— 2 of 2 weeks$/);
  });

  test("an all-null series still lists its other gaps", () => {
    const row = renderActivityRow(
      document,
      "pr-merges",
      {
        kind: "loaded",
        series: series("pr-merges", [
          pt(null, "low_sample"),
          pt(null, "low_sample"),
          pt(null, "github_only_merge_data"),
        ]),
      },
      R,
    );
    expect(row.querySelector(".dora-row__notrend")?.textContent).toMatch(/— 2 of 3 weeks$/);
    expect(row.querySelector(".dora-row__gap")?.textContent).toContain("Only GitHub");
    expect(row.querySelectorAll(".dora-row__gap")).toHaveLength(1);
  });

  test("a failed trend says so on this row only", () => {
    const row = renderDeliveryRow(document, "mttr", { kind: "loading" }, { kind: "failed" }, R);
    expect(row.textContent).toContain(TREND_FAILED);
  });

  test("a hidden trend (route absent) renders nothing in the trend slot", () => {
    const row = renderDeliveryRow(document, "mttr", { kind: "loading" }, { kind: "hidden" }, R);
    expect(row.querySelector(".dora-row__trend")?.childNodes).toHaveLength(0);
  });
});

describe("an activity row", () => {
  test("the headline is a total with its coverage", () => {
    const row = renderActivityRow(
      document,
      "pr-merges",
      { kind: "loaded", series: series("pr-merges", [pt(3), pt(null, "low_sample"), pt(4)]) },
      R,
    );
    expect(row.querySelector(".dora-row__value")?.textContent).toBe("7");
    expect(row.querySelector(".dora-row__sample")?.textContent).toBe(
      "total · 2 of 3 weeks reported",
    );
  });

  test("an all-null activity series reads as a gap, not a zero", () => {
    const row = renderActivityRow(
      document,
      "incidents-opened",
      {
        kind: "loaded",
        series: series("incidents-opened", [pt(null, "low_sample"), pt(null, "low_sample")]),
      },
      R,
    );
    expect(row.querySelector(".dora-row__value")?.textContent).toBe("—");
    expect(row.querySelector("svg")).toBeNull();
    // Coverage is honest about the zero REPORTED buckets; the figure is not a zero.
    expect(row.querySelector(".dora-row__sample")?.textContent).toBe(
      "total · 0 of 2 weeks reported",
    );
  });
});

describe("the footnote", () => {
  test("is the spec's sentence verbatim", () => {
    expect(renderFootnote(document).textContent).toBe(FOOTNOTE);
  });
});
