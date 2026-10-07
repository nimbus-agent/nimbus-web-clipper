# C10.2 — The DORA page

Supersedes §5 and the `dora-metrics` half of §6.1 of
[`2026-09-10-before-you-ship-it-design.md`](./2026-09-10-before-you-ship-it-design.md),
which this feature's PR deletes (§9).

## 1. Intent

The last unbuilt slice of Phase C10 — "before you ship it". C10.1 answers *is
this change safe to deploy?* from a PR or build page; this page answers *how is
this service delivering?* — the four DORA metrics plus two activity counts for a
service the user has already bound, read from the local gateway.

The page shows a **headline figure** per metric and a **trend** beneath it, and
it shows its own uncertainty rather than hiding it: a metrics page that renders
a confident-looking number nobody should trust is the failure mode this design
exists to avoid.

Success:

- A user with a bound service reaches the page in one click from Options or
  from the panel's deploy section, and sees six rows filled in independently.
- No `null` is ever drawn as `0`; every gap the gateway reports is named on the
  page.
- A gateway without the trend route renders the headlines exactly as well, with
  one sentence saying trends need a newer gateway — no version floor.

## 2. Why the original §5 is superseded

§5.1 of the C10 spec ruled out a trend line: `GET /v1/metrics/dora` takes
`since` and no `until`, so its windows nest and a slope between them means
nothing. That was true when written. `GET /v1/metrics/stats` (Nimbus#1493,
released in gateway v7.19.0) now serves one metric as a genuine **bucketed time
series**, publicly, beside the two routes C10.1 consumes. The `until` §7 of that
spec proposed is moot.

## 3. The two routes

Both are on the gateway's public read-only table: no bearer, no scope, no
`parseScopeGap`, no 403 path.

**`GET /v1/metrics/dora?service=&since=`** — one envelope with all four DORA
metrics over a window ending now. `since` matches `^\d+(d|h)$`, 1–365. An
unknown service answers **200** with every metric gapped `unknown_service`.

```ts
interface DoraMetricValue {
  value: number | null; unit: string; sample: number; gap: DoraGap;
}
interface DoraMetricsResult {
  service: string; since_ms: number; computed_at: string;
  metrics: {
    deployment_frequency: DoraMetricValue; lead_time_for_changes: DoraMetricValue;
    change_failure_rate: DoraMetricValue; mttr: DoraMetricValue;
  };
}
```

**`GET /v1/metrics/stats?service=&metric=&window_ms=&bucket_ms=`** — one metric
per call.

```ts
type StatsMetricId = "deployment-frequency" | "lead-time" | "change-failure-rate"
  | "mttr" | "pr-merges" | "incidents-opened";
interface StatsPoint {
  start_ms: number; end_ms: number; value: number | null;
  unit: string; sample: number; gap: StatsGap;
}
interface StatsSeries {
  metric: StatsMetricId; service: string;
  window: { since_ms: number; until_ms: number };
  bucket_ms: number; points: StatsPoint[];
}
```

`DoraGap` is `null | "unknown_service" | "no_pagerduty_mapping" | "no_repos" |
"no_deployment_data" | "low_sample" | "approximate_lead_time" | "mixed_source"`;
`StatsGap` adds `"github_only_merge_data" | "incidents_missing_opened_at"`.

Upstream facts the design depends on, each verified in the Nimbus source:

- **400 is a refusal.** Unknown service, unknown metric, non-integer or
  non-positive bounds, bucket > window and more than `MAX_BUCKETS` (400) buckets
  all answer `400 { error }`. A malformed `nimbus.toml` answers
  `500 { error: "config_unreadable" }`.
- **404 means the route is absent** — a gateway older than v7.19.0.
- **Buckets walk backward from now; the OLDEST bucket absorbs the remainder.**
  When the bucket does not divide the window, the first point is short.
- **Each bucket is the DORA value for that sub-window.** `low_sample` fires
  when n < 3 and *keeps* the value.
