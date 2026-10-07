// The DORA page's trend line. Hand-drawn inline SVG — no charting dependency,
// because the shipped extension has no runtime deps.
//
// The honesty rules this file enforces (spec §5.3):
//   - a null point BREAKS the line; it is never drawn as zero;
//   - the y-axis starts at zero, so a 9%→11% wobble does not fill the chart;
//   - a flat-zero series sits on the baseline — the scale is never value/max
//     with max 0 (NaN) — and is NOT clamped to a floor of 1, because `ratio`
//     lives in 0–1 and a floor of 1 would flatten every change-failure trend.

import type { StatsPoint } from "../shared/dora.ts";
import { formatValue, GAP_SENTENCE } from "./dora-format.ts";

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

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
): SVGElementTagNameMap[K] {
  return doc.createElementNS(SVG_NS, tag);
}

function periodLabel(pt: StatsPoint): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(pt.start_ms)} – ${fmt(pt.end_ms)}`;
}

function pointTitle(pt: StatsPoint): string {
  const head = `${periodLabel(pt)}: ${pt.value === null ? "—" : formatValue(pt.value, pt.unit)}`;
  return pt.gap === null ? head : `${head}. ${GAP_SENTENCE[pt.gap]}`;
}

function hasGap(pt: StatsPoint | undefined): boolean {
  return pt !== undefined && pt.gap !== null;
}

function dot(doc: Document, cx: number, cy: number, cls: string, title: string): SVGCircleElement {
  const c = svgEl(doc, "circle");
  c.setAttribute("class", cls);
  c.setAttribute("cx", cx.toFixed(1));
  c.setAttribute("cy", cy.toFixed(1));
  c.setAttribute("r", "2.5");
  const t = svgEl(doc, "title");
  t.textContent = title;
  c.append(t);
  return c;
}

export function renderSparkline(
  doc: Document,
  points: readonly StatsPoint[],
  summary: string,
): SVGSVGElement {
  const g = sparkGeometry(points.map((pt) => pt.value));
  const svg = svgEl(doc, "svg");
  svg.setAttribute("class", "dora-spark");
  svg.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", summary);

  const base = svgEl(doc, "line");
  base.setAttribute("class", "dora-spark__baseline");
  base.setAttribute("x1", "0");
  base.setAttribute("x2", String(SPARK_W));
  base.setAttribute("y1", String(g.baseline));
  base.setAttribute("y2", String(g.baseline));
  svg.append(base);

  for (const { from, to } of g.segments) {
    const y1 = g.ys[from] ?? null;
    const y2 = g.ys[to] ?? null;
    const x1 = g.xs[from];
    const x2 = g.xs[to];
    if (y1 === null || y2 === null || x1 === undefined || x2 === undefined) continue;
    const hedged = hasGap(points[from]) || hasGap(points[to]);
    const path = svgEl(doc, "path");
    path.setAttribute(
      "class",
      hedged ? "dora-spark__line dora-spark__line--hedged" : "dora-spark__line",
    );
    path.setAttribute(
      "d",
      `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`,
    );
    svg.append(path);
  }

  // An indexed loop, not `forEach` — biome.json sets `noForEach` to error.
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const x = g.xs[i];
    const y = g.ys[i] ?? null;
    if (pt === undefined || x === undefined) continue;
    if (pt.value === null || y === null) {
      svg.append(dot(doc, x, g.baseline, "dora-spark__dot--null", pointTitle(pt)));
      continue;
    }
    const cls = pt.gap === null ? "dora-spark__dot" : "dora-spark__dot dora-spark__dot--hedged";
    svg.append(dot(doc, x, y, cls, pointTitle(pt)));
  }
  return svg;
}
