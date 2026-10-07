// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { renderSparkline } from "../../src/dora/sparkline.ts";
import type { StatsPoint } from "../../src/shared/dora.ts";

const p = (value: number | null, gap: StatsPoint["gap"] = null): StatsPoint => ({
  start_ms: 0,
  end_ms: 86_400_000,
  value,
  unit: "ratio",
  sample: 3,
  gap,
});

describe("renderSparkline", () => {
  test("one path per unbroken pair; a null splits the line", () => {
    const svg = renderSparkline(
      document,
      [p(0.1), p(0.2), p(null, "low_sample"), p(0.3), p(0.4)],
      "s",
    );
    expect(svg.querySelectorAll("path.dora-spark__line")).toHaveLength(2);
  });

  test("a null is a hollow baseline marker titled with its gap, never a dip to a value", () => {
    const svg = renderSparkline(document, [p(0.1), p(null, "low_sample")], "s");
    const dot = svg.querySelector("circle.dora-spark__dot--null");
    expect(dot?.querySelector("title")?.textContent).toContain("Too few events");
  });

  test("a value with a gap is hedged: hollow dot, dashed neighbours", () => {
    const svg = renderSparkline(document, [p(0.1), p(0.2, "mixed_source")], "s");
    expect(svg.querySelectorAll("circle.dora-spark__dot--hedged")).toHaveLength(1);
    expect(svg.querySelector("path.dora-spark__line--hedged")).not.toBeNull();
  });

  test("every value has a titled dot with its formatted value, so a lone point still shows", () => {
    const svg = renderSparkline(
      document,
      [p(null, "low_sample"), p(0.25), p(null, "low_sample")],
      "s",
    );
    const dots = svg.querySelectorAll("circle.dora-spark__dot");
    expect(dots).toHaveLength(1);
    expect(dots[0]?.querySelector("title")?.textContent).toContain("25.0%");
  });

  test("carries its summary for assistive technology and no NaN", () => {
    const svg = renderSparkline(document, [p(0), p(0)], "2 weekly points, 2 with values");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("2 weekly points, 2 with values");
    expect(svg.outerHTML).not.toContain("NaN");
  });
});