- **The two count metrics answer a zero as `value: null, gap: "low_sample"`**,
  not `0`.
- **The four wrapped DORA metrics bucket on `item.modified_at`** (last touch),
  so a PR or incident can land in a later bucket than it happened, and an event
  exactly on a boundary can be counted in two adjacent buckets. `pr-merges` and
  `incidents-opened` bucket on true event time.
- `github_only_merge_data` and `incidents_missing_opened_at` are series-wide
  reasons, repeated on many points.

## 4. The page

`src/dora/` — `dora.ts` → `dora.js`, `dora.html`/`dora.css`, and a pure
`dora-view.ts`. Mirrors `src/ledger/`.

### 4.1 Layout

1. **Service picker** and **range toggle**.
2. **Delivery** — four rows: deployment frequency, lead time, change failure
   rate, MTTR. Each row: headline value + unit + `n=`, a sparkline, its gap list.
3. **Activity** — two rows: PR merges, incidents opened. The headline is the
   **total** of the series' non-null buckets (§5.4).
4. Footer — the headline envelope's `computed_at`, and that every figure is read
   from the local gateway.

The two routes name the same four metrics differently — snake_case keys in the
headline envelope, kebab-case ids on the trend route, and `lead_time_for_changes`
is `lead-time` there. One table in `src/shared/dora.ts` pairs them, so a row's
headline and trend cannot come from different metrics:

```ts
export const DELIVERY_ROWS: Record<keyof DoraMetricsResult["metrics"], StatsMetricId> = {
  deployment_frequency: "deployment-frequency",
  lead_time_for_changes: "lead-time",
  change_failure_rate: "change-failure-rate",
  mttr: "mttr",
};
```

A `Record` over the envelope's keys, so a fifth DORA metric upstream is a type
error here rather than a row that silently never renders.

### 4.2 The service picker

Seeded from the existing `service-bindings-list` message: the distinct service
ids, each labelled with the repos bound to it. Which service loads, in order:

1. `?service=<id>`, when it passes `sendableId` — **even if no binding names
   it**. A binding is a convenience for the picker, not a permission: the routes
   are public and the gateway is the authority on whether the id exists, so an
   unknown one renders the headline's own `unknown_service` sentence rather than
   a client-side refusal. Such an id joins the picker labelled "not bound in
   this browser".
2. Otherwise, when exactly one service is bound, that one.
3. Otherwise the picker opens with nothing selected and no reads issued.

