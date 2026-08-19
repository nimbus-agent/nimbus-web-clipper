# Briefs over your index

**Status:** design, approved 2026-08-19. Delivers the one half of **5.1 "Ask-your-clips"**
that C5.2 recorded as *genuinely unbuilt* — "a brief with `useIndex: true`, which is a
follow-up to C5.1, not a separate feature" — as a new **C5.4**.

**Branching:** `dev/asafgolombek/briefs-over-your-index`, off `main` (`1477c36`, *chore:
clear the ten follow-ups C5.3 left behind (#63)*). Nothing is stacked.

**This slice has an upstream half, and the upstream half leads.** See
`dev/asafgolombek/brief-index-widening` in the Nimbus repo, and *The upstream half* below.
The client code here works against today's gateway; only its user-facing copy waits.

## What this builds

A brief's sources are the tabs you picked and the passages you highlighted. Everything
Nimbus already knows — every page you clipped, and after the upstream half, every pull
request, build and issue its connectors indexed — sits one process away and is never
consulted.

This slice adds one control to the brief composer: **also search what Nimbus has indexed.**
Off by default, sticky once you choose. With it on, the gateway searches its index with
your question, admits up to `MAX_INDEX_HITS` (8) matching items to the source registry as
`C1..Cn` tokens, and the finished brief cites them alongside the tabs you picked — visibly
marked as *yours*, so you always know whether a claim came from a tab you chose or from
something you saved months ago.

## Why this is unblocked now

**The gateway already implements it.** This is not a proposal:

- `brief-validate.ts:67-72` accepts `useIndex` on `POST /v1/briefs` and coerces it to a
  boolean.
- `brief-registry.ts:62-95` runs the search, mints `C{n}` tokens and builds a
  `SourceRef` per hit.
- `brief-gaps.ts:35-48` already separates *the search broke*, *nothing matched* and
  *keyword-only recall* into three distinct gap lines.
- `brief-report.ts:9` in **this** repo already guards `kind: "clip"` and `clipId`.

The client is the only thing that never opted in: `src/shared/brief.ts:112` hard-pins
`useIndex: false`, and its return type is the literal `false`, so the pin is enforced by
the type checker rather than left to a caller.

## The decisions

### 1. The disclosure names a set it cannot enumerate — and says so

`buildBriefPreview`'s docblock states the rule this slice has to bend:

> Every source is named individually rather than summarised as a count alone — a count is
> not consent to send twenty specific pages.

With `useIndex` on, the client **cannot** name the items in advance. The search runs
gateway-side, during the run, against a corpus the client has no read access to. Any list
the preview showed would be a guess.

So the preview does not pretend. It gains one row, present only when the control is on,
which states three true things and no more:

1. The gateway will also search what it has indexed.
2. It may draw on **up to 8** items, and they **cannot be listed before the run**.
3. The **question text** is what gets searched.

Point 3 is not padding — see decision 2. Point 2 is the honest form of the named-sources
rule: when you cannot name the members, name the bound and say that you cannot name the
members. The report afterwards names every item that was actually used, which is where
enumeration genuinely belongs.

### 2. The query may leave the machine, and the client says so rather than fixing it

Clips are embedded **locally** — `LOCAL_ONLY_PROSE_TYPES` holds `nimbus:web_clip`
(`packages/gateway/src/embedding/routing.ts:72`), which is how Nimbus#1006 was closed. That
rule governs **indexing prose**, not **querying**. The search path calls
`ss.embedQueryDual(nameQ)` (`packages/gateway/src/index/local-index.ts`), which is routed by
the ordinary embedding configuration.

Therefore: with `useIndex` on, your clips still never leave, but **your question may**.

That is a real gap and this slice does not close it. Closing it means routing work in
`packages/gateway/src/embedding/`, a different subsystem from briefs, and bundling it here
would make one slice own two unrelated changes. The client's obligation is the one it has
always had — *never claim a destination it cannot know* — and it discharges that by
disclosing, exactly as `SYNTHESIS_NOTICE` already discloses that synthesis may be remote.

**Follow-up, not scope:** a local-only query embedding when the search is index-scoped, or
a pre-run signal the client can read. Proposed upstream, not here.

### 3. Off by default, sticky once chosen

A new `src/background/index-pref.ts`, modelled on `preview-pref.ts` — one key, no secret,
read and written directly by the composer.

It differs from `preview-pref.ts` in which way it fails. That store defaults **on** and
falls back **on**, because its fail-safe direction is "show a preview nobody asked for."
This one defaults **off** and falls back **off**: the fail-safe direction for a control
that widens what a run consults is *don't*. An unreadable value must never silently turn
on a wider search.

Sticky rather than per-run because the choice is a standing preference about your own
corpus, not a per-run consent — the per-run consent is the preview, which restates the
disclosure every single time regardless of how the pref got there.

**It is also visible and resettable outside the composer.** `preview-pref` is not only a
popup control — Options stage 4 reads and writes it (`src/options/options.ts:439-447`), so a
setting you turned on months ago is findable in the place users look for settings. A sticky
preference whose only surface is the control that set it is one a user cannot audit. The
index pref gets the same treatment, next to the preview toggle.

### 4. A checkbox, not a source row

The composer's rows are things the client **feeds**: a tab it captures, a passage group it
holds. The index is neither — the client sends a flag and the gateway supplies the bodies.

Rendering it as a row would put it in `BRIEF_CAPS.maxSources`, where it does not belong
(the gateway's cap is about sources the client declares and feeds), and it would join a
selection model whose every other member has a URL, a title and a capture time. It is a
checkbox beside the list.

### 5. An indexed citation says it is indexed

`renderCitations` (`src/brief/brief-view.ts:357`) draws title, optional quote, optional
link. A `C{n}` citation gets two additions:

- A visible marker that it came from your index, plus the item's type once the upstream
  half supplies `itemType` — a Jira issue and a page you clipped are not the same evidence
  and should not read identically.
- Its `url`, when present, links to the **original page** through the existing
  `safeHttpUrl` guard. A citation URL is as untrusted as the rest of the report; nothing
  about its being index-sourced makes it safer.

An item with no URL (`h.url ?? h.canonicalUrl ?? null` can be null) renders as title alone.
There is no open-in-Nimbus affordance — 4.1 dropped it and nothing here revives it.

### 6. The egress log records that the index was consulted

`BriefLogEntry` grows `usedIndex` and `indexHits`. `brief-log.ts`'s own docblock justifies
this: the log exists because `THIS_BINARY_COVERAGE.model` is `none` and `nimbus prove`
shows nothing for a brief's synthesis, so this is the only durable record that the egress
happened. A run that consulted your index — and, per decision 2, possibly sent your
question to an embedder — is a materially different event from one that did not. A record
that cannot tell them apart is a worse record.

Both fields are optional, so entries written before this slice remain valid against the
guard.

### 7. `kind: "clip"` is kept, and it stops meaning "clip"

The upstream half widens the search past `web_clip`, so a `C{n}` citation may be a pull
request. The honest-looking move is to rename `kind`. It is the wrong move: `kind` is
persisted in every saved `research_brief` item upstream, and renaming it rewrites history
it does not own.

Instead `kind: "clip"` is documented on both sides as *"an item from your index"*, and the
new optional `itemType` carries what it actually is. The client's guard keeps accepting
exactly `"source" | "clip"`, so a report from an un-upgraded gateway still parses.

### 8. The index cannot be the sole corpus, and this slice does not change that

An earlier draft of this spec claimed a run with `useIndex: true` and zero picked tabs was
allowed, with only a copy problem to solve. That was wrong, and the contract says so
plainly:

```ts
// briefs/brief-validate.ts
if (!Array.isArray(rawSources) || rawSources.length === 0) {
  throw new BriefValidationError("sources must be a non-empty array", "sources");
}
```

`POST /v1/briefs` **400s** on an empty source list, whatever `useIndex` says. So "ask my
index alone" — which is, almost exactly, the question box 5.1 originally wanted — is not
reachable from this slice, and no client-side copy can make it so.

It is deliberately **deferred, not smuggled in**. Allowing `sources: []` when `useIndex` is
true is an upstream validation change with its own consequences: `declaredCount` feeds the
"N of M selected sources were never received" gap, the feed stage would have to accept a
run that never receives a source, and a run whose entire corpus is chosen by a search
becomes a different consent object from one whose sources the user named. That is a slice,
not a clause.

**Consequence for this one:** the composer keeps requiring at least one pick, exactly as it
does today. The index widens what a brief may draw on; it does not replace what you chose.

### 9. The choice is disclosed where it is made, not only where it is sent

The preview always renders before Send — `buildBriefPreview` has no off switch, by the same
reasoning C4.2 applied to the targeted fetch — so the decision-1 disclosure is guaranteed to
reach the user before anything leaves. That is necessary and it is not sufficient: by the
time you are reading a confirmation you have already composed the brief.

So the checkbox carries its own one-line description of what turning it on means, in
**visible helper text**, not a tooltip. `src/` contains no `title=` attribute anywhere; a
tooltip would be a new pattern whose content is invisible to touch and to keyboard users,
for exactly the sentence they most need. The preview keeps the full statement; the checkbox
gets the short form.

### 10. A citation shows a type, never an item id

An item id is `nimbus:clip:<sha256>` — a hex digest. It is the right key for the gateway and
useless to a person: nothing in this extension accepts an item id as input, so displaying it
offers no way to "locate" anything. `itemType` is the part a human can act on, and decision
5 already shows it. `itemId` stays in the payload for the gateway's benefit and stays out of
the UI.

## Shape

| File | Change |
| --- | --- |
| `src/shared/brief.ts` | `buildCreateBody` takes `useIndex: boolean`; return type stops being the literal `false` |
| `src/background/index-pref.ts` *(new)* | `isIndexSearchEnabled` / `setIndexSearchEnabled`; defaults off, falls back off |
| `src/shared/messages.ts` | `BriefStartRequest.useIndex: boolean` + its guard in `isBriefStartRequest` |
| `src/background/brief-handlers.ts` | Thread the flag into `createBrief`; record `usedIndex` on the log entry |
| `src/background/brief-client.ts` | `createBrief`'s body type widens with `buildCreateBody` |
| `src/brief/brief-view.ts` | The checkbox; the indexed-citation marker in `renderCitations` |
| `src/brief/brief.ts` | Read the pref on load, write it on toggle, pass it to `brief-start` |
| `src/shared/preview.ts` | `BriefPreview.indexNotice`; `buildBriefPreview` takes `useIndex` |
| `src/options/options.ts` + `options.html` | The pref's second surface, beside the preview toggle (decision 3) |
| `src/options/brief-log-view.ts` | Show that a logged run consulted the index |
| `src/shared/brief-report.ts` | `isCitation` accepts `itemType` and `itemId` |
| `src/shared/brief-log.ts` | `BriefLogEntry.usedIndex` / `.indexHits` + guard |

## Layers

Nothing here touches the browser seam, and no new manifest permission is needed — the
index is the gateway's, reached over the connection that already exists. The pure modules
(`brief.ts`, `preview.ts`, `brief-report.ts`, `brief-log.ts`) stay pure and carry the whole
decision surface; `brief-view.ts` renders what they return; the background layer threads
one boolean and writes one log field.

## Failure surface

| Case | Behaviour |
| --- | --- |
| Search failed gateway-side | Gateway emits its distinct gap; the client renders gaps already. **Never** laundered into "nothing matched" |
| Zero hits | Its own gap line; the report is the tabs-only report it would have been |
| Semantic unavailable | Its own gap line — recall was keyword-only |
| Pref unreadable | Falls back **off** (decision 3) |
| Report from an older gateway | No `itemType`; citations render with the index marker and no type label |
| `useIndex` on, no tabs picked | **Impossible to send** — see decision 8. The composer's existing "at least one pick" behaviour is unchanged and still correct |
| Empty question | Already blocked twice: `showPreview` (`src/brief/brief.ts:117`) hides the preview when `question === ""`, and the gateway rejects it with 400 `brief must be a non-empty string` |

## Testing

Unit (vitest) covers the pure half, which is where every decision lives: `buildCreateBody`
carrying the flag both ways; `buildBriefPreview` emitting the notice only when on, and its
exact wording; `isCitation` accepting the new optional fields and still rejecting a bad
`kind`; `isBriefLogEntry` accepting old entries without the new fields; the pref store's
default-off and fallback-off.

One case earns its own test because it is a compatibility guarantee rather than a behaviour:
**a citation whose `itemType` is a value this build has never heard of — `"slack_message"`
from a connector added to the gateway after this client shipped — must parse and render.**
`itemType` is an optional string of *any* value, never an enum; connectors land upstream on
their own schedule, so an enum here would break on somebody else's release.

E2E (`test/e2e/`, against `mock-gateway.ts`) asserts the flag reaches the wire and the
disclosure is on screen before Send. **`mock-gateway.ts` does not serve index hits today**
— teaching it to is part of this slice, and is the same class of fix C5.3 needed when its
`serve()` turned out to drop POST bodies.

Manual verification needs a real gateway with a **populated** index; the checklist entry
goes in `docs/development.md` with the rest of the surfaces unit tests cannot reach.

## The upstream half

`dev/asafgolombek/brief-index-widening` in the Nimbus repo, specified there. In summary:
drop `itemType: "web_clip"` from the brief search (`platform/assemble.ts`), thread the
hit's type through `IndexHit` into an additive `SourceRef.itemType`/`itemId`, and reword
the three `brief-gaps.ts` lines that say "saved clips" about a search that is no longer
only clips.

The client half is written against today's contract and ships against it. What waits on
upstream is one thing: the copy may say *what Nimbus has indexed* rather than *your clips*
only once the search is actually wider.

## Not in this slice

- **Fixing the query-embedding egress.** Disclosed, not closed — decision 2.
- **A scope picker.** `useIndex` stays a boolean. Choosing which types to search is a
  contract change and a composer surface for a choice nobody has asked for.
- **Open-in-Nimbus on a citation.** Dropped by 4.1; not revived here.
- **Index search anywhere but briefs.** The panel's related lane has its own path.
- **An index-only brief.** Blocked upstream by a non-empty `sources` requirement, and worth
  its own slice rather than a clause in this one — decision 8.
- **A minimum question length.** A one-character question makes a bad brief with or without
  the index, so it is not this slice's rule to invent; `MAX_BRIEF_CHARS` exists upstream and
  no minimum does. If one is wanted it belongs in `brief-validate.ts`, applied to every
  brief equally.

## Corrections to the roadmap

- **Phase C5 has no brief for this work.** Like C5.3 before it, this lands as a new C5.4
  and the roadmap gains the entry after the fact.
- **5.1's "Ask-your-clips" is now fully accounted for.** C5.2 recorded it as superseded
  except for the index-backed half; that half is this. After this slice, nothing in 5.1
  remains unbuilt.
- **"Your clips" is the accurate phrase today, not "your index".** The gateway's brief
  search is scoped to `itemType: "web_clip"`. Any roadmap copy promising briefs over pull
  requests, builds and issues is describing the upstream half, not shipped behaviour.
