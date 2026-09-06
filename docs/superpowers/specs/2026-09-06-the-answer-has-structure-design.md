# Phase C8 — The answer has structure

> **Status:** design, approved for implementation. Sliced into C8.1–C8.3 (§6).
> **Repo:** `nimbus-web-clipper` (client-only; the parallel upstream work in §9
> is not a dependency).

## 1. Summary

Every agent lane in the panel renders one paragraph. The gateway sends that
paragraph **and** the typed object it was flattened from, on the same response,
and has since the route shipped. The client reads the paragraph and drops the
object.

This phase reads the object. Each lane renders what its agent actually returns —
ranked reviewers with the evidence behind each one, impacted items with hop
counts, a *why* timeline whose entries carry real URLs — plus two things that
ride along with all seven lanes and are invisible today: the `gaps` that explain
an empty answer, and the provenance that says whether a model wrote the text.

**Nothing gateway-side changes.** This is a client parser and a renderer.

## 2. What is already on the wire

`GET /v1/agents/runs/{id}` serves
(`Nimbus/packages/gateway/src/ipc/http-server.ts:951-961`):

```text
status                              // always
brief?         : string             // the flattened markdown
findings?      : unknown            // the full typed brief
failureReason? : string
synthesis?     : SynthesisProvenance
```

`findings` is populated for every agent, because all of them emit through one
helper (`agents/_lib/emit-brief.ts:64-69`):

```ts
opts.notify(opts.briefReadyMethod, {
  sessionId: opts.sessionId,
  brief: markdown,        // synthesized/deterministic markdown
  findings: brief,        // THE FULL TYPED BRIEF OBJECT
  synthesis: provenance,
});
```

The markdown is a **lossy flattening** performed by `agents/_lib/render.ts`. It
drops `personId` and `score` from `expert`, `affectedItemId` from `impact`,
`entityId` from `why`, and never renders `catchup`'s `involvement` at all. Both
forms ride the same notification and land in the same run record; the client
chooses the lossy one.

The client's `parseAgentRunBody` (`src/background/gateway-client.ts:658-683`)
reads `status`, `brief` and `failureReason`, and touches neither `findings` nor
`synthesis`.

### 2.1 Why the existing deferral no longer applies

`src/shared/types.ts:575` records why `findings` was left unmodelled:

> Upstream types it `unknown` — "the shape is per-agent" — and nothing in the
> panel renders it. […] add `findings` back only alongside a concrete renderer
> for it, never as a passthrough `unknown`.

Both halves still hold, and this phase satisfies both. The shape *is* per-agent —
and each agent's shape is published and stable (`@nimbus-dev/sdk`,
`@moduleStability stable`). And this phase **is** the concrete renderer, which is
the precondition the comment names. What it forbids — a passthrough `unknown`
across the message boundary — §4.1 specifically does not do.

## 3. Non-goals

- **No save-to-index for an agent answer.** Considered and rejected, because
  upstream already rejected it: `agent-runs/agent-run-store.ts:8` records that
  persisting agent briefs would "write synthesised brief text — derived from the
  private index — into a new on-disk table, which is a privacy expansion." There
  is no save route and the absence is a decision. The client does not invent one.
- **No markdown rendering of `brief`.** The `textContent`-only rule
  (`docs/architecture.md:940`) is untouched. This phase renders *structure*, not
  formatted prose, and every string still goes through `textContent`.
- **No new gateway surface.** The one thing that would need one — resolving an
  `itemId` back to a URL (§4.6) — is named as an upstream candidate, not built
  around.
- **No re-run, no abort, no follow-up question.** The lane's interaction model is
  unchanged.

## 4. Design

### 4.1 Where findings enter

**Narrowing happens in the background, where the lane identity is known.**

`parseAgentRunBody` sits in `gateway-client.ts` and is handed a poll response; it
does not know which agent produced it. So it reads `findings` as `unknown` and
hands it up, and the terminal transition — `terminalLaneState`
(`src/background/service-worker.ts:309-331`), which is what builds
`{ kind: "done", brief }` today — narrows it against the lane through one guard
dispatch table. What crosses the message boundary is already typed — never
`unknown`.

Note that `handleAgentRun` (`handlers.ts:1043`) is the *invoke* path and is not
where this happens; it short-circuits on a cached `running`/`done` and never sees
a poll body.