Choosing a service updates the URL through `history.replaceState`, so a reload
or a duplicated tab keeps it. With no bindings and no `?service=` the page says
how to make one (from a PR page's deploy section) and issues **no** gateway
reads.

### 4.3 The range

One toggle, three week-aligned options. Week-aligned because upstream's short
oldest bucket (§3) would read as a false dip on a count metric; every window
here divides exactly by its bucket.

| Range | Label | Headline `since` | Trend `window_ms` | Trend `bucket_ms` | Points |
|---|---|---|---|---|---|
| `4w` | 4 weeks | `28d` | 28 d | 2 d | 14 |
| `13w` | 13 weeks | `91d` | 91 d | 7 d | 13 |
| `26w` | 26 weeks | `182d` | 182 d | 14 d | 13 |

Default `13w`. One `RANGES` table in `src/shared/dora.ts` is the only source of
these numbers; the page reads its labels from it and the worker its parameters.
It is a `Record<DoraRangeId, { label, since, windowMs, bucketMs }>` keyed by
`DORA_RANGES = ["4w", "13w", "26w"] as const` — the array the message guard
tests membership against. The point count is **not** a field: it is
`windowMs / bucketMs`, and a test asserts that divides exactly, so storing it
too would only be a second number that could disagree.
The choice persists per viewer in `localStorage`, every access wrapped in
try/catch, falling back to `13w`.

### 4.4 Seven reads, independently fallible

A render issues one `dora-metrics` and six `metrics-stats` messages
concurrently. **Each read carries its own `.then`** that renders its own row the
moment it settles; a single `await Promise.allSettled(...)` before rendering
would hold every row hostage to the slowest read. `Promise.allSettled` over the
same seven promises is awaited *afterwards*, only to decide the page-level
states below — never `Promise.all`, which would reject on the first failure.

Changing service or range re-issues all seven; a **generation counter**,
captured when the reads are issued and compared in every `.then` and in the
`allSettled` continuation, discards any reply belonging to an earlier selection,
so a slow stale read never overwrites a newer one.

Page-level states, and only these:

- all seven `unreachable` → "Can't reach your Nimbus gateway" in place of the
  rows;
- any stats read `unsupported` → one line spanning both groups, "Trends need a
  newer Nimbus gateway", with no sparklines and the headlines unaffected.

## 5. Honesty rules

### 5.1 The gap vocabulary

`src/shared/dora.ts` exports `DORA_GAPS` and `STATS_GAPS` (the former spread
into the latter) as `as const` arrays. The client-side type is
`StatsGap = (typeof STATS_GAPS)[number] | typeof UNRECOGNISED_GAP | null`, and
the sentence for each renders through a
`Record<NonNullable<StatsGap>, string>` — `null` cannot be a `Record` key, and
it needs no sentence because it means "no gap". Never a switch, so deleting an
arm is a type error and there is no unreachable backstop line for coverage to
count.

**One** gap parser serves both routes, over `STATS_GAPS`. A headline that cites
a stats-only reason is not a shape violation; it renders that reason's sentence.

An unknown gap **string** parses to `UNRECOGNISED_GAP` (reusing the constant
from `src/shared/deploy.ts`) and degrades only that point or headline. A gap of
the wrong **type** is a shape violation and rejects the envelope (§6.3).

The `low_sample` sentence covers the count metrics' zero (§3): *"Too few events
to report a value (none, or fewer than three)."* The client never reinterprets
it as `0`.

### 5.2 Headlines

- `value === null` → "—" and the gap sentence. **Never `0`.**
- `n=` is always shown.
- A value with a gap (`low_sample`, `mixed_source`) prints the value with the
  sentence beneath it.
- Units format through a `Record` over the known units, one formatter per unit
  shared by headlines, gap lists and sparkline `<title>`s, so a point and its
  headline never disagree on precision:

  | Unit | Format | Examples |
  |---|---|---|
  | `deploys_per_day` | one decimal; two below 0.1 | "1.4 / day", "0.05 / day" |
  | `ratio` | percentage, one decimal | "4.2%", "0.0%", "100.0%" |
  | `seconds_median` | the two largest non-zero units, labelled "median" | "45s", "18m", "4h 12m", "2d 12h" |
  | `merges`, `incidents` | integer | "7" |

  An unknown unit prints the raw number and the unit string.

### 5.3 Sparklines

Hand-drawn inline SVG in `dora-view.ts`; no charting dependency.

- A `null` point **breaks the line** and draws a hollow baseline marker whose
  `<title>` names its period and gap.
- A point with a value *and* a gap is drawn hollow and its adjoining segments
  are dashed.
- The y-axis **starts at zero** and ends at the largest plotted value. When
  that largest value is `0` — a flat zero series, e.g. no change failures in
  any week — every point sits on the baseline; the scale is never computed as
  `value / max`, which would make every coordinate `NaN`. It is **not** clamped
  to a floor of `1` either: `ratio` lives in 0–1, and a floor of 1 would flatten
  every change-failure-rate trend toward the baseline.
- A series with exactly one plotted value draws a lone marker, since a
  one-point path has no segment to stroke.
- An all-null series renders no SVG: "No trend: <sentence for its most common
  gap>".
- Each SVG carries a text summary for assistive technology, e.g. "13 weekly
  points, 9 with values, 0.8–1.7 / day".

### 5.4 Gap lists and totals

Under each row every distinct gap in its series is listed **once**, with its
coverage — "Too few events to report a value — 4 of 13 weeks". A series-wide
reason is therefore one line, not thirteen.

An Activity row's total sums its non-null buckets and states its coverage:
"total · 9 of 13 weeks reported". All-null → "—" and the gap.

### 5.5 The last-touch footnote

The four Delivery rows' trends carry one footnote: *"Trend buckets group work by
when it was last updated, so an item can land in a later period than it
happened."* The Activity rows do not — they bucket on event time (§3).

## 6. Messages and client

### 6.1 Messages

In `src/shared/messages.ts`, `kind`-discriminated, each with a guard:

- `dora-metrics { serviceId, range }` →
  `{ ok: true, result: DoraMetricsResult } | { ok: false, reason }`
- `metrics-stats { serviceId, range, metric }` →
  `{ ok: true, series: StatsSeries } | { ok: false, reason }`
- `open-dora { serviceId }` → **no reply**, deliberately (§7.2). It follows
  the existing `cue-open` precedent exactly: the route opens the tab and
  returns `false`, which closes the channel, and the panel sends it as
  `void sendMessage(…).catch(() => undefined)`. Nothing awaits it, so nothing
  can hang; a reply type would be a shape no caller reads.

The page sends a **range name**, never milliseconds; the worker resolves it
through `RANGES`. The guards check `range` and `metric` by **membership in the
real lists**, not `typeof === "string"` — the type-narrow-runtime-wide defect
this repo has shipped three times. `serviceId` passes the existing `sendableId`.

### 6.2 Client

`src/background/deploy-client.ts` gains `fetchDoraMetrics` and
`fetchStatsSeries`, reusing its tokenless `getJson`, the deploy timeout and
`readJson`. `GATEWAY_PATHS` gains `metricsStats: "/v1/metrics/stats"`;
`metricsDora` is already there.

The stats read needs a wider status ladder than `getJson`'s ok/non-ok:

| Outcome | `reason` | Rendered as |
|---|---|---|
| fetch threw, or timed out | `unreachable` | "Couldn't load this trend" on that row |
| 404 | `unsupported` | the page-level line of §4.4 |
| 400 | `refused` | nothing extra; the headline already shows `unknown_service` |
| other non-2xx | `server_error` | "Couldn't load this trend" on that row |
| body fails §6.3 | `malformed` | "Couldn't load this trend" on that row |

The gateway's 400 text is not shown: it names `nimbus.toml` internals, and the
headline's gap sentence says the same thing in the user's terms.

`dora-metrics` keeps `getJson`'s existing ladder (`unreachable` /
`server_error` / `malformed`); its failure renders "Couldn't load" in place of
the four headlines only.

