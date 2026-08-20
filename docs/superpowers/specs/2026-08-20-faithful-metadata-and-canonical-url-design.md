# Faithful metadata and a canonical URL you can trust (2.5)

> **Status:** design, approved 2026-08-20. Splits into three slices across two
> repos. **S1 is client-only and ships against the shipped contract.** The
> `source` object in S2/S3 is **proposed, not contracted** — per the roadmap's
> [gateway-dependent feature protocol](../../../ROADMAP.md#proposing-a-gateway-dependent-feature)
> its shape is decided in the Nimbus repo, not here. This document is the whole
> cross-repo design; the upstream slice carries its own.

## The gap this closes

Roadmap **2.5** reads as a polish item — "a clip becomes a real record you can
cite, not a de-styled dump" — with a `**Reframe**` line promoting it because
`canonicalUrl` became the resolution key for **C1.1**/**C1.2**. Reading both
sides shows the reframe understated it and the brief overstated what is
possible. Two findings, and they pull in opposite directions.

### Finding 1 — the metadata half has nowhere to go today

`validateClipInput` (`Nimbus/packages/gateway/src/clips/clip-ingest.ts:46`)
reads exactly seven fields and drops everything else. `ingestClip` then builds
the item's `metadata` itself, from `tags`, `mode`, `wordCount` and `clippedAt`
(`clip-ingest.ts:144`). An `author` or `publishedAt` sent today is **silently
discarded** — no error, no warning, no field a caller could read to detect the
loss.

So 2.5's "within the existing ingest body shape" does not survive contact with
the validator. That half is 🟡, not 🟢, and it is the reason this design is
cross-repo at all.

### Finding 2 — the canonical half is a live data-loss bug

Gateway-side, the clip's identity is derived like this
(`clip-ingest.ts:128-130`, `:76`):

```ts
const canonical = canonicalizeUrl(input.canonicalUrl ?? input.url);
const externalId = `clip:${sha256(canonical)}`;   // selection mode also hashes the body
const id = itemPrimaryKey("nimbus", externalId);
```

So an `article` clip's identity is the canonical URL **alone**; a `selection`
clip's is that URL plus a hash of the selected body, which is what lets two
selections from one page be two items. Nothing else enters either — not the
title, not the tags, not the metadata. **Whatever this client sends as
`canonicalUrl` decides which item the clip _is_** — dedup, re-clip-as-update,
and resolve-by-URL all turn on it.

What this client sends (`src/capture/capture-in-page.ts:12`) is the raw
`link[rel="canonical"]` href, forwarded with no validation beyond "not empty":

```ts
function canonicalUrl(doc: Document): string | undefined {
  const href = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? undefined;
  return href !== undefined && href !== "" ? href : undefined;
}
```

Three failures follow, all reachable today:

1. **A relative href collides across sites.** `canonicalizeUrl` opens with
   `new URL(raw)` and, on a throw, **returns its input unchanged**
   (`Nimbus/packages/gateway/src/util/url-canonical.ts:13-17`). A page declaring
   `<link rel="canonical" href="/blog">` therefore has the literal string
   `/blog` hashed as its identity. Two unrelated sites that both declare `/blog`
   produce the **same `externalId`, the same primary key, and one clip
   overwrites the other's item.**
2. **A site-wide canonical collapses a whole site into one item.** The common
   misconfiguration `<link rel="canonical" href="https://site.com/">` on every
   page means every clip from that site upserts the *same* row. Each capture
   clobbers the last; the user sees "updated" and assumes it worked.
3. **A cross-origin canonical files your clip under someone else's URL.** A
   syndicated — or hostile — page can name any address it likes, and the
   extension forwards it verbatim.

There is also a duplication that guarantees drift: `readContext` in
`src/panel/panel-in-page.ts:360` re-implements the same naive one-liner for
`POST /v1/clips/related`, so panel context and clip identity can already
disagree about what page you are on.

## The constraint that shapes the fix

`src/shared/recognise.ts:253` commits this repo, in writing, to a rule:

> Canonicalisation is the GATEWAY's job: `canonicalizeUrl` drops the fragment,
> `utm_*`/click-ids and a trailing slash […] Doing any of that here would be
> work the gateway redoes under different rules — and its rules are
> load-bearing, because `externalIdFor` hashes `canonicalizeUrl`'s output.

This design does not touch that rule and must not be read as eroding it. The
client is not normalising URLs. It is **resolving and validating what the page
declared** — is it absolute, does it parse, is it same-origin, is it plausible —
before forwarding it. Extraction correctness, not canonicalisation. The
distinction is load-bearing enough that it is repeated in the module docblock,
because the next reader will want to add tracking-param stripping to it.

## S1 — `src/shared/canonical.ts` (client-only, ships alone)

One pure function, one place, both callers.

```ts
export type CanonicalRejection =
  | "unparseable"
  | "bad-scheme"
  | "credentials"
  | "cross-origin"
  | "downgrade"
  | "root-collapse";

export type CanonicalResult =
  | { readonly kind: "none" }
  | { readonly kind: "resolved"; readonly url: string }
  | { readonly kind: "rejected"; readonly reason: CanonicalRejection; readonly declared: string };

export function resolveCanonical(
  declared: string | undefined,
  pageUrl: string,
): CanonicalResult;
```

A ladder, each rung a named outcome:

1. **Nothing declared** — absent, empty, or whitespace-only → `none`.
2. **Resolve against the page as base** — `new URL(declared, pageUrl)`. This is
   the fix for failure 1: `/article/5` becomes absolute before it can be hashed
   literally, and protocol-relative `//host/path` picks up the page's scheme. A
   throw → `rejected: "unparseable"`.
3. **Scheme must be `http:` or `https:`** → else `rejected: "bad-scheme"`, so a
   `javascript:` or `data:` canonical never reaches the wire.
4. **No userinfo** → else `rejected: "credentials"`. A canonical carrying
   `user:pass@` is **refused, not sanitised**: stripping it would mean rewriting
   what the page declared, and this module only ever rejects or absolutises —
   editing a declaration is canonicalisation, which belongs to the gateway.
   Refusing costs nothing, since the clip falls back to the address bar as it
   does for any other rejection, and it keeps a credentials-shaped string out of
   both the identity hash and the pre-send preview, where it would otherwise be
   rendered verbatim. The check reads `username`/`password` off the parsed URL
   rather than looking for an `@` in the raw string, so `https://host/users/@alice`
   — an `@` in the path, which is ordinary — still resolves.
5. **Same site, or `rejected: "cross-origin"` / `"downgrade"`.** Not a bare origin equality —
   origin comparison is the right instinct and wrong in two specific ways, so
   the rung is three checks:
   - **Port must match**, always.
   - **Scheme must match, or be an upgrade.** An `https` page canonicalising to
     `http` on the same host is rejected — but as **`"downgrade"`, not
     `"cross-origin"`**. The refusal is the same; the reason is not, and the
     difference is user-visible: the host is *identical*, so telling the reader
     their page "asked to be saved under another site's address" would be
     false, and an https-page-declaring-http-canonical is a well-known SEO
     misconfiguration that real readers will meet. A downgrade is not something
     a page should be able to do to your index. The opposite direction is
     *accepted* —
     an `http` page declaring an `https` canonical is the correct declaration
     during an HTTPS migration, and rejecting it would give one page two
     identities depending on which scheme the user happened to arrive on.
     Upgrades are safe in a way downgrades are not.
   - **Host must match after stripping one leading `www.` label from each
     side.** `example.com` ↔ `www.example.com` is one site, in both directions.
     This is the *only* host relaxation: `blog.example.com` is still a different
     host, because it genuinely can be a different site. The strip applies to a
     whole leading label only (`wwwexample.com` is untouched), at most once, and
     **only when what remains still contains a dot** — so a pathological
     `www.com` does not decay to `com`.

   The `www` rule is worth its three lines because without it the single most
   common canonical on the web — a site normalising between its bare and `www`
   forms — is rejected, and clipping the same article from the two entry points
   produces two items. Unlike a general registrable-domain comparison it needs
   no public-suffix list: `www` is one well-known label, not a guess about where
   a domain becomes registrable.
6. **Root-collapse guard** — the resolved path is `/` (or empty) while the
   page's own path is not → `rejected: "root-collapse"`. A real article never
   legitimately canonicalises to the homepage. A root canonical **on** the root
   page is correct and is kept.
7. Otherwise → `resolved`, carrying the absolute href.

**What it deliberately does not do:** strip fragments, tracking parameters or
trailing slashes, strip userinfo, or follow redirects. Rungs 2–6 only ever *reject* or
*absolutise*: the path, query and fragment of a surviving canonical are
forwarded exactly as declared. The scheme and host come back case-normalised,
because that is what `new URL()` does to any input it parses — it is not a
dedup rule this module chose, and it is the one difference between "what the
page wrote" and "what we send". Two unit tests pin the rest as a negative
(below).

On anything other than `resolved`, the caller sends **no `canonicalUrl` at
all**, and the gateway falls back to `canonicalizeUrl(input.url)` — the address
bar, which is always a real absolute URL. Failing to the address bar is the
conservative direction: worst case the clip is filed under a URL carrying
tracking params the gateway then strips, which is a far smaller harm than being
filed under the wrong item entirely.

### Both call sites collapse onto it

- `src/capture/capture-in-page.ts` — delete the local `canonicalUrl()`, call
  `resolveCanonical(declared, location.href)`.
- `src/panel/panel-in-page.ts:360` (`readContext`) — same call.

Both are injected bundles, and both already import values from `src/shared/`
(`capture-in-page.ts` imports `./fallback.ts`; `panel-in-page.ts` imports
`../shared/capture-offer.ts`), so esbuild inlines the module into each entry
with no new machinery. That shared call is what stops clip identity and panel
context from disagreeing.

### Rejections are shown, not swallowed

`resolveCanonical` returns the reason rather than a bare `string | undefined`
so the pre-send preview can say what happened. `buildClipPreview`
(`src/shared/preview.ts:44`) already renders a `Canonical URL` row when one is
present; it gains a row naming an ignored declaration. Silently overriding a
page's own declaration is exactly the class of thing pillar 4 says to surface,
and it costs one field on a type we are writing anyway.

**Each reason gets its own sentence.** One generic string cannot describe four
different situations without being wrong in three of them:

| Reason | Line shown |
| --- | --- |
| `cross-origin` | "This page asked to be saved under another site's address; Nimbus ignored that and used the address above." |
| `root-collapse` | "This page asked to be saved as the site's homepage, which would overwrite your other clips from it; Nimbus used the address above instead." |
| `unparseable` | "This page's canonical address wasn't a usable URL; Nimbus used the address above." |
| `bad-scheme` | "This page's canonical address wasn't a web address; Nimbus used the address above." |

"the address above" is not a new row — `buildClipPreview` already renders `URL`
as its second field (`preview.ts:47`), and on a rejection that row *is* the
identity the clip will take. The copy points at it rather than repeating the
value, so the preview never shows the same URL twice.

`CanonicalRejection` is a closed union consumed by that renderer. Exhaustiveness
goes in the **return type** of the mapping function, not a `satisfies never`
backstop — that backstop is two permanently-uncovered lines against the Sonar
gate.

## S2 — the wire contract (proposed upstream)

`POST /v1/clips` gains one optional object, namespaced so it cannot collide
with anything `ingestClip` builds for itself:

```ts
source?: {
  author?: string;
  publishedAt?: number;   // epoch ms
  siteName?: string;
  lang?: string;
  leadImage?: string;     // absolute http(s) URL
}
```

**`publishedAt` is epoch ms, normalised client-side**, matching `capturedAt`.
Readability returns `publishedTime` as whatever string the page put in
`article:published_time` or JSON-LD `datePublished` — arbitrary format. Parsing
that belongs where the messy input is; the gateway validator then only checks
"integer within `Date`'s range", rather than growing a date parser on a locked
contract. An unparseable date means the client omits the field.

Upstream work, specified in full in the Nimbus slice:

- `validateClipInput` parses `source`: a non-object is rejected; individual
  members of the wrong type are **dropped rather than failing the whole clip**
  (a bad byline should not cost you the clip); and every field is bounded so a
  hostile page cannot push the item toward the store's 64 KB metadata ceiling
  (`packages/gateway/src/index/item-store.ts:85`). **Prose is truncated,
  structured values are dropped** — a byline cut to 200 characters is still a
  byline, but half a URL or half a language tag is corrupt rather than short.
  So `author`/`siteName` truncate at 200; `lang` (20) and `leadImage` (2048)
  are dropped when they exceed their bound; `publishedAt` must be an integer in
  the range `Date` can represent. The upstream slice carries the full rules.
- `ingestClip` merges the result in as `metadata.source`.

Two properties the upstream spec must assert:

1. **Identity is unaffected.** `externalIdFor` hashes the canonical URL and, for
   selections, the body — never metadata. Re-clipping a page with new metadata
   must stay an `updated` on the same id, not a second item.
2. **A re-clip without `source` clears a stored one**, because
   `upsertIndexedItem` replaces metadata wholesale
   (`item-store.ts:130`, `metadata = excluded.metadata`). This is already how
   `tags` behave, so it is written down rather than fixed — but it must be
   written down, or the first person to notice will read it as a bug.

## S3 — extraction and threading (client, gated on S2)

Readability is already bundled (`@mozilla/readability@^0.6.0`), already parses
JSON-LD and OpenGraph internally, and already returns `byline`, `siteName`,
`publishedTime`, `lang` and `excerpt` — and `capture-in-page.ts:31` currently
**throws all five away**. The client cost here is close to zero; essentially all
of this feature's cost is the contract.

Only the article path has an article to mine, so one helper covers the rest:

- `readPageMeta(doc)` — `og:site_name`, `article:published_time`,
  `meta[name="author"]`, `og:image`, `<html lang>`.
- **article** → Readability first, `readPageMeta` filling gaps.
- **selection** and the **fallback** path (`readableFound: false`) →
  `readPageMeta` alone.

`leadImage` runs through **rungs 2 and 3 only** — resolved against the page so a
relative `/img/hero.jpg` becomes absolute, and `http(s)`-only so a `data:` or
`javascript:` URL cannot ride in. It deliberately does **not** get rung 4's
origin check, and the reason is the threat model, not convenience: a canonical
URL decides the clip's *identity*, so a wrong one corrupts the index; a lead
image is a display reference that never enters `externalIdFor` and is never
fetched by this client. Applying the origin rung would reject the common case
rather than an attack — hero images live on `cdn.example.com`, Cloudfront, S3
and Unsplash far more often than on the page's own origin, so an origin check
would drop most real lead images while preventing nothing.

Rungs 4 and 5 are identity rules. They belong to the field that decides
identity, and to nothing else.

Threading it to the wire is the bulk of S3, and the list is longer than it
looks:

| File | Change |
| --- | --- |
| `src/shared/types.ts:1` | `CaptureResult` gains `source?: ClipSource` |
| `src/shared/clip.ts:25` | `buildClipPayload` passes it through |
| `src/shared/messages.ts:455,478` | both capture/clip guards accept it |
| `src/browser/scripting.ts:11` | injected-result guard accepts it |
| `src/shared/queue.ts:61` | **queued-clip guard** accepts it |
| `src/shared/preview.ts:44` | Author / Published / Site / Lead image rows |
| `CLAUDE.md:22` | the locked-contract body shape gains `source?` |
| `docs/architecture.md:249` | the `CaptureResult` line in the pipeline diagram |

`queue.ts` is the one that is easy to miss: an offline-queued clip is
re-validated on flush, so a guard that does not know about `source` drops the
metadata of every clip captured offline — silently, and only offline, which is
the worst way to find a bug.

The preview rows are **not optional**. 1.3's promise is that nothing leaves
without the user seeing it; anything new on the wire appears before Send or the
promise is void.

## Sequencing

| | Repo | Slice | Depends on |
| --- | --- | --- | --- |
| **S1** | clipper | `canonical.ts` + both call sites + preview reason | — |
| **S2** | Nimbus | `source` passthrough + validation | — |
| **S3** | clipper | extraction + threading | S2 released |

S1 and S2 are designed side by side, one worktree each, and are genuinely
independent. **S1 must not queue behind S2's review cycle** — it fixes identity
collisions against the contract that is already shipped, and it is the half with
a user-visible failure today.

S3 is deliberately gated on S2 being *released*, not merely merged. Shipping
extraction earlier would put Author and Published in the pre-send preview while
the validator discarded them: the preview would be lying about what lands, which
is a worse outcome than not having the feature.

## Testing

**`canonical.ts`** is pure and table-driven. The cases that earn their place:

- relative href (`/article/5`) → absolutised against the page
- protocol-relative (`//host/path`) → picks up the page scheme
- cross-origin → rejected
- same host, `https` page → `http` canonical → rejected (downgrade)
- same host, `http` page → `https` canonical → **accepted** (upgrade; the
  asymmetry in rung 4, and the case a strict origin comparison gets wrong)
- same host and scheme, different port → rejected
- `example.com` page → `www.example.com` canonical → **accepted**, and the
  reverse direction too
- `blog.example.com` page → `www.example.com` canonical → rejected (the `www`
  strip is not a general subdomain relaxation, and this test is the fence)
- `wwwexample.com` → not treated as `example.com` (whole-label strip only)
- `www.com` → does not decay to `com` (the still-has-a-dot condition)
- `javascript:` / `data:` → rejected
- root canonical on a non-root page → rejected
- **root canonical on the root page → kept** (the guard's own boundary)
- absent / empty / whitespace-only → `none`
- **a valid canonical carrying a fragment and `utm_` params → returned
  untouched.** This test and the trailing-slash one exist to prove a *negative*:
  that we did not start canonicalising. They are the regression fence around
  `recognise.ts:253`.

**`readPageMeta`** gets jsdom tests via the repo's docblock convention.
**Guards** (`messages`, `queue`, `scripting`) get round-trip tests with and
without `source`, including the offline-queue flush path. **`preview.ts`** gets
assertions on the new rows and one per rejection reason, since four strings that
must each match their case is exactly the kind of mapping that rots silently.
`leadImage` gets its own cases: a CDN-hosted image on a foreign origin is
**kept** (the rung-4 exemption), a `data:` URL is not.

`capture-in-page.ts` and `panel-in-page.ts` **are** reachable by unit tests —
`test/unit/capture-in-page.test.ts` and `test/unit/panel-in-page.test.ts` drive
both through jsdom, and that is where each rejection reason and the absolutise
path are covered at the call site. (An earlier draft of this spec claimed the
opposite, and `docs/development.md` claimed it too; both were wrong, and the
claim is corrected in the same slice. Believing it would mean writing a manual
checklist where a unit test would do.)

What jsdom genuinely cannot give is a real page in a real Chromium running the
real built extension: the injected bundle, the extension plumbing, and
browser-accurate CSS selector semantics. That is the e2e harness's job — S1
should establish whether the #60 harness can carry a canonical fixture, which
is materially stronger than a manual step — with a `docs/development.md`
checklist entry for whatever remains.

Gate notes carried from previous runs: the Nimbus slice needs
`bun run lint:markdown` over its docs before CI will go green, and the clipper's
own gates are `typecheck`, `lint`, `test`, `build`, `check-build`.

## Non-goals and deferrals

- **Inline figures and image references.** 2.5's brief asks to "preserve key
  figures/images references", but `body` is plain `textContent` by contract, so
  image references are stripped today and preserving them inline means
  redesigning body extraction — its own feature, with its own body-cap and
  embedding consequences. `leadImage` is the cheap 80% and is in scope; inline
  figures are deferred, and this paragraph is the record of why.
- **`excerpt`.** Readability offers it free, and it is still cut: it summarises
  a body we are already sending in full, and 2.5 never asked for it.
- **Resolving `author` into the `person` table.** `item.author_id` exists and is
  a genuinely richer target — a clip's author becoming the same entity as a PR
  author. Byline-string → person resolution is fuzzy and cross-connector, and it
  is a design of its own. Not this one.
- **General registrable-domain matching.** The `www` relaxation in rung 4 is
  deliberately not the thin end of this wedge. Treating `shop.example.com` and
  `example.com` as one site in general requires a public-suffix list — without
  one there is no way to know that `bbc.co.uk` and `github.io` are not
  registrable the way `example.com` is — and a PSL is real weight in a bundle
  that ships with no runtime dependencies. `www` is exempt from that argument
  because it is a single well-known label rather than a guess. If a site
  canonicalises across some other subdomain boundary, rung 4 rejects it and the
  clip is filed under the address bar: a duplicate item, which is visible and
  mergeable, rather than the collision this design exists to prevent.
- **Any client-side canonicalisation.** See the constraint section. If a future
  reader believes the client should strip `utm_` params, the answer is that the
  gateway already does, under rules that are load-bearing for identity.
