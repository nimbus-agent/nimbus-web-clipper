// src/dora/dora.ts
// The DORA page (C10.2). Sends messages, renders what comes back.
//
// It never calls the gateway — the worker does, through two PUBLIC routes —
// and it never stores a figure. Seven reads per selection: one headline
// envelope, six trend series. Each read paints its own row the moment it
// settles; `Promise.allSettled` over the same seven runs afterwards only to
// decide the page-level "can't reach" state. A generation counter discards any
// reply that belongs to an earlier service or range.

import { sendMessage } from "../browser/runtime.ts";
import { sendableId } from "../shared/deploy.ts";
import {
  ACTIVITY_METRICS,
  type ActivityMetricId,
  DEFAULT_RANGE,
  DELIVERY_KEYS,
  DELIVERY_ROWS,
  DORA_RANGES,
  type DoraMetricKey,
  type DoraRangeId,
  doraPagePath,
  isDoraRangeId,
  RANGES,
  type StatsMetricId,
} from "../shared/dora.ts";
import {
  isDoraMetricsResponse,
  isMetricsStatsResponse,
  isServiceBindingsListResponse,
} from "../shared/messages.ts";
import type { ServiceBinding } from "../shared/services.ts";
import {
  type HeadlineState,
  renderActivityRow,
  renderDeliveryRow,
  renderFootnote,
  type TrendState,
  UNREACHABLE_NOTICE,
  UNSUPPORTED_NOTICE,
} from "./dora-view.ts";

const RANGE_KEY = "nimbus.dora.range";
const NO_BINDINGS =
  "No services bound yet. Open a pull request in a repository Nimbus knows, open the Nimbus panel, and bind it under Deploy readiness.";
const CHOOSE = "Choose a service";

const picker = document.getElementById("service-picker") as HTMLSelectElement | null;
const notice = document.getElementById("dora-notice");
const deliveryList = document.getElementById("delivery-rows");
const activityList = document.getElementById("activity-rows");
const footer = document.getElementById("dora-footer");

let generation = 0;
let serviceId: string | null = null;
let range: DoraRangeId = readRange();

const headline: Record<DoraMetricKey, HeadlineState> = Object.fromEntries(
  DELIVERY_KEYS.map((k) => [k, { kind: "loading" }]),
) as Record<DoraMetricKey, HeadlineState>;
const trends = new Map<StatsMetricId, TrendState>();

function readRange(): DoraRangeId {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    return isDoraRangeId(v) ? v : DEFAULT_RANGE;
  } catch {
    return DEFAULT_RANGE;
  }
}

function saveRange(r: DoraRangeId): void {
  try {
    localStorage.setItem(RANGE_KEY, r);
  } catch {
    // A per-viewer convenience: losing it costs one click next time.
  }
}

function setNotice(text: string | null): void {
  if (notice === null) return;
  notice.hidden = text === null;
  notice.textContent = text ?? "";
}

function paint(): void {
  // The range buttons reflect state even before a service is chosen.
  for (const id of DORA_RANGES) {
    document.getElementById(`range-${id}`)?.setAttribute("aria-pressed", String(id === range));
  }
  if (serviceId === null) {
    // Nothing chosen (no bindings, or several and no ?service=): no rows at
    // all, rather than six "…" placeholders under a notice saying why.
    deliveryList?.replaceChildren();
    activityList?.replaceChildren();
    return;
  }
  const r = RANGES[range];
  deliveryList?.replaceChildren(
    ...DELIVERY_KEYS.map((k) =>
      renderDeliveryRow(
        document,
        k,
        headline[k],
        trends.get(DELIVERY_ROWS[k]) ?? { kind: "loading" },
        r,
      ),
    ),
    renderFootnote(document),
  );
  activityList?.replaceChildren(
    ...ACTIVITY_METRICS.map((m: ActivityMetricId) =>
      renderActivityRow(document, m, trends.get(m) ?? { kind: "loading" }, r),
    ),
  );
}

/** A rejected send — the channel closed, most often a worker restart — counts
 *  as unreachable: nothing was answered. */
type Outcome = "ok" | "unreachable" | "other";