### 6.3 Parsers

`parseDoraMetrics` and `parseStatsSeries` in `src/shared/dora.ts` **build new
objects field by field** — never return the input object — and reject:

- a `service` or `metric` different from the one requested;
- more than `MAX_BUCKETS` (400) points;
- a non-finite number anywhere, or `start_ms >= end_ms`;
- a gap that is neither `null` nor a string.

### 6.4 Mock gateway

`scripts/screenshots/mock-gateway.ts` serves `/v1/metrics/stats` with fixtures
for a healthy series, a sparse `low_sample` series, an all-
`no_pagerduty_mapping` series and a series carrying `github_only_merge_data`;
plus a scenario with the route absent (404).

## 7. Outside `src/dora/`

### 7.1 Build

- `esbuild.mjs`: a `dora` entry in `ENTRIES`; `dora.html`, `dora.css` in
  `HTML_CSS`.
- `scripts/check-build.mjs`: `dora.js`, `dora.html`, `dora.css` in
  `REQUIRED_FILES`.
- **No manifest change, no new permission.** `store/listing.md` is untouched.

### 7.2 Entry points

- **Options** — a "DORA metrics" link beside Activity and Briefs, through the
  existing `openExtensionPage`.
- **Panel deploy section** — when a service is bound, "Delivery metrics for
  `<id>` →". The panel is a content script: it cannot call `chrome.tabs.create`,
  and an `<a href="chrome-extension://…">` from a web page needs `dora.html`
  declared web-accessible, which would let any site probe for the extension.
  So the link sends `open-dora`; the worker validates the id with `sendableId`
  and opens `dora.html?service=<encodeURIComponent(id)>`. Its docblock says why,
  so nobody "simplifies" it into an anchor. The control is a `<button>`, like
  the deploy section's other actions, placed under the verdict.

