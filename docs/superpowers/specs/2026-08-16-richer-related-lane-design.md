# Related that knows what it is related to

**Status:** design, approved 2026-08-16. Implements roadmap **4.1**.

**Upstream read at:** `Nimbus` @ `b0fbe14a` (`origin/main`, past `v1.27.0`). Every
contract claim below was read from that source. Where it contradicts this repo's
roadmap, the roadmap is corrected in the last section rather than silently edited.

**Two repos.** The gateway half lands first in
`Nimbus` (`dev/asaf/related-item-and-fields`); the client half consumes it here
(`feat/richer-related-lane`) and must keep working against a gateway that has not
taken it.

## What this builds

The Related lane is the oldest surface in the panel — it predates the reframe,
predates recognition, and predates resolve. It renders on every panel open, on
every surface, and it has not changed since Slice 2. This slice makes it *about
the item the panel already resolved*, and makes each row worth reading.

Four changes, in descending order of how much they matter:

1. The snippet stops being a truncated echo of the title.
2. Related becomes related **to the resolved item**, not to `document.title`.
3. Each hit carries its kind and its freshness, so a row says what it is.
4. The lane groups by service and says how many it found.

## Why the brief could not be built as written

Roadmap 4.1 asks for "grouped, previewable related items (source type, snippet,
date) with open-in-Nimbus". Read against the shipped contract, two thirds of that
sentence does not exist:

- **`RelatedHit` is five fields** — `{id, title, service, snippet, url}`
  (`packages/gateway/src/clips/clip-related.ts:8`). No type. No date.
- **There is no open-in-Nimbus primitive anywhere in the gateway.** No route, and
  no URL scheme: `grep -rn "nimbus://" packages` returns **zero** matches. There
  is nothing to link to.

So "source type" and "date" are an upstream projection change, and
open-in-Nimbus is **dropped from the brief** — see the corrections section. What
the hit already has is a `url` to the source, which the lane already links.

## The five decisions

### 1. The snippet is a snippet of the title, and always has been

This is the finding that reorders the whole slice.

The related query asks for
`snippet(item_fts, 0, '', '', '…', 10) AS snippet`
(`packages/gateway/src/ipc/http-server.ts:564`). The second argument is a **column
index into the FTS table**, and migration V48 re-pointed `item_fts` from
`(title, body_preview)` to `(title, body)`
(`packages/gateway/src/index/body-store-v48-sql.ts:44`). Column `0` is `title`.

So every snippet the panel has ever rendered is a ten-token extract **of the
title**, printed directly underneath that same title. The lane does not feel thin
because it lacks grouping. It feels thin because its second line is its first line
again.

The fix is the character `0` → `1`, plus a token budget that suits a preview
rather than a phrase: **`snippet(item_fts, 1, '', '', '…', 24)`**. The empty
start/end markers stay — the client renders every gateway string through
`textContent`, so highlight markup would be printed literally, not rendered.

`item.body` is nullable, and title-only items (Notion pages never fetched,
Confluence stubs) will now produce an **empty** snippet where they previously
produced a title echo. That is the honest outcome, and the client handles it by
omitting the line rather than rendering a blank paragraph — decision 5.

### 2. Relatedness comes from the resolved item, not the page title

`buildRelatedQuery` takes its query text from `selection ?? title`
(`clip-related.ts:42`), and `title` is the browser's `document.title`. On the
surfaces this client exists for, that string is mostly chrome:

> `Fix the flaky retry in queue-flush by asaf · Pull Request #482 · acme/web`

and on Jenkins it is `build #42 [Jenkins]`, which is not a query about anything.

Since C1.1 the panel knows exactly which indexed item the page *is*. `RelatedInput`
therefore grows **`itemId?: string`**. When it names an indexed row, the query text
is that item's own `title` — the connector's clean title — and the item itself is
excluded from its own related list.