`LaneState`'s `done` arm grows **two** optional fields, and they are siblings —
`synthesis` is deliberately *not* nested inside `findings`:

```ts
| {
    readonly kind: "done";
    readonly brief: string;
    readonly gaps?: readonly GapNote[];
    readonly findings?: LaneFindings;
    readonly synthesis?: SynthesisProvenance;
  }
```

`LaneFindings` is a discriminated union on `kind`, and it **grows one arm per
slice** — `why` in C8.1, three more in C8.2, three more in C8.3. An arm that does
not exist yet behaves exactly like a guard rejection: no findings, prose body.

**Why `gaps` and `synthesis` are siblings, not children.** Both are universal —
`gaps` sits on `AgentBriefBase`, so every agent carries it, and `synthesis` is a
top-level field of the response. Nesting either inside `findings` would tie it to
the one thing most likely to be missing: a guard rejection (§4.3), the byte bound
(§4.8), or simply a lane whose arm this slice has not added yet. They would then
vanish in exactly the case where the reader most needs them — a lane that fell
back to prose, where "why is this empty?" and "did a model write this, and did it
stay on my machine?" are unchanged and still answerable.

This is what makes §4.5's promise — gaps and provenance on **all seven** lanes —
deliverable in C8.1, when only one lane has a findings arm. Extracting them does
not require knowing which agent answered.

**`findings` holds a client projection, not the wire object verbatim.** Each arm
carries only the lane-specific payload this client renders; the base fields
(`gaps`, `agentVersion`, `generatedAt`, `latencyMs`) are not duplicated inside it.
The SDK types type the *parse*; the projection is what is persisted. That keeps
`gaps` single-sourced and keeps the stored payload close to what §4.8's byte
bound is actually protecting.

`isSynthesisProvenance` is its own guard in `src/shared/messages.ts`, narrowing
the three-arm union (§4.5) rather than accepting a bare object.

**The optionality of `findings` is the fallback mechanism.** Absent means "the
guard rejected, or this is a shape we do not model", and `renderLaneBody` renders
the prose `<pre>` exactly as it does today. That matches the fail-quiet the
roster read and the resolve-file probe already make.

Precisely: the fallback restores today's rendering **of the answer body**. It is
not a claim that the lane renders byte-identically to today, because §4.5 adds
gaps and provenance to all seven lanes independently of whether findings parsed.
A lane that falls back still gains its provenance line. Nothing about the
*failure* is announced — that is what stays silent.

**`terminalLaneState` needs the lane, and its result union needs the payload.**
Today it is `terminalLaneState(result, label)`
(`src/background/service-worker.ts:309`, called at `:429`), and the `done` arm of
the union it accepts is `{ ok: true; status: "done"; brief: string }`. Both
widen: the arm carries `findings?: unknown` and `synthesis?: unknown`, and the
function takes `lane: AgentLane` so it can select the right guard from the
dispatch table. The call site passes `run.lane`, which it already holds.

**The store guard grows with it — and must not evict.**
`agent-run-store.ts:135`'s `isLaneState` guards persisted data as external input
on purpose. But `readGuarded` (`keyed-store.ts:32`) **discards any entry whose
guard returns false**, by documented design: *"A value that fails is dropped, not
repaired and not thrown on."* So a storage-layer `isLaneState` that rejected a
run because its *findings* were malformed would throw away the whole run,
including a perfectly good `brief` — the opposite of the degradation this design
promises.

