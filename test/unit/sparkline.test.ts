import { describe, expect, test } from "vitest";
import { SPARK_H, SPARK_PAD, SPARK_W, sparkGeometry } from "../../src/dora/sparkline.ts";

describe("sparkGeometry", () => {
  test("a null breaks the line: no segment touches it", () => {
    const g = sparkGeometry([1, 2, null, 3, 4]);
    expect(g.segments).toEqual([
      { from: 0, to: 1 },
      { from: 3, to: 4 },
    ]);
    expect(g.ys[2]).toBeNull();
  });

  test("the axis starts at zero: the largest value is at the top, zero at the baseline", () => {
    const g = sparkGeometry([0, 5, 10]);
    expect(g.ys[0]).toBe(g.baseline);
    expect(g.ys[2]).toBe(SPARK_PAD);
    expect(g.ys[1]).toBeCloseTo((g.baseline + SPARK_PAD) / 2);
  });

  test("a flat zero series sits on the baseline with no NaN anywhere", () => {
    const g = sparkGeometry([0, 0, 0]);
    expect(g.ys).toEqual([g.baseline, g.baseline, g.baseline]);
    for (const n of [...g.xs, ...g.ys]) expect(Number.isNaN(n)).toBe(false);
  });

  test("a small ratio series is not flattened — no floor of 1", () => {
    const g = sparkGeometry([0.02, 0.09]);
    expect(g.ys[1]).toBe(SPARK_PAD);
  });

  test("a single value sits mid-width and has no segment", () => {
    const g = sparkGeometry([null, 3, null]);
    expect(g.segments).toEqual([]);
    const lone = sparkGeometry([3]);
    expect(lone.xs[0]).toBe(SPARK_W / 2);
  });

  test("x spans the padded width evenly", () => {
    const g = sparkGeometry([1, 1, 1]);
    expect(g.xs).toEqual([SPARK_PAD, SPARK_W / 2, SPARK_W - SPARK_PAD]);
    expect(g.baseline).toBe(SPARK_H - SPARK_PAD);
  });
});