async function readHeadline(gen: number, svc: string): Promise<Outcome> {
  let raw: unknown;
  try {
    raw = await sendMessage({ kind: "dora-metrics", serviceId: svc, range });
  } catch {
    raw = undefined;
  }
  if (gen !== generation) return "other";
  if (!isDoraMetricsResponse(raw, svc) || !raw.ok) {
    for (const k of DELIVERY_KEYS) headline[k] = { kind: "failed" };
    paint();
    // Only no answer at all, or the worker's own "unreachable", counts toward
    // the page-level state; a malformed reply is a failed row, not a dead gateway.
    if (raw === undefined) return "unreachable";
    return isDoraMetricsResponse(raw, svc) && !raw.ok && raw.reason === "unreachable"
      ? "unreachable"
      : "other";
  }
  for (const k of DELIVERY_KEYS) headline[k] = { kind: "loaded", value: raw.result.metrics[k] };
  if (footer !== null) {
    footer.textContent = `Calculated ${new Date(raw.result.computed_at).toLocaleString()} by your local Nimbus gateway.`;
  }
  paint();
  return "ok";
}

async function readTrend(gen: number, svc: string, metric: StatsMetricId): Promise<Outcome> {
  let raw: unknown;
  try {
    raw = await sendMessage({ kind: "metrics-stats", serviceId: svc, range, metric });
  } catch {
    raw = undefined;
  }
  if (gen !== generation) return "other";
  if (!isMetricsStatsResponse(raw, svc, metric)) {
    trends.set(metric, { kind: "failed" });
    paint();
    return raw === undefined ? "unreachable" : "other";
  }
  if (raw.ok) {
    trends.set(metric, { kind: "loaded", series: raw.series });
    paint();
    return "ok";
  }
  if (raw.reason === "unsupported") {
    trends.set(metric, { kind: "hidden" });
    setNotice(UNSUPPORTED_NOTICE);
  } else {
    trends.set(metric, { kind: "failed" });
  }
  paint();
  return raw.reason === "unreachable" ? "unreachable" : "other";
}

async function load(): Promise<void> {
  if (serviceId === null) return;
  const gen = ++generation;
  const svc = serviceId;
  for (const k of DELIVERY_KEYS) headline[k] = { kind: "loading" };
  trends.clear();
  setNotice(null);
  if (footer !== null) footer.textContent = "";
  paint();
  const metrics: StatsMetricId[] = [
    ...DELIVERY_KEYS.map((k) => DELIVERY_ROWS[k]),
    ...ACTIVITY_METRICS,
  ];
  const reads = [readHeadline(gen, svc), ...metrics.map((m) => readTrend(gen, svc, m))];
  const settled = await Promise.allSettled(reads);
  if (gen !== generation) return;
  if (settled.every((s) => s.status === "fulfilled" && s.value === "unreachable")) {
    setNotice(UNREACHABLE_NOTICE);
    deliveryList?.replaceChildren();
    activityList?.replaceChildren();
  }
}

function fillPicker(bindings: readonly ServiceBinding[], extra: string | null): void {
  if (picker === null) return;
  const scopes = new Map<string, string[]>();
  for (const b of bindings) scopes.set(b.serviceId, [...(scopes.get(b.serviceId) ?? []), b.scope]);
  const options: HTMLOptionElement[] = [];
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = CHOOSE;
  options.push(placeholder);
  for (const [id, list] of scopes) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = `${id} — ${list.join(", ")}`;
    options.push(o);
  }
  if (extra !== null && !scopes.has(extra)) {
    const o = document.createElement("option");
    o.value = extra;
    o.textContent = `${extra} — not bound in this browser`;
    options.push(o);
  }
  picker.replaceChildren(...options);
}

function select(id: string): void {
  serviceId = id;
  if (picker !== null) picker.value = id;
  window.history.replaceState(null, "", doraPagePath(id));
  void load();
}

async function main(): Promise<void> {
  const fromUrl = new URLSearchParams(window.location.search).get("service");
  const requested = sendableId(fromUrl) ? fromUrl : null;
  let bindings: readonly ServiceBinding[] = [];
  try {
    const res = await sendMessage({ kind: "service-bindings-list" });
    if (isServiceBindingsListResponse(res) && res.ok) bindings = res.bindings;
  } catch {
    // No bindings to offer; a ?service= still loads.
  }
  fillPicker(bindings, requested);
  const distinct = [...new Set(bindings.map((b) => b.serviceId))];
  if (requested !== null) {
    select(requested);
  } else if (distinct.length === 1 && distinct[0] !== undefined) {
    select(distinct[0]);
  } else if (distinct.length === 0) {
    setNotice(NO_BINDINGS);
  }
  paint();
}

picker?.addEventListener("change", () => {
  if (picker.value !== "") select(picker.value);
});

for (const id of DORA_RANGES) {
  document.getElementById(`range-${id}`)?.addEventListener("click", () => {
    if (id === range) return;
    range = id;
    saveRange(id);
    void load();
  });
}

void main(); // NOSONAR S7785: the "iife" build rejects top-level await
