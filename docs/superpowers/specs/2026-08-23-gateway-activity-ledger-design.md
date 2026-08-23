# What the gateway did for you — the egress ledger in the browser (C4.1)

> **Status:** design, approved 2026-08-23. Cross-repo, three upstream efforts
> and four client slices. The read routes, the `egress` scope and the ledger-row
> changes are **proposed, not contracted** — per the roadmap's
> [gateway-dependent feature protocol](../../../ROADMAP.md#proposing-a-gateway-dependent-feature)
> their shape is decided in the Nimbus repo, not here. This document is the
> whole cross-repo design; each upstream slice carries its own.

## The gap this closes

Roadmap **C4.1** is the last unshipped item in the C1–C5 client arc. Its premise
is that Pillar 4 grew a second half the moment the extension could cause the
gateway to reach out: "where does my data go?" now needs "and what did it go and
get?" beside it. The **1.2** trust panel answers the first; nothing answers the
second.

The brief's own approach section is careful about the trap — the client should
read the gateway's record rather than keep a private one it could quietly
disagree with — and it leaves one question open: *whether a targeted sync lands
in the ledger at all*. That question is now answered, along with three the brief
did not know to ask.

## What the upstream already gives us

Read against `Nimbus` `main` at `99b45874`, past `v1.27.0`.

### Finding 1 — everything this client causes is already ledgered

The open question resolves in our favour. `sync/targeted-fetch.ts:300` appends
one egress row per targeted fetch *before* calling the connector's `fetchOne`,
and `POST /v1/items/fetch` is the only route that reaches it. Agent invocations
over HTTP append one `source_type='http'` row each
(`agent-runs/agent-http-invoke.ts:133`). Clip ingest appends nothing, correctly:
a clip is inbound, and I29 records egress.

So the record exists. Nothing about it needs inventing — only reading.

### Finding 2 — the read verbs exist, but not over HTTP

`egress.head`, `egress.list`, `egress.proveWindow` and `egress.verify` shipped
as IPC/JSON-RPC verbs (`ipc/egress-rpc.ts`, I29, #698) and are LAN-allowlisted;
the mutating `egress.prune` is deliberately absent from that allowlist. There is
no `/v1/egress` HTTP route — the v1 surface is clips, items, agents, briefs,
search, admin and health.

This narrows the upstream ask considerably. C4.1 does not need a new record, a
new table or a new appender. It needs a **read route over primitives that
already exist**, shaped like `GET /v1/items/resolve`.

### Finding 3 — attribution is asymmetric, against the feature's own promise

An agent row carries `sourceId = clientId`, and `clientId` is the verified
pairing-token label (`egress/agent-brief-egress.ts:49`,
`agent-runs/agent-http-invoke.ts:133`). This extension knows its own label:
`confirmPair` returns it and `Connection` stores it beside the token, so
scoping agent rows to "ours" needs no new plumbing at all.

A targeted-fetch row does not. `recordSyncEgress` hardcodes `sourceId: null`
(`egress/sync-egress.ts:78`), so the fetches — the entire reason Phase C4 exists
— carry no caller identity.

The row is also thinner than the brief assumes. In full, a targeted fetch today:

```ts
{ sourceType: "sync", sourceId: null, destination: <serviceId>,
  method: "items.fetch", payloadSummary: redact({ method }),
  hitlStatus: "not_required", resultStatus: "authorized" }
```

`destination` is the service id and the module's own doc says it is "NEVER a raw
URL with a query-string secret". So of the brief's four promises — *what was
fetched, when, for which page, how it ended* — the row answers **when** and
**which service**, and neither of the other two:

- **"for which page"** — there is no item identity in the row.
- **"how it ended"** — the append happens *before* `fetchOne`, deliberately
  (fail-closed: no row, no dispatch). `result_status` records the authorization
  decision, not the fetch's outcome. A fetch that 404s or times out still reads
  `authorized`.

### Finding 4 — `method` already separates a fetch from a background sync

`targeted-fetch.ts:300` appends `method: "items.fetch"`; the scheduler appends
`method: "sync.run"` (`sync/scheduler.ts:727`). So the ledger already
distinguishes the *action class* — a fetch someone asked for, versus a scheduled
background sync — without any upstream change.

What it cannot distinguish is *which client asked*. With one paired browser those
are the same fact; with a browser and a VS Code satellite both paired, they are
not. Finding 4 is why the client can ship something honest against U1 alone, and
Finding 3 is why U2 still matters.

## Decisions

| Question | Decision |
| --- | --- |
| Attribution | Propose it upstream. Do not correlate client-side. |
| Read surface | The full four verbs, `proveWindow` included. |
| Where it lives | Both: a summary line in the Options trust panel, detail on its own page. |
| Default scope | Ours by default, everything one click away, unattributable labelled as such. |
| Sequencing | Contract-first, two worktrees in parallel. |
| Row contents | Label, item identity, and outcome — the full done-when. |

The last one is the expensive choice and is taken with its cost stated: outcome
rows add a row class to an append-only chained ledger and touch I29's counting,
coverage vector and completeness argument. That is its own upstream design spec
(**U3**), not a slice of this one, and the client is sequenced so it never waits
on it.

## The upstream contract (Nimbus)

### U1 — the `egress` scope and four read routes

Add `egress` to `API_SCOPES` (`clips/api-scopes.ts:11`). It stays out of
`LEGACY_SCOPES`, matching that module's stated rule that a migration grants no
new capability. The consequence is real and must be designed for, not
discovered: **an already-paired user has to re-pair to see their ledger.**

Two things about that re-pair, because they bound how smooth it can be made.
**It cannot happen inside the extension alone.** Minting is fail-closed (I30) —
the owner opens a pairing window with `nimbus clip pair` on the gateway, and the
scopes are fixed when that window opens. An "upgrade permissions" button that
grants itself a scope is precisely what I30 exists to prevent, so the flow will
always route through the CLI.

**But it is already an in-place upgrade, not a teardown.** `handlePair`
overwrites the connection only on a confirmed new token, and a failed attempt
(wrong code, expired window) leaves the working connection untouched by design
(`handlers.ts:115`). The one real cost is that a confirmed re-pair clears cached
agent answers, best-effort, because a cached brief belongs to the gateway that
produced it (`handlers.ts:127`). So what this design adds is the *prompt*, not
the plumbing: an "Enable Activity" affordance that names the missing scope, tells
the user which command to run, and drops them on the code field with the origin
pre-filled.

Four bearer reads under that scope, following the `GET /v1/items/resolve`
precedent — an entry in the read-route auth table
(`ipc/http-route-auth.ts:22,72`), and no egress row of their own:

| Route | Over | Returns |
| --- | --- | --- |
| `GET /v1/egress` | `listEgress` | a page of rows **plus the window's counted totals** — see below |
| `GET /v1/egress/head` | `egressHead` | head hash + count |
| `GET /v1/egress/verify` | `verifyEgressChain` | chain-intact verdict |
| `GET /v1/egress/prove` | `proveWindow` + `signWindowDigest` | rows, digest, `sigB64`, `pubkeyB64`, truncation flags |

**Ordering and totals are part of the ask, not an implementation detail.**
`listEgress` orders `id ASC` and caps at 1000 rows by default with no offset or
cursor (`egress/egress-verify.ts:187`). A view that leads with recent activity
and reads that route over a wide window therefore gets the **oldest** thousand
rows while presenting them as the newest, and a count derived from that page
under-reports. Upstream has already been bitten by exactly this: `proveWindow`
returns `rowsTotal` and `rowsTruncated` so that "the page no longer PRETENDS to
be the window", and `countOutboundEgress` exists because deriving the count from
a page "drops the MOST RECENT rows while doing it" — its own doc calls that "the
worst possible direction" for a primitive whose job is to state how much left the
machine.

So `GET /v1/egress` must return `{ rows, rowsTotal, rowsTruncated }` mirroring
`proveWindow`, and must support **newest-first ordering with a cursor**, so the
Activity page can page backwards through a long ledger without inventing its own
windowing by timestamp (which cannot page within a same-timestamp burst). This is
a shape upstream already settled once; the ask is to apply it to the new route
rather than to invent it.

**`prove` is the contested one and the proposal must argue it rather than bundle
it.** `signWindowDigest` (`egress/egress-sign.ts:43`) signs with the Vault share
keypair, so exposing it over HTTP hands a pairing-token holder a narrow signing
oracle. How narrow is worth stating precisely, because it is the question the
upstream reviewer will ask:

- **The caller cannot choose the signed bytes.** The signed message is the
  BLAKE3 hex digest of a payload the gateway builds — `"nimbus-egress-window-v2"`,
  the outbound and total counts, and the window's ordered row hashes
  (`digestEgressWindow`, `egress-sign.ts:24`). The caller supplies `since` and
  `until` integers, nothing more. The reachable message space is 64-character hex
  strings, each pinned to real ledger content.
- **The `v2` domain tag is bound, transitively.** It is inside the hashed payload
  rather than the signed message, but since the signed message *is* that hash,
  a digest produced under a different rule cannot collide with one produced under
  this one.
- **Cross-protocol reuse is not reachable.** The same keypair signs share files,
  but `buildShareFile` signs `canonicalizeBody(body)` — canonical JSON bytes
  (`share/share-format.ts:76`). A 64-character hex string is not a canonical JSON
  body, so a signature harvested here cannot be replayed as a share file.
- **What it does share is identity.** A ledger receipt and a share file verify
  under the same public key, which `share.pubkey` already publishes. That is a
  property of upstream's deliberate "reused — no new Vault key" choice, not
  something this route introduces.

The proposal should still ask for a **per-token rate limit on `prove`
specifically** — it is the only one of the four routes that does asymmetric
crypto per call, so it is the only one where a hot loop costs meaningfully more
than a read.

Deliberately **not** asked for: a ledger-specific derived signing key. Key
separation is a Vault key-management decision upstream owns, and the current
reuse is documented as intentional; raising it here would trade the route's
chances for a change this client does not need. If upstream declines `prove`
outright, the client degrades by losing *Export proof* and nothing else.

### U2 — caller identity on a targeted fetch

`recordSyncEgress` gains an optional caller label; `targetedFetch` threads the
label the route already verified (`/v1/items/fetch` authenticates the same
labeled clip token under its own `fetch` scope,
`ipc/http-write-routes.ts:46`). The scheduler passes nothing, so `sourceId: null`
gains a meaning it does not have today: **not caller-initiated**.

Same slice, the item identity: a `{ service, type, id }` triple in
`payload_summary` — never the raw URL, so the no-URL-with-query-secret rule is
respected rather than renegotiated. Existing rows are untouched and the chain is
unaffected; only new rows differ.

### U3 — outcome

How a fetch ended, recorded after the fact. On an append-only chained ledger
this means a second row class and a correlation key back to the authorizing row,
which is why it gets its own design document in the Nimbus repo. Out of scope
here beyond the client's forward-compatibility: the Activity page renders an
outcome column when rows carry one and omits it when they do not.

## Client architecture

New pure logic stays out of the `chrome.*` seam, as everywhere else in this repo.

- **`src/shared/egress.ts`** (new, pure) — row types, `unknown`-narrowing guards,
  and `partitionRows(rows, ourLabel)` → *ours* / *other clients* / *not
  attributable*. Unattributable is its own bucket; nothing infers ownership from
  timing or service.
- **`src/shared/gateway.ts`** — four new `GATEWAY_PATHS` entries.
- **`src/background/egress-client.ts`** (new) — the four reads with the same
  fetch/timeout/status-mapping shape as the rest. Beside `gateway-client.ts`
  rather than inside it: that file is 648 lines and `brief-client.ts` set the
  precedent for splitting a surface out.
- **`src/background/egress-handlers.ts`** (new) — pure handlers with injected
  deps, mirroring `brief-handlers.ts`, so `handlers.ts` (886 lines) does not grow
  again.
- **`src/shared/messages.ts`** — one typed request/response pair per read, with
  guards.
- **`src/ledger/`** (new build entry) — `ledger.html` + `ledger.ts` + pure
  `ledger-view.ts`, the same three-file shape as `src/brief/`. Needs an `ENTRIES`
  line in `esbuild.mjs` and the new page in `scripts/check-build.mjs`'s
  per-target completeness assertion.
- **`src/options/ledger-summary-view.ts`** (new, pure) — the trust-panel summary
  line; `options.ts` wires it and links through.

Both renderers consume the **same** `partitionRows`, so the summary and the page
cannot disagree about what counts as ours — the discipline `src/shared/preview.ts`
already enforces for the clip and fetch previews.

## The two views

**Options trust panel.** One line under "Where does my data go?" — *"14 outbound
actions in the last 7 days, 9 of them yours. Chain verified."* — and a link. It
belongs there and not in the popup because it is the second half of the sentence
that panel already starts.

**The Activity page.** Leads with our own rows; a toggle reveals the full window.
Per row: time, service, action class (`items.fetch` versus `sync.run`), what it
was for once U2 lands, authorized versus blocked, and outcome once U3 lands.
Verification is an explicit action — pressing it walks the chain and reports the
verdict. *Export proof* produces the signed `{ digest, sig, pubkey }` artifact.

Rows are newest-first and paged with the cursor U1 provides; the page states the
window it is showing and the total in it, so a truncated view reads as truncated
rather than as the whole record.

## Degradation and the honesty rules

The client already maps 403 → `insufficient_scope` (with a `scopeGap` detail)
and 404 → too-old-gateway for `resolve`/`fetch`/`agents`. The Activity page
reuses both, so U1's re-pair cost is paid by existing plumbing:

- **No route (404)** — "your gateway does not offer this yet", never an empty
  list. The client gates on the 404, not on a parsed version string.
- **No `egress` scope (403)** — "re-pair to grant Activity access", naming the
  missing scope from `scopeGap`.
- **Not paired** — the page says so and links to Options.

Four rules this design is actually about:

- **Never a private log.** The client persists nothing about past fetches. Every
  row rendered comes from the gateway on that read; the only local input is the
  `label` already in `Connection`. This is what makes the view structurally
  unable to disagree with `nimbus prove`.
- **Verification is claimed, never assumed.** "Chain verified" appears only after
  `verify` returned intact. A failed verify is loud: the page states the chain
  did not verify and stops presenting the list as trustworthy. Concretely it
  names the first row where the chain broke (`verifyEgressChain` returns it),
  says the three things that can cause it — tampering, database corruption, or a
  pruned window whose tombstone is missing — and keeps *Export proof* available,
  since the signed artifact over a broken window is exactly what a diagnosis
  needs. It offers no repair action: nothing in this client may write to the
  ledger.
- **A count never comes from a page.** The summary line's numbers come from the
  window totals the route returns, never from `rows.length`. This is the failure
  mode `countOutboundEgress` was written to end, and a browser view that
  re-introduced it would under-report egress while looking confident.
- **Unattributable is a bucket, not a guess.**
- **The pre-attribution window is stated, not hidden.** Rows written before U2
  carry no label, so "ours by default" would otherwise render a silently short
  list. The page says attribution is unavailable for that period rather than
  implying the extension did less than it did.

## Testing

Pure-first, as the repo does everywhere. `egress.ts` partition and guards as
plain unit tests; `ledger-view.ts` and `ledger-summary-view.ts` under the jsdom
docblock; `egress-client.ts` status mapping against a fetch stub;
`egress-handlers.ts` with injected deps. `check-build.mjs` gains the new page and
the manifest test covers both targets, so a Chrome/Firefox drift stays a type
error.

For what no unit test reaches, `scripts/mock-gateway.ts` grows the four routes
and `test/e2e/ledger.e2e.ts` drives them, declaring `COVERS` markers that match
new steps in `docs/development.md` — `e2e-coverage.test.ts` fails the build on a
checklist step claiming coverage no test provides.

Upstream tests belong to the Nimbus repo: U2 touches `sync-egress.test.ts`,
`targeted-fetch.test.ts` and the `I29` describe block in
`security-invariants.test.ts`, and the I29 section of `docs/SECURITY-INVARIANTS.md`
needs its `sourceId: null` claim updated.

## Slices

**Upstream (Nimbus worktree)**

- **U1** — `egress` scope, four read routes (newest-first ordering, a cursor, and
  window totals on the list route), a per-token rate limit on `prove`, the
  route-auth entry, and the I29 doc note.
- **U2** — caller label and `{ service, type, id }` identity on targeted-fetch rows.
- **U3** — outcome rows; its own design document first.

**Client (this repo)**

- **S1** — contract types, `egress-client`, handlers, messages, against the
  extended mock gateway. No UI.
- **S2** — the Activity page: list, ours/all toggle, verify, export proof.
- **S3** — the Options trust-panel summary line.
- **S4** — identity and outcome columns, once U2 and U3 land.

S1–S3 ship against U1 alone and are useful without U2 or U3, because Finding 4
already separates a fetch from a background sync. The columns appear when the
rows carry the fields. This keeps the client off the critical path of the largest
upstream piece.

## What this design does not do

- It does not correlate rows client-side or keep a local record of past fetches.
- It does not expose `egress.prune`; the read routes are reads, and the one
  sanctioned mutation stays owner-gated and off the LAN allowlist.
- It does not claim a fetch succeeded until U3 makes that a fact the ledger
  holds.
- **It does not isolate clients from each other, and does not hash item ids.**
  Considered and declined. The threat model is one owner on one machine: the
  gateway binds loopback (I6) and every token is minted by that owner running
  `nimbus clip pair` (I30). A token that can read the ledger can already
  `resolve` and `fetch` those same items, so the rows expose no item the caller
  could not otherwise reach. What the "everything" view does add is the fact that
  *another* client fetched something — and that is the deliberate content of the
  ours-by-default-everything-one-click-away decision, not an oversight; the
  alternative, an ours-only view, was rejected because the chain covers the whole
  ledger and a verification claim over rows the view refuses to show is not a
  claim worth making. Per-client sub-ledgers fail for the same reason. Hashing
  ids would defeat the feature's own purpose, which is to name the page a fetch
  was for.