The storage guard therefore accepts `findings` as `unknown` at the entry level,
and sanitises on the way out: the read path strips findings that fail
`isLaneFindings` for that entry's lane and keeps `{ kind: "done", brief,
synthesis }`. Validation moves from the eviction boundary to a projection step,
so a malformed payload costs the structured view and nothing else.

### 4.2 Type provenance and the SDK seam

| type | source | guard |
| --- | --- | --- |
| `expert` `impact` `catchup` `why` briefs | `import type` from `@nimbus-dev/sdk` | written here (§4.3) |
| `ownership` `decisions` `glossary` briefs | local mirror, `src/shared/` | written here (§4.3) |
| `GapNote` (all seven) | `import type` from `@nimbus-dev/sdk` | written here |
| `SynthesisProvenance` | **local mirror** — see below | written here |

**`SynthesisProvenance` is a fourth mirror, not an SDK import.** It is declared in
the gateway's `agents/_lib/synthesize.ts` and is exported nowhere in
`@nimbus-dev/sdk` — the SDK models brief *shapes*, and provenance is a property
of the response that carries one. So it is mirrored locally on the same terms as
the other three, and publishing it is added to the upstream list (§9). This is
worth stating because §4.1 makes provenance a universal field: it is the one
mirrored type that C8.1 cannot defer.

`@nimbus-dev/sdk@^1.32.0` is added as a **devDependency, imported type-only**.
Type-only imports are erased at build, so:

- zero bytes reach `dist/`; `check-build.mjs` and `REQUIRED_FILES` are untouched;
- the "bundled, no runtime deps" rule is untouched, because nothing is imported
  at runtime;
- the SDK's export map (no `./agents` subpath) and its unset `sideEffects` stop
  mattering — there is no tree-shaking question to answer.

The package publishes to public npm (`publishConfig.access: "public"`,
`registry.npmjs.org`) and `nimbus-client` already consumes it at `^1.32.0`, so CI
and outside contributors can install it. This repo becomes the second SDK
consumer, and the first of the two satellite extensions — a Phase 8.1 data point,
not a Phase 8.1 commitment.

**`GapNote` needs no mirror.** The gateway's `_lib/findings.ts` is a pure
`export type { … } from "@nimbus-dev/sdk"` re-export, and `ownership-types.ts`
imports `GapNote` from the SDK directly. It is one SDK-owned type across all
seven lanes.

**Version skew is a non-event.** If the SDK's declarations and the gateway's wire
ever disagree, our own guards reject and the lane renders prose. The failure mode
is today's behaviour.

**The three mirrors are temporary and say so.** They live in one module, each
carrying the upstream issue that will replace it; swapping them later changes an
import, not a renderer. Nothing enforces that they stay in step with the SDK —
the same honest position `registry.ts` takes about the `Product → connector id`
coupling, which it documents as "discoverability, not enforcement". A test pins
the fields we actually read, so drift surfaces as a failure rather than as a
wrong render.

### 4.3 The guards are written here, at the depth we render

The SDK exports runtime guards (`isExpertBrief`, …). **They are too shallow to
render from**, by design. `createBriefGuard` (`guard-factory.ts`) checks `kind`,
`agentVersion === 1`, `Array.isArray(gaps)`, two numbers and a non-null `query`,
then one `extra` predicate — which for every agent is a bare
`Array.isArray(b["ranked"])` / `b["affected"]` / `b["sections"]`. No element is
ever validated. `isExpertBrief` asserts `ExpertBrief` over `{ ranked: [42, null] }`.

That is the failure mode this codebase keeps hitting — **type narrow, runtime
wide**: a guard that licenses the renderer to trust fields nobody checked. It is
not a security hole (`safeHttpUrl` rejects non-strings via `new URL`'s throw, and
`textContent` coerces) but a renderer reading `finding.displayName` as `string`
would paint `undefined`.

So the client writes element-level guards for all seven lanes, in the
`src/shared/messages.ts` idiom. One guard idiom, uniform across SDK-typed and
mirrored lanes — the SDK/local split is confined to where *declarations* come
from, which vanishes from the shipped bundle entirely.

Guards validate exactly the fields the renderer reads, and no more. A field we do
not render is not a field we gate on: an over-strict guard would reject briefs we
could have rendered usefully.

### 4.4 The seven renderers

Each is a pure module under `src/panel/findings/`, taking a typed brief, a
`Document` and `nowMs`, and returning a fragment. Not appended to `panel-view.ts`
(1,191 lines) or `panel-in-page.ts` (2,119 lines) — the two largest files in the
repo, and `renderLaneBody` is already a ten-branch function. Unit-tested under
the jsdom docblock, with no panel harness.

`nowMs` is a parameter, not a `Date.now()` call, so relative times are
deterministic in tests. That is already the house signature —
`formatAge(modifiedAtMs, nowMs)` in `src/shared/freshness.ts:27` — and the
renderers reuse it rather than formatting dates themselves.

**Every timestamp on the wire is a number.** `modifiedAt`, `occurredAt`,
`generatedAt`, `firstSeenAt`, `decidedAt` are all typed `number` (epoch ms) in
the SDK and the gateway, several explicitly documented as "Epoch ms, as the
source reports it". No renderer parses a date string, and no guard accepts one:
doing either would invent a wire shape the contract does not have. The guards
check `typeof === "number"`, which is what keeps a malformed value out of
`formatAge` rather than through it.

Three shared concerns live beside the renderers rather than inside each:

- **`findings-css.ts`** exports a `FINDINGS_CSS` string interpolated into
  `STYLES` (`panel-in-page.ts:273`). The panel is a Shadow DOM, so external
  stylesheets do not apply and all CSS is inline today; adding seven renderers'
  worth directly to that constant would grow the repo's largest file for no
  reason.
- **A shared link builder** — takes `(doc, text, rawUrl)`, returns an `<a>` when
  `safeHttpUrl` accepts and a `<span>` when it does not, always via
  `textContent`. This is the existing house pattern (`panel-view.ts:40-43` and
  `:327-330`, both `target="_blank"` + `rel="noopener noreferrer"`); factoring it
  out avoids a third hand-rolled copy and makes the safe-degradation rule
  impossible to forget in one renderer out of seven.
- **A quiet empty-state line per lane**, for the case where the result array and
  `gaps` are *both* empty. Without one the renderer emits an empty fragment and
  the lane paints a blank box under its header. The exact wording is set in the
  implementation plan; the rule is that it states the lane found nothing, and
  never implies the question could not be asked — that is what `gaps` is for.

- **`why`** — a timeline grouped by `WhyLane` (`authorship`, `pull_request`,
  `ticket`, `discussion`, `driver`, `downstream`). Each finding renders `title`,
  `detail`, `occurredAt`, and a link when `url` passes `safeHttpUrl`. A subject
  header from whichever arm is present — note `WhyChangeSubject.url` is
  non-nullable `string` while `WhyItemSubject.url` is `string | null`, so one
  null-check cannot span both arms.
- **`expert`** — `ranked` people: `displayName`, `confidence` band, `score`, with
  `evidence` rows (`type`, `title`, `modifiedAt`, `weight`) behind a disclosure.
  Keeps `personId` and `score`, both of which `render.ts` drops.
- **`impact`** — `affected` grouped by `category`, each with `affectedTitle`,
  `hops`, `pathSummary`. No links (§4.6).
- **`ownership`** — `target` and `parentDirectory` as owner tables: `label`,
  `share` as a percentage, and a marker where `resolved: false` (the
  `git:<email>` fallback, not a matched person row). The three count fields need
  care: `ownership-store.ts:22` states `null` means **not recorded** and "never
  doubles as 'no truncation'", so the renderer says *unavailable*, never
  *complete*.
- **`catchup`** — `sections` by service with items, `modifiedAt` and
  `relevanceReasons`; plus `involvement`, which upstream's own renderer never
  prints at all. This would be the first surface anywhere to show it.
- **`decisions`** — `statement`, `rationale`, `alternatives`, `confidence`,
  `hasAdr`, and evidence rows with links. `stats.truncatedSources` renders as an
  honesty caveat.
- **`glossary`** — mode-aware on `mode`: `term` → definition, `definitionSource`,
  `topSources` links; `miss` → `suggestions` as "did you mean"; `list` → ranked
  entries showing `score`. Upstream records that printing only `docFreq` while
  sorting on `score` made the visible number contradict the visible order; this
  renders the ordering key.

### 4.5 Gaps and provenance, on all seven lanes

**`gaps: GapNote[]`** — `{ category, detail, remediation? }` — rides every brief
and is invisible today. It is most valuable exactly where the lane's own result
array is empty, which is the case that currently reads as "there is nothing" when
the truth is "this cannot be asked". Rendering `detail` plus `remediation` turns
an empty answer into a reason and a fix.

This is the same honesty problem C6.1 solved by *withholding* lanes on a
Confluence `doc` page, and C7 solved with two distinct miss sentences. `gaps` is
the general mechanism that both of those approximated by hand.

**`synthesis: SynthesisProvenance`** — a one-line provenance note:

```ts
| { attempted: false; reason: "disabled" | "no_eligible_provider" | "reserved_extraction_failed" }
| { attempted: true; used: true;  model: string; remote: boolean }
| { attempted: true; used: false; reason: SynthesisDiscardReason; violations?: string[]; detail?: string }
```

`remote` exists only on the `used: true` arm and is the local/remote bit. So the
panel can state whether a model wrote the answer, which model, and whether it
stayed on the machine.

**This does not close C5.1's honest gap, and must not be written as if it does.**
That gap is about *briefs* and about a *pre-run* signal. This is *lanes* and
*post-run*. It answers the same question where the answer actually exists.

`detail` on the discard arm is redacted upstream before it reaches the type, but
it is still gateway free text and gets the same `textContent` treatment that
`failureReason` already does.

### 4.6 What can be linked, and what cannot

Exhaustive URL inventory across the seven browser lanes:

| carries a URL | ids only — not linkable |
| --- | --- |
| `why.findings[].url`, `why.changeSubject.url`, `why.itemSubject.url` | `impact` — only `affectedItemId` |
| `decisions.entries[].evidence[].url` | `catchup` — only `itemId` |
| `glossary.entries[].topSources[].url` | `expert.ranked[].evidence[]` — only `itemId` |

`impact`'s only URL is the query it echoes back, which is not a result.

**There is no client-side way to turn an `itemId` into a URL.**
`GET /v1/items/resolve` maps URL → item, not the reverse, and nothing else on the
contract does either. Three lanes get links and three do not; the renderers for
the second group show titles as text and say nothing about links they cannot
make. A reverse item-id → URL read is a clean upstream candidate (§9) — this
phase is shaped so those lanes gain links by adding a resolver later, with no
renderer change beyond a link wrap.

### 4.7 Security

Structured rendering **narrows** the attack surface rather than widening it.

- Every string still goes through `textContent`. The difference is that strings
  land in known slots instead of one blob — there is no parsing step anywhere,
  and no markdown pass. The rule at `docs/architecture.md:940` is preserved
  verbatim, not weakened.
- Findings are **graph-derived**: hops, weights, ids, timestamps and categories
  come from graph traversal, not from a model. The `brief` string is the model's
  prose rendering *of* them. So the structured form is, if anything, less
  attacker-adjacent than what the panel renders today.
- String fields inside findings (`title`, `displayName`, `pathSummary`, `detail`)
  still originate from indexed third-party content — a PR title is
  attacker-controlled — so they get no more trust than the blob does.
- Every URL goes through `safeHttpUrl` with no `base` (the strings are absolute,
  from the gateway). When it returns null the raw string renders as **text**, per
  that function's own documented rule: the user still sees what was claimed and
  simply cannot click it into an executable scheme.
- These are the first clickable references in the panel. They are sourced from
  the gateway's index, not parsed out of model prose — which is the distinction
  that makes them safe to add now when a markdown pass still is not.

### 4.8 Storage, privacy and size

`LaneState` is persisted (`agent-run-store.ts`), so findings will be too, under
the existing 10-minute TTL and 16-run cap.

This must be stated rather than inherited silently. Upstream deliberately does
**not** persist agent briefs to disk, calling it a privacy expansion. The client
already made the opposite call for `brief` text, bounded by TTL. Persisting
`findings` widens what sits in `chrome.storage.local` in *kind* — item ids,
person ids, evidence rows — while leaving lifetime and count unchanged. That is
defensible for a cache whose whole purpose is to avoid re-spending a model call,
and it is written down here so the next reader inherits the reasoning rather than
just the fact.

**Size is a new problem.** A `decisions` brief with twenty entries and their
evidence, or a `catchup` with several populated sections, is far larger than a
paragraph. The store has a run-count cap but no byte cap. This phase adds one: a
per-run findings byte bound, applied in `putRun` before persisting, above which
findings are dropped and the run is stored as `{ kind: "done", brief, synthesis }`
— degrading to exactly the §4.1 fallback rather than refusing the write. Note
`synthesis` survives the drop, for the reason §4.1 gives.

Two details that are easy to get wrong:

- **Measure UTF-8 bytes, not string length.** `JSON.stringify(findings).length`
  counts UTF-16 code units, which undercounts every non-ASCII title and
  disagrees with how the rest of this repo states its caps (`BRIEF_CAPS`'
  extraction cap is 200 KB **UTF-8**, and `buildSourceBody` cuts on bytes). The
  bound is a byte bound or it is a different bound than it claims to be.
- **Drop, never refuse.** The passage store refuses a write under pressure
  rather than evicting, because a passage was put there by hand and exists in
  exactly one place. Findings are neither — they are a cache of something the
  gateway will re-derive — so the run must still be written without them. Taking
  the passage rule here would lose the `brief` too.

The bound's value is set in the C8.1 implementation plan, sized against real
briefs rather than guessed here.

## 5. Testing

- **Guards** — element-level, per lane, including the rejection cases that
  matter: a non-array where an array is required, a null element, a wrong-typed
  field the renderer reads. The SDK's shallow-guard shapes
  (`{ ranked: [42, null] }`) become explicit rejection fixtures, since they are
  exactly what a shallower guard would admit.
- **Renderers** — pure, jsdom docblock, one suite per lane. Assert on structure
  and on `textContent`, and assert that a `javascript:` URL renders as text with
  no `href`.
- **Fallback** — a `done` with absent or rejected findings renders the same DOM
  as today. This is the test that makes the silent degradation a guarantee rather
  than an intention.
- **Store** — a persisted run whose findings fail the guard replays as prose **and
  is still present**: the regression this guards against is `readGuarded`
  evicting the whole entry (§4.1), so the assertion is on the run surviving, not
  merely on the render. A findings payload past the byte bound is stored without
  findings but keeps `brief` and `synthesis`.
- **Provenance survives a findings drop** — both paths (guard rejection, byte
  bound) still render the provenance line. This is the test that pins the
  sibling-not-child decision in §4.1.
- **Empty results with empty gaps** renders the lane's empty line, not a blank
  fragment; empty results *with* gaps renders the gap and its remediation.
- **Type pinning** — a test naming the mirrored fields we read, so an upstream
  rename surfaces as a failure (§4.2).
- `test/unit/doc-references.test.ts` already gates this spec's path once it is
  cited; `docs/superpowers/plans/` stays empty per the convention it enforces.

## 6. Slicing

Same destination, three independently shippable PRs. Each is safe to ship alone,
because an unmodelled lane renders today's prose.

- **C8.1** — the entry path (§4.1: parser, `LaneState`, store guard, byte bound),
  `gaps` + provenance on all seven lanes (§4.5), and the `why` renderer (§4.4).
  Ships the flagship and the honesty win together.
- **C8.2** — `expert`, `impact`, `ownership`.
- **C8.3** — `catchup`, `decisions`, `glossary`.

## 7. Corrections this phase records

- **`src/shared/types.ts:575` is stale in one clause.** "Upstream types it
  `unknown` — the shape is per-agent" was true when written and remains true of
  the *gateway*, but each agent's shape is now published and stable in the SDK.
  The comment's own precondition — "add it back alongside a concrete renderer" —
  is what this phase satisfies. Update the comment; do not delete the reasoning.
- **`docs/architecture.md`'s agent-lanes section describes `brief` as the
  answer.** It is one of two forms of the answer, and the lossy one. The section
  needs the distinction once C8.1 lands.
- **`CHANGELOG.md:14` cites a version that does not exist.** It says the file
  lanes "shipped in 0.9.0"; the last tag is `v0.5.0` and those lanes are still
  under `[Unreleased]`. Unrelated to this phase, found while reading for it, and
  recorded here so it is not lost.

## 8. Risks and open questions

1. **Seven renderers is real surface.** Mitigated by the slicing (§6) and by the
   per-lane module boundary, but C8.2 and C8.3 are each still a couple of
   renderers plus guards plus tests.
2. **The three mirrored types can drift** from the SDK with nothing enforcing it
   (§4.2). Accepted, with the precedent named and a field-pinning test.
3. **`DecisionsBrief.agentVersion` is typed `number`**, not the literal `1` that
   every other brief uses. Our guard should accept what the gateway actually
   sends rather than asserting `=== 1` for this one lane.
4. **Three lanes gain no links** (§4.6) and will read as less useful than `why`
   until a reverse resolver exists upstream.
5. **Unverified:** that `@nimbus-dev/sdk@1.32.0`'s published `dist/index.d.ts`
   exports the brief types identically to `src/`. The source re-exports them
   (`src/index.ts:30,42,60`); the built artifact should be checked on first
   install rather than assumed.

## 9. Parallel upstream work (not a dependency)

Designed side by side in their own worktrees; the client never waits on them.

- **`nimbus-sdk`** — add `ownership`, `decisions` and `glossary` brief types,
  guards and fixtures. The SDK's `agent-names.ts:5` states that lagging the
  gateway is intended and that a name earns its place only once all three exist,
  so this is real work, not a rubber stamp. When it lands, the three mirrors
  (§4.2) become re-exports and then disappear.
- **`nimbus-sdk`** — publish `SynthesisProvenance` (§4.2). It is a property of
  the `briefReady` payload the SDK already models (`BriefReadyPayload`), so its
  absence there is an omission rather than a boundary, and every consumer that
  wants to say "a model wrote this, and it was local" mirrors it by hand today.
- **`nimbus-sdk`** — feedback that `createBriefGuard` is dispatch-level, not
  render-level (§4.3). Consumers rendering from these briefs need their own
  depth, and the factory's doc comment should say so.
- **`Nimbus`** — propose a reverse `itemId → URL` read (§4.6). It would light up
  links on `impact`, `catchup` and `expert` evidence with no renderer change
  here.

## 10. Review disposition

Reviewed against
[`2026-09-06-the-answer-has-structure-design-review.md`](./2026-09-06-the-answer-has-structure-design-review.md).
Each finding was checked against the code before being accepted.

**Accepted and folded in.**

| finding | verified against | where it landed |
| --- | --- | --- |
| Q2.1 `synthesis` unmodelled on `LaneState` | — (genuine omission) | §4.1, as a **sibling** of `findings` so it survives a drop |
| Q2.2 `readGuarded` evicts the whole run | `keyed-store.ts:32` — "A value that fails is dropped" | §4.1: entry-level guard takes `findings` as `unknown`, sanitise on read |
| Q2.3 `terminalLaneState` lacks `lane` | `service-worker.ts:309`, call site `:429` | §4.1: signature and result union both widen |
| I3.1 inline panel CSS would bloat | `panel-in-page.ts:273` (`STYLES`, not `PANEL_CSS`) | §4.4: `findings-css.ts` |
| I3.2 blank box when results and gaps both empty | — | §4.4: per-lane empty line, bounded so it never impersonates a gap |
| I3.3 shared link builder | `panel-view.ts:40-43`, `:327-330` | §4.4: factored, matching the existing pattern |
| I3.4 byte bound | `BRIEF_CAPS` / `buildSourceBody` cut on UTF-8 | §4.8, with the measurement corrected to bytes |

**Rejected, with reasons.**

- **Q2.4's premise — that timestamps "may be ISO 8601 strings".** They are not.
  `modifiedAt`, `occurredAt`, `generatedAt`, `firstSeenAt` and `decidedAt` are
  every one typed `number` in the SDK and the gateway, several documented as
  "Epoch ms". The proposed `parseTimestampMs` accepting `string` would invent a
  wire shape the contract does not have and paper over a real guard failure. The
  *useful* half of the finding is kept: guards check `typeof === "number"`, and
  renderers take `nowMs` — which was already the `formatAge` signature, so no new
  convention was needed (§4.4).
- **`synthesis: { reason: "guardrail_violation" }`** in the edge-case matrix.
  No such member. `SynthesisDiscardReason` is
  `"timeout" | "contract_violation" | "egress_append_failed" | "provider_error" | "empty_result"`.
  The scenario is still worth testing — under `contract_violation`, which also
  carries `violations?: string[]`.
- **`OwnershipBrief.target.commitCount`** in the edge-case matrix. No such field.
  The three nullable counts are `ownerCount`, `ownersAboveFloor` and `truncated`
  (`ownership-types.ts:9-14`). The *behaviour* the row asks for is right and is
  already specified in §4.4 — `null` renders as "unavailable", never "complete".

**Noted, no change.** The review's suggestion to confirm `doc-references.test.ts`
resolves this spec and the review file: both paths match its `SPEC_REF` pattern
and both exist, so the gate is already satisfied. Per `CLAUDE.md`, review notes
are pruned once the feature ships — this one included.
