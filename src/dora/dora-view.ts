// src/dora/dora-view.ts
// The DORA page's renderer. Pure: state in, DOM out; no messaging, no clock.
//
// createElement + textContent only. Nothing gateway-supplied ever reaches
// innerHTML — a unit string and an unrecognised gap are both the gateway's.

import type {
  ActivityMetricId,
  DoraMetricKey,
  DoraRange,
  MetricValue,
  StatsGap,
  StatsSeries,
} from "../shared/dora.ts";
import { formatValue, GAP_SENTENCE, gapSummary, seriesTotal, trendSummary } from "./dora-format.ts";
import { renderSparkline } from "./sparkline.ts";

export type HeadlineState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "loaded"; readonly value: MetricValue };

export type TrendState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  /** The route is absent (a gateway older than v7.19.0); the page says so once. */
  | { readonly kind: "hidden" }
  | { readonly kind: "loaded"; readonly series: StatsSeries };

export const DELIVERY_LABEL: Record<DoraMetricKey, string> = {
  deployment_frequency: "Deployment frequency",
  lead_time_for_changes: "Lead time for changes",
  change_failure_rate: "Change failure rate",
  mttr: "Time to restore",
};

export const ACTIVITY_LABEL: Record<ActivityMetricId, string> = {
  "pr-merges": "Pull requests merged",
  "incidents-opened": "Incidents opened",
};

export const UNREACHABLE_NOTICE = "Can't reach your Nimbus gateway.";
export const NOT_PAIRED_NOTICE = "This browser isn't paired with a Nimbus gateway yet.";
export const UNSUPPORTED_NOTICE = "Trends need a newer Nimbus gateway.";
export const TREND_FAILED = "Couldn't load this trend.";
export const HEADLINE_FAILED = "Couldn't load this figure.";
export const FOOTNOTE =
  "Trend buckets group work by when it was last updated, so an item can land in a later period than it happened.";

function el(doc: Document, tag: string, cls: string, text?: string): HTMLElement {
  const e = doc.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function rowFrame(
  doc: Document,
  label: string,
): {
  row: HTMLElement;
  head: HTMLElement;
  trend: HTMLElement;
  notes: HTMLElement;
} {
  const row = el(doc, "li", "dora-row");
  const head = el(doc, "div", "dora-row__head");
  head.append(el(doc, "span", "dora-row__label", label));
  const trend = el(doc, "div", "dora-row__trend");
  const notes = el(doc, "ul", "dora-row__notes");
  row.append(head, trend, notes);
  return { row, head, trend, notes };
}

function headlineInto(
  doc: Document,
  head: HTMLElement,
  notes: HTMLElement,
  state: HeadlineState,
): void {
  if (state.kind === "loading") {
    head.append(el(doc, "span", "dora-row__value dora-row__value--loading", "…"));
    return;
  }
  if (state.kind === "failed") {
    head.append(el(doc, "span", "dora-row__value", "—"));
    notes.append(el(doc, "li", "dora-row__failed", HEADLINE_FAILED));
    return;
  }
  const v = state.value;
  head.append(
    el(doc, "span", "dora-row__value", v.value === null ? "—" : formatValue(v.value, v.unit)),
  );
  head.append(el(doc, "span", "dora-row__sample", `n=${v.sample}`));
  if (v.gap !== null) notes.append(el(doc, "li", "dora-row__headgap", GAP_SENTENCE[v.gap]));
}

function trendInto(
  doc: Document,
  trend: HTMLElement,
  notes: HTMLElement,
  state: TrendState,
  range: DoraRange,
  headGap: StatsGap,
): void {
  if (state.kind === "hidden" || state.kind === "loading") return;
  if (state.kind === "failed") {
    notes.append(el(doc, "li", "dora-row__failed", TREND_FAILED));
    return;
  }
  const pts = state.series.points;
  let gaps = gapSummary(pts);
  if (pts.every((p) => p.value === null)) {
    const top = gaps[0];
    if (top === undefined) {
      trend.append(el(doc, "p", "dora-row__notrend", "No trend: no data."));
    } else {
      // The top gap's coverage rides on this line, so it is not listed again.
      // When the headline already says it for every bucket, point at it.
      const reason =
        top.gap === headGap && top.count === pts.length
          ? "for the reason above"
          : GAP_SENTENCE[top.gap];
      trend.append(
        el(
          doc,
          "p",
          "dora-row__notrend",
          `No trend: ${reason} — ${top.count} of ${pts.length} ${range.bucketNoun}`,
        ),
      );
      gaps = gaps.slice(1);
    }
  } else {
    trend.append(renderSparkline(doc, pts, trendSummary(pts, range)));
  }
  for (const { gap, count } of gaps) {
    if (gap === headGap && count === pts.length) continue; // the headline already says it
    notes.append(
      el(
        doc,
        "li",
        "dora-row__gap",
        `${GAP_SENTENCE[gap]} — ${count} of ${pts.length} ${range.bucketNoun}`,
      ),
    );
  }
}

export function renderDeliveryRow(
  doc: Document,
  key: DoraMetricKey,
  headline: HeadlineState,
  trend: TrendState,
  range: DoraRange,
): HTMLElement {
  const f = rowFrame(doc, DELIVERY_LABEL[key]);
  f.row.dataset["metric"] = key;
  headlineInto(doc, f.head, f.notes, headline);
  trendInto(
    doc,
    f.trend,
    f.notes,
    trend,
    range,
    headline.kind === "loaded" ? headline.value.gap : null,
  );
  return f.row;
}

export function renderActivityRow(
  doc: Document,
  metric: ActivityMetricId,
  trend: TrendState,
  range: DoraRange,
): HTMLElement {
  const f = rowFrame(doc, ACTIVITY_LABEL[metric]);
  f.row.dataset["metric"] = metric;
  if (trend.kind === "loaded") {
    const t = seriesTotal(trend.series.points);
    // From a point that HAS a value: that is the unit the total is a sum of.
    const unit = trend.series.points.find((p) => p.value !== null)?.unit ?? "";
    f.head.append(
      el(doc, "span", "dora-row__value", t.total === null ? "—" : formatValue(t.total, unit)),
    );
    f.head.append(
      el(
        doc,
        "span",
        "dora-row__sample",
        `total · ${t.reported} of ${t.of} ${range.bucketNoun} reported`,
      ),
    );
  } else {
    f.head.append(el(doc, "span", "dora-row__value", trend.kind === "loading" ? "…" : "—"));
  }
  trendInto(doc, f.trend, f.notes, trend, range, null);
  return f.row;
}

export function renderFootnote(doc: Document): HTMLElement {
  return el(doc, "p", "dora__footnote", FOOTNOTE);
}