**The query text is the item's title, NOT its body.** `ftsMatchQuery` maps every
token to `(title : "tok"* OR body : "tok"*)` and joins them with **`AND`**
(`packages/gateway/src/search/hybrid-internal.ts:58-63`). Feeding it a 16 KiB body
would build an AND-chain of thousands of required terms and match nothing. This is
a trap worth stating plainly, because "use the body, it's richer" is the obvious
wrong turn here.

**Precedence is `selection` → `itemId` → `title`.** A selection is a question the
user just asked out loud and must keep beating everything, or 4.2's
*What's related to this?* silently stops working on exactly the pages that resolve.

**An unknown `itemId` is ignored, not an error.** The only ids the client sends are
ids the gateway itself returned from resolve moments earlier, so a miss means the
row was deleted in between. Falling through to the existing `title` path answers
the question; a 404 would blank a working lane over a race.

### 3. `type` and `modified_at` join the projection, named as resolve names them

Both are columns on `item` — the very table the related query already reads — and
both are indexed (`packages/gateway/src/index/unified-item-v3-sql.ts:19,25,34,35`).
This is two fields added to a `SELECT` and to a row mapping.

The wire names mirror `GET /v1/items/resolve` exactly: **`type`** plain, and
**`modified_at`** snake-case. That looks inconsistent beside camel-case `matchKind`
— and it is — but resolve's item already ships `modified_at`
(`packages/gateway/src/index/resolve-by-url.ts:24`) and this client already renames
it to `modifiedAt` at its HTTP boundary. One convention with a known wart beats a
second convention and a second parser.

Both fields are **additive**. A client that has not taken this slice ignores them.

### 4. The host-exclusion bug dies without a contract change

`runClipRelated` drops every hit whose host matches the `canonicalUrl` in the
request (`clip-related.ts:58`). The panel sends `<link rel="canonical">`
(`src/panel/panel-in-page.ts:330`), and GitHub emits one on every PR page.

**So on a GitHub pull request — the flagship surface — every other github.com item
is excluded from Related.** The one host holding all your context is the one host
filtered out. It is inconsistent too: Jenkins pages carry no canonical link, so
nothing is excluded there.

That rule was written for a clipper, where "don't show me more of this news site"
is right. The instinct is to change or flag it upstream. **Don't.** Decision 2
dissolves it: on a resolved page the client sends `itemId` and *stops sending
`canonicalUrl`*, so the host filter never fires, and the item excludes itself by
id instead. On an unrecognised reading page nothing changes and the clipper-era
behaviour is still correct.

No behaviour change to a shipped route, no new knob, no migration. The bug dies as
a side effect of a better query.

### 5. The client must stay correct against an old gateway

Users update a browser extension and a gateway on unrelated schedules. Three rules
follow, and the first is the one that would bite:

**Keep sending `title` alongside `itemId`.** An old gateway ignores `itemId`; if the
client had also dropped `title`, the query text would be empty and `runClipRelated`
returns `{items: []}` on an empty query (`clip-related.ts:52`) — a lane that goes
permanently blank for anyone on an older gateway. `canonicalUrl` is the only field
withheld on a resolved page, and withholding it against an old gateway merely
disables the host filter, which is the outcome we want anyway.

**`type` and `modifiedAt` are optional on the client type**, and `isRelatedHit`
accepts both wire shapes. A hit without them renders as today's row — no chip, no
age line — rather than being rejected or rendering `Invalid Date`.

**An empty snippet omits the line.** Required by decision 1, and it also covers an
old gateway sending a title-echo snippet: that still renders, unchanged.

## Shape

Gateway, `packages/gateway/src/clips/clip-related.ts`:

```ts
export interface RelatedInput {
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly selection?: string;
  readonly itemId?: string;      // new
  readonly limit?: number;
}

export interface RelatedHit {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly type: string;         // new
  readonly snippet: string;
  readonly url: string | null;
  readonly modified_at: number;  // new
}
```

Client, `src/shared/types.ts`:

```ts
export interface RelatedHit {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly snippet: string;
  readonly url: string | null;
  /** Absent when the gateway predates the projection. No chip, not a rejection. */
  readonly type?: string;
  /** Epoch ms, renamed from the wire's `modified_at` at the HTTP boundary. */
  readonly modifiedAt?: number;
}
```