### 7.3 Routing

`src/background/service-worker.ts` routes through `??`-chained slices, each kept
under Sonar's cognitive-complexity ceiling. `routeDeploy` already carries five
messages, so the three new ones get a **`routeDora`** slice of their own,
chained after `routeDeploy`, rather than growing it to eight.

### 7.4 Docs

- `docs/architecture.md` — "The DORA route's windows are nested, not a trend" is
  replaced by a "The DORA page" subsection recording §4.3's week alignment and
  why, §4.4, §5, the 404-is-capability rule, and `open-dora` versus
  web-accessible.
- `ROADMAP.md` — C10.2 ✅ shipped; its "never stitched into a line" text and the
  2026-09-13 correction are replaced by what shipped.
- `CLAUDE.md` — `/metrics/stats` joins the tokenless list; "nothing calls it
  yet" about `/metrics/dora` goes; `dora` joins the entries parenthesis.
- `development.md` — a manual-verification section carrying the e2e markers.
- `CHANGELOG.md` `[Unreleased]` — an `### Added` entry.
- The privacy policy is checked, not assumed: the page persists only a range
  preference in `localStorage`.

## 8. Testing

Test-first throughout, against the existing deploy/ledger test files.

- `dora.test.ts` — parser rejections (§6.3); unknown gap → `UNRECOGNISED_GAP`;
  an extra input field absent from the output; every `RANGES` row divides
  exactly, stays ≤ 400 buckets, and its `since` matches `^\d+d$` within 1–365.
- `messages.test.ts` — the three guards accept every real `range` / `metric`
  and reject a string outside the lists.
- `deploy-client.test.ts` — the §6.2 ladder, row by row; the query string
  carries `RANGES`' numbers.
- `deploy-handlers.test.ts` — `open-dora` rejects an unsendable id and encodes
  an accepted one.
- `dora-view.test.ts` (jsdom) — one test per §5 rule, including a flat-zero
  series (no `NaN` in any coordinate, every point on the baseline), a 0–1
  `ratio` series that is not flattened, a one-value series, and every row of
  §5.2's format table. The `Record` exhaustiveness is proven once by deleting a
  key and watching `typecheck` fail.
- `dora-page.test.ts` (jsdom) — a fast row renders while a slow one is still
  pending; one failed stats read leaves five rows; all seven unreachable → the
  page-level message; a 404 → the single "newer gateway" line; a range switch
  whose stale replies resolve last leaves the newer data; `?service=`
  preselects, an unbound one still loads and joins the picker as "not bound in
  this browser"; a single binding auto-selects; choosing a service rewrites the
  URL; no bindings and no `?service=` → no gateway reads; `localStorage`
  throwing still renders.
- `mock-gateway.test.ts` — the new fixtures and the absent-route scenario.
- e2e `test/e2e/dora.e2e.ts` — `dora-from-options`, `dora-from-panel`,
  `dora-old-gateway`, with matching markers in `development.md`.

Before each push: `typecheck`, `lint`, `test`, `build`, `check-build`,
`test:e2e`, and a grep for absolute `file:///` links.

## 9. Slices and pruning

One PR, three commits:

1. Shared types, `RANGES`, parsers, client, messages — no UI.
2. The page and the Options link.
3. The panel link, docs, CHANGELOG — and deletion of
   `2026-09-10-before-you-ship-it-design.md`, its `-review.md`, this file and its
   `2026-10-07-the-dora-page-review.md`,
   after confirming every durable decision in them lives in
   `docs/architecture.md`.
