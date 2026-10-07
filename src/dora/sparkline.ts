// The DORA page's trend line. Hand-drawn inline SVG — no charting dependency,
// because the shipped extension has no runtime deps.
//
// The honesty rules this file enforces (spec §5.3):
//   - a null point BREAKS the line; it is never drawn as zero;
//   - the y-axis starts at zero, so a 9%→11% wobble does not fill the chart;
//   - a flat-zero series sits on the baseline — the scale is never value/max
//     with max 0 (NaN) — and is NOT clamped to a floor of 1, because `ratio`
//     lives in 0–1 and a floor of 1 would flatten every change-failure trend.

export const SPARK_W = 160;
export const SPARK_H = 32;
export const SPARK_PAD = 4;

export interface SparkGeometry {
  readonly baseline: number;
  readonly xs: readonly number[];
  readonly ys: readonly (number | null)[];
  readonly segments: readonly { readonly from: number; readonly to: number }[];
}

export function sparkGeometry(values: readonly (number | null)[]): SparkGeometry {
  const baseline = SPARK_H - SPARK_PAD;
  const span = SPARK_H - 2 * SPARK_PAD;
  const n = values.length;
  const xs = values.map((_, i) =>
    n === 1 ? SPARK_W / 2 : SPARK_PAD + (i * (SPARK_W - 2 * SPARK_PAD)) / (n - 1),
  );
  const max = values.reduce<number>((m, v) => (v !== null && v > m ? v : m), 0);
  const ys = values.map((v) => {
    if (v === null) return null;
    return max === 0 ? baseline : baseline - (v / max) * span;
  });
  const segments: { from: number; to: number }[] = [];
  for (let i = 0; i + 1 < n; i++) {
    if (values[i] !== null && values[i + 1] !== null) segments.push({ from: i, to: i + 1 });
  }
  return { baseline, xs, ys, segments };
}
