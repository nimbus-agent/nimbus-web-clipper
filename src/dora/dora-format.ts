// src/dora/dora-format.ts
// Every string the DORA page prints about a number or a gap. Pure.
//
// One formatter per unit, shared by headlines, gap lists and sparkline titles,
// so a point and its headline never disagree on precision. Both tables are
// `Record`s, never switches: deleting a key is a type error, and there is no
// unreachable backstop line for coverage to count.

import { UNRECOGNISED_GAP } from "../shared/deploy.ts";
import { type DoraRange, STATS_GAPS, type StatsGap, type StatsPoint } from "../shared/dora.ts";

const KNOWN_UNITS = ["deploys_per_day", "ratio", "seconds_median", "merges", "incidents"] as const;
type KnownUnit = (typeof KNOWN_UNITS)[number];

function isKnownUnit(u: string): u is KnownUnit {
  return (KNOWN_UNITS as readonly string[]).includes(u);
}

const DURATION_UNITS: readonly (readonly [number, string])[] = [
  [86_400, "d"],
  [3_600, "h"],
  [60, "m"],
  [1, "s"],
];

/** The largest unit, plus the next one down when it is non-zero: "4h 12m", "2d". */
export function formatDuration(seconds: number): string {
  let rest = Math.round(seconds);
  const parts: [number, string][] = DURATION_UNITS.map(([size, suffix]) => {
    const n = Math.floor(rest / size);
    rest -= n * size;
    return [n, suffix];
  });
  const first = parts.findIndex(([n]) => n > 0);
  if (first === -1) return "0s";
  const [n1, s1] = parts[first] ?? [0, "s"];
  const next = parts[first + 1];
  return next !== undefined && next[0] > 0 ? `${n1}${s1} ${next[0]}${next[1]}` : `${n1}${s1}`;
}

const UNIT_FORMAT: Record<KnownUnit, (v: number) => string> = {
  deploys_per_day: (v) => `${v !== 0 && v < 0.1 ? v.toFixed(2) : v.toFixed(1)} / day`,
  ratio: (v) => `${(v * 100).toFixed(1)}%`,
  seconds_median: (v) => `${formatDuration(v)} median`,
  merges: (v) => String(Math.round(v)),
  incidents: (v) => String(Math.round(v)),
};

export function formatValue(value: number, unit: string): string {
  return isKnownUnit(unit) ? UNIT_FORMAT[unit](value) : `${value} ${unit}`;
}

/** `null` means "no gap" and needs no sentence — and cannot be a `Record` key. */
export const GAP_SENTENCE: Record<NonNullable<StatsGap>, string> = {
  unknown_service: "Nimbus has no service with this id configured.",
  no_pagerduty_mapping: "This service has no PagerDuty mapping, so incidents can't be counted.",
  no_repos: "No repository this metric can read is bound to this service in Nimbus.",
  no_deployment_data: "No deployments recorded in this period.",
  low_sample: "Too few events to report a value (none, or fewer than three).",
  approximate_lead_time:
    "Some lead times are approximate: not every change could be matched exactly to the deployment that shipped it.",
  mixed_source:
    "Deployments are counted from two kinds of record: annotated deploys and pattern-matched CI runs.",
  github_only_merge_data:
    "Only GitHub records merge times, so this service's other repositories aren't counted.",
  incidents_missing_opened_at: "Some incidents have no recorded opening time and aren't counted.",
  [UNRECOGNISED_GAP]: "Nimbus gave a reason this version of the extension doesn't recognise.",
};

const GAP_ORDER: readonly NonNullable<StatsGap>[] = [...STATS_GAPS, UNRECOGNISED_GAP];

export function gapSummary(
  points: readonly StatsPoint[],
): { gap: NonNullable<StatsGap>; count: number }[] {
  const counts = new Map<NonNullable<StatsGap>, number>();
  for (const pt of points) {
    if (pt.gap !== null) counts.set(pt.gap, (counts.get(pt.gap) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([gap, count]) => ({ gap, count }))
    .sort((a, b) => b.count - a.count || GAP_ORDER.indexOf(a.gap) - GAP_ORDER.indexOf(b.gap));
}

/** A sum of counts is honest; a sum over zero reported buckets is not a zero. */
export function seriesTotal(points: readonly StatsPoint[]): {
  total: number | null;
  reported: number;
  of: number;
} {
  let total = 0;
  let reported = 0;
  for (const pt of points) {
    if (pt.value !== null) {
      total += pt.value;
      reported += 1;
    }
  }
  return { total: reported === 0 ? null : total, reported, of: points.length };
}

export function trendSummary(points: readonly StatsPoint[], range: DoraRange): string {
  const n = points.length;
  const head = `${n} ${range.adjective} point${n === 1 ? "" : "s"}`;
  const values = points.flatMap((pt) =>
    pt.value === null ? [] : [{ v: pt.value, unit: pt.unit }],
  );
  const first = values[0];
  if (first === undefined) return `${head}, none with values`;
  const min = values.reduce((a, b) => (b.v < a.v ? b : a), first);
  const max = values.reduce((a, b) => (b.v > a.v ? b : a), first);
  return `${head}, ${values.length} with values, ${formatValue(min.v, min.unit)} to ${formatValue(max.v, max.unit)}`;
}
