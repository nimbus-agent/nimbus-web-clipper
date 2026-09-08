# C9 — A title you can follow

**Status:** design · 2026-09-08

## 1. The problem

Two lanes list items the reader cannot reach.

`expert` ranks people by evidence — pull requests, reviews, incidents — and each
piece of evidence carries `itemId`, a real `item.id`, alongside its title.
`catchup` lists the window's items per service, and each carries `itemId` too.
Both render the title as plain text, because until now the contract had no way
to turn an item id into a URL: `GET /v1/items/resolve` maps URL → item, not the
reverse.

That changed. `GET /v1/items/resolve-ids` shipped upstream and is in a gateway
release. This phase spends it.

**Only these two lanes.** `why`, `glossary` and `decisions` already carry URLs on
the wire. `impact` and `ownership` gain nothing and never will — `impact`'s
`affectedItemId` holds a `graph_entity.id` despite its name, and `ownership`
carries person ids and paths. `docs/architecture.md`'s link inventory records
both, and this design does not revisit them.

## 2. Where the resolution happens

**In the background service worker, when a run completes — not in the panel.**

The panel is injected into the page and holds no token; every gateway call in
this extension goes through `src/background/`. So the run handler resolves the
ids once, as the run lands, and the resolved map is persisted with the run.

The consequence worth stating: a resolved URL is **cached with the run**, not
fetched per repaint. A link the reader follows an hour later is the URL the
index held when the agent answered. That is the right trade — the alternative is
a gateway round trip on every panel open, for a link most readers never click.

## 3. The shape: a sibling map, not a field on each element

The resolved URLs land as a **separate map on the run**, keyed by item id:

```ts
/** itemId -> the URL the index holds for it. Absent id = not resolved. */
export type ItemUrlMap = Readonly<Record<string, string>>;
```

They are deliberately **not** merged into `ExpertFindings` / `CatchupFindings`
as a `url` field per element. Three reasons:

1. **A URL is not part of the agent's answer.** The brief is what the agent
   said; this is a client-side enrichment of it. Keeping them separate keeps
   `findings` a faithful projection of the wire, which is what every guard in
   `findings-guards.ts` is written against.
2. **The element guards stay untouched.** Adding an optional field to a nested
   element means every guard arm grows a branch, and the `sanitiseState`
   idempotence invariant has to be re-proved for each. A flat
   `Record<string, string>` is idempotent by inspection.
3. **Runs stored before this ships have no map**, and must keep rendering. An
   absent map is the same code path as a gateway that cannot resolve.

## 4. The contract, and what the client owes it

`GET /v1/items/resolve-ids?id=…&id=…`, a bearer read under the **existing
`resolve` scope** — the same scope `resolve` and `resolve-file` already use, so
no re-pairing and no new scope.

Response: `{ items: [{ id, service, type, title, url, modified_at }] }`. This
client reads `id` and `url` only. **`url` is nullable** — an indexed item may
have none — and a null URL is not a link, exactly as an unresolved id is not.

**An unindexed id is absent from the response**, not a null entry. Absent and
`url: null` are different facts upstream and both mean "no link" here, so the
map simply has no key.

### 4.1 Two bounds, and only one of them is the gateway's

The route refuses more than **100 raw `?id=` parameters** with
`400 too_many_ids`, counted before de-duplicating.

The **byte budget is the client's**, and this is the part a naive implementation
gets wrong. `item.id` is unconstrained `TEXT`, so 100 ids is anywhere from ~3 KB
to past 12 KB of query string. A URL past the server's request-line limit is
refused **before any handler runs**, so an over-long batch returns a transport
error rather than the honest `too_many_ids` the route would have given. A limit
the route cannot enforce is one the caller must respect.

So chunking is by **both**: at most 100 ids, and at most **~1,800 bytes** of
query string per request. Whichever binds first, binds.

### 4.2 Failure is silence, never an error

Every failure mode ends the same way: **no map, no links, no message.**

- **404 `resolve_disabled`** — the gateway is older than the route, or its clips
  surface is unmounted. This is the capability signal, and it is the whole
  reason the route answers 404 before its auth check. Same pattern as C7's
  `resolve-file`: presence is the signal, so **no version floor is introduced**.
- **403** — a browser paired before scopes existed lacks `resolve`. The owner
  clears it with `nimbus clip scopes`; the panel does not nag about it.
- **Network error, timeout, malformed body** — the lane still has its structure,
  which is the whole point of C8. A missing link is a smaller loss than an error
  banner over a working answer.

A lane rendering titles as text is the **normal** state for an older gateway,
not a degraded one.

## 5. Size, and why the store already handles it

`agent-run-store.ts` bounds a persisted run's `findings` at
`MAX_FINDINGS_BYTES` (16 KiB) and, over that, **drops findings and keeps the
run** — the brief still renders. The URL map is bounded the same way and counted
in the same budget.

A worst case is roughly 25 evidence rows for `expert` at ~80 bytes of URL each,
so ~2 KB. Well inside the bound, and if a pathological run exceeds it the
existing behaviour already degrades correctly: the reader gets the prose brief
rather than a broken panel.

## 6. Security

No new destination, no new permission, no widened host access. The route is on
the same loopback origin as every other call, under a scope the token already
holds.

Every resolved URL goes through **`safeHttpUrl`** before it becomes an `href`,
via the existing `findingLink` helper — the same path `why`, `glossary` and
`decisions` already use. The gateway is not treated as trusted output: an
`item.url` is external data that reached the index from a connector, so it is
validated here exactly as a URL inside `findings` is.

## 7. Slicing

One slice. The client work is a gateway-client method, a resolver that chunks
and tolerates failure, a store field, and two renderers gaining a link wrap. The
renderers were built in C8.3 so that adding links is a wrap and not a redesign —
that was the point of leaving them link-less rather than link-shaped.

## 8. What this does not do

- **No re-resolution on repaint.** The map is written once, when the run lands.
- **No backfill of runs already stored.** They keep rendering as text.
- **No new lane.** `impact` and `ownership` are not made linkable, because they
  have no item id to link.
- **No version floor.** Presence of the route is the signal, per §4.2.