## Layers

**Gateway.** `clip-related.ts` owns the input precedence, the item lookup and the
self-exclusion; `http-server.ts`'s injected `search` adapter owns the SQL. The
lookup follows the house pattern — an inline
`SELECT ... FROM item WHERE id = ?`, as `decisions.ts:33` and
`decision-corroborate.ts:49` already do. No new helper.

**Client.** All new decision logic is pure and lives outside the `chrome.*` seam:

- `src/shared/related.ts` — the guard accepting both wire shapes; the boundary
  rename `modified_at` → `modifiedAt`; `buildRelatedQuery` learns `itemId` and the
  rule that `canonicalUrl` is withheld when an id is present.
- A new pure `src/panel/related-groups.ts` — hits → ordered service groups with
  counts. New, not grown inside `panel-view.ts` (884 lines) or `panel-in-page.ts`
  (1,513 lines), following the precedent `lane-input.ts` set in the C2.5 slice.
- `src/panel/panel-view.ts` — `renderHit` / `renderHits` gain the chip, the age
  line and the group heading. `formatAge` is reused, and the copy is **"Updated
  N ago"**, identical to the header's freshness line, so two freshness claims in
  one panel cannot word the same fact differently.
- `src/panel/panel-in-page.ts` — supplies the item id from a `found` header, or
  from a `chosen` one, reusing the id C2.5 already carries and already validates
  against the candidate set. No new trust boundary.

## Testing

**Gateway** (`clip-related.test.ts`, `clip-e2e.test.ts`): the snippet column
index; `itemId` resolving to a title query; `itemId` excluding itself from its own
hits; an unknown `itemId` falling through to `title`; `selection` still beating
`itemId`; the two new fields present on the wire.

**Client**: `isRelatedHit` against both wire shapes and against a hit with a
non-numeric `modified_at`; the group builder for one service, several services,
and zero hits; `buildRelatedQuery` withholding `canonicalUrl` exactly when an id
is present and never dropping `title`; jsdom render tests for the chip, the age
line, the omitted-when-empty snippet, and a hit that predates the new fields.

Both suites green before either PR. The gateway PR merges first.

## Not in this slice

- **open-in-Nimbus** — no primitive exists. See the corrections below.
- **Ranking or scoring changes.** Rank order arrives from the search adapter and is
  preserved; grouping is a rendering choice, so the gateway grows no opinion about
  presentation.
- **Widening `snippet` to the metadata JSON.** `item_fts` indexes title and body
  only (`body-store-v48-sql.ts:44`); reaching past that is its own slice.
  (Drive-by worth taking in the gateway PR: `glossary-project.ts:21` still
  describes `item_fts` as indexing `title` and `body_preview`, which V48 made
  untrue. A comment-only correction, no behaviour.)
- **Related on an unresolved page** keeps today's behaviour exactly, host filter
  included.

## Corrections to the roadmap

Recorded here rather than silently edited, following the pattern C2.1 and C2.3
set.

**4.1's "open-in-Nimbus" is dropped, not deferred.** It presumes a way to address
an indexed item from outside the gateway, and there is none — no scheme, no route,
nothing in the tree. The `url` link to the source item, which the lane already
renders, is the only "open" that exists. If a deep-link primitive is ever proposed
upstream, this becomes a one-line client change and can be re-opened then.

**4.1 is retagged 🟢 M → 🟡 M for the fields, 🟢 for the rest.** The brief lists it
as buildable today against the locked contract. Grouping and the query change are;
`type` and `date` are not, and never were — they need the upstream projection this
slice also writes.

**The claim that 4.1 is "retained as the first lane of the C1.3 shell — same
content" understates it.** The content is not the same, because the content was
partly wrong: the snippet has been echoing the title since Slice 2, and the host
filter has been hiding same-host items since the reframe made same-host the point.
Both are defects that shipped, not features awaiting polish.
