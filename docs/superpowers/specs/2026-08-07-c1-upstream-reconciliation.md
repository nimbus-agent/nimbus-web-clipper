# Phase C1 ↔ Gateway — Reconciliation

**Date:** 2026-08-07
**Status:** Findings. No code changes here; this records what must change and when.
**Supersedes:** the *Proposed gateway contract* section of
[`2026-08-07-phase-c1-know-where-you-are-design.md`](./2026-08-07-phase-c1-know-where-you-are-design.md).

> **2026-08-09 update:** the route landed. `GET /v1/items/resolve` first shipped
> upstream in gateway v1.25.0; this repo verified it against v1.26.0. The "When
> gateway PR 3 lands" section below has landed and its client adaptation has
> shipped in this repo (phase C2, branch `c2-resolve-contract`). The table row
> and prose below that said "not landed" are corrected in place rather than
> rewritten, so this document stays the accurate record of why the C2 work
> happened — read it as history, not as the current state.

## Why this exists

Phase C1 shipped (#36) stating that a contract proposal for resolve-by-URL still
had to be opened in the [Nimbus gateway repo](https://github.com/nimbus-agent/Nimbus).
**That was wrong, and it was asserted without checking that repo.** The route was
already designed there — a day before the C1 spec was written — reviewed, and
partly landed.

Everything below was read from the gateway repo at `82c03d27`, not reasoned about.

## What is actually upstream

| Artefact | State |
| --- | --- |
| `docs/superpowers/specs/2026-08-06-http-agents-route-and-resolve-by-url-design.md` | Designed + reviewed (review and review-response alongside it). Owns the **gateway side**. |
| `docs/superpowers/specs/2026-08-01-browser-gateway-client-design.md` | Committed but **unmerged**, on `dev/asafgolombek/spec-browser-client` (`d8b4d93d`). Owns the **extension side** — recogniser, panel, notify-when-ready. |
| Token scopes (PR 1 of the gateway design) | **Landed** — `feat(gateway): scope the HTTP API bearer tokens (#1062)`. `packages/gateway/src/clips/api-scopes.ts` is on main. |
| The resolve route itself (PR 3) | Designed and sequenced at the time this table was written; **landed since** — shipped in gateway v1.25.0, verified against v1.26.0. `items/resolve` is now in `packages/gateway/src/`. See the 2026-08-09 update banner above. |

So there is nothing to propose. The C1 client is a consumer of a contract that
already exists on paper, and it was built against a different shape.

## Where the two designs agree

These need no change, and are worth stating so the divergences below don't read
as a rewrite:

- **The recogniser is a pure, unit-testable pattern table**, shipping the same
  five surfaces: Bitbucket PR, Jenkins build, Jira issue, GitHub PR, GitLab MR.
- **The recogniser is the security boundary** — only URLs it matches are ever
  sent to the gateway. C1's `handleResolve` honours this: an unrecognised page
  short-circuits with no gateway call, asserted in `handlers.test.ts`.
- **Resolve is a read, at most one item, and never dressed up from ranked hits.**
- **The panel renders progressively** rather than blocking on the slowest answer.
  C1 already loads resolve and related in parallel and repaints as each lands.
- **Targeted fetch on a miss is a separate concern** (C3.1 here, §5 upstream).

## Where this repo diverges, and must change

| Aspect | Shipped in C1 (#36) | Upstream design (§4) |
| --- | --- | --- |
| Route | `POST /v1/clips/resolve` | `GET /v1/items/resolve?url=` |
| Payload | JSON body `{ canonicalUrl }` | query parameter |
| Auth | any paired clip token | requires the **`resolve` scope** |
| Success shape | `{ item: {...} \| null }` | `{ found: true, item: {...}, matchKind }` |
| Item fields | `id, service, type, title, canonicalUrl, url` | `id, service, type, title, url, modified_at` |
| Miss | `item: null` | `{ found: false, reason: "not_indexed" \| "unresolvable_url", service, fetchable }` |
| Third outcome | *none* | `{ found: false, reason: "ambiguous", candidates[], truncated }` |
| Canonicalisation | client strips all query params, collapses sub-tabs | gateway owns it: `canonicalizeUrl` + a bounded ladder (exact → query-stripped → ≤3 trimmed path segments) |

Four consequences, in the order they'd bite a user:

1. **Existing pairings will be rejected, and we'd report it wrongly.**
   `LEGACY_SCOPES` is `["clip", "briefs"]` — deliberately, so that tokens already
   in the wild cannot resolve arbitrary URLs. Every browser paired today therefore
   lacks the `resolve` scope. `postResolve` maps only `401` and `404`, so a `403`
   insufficient-scope falls through to `server_error` and the panel says *"Nimbus
   had an error resolving this page."* The truthful message is *"this pairing
   predates resolve — re-pair to grant it."* **This is the single most important
   fix**, because it is the state every existing user hits first.

2. **`ambiguous` has nowhere to go.** The upstream design caps candidates at five
   and returns them deliberately: *"the panel is the one place a human can resolve
   the ambiguity in one click."* C1 has no such state in `ResolveResponse`,
   `HeaderState`, or the panel — an ambiguous answer would fail the guard and
   render as `server_error`. Upstream is expecting a chooser this repo did not
   build.

3. **The panel shows no provenance or freshness.** The browser spec is explicit:
   show *"indexed 3 min ago"* vs *"fetched just now"*, because *"an answer whose
   staleness is invisible is the characteristic failure of tools in this space."*
   The upstream response carries exactly the fields for it — `modified_at` and
   `matchKind` — and C1's `ResolvedItem` models neither. `matchKind` matters
   independently: a `path_trimmed` match is a weaker claim than an `exact` one and
   should not be presented with the same confidence.

4. **Canonicalisation is owned in the wrong place.** C1 strips *all* query
   parameters; `canonicalizeUrl` strips only the fragment, `utm_*`/click-ids and a
   non-root trailing slash, deliberately preserving browser view-state. For the
   five shipped surfaces no identity lives in the query, so this is currently
   harmless — but the client is doing work the gateway will redo, against
   different rules, and `canonicalizeUrl` is explicitly *"reused, never modified"*
   because `externalIdFor` hashes its output. The client should send the address-bar
   URL and let the ladder match, keeping only the sub-tab collapsing that helps
   the header read well.

## Where the upstream browser spec is itself stale

Recorded so it isn't treated as current when the branch merges. The gateway design
already corrects all three, having checked them against source:

- *"Resolve is no new table; a new query only"* — false. `canonical_url` carries
  no index and stores raw provider URLs, so resolve needs a derived `resolve_key`
  column, `idx_item_resolve_key`, and a backfill (migration V50).
- *"Targeted fetch goes through the connector, so it gets an egress ledger row"* —
  false. `bitbucket-sync.ts:280` calls `fetch()` directly; sync is not a dispatch.
- *"Abort is free via a job registry"* — false. Agents use no
  `LongRunningJobRegistry` and contain no `AbortController`.

It also keys resolve on `externalId`; the gateway design supersedes that with
URL matching via `resolve_key`, which is closer to what C1 built.

## What changes in this repo, and when

Both steps below are now done — see the 2026-08-09 update banner at the top.
Left as originally written (rather than rewritten in past tense) because this
document's value is the record of the plan made *before* the route landed;
only the two corrections below are updated in place so a reader doesn't come
away believing the opposite of what happened.

**Then** — corrections only, because at the time of writing the route had not
landed and adapting to a design that might still shift would have been rework:

- `ROADMAP.md` C1.1: drop *"Propose in the gateway repo first"*; link the real
  upstream design and name the shape the client will consume.
- `2026-08-07-phase-c1-know-where-you-are-design.md`: mark *Proposed gateway
  contract* superseded by this note, and correct *Token scope — decided (client
  position)*, which claimed resolve reuses the clip token. It does not.

**When gateway PR 3 landed** — the client adaptation, done in one slice (phase
C2, this branch):

- `GET /v1/items/resolve?url=` in place of the POST, and `PROPOSED_PATHS` becomes
  a real entry.
- `403` → a distinct `insufficient_scope` reason, surfaced as re-pair guidance.
- `ambiguous` as a first-class `ResolveResponse` arm and `HeaderState`, with a
  candidate chooser in the panel.
- `ResolvedItem` gains `modified_at`; the header shows freshness and distinguishes
  an exact match from a trimmed one.
- Stop stripping query params client-side; send the address-bar URL.
- `fetchable` is carried through for C3.1 rather than dropped.

**Sequencing note (historical).** The 404-degradation path shipped in C1 kept
working throughout the wait: an unshipped route 404ed, and the panel said so.
Nothing was broken while waiting, and none of the above was urgent — it was the
difference between the feature lighting up correctly and lighting up wrong once
the route landed, which it now has.
