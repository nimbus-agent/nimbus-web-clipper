# C3.1 — Targeted fetch on a resolve miss

**Date:** 2026-08-09
**Status:** Design, approved. Implementation plan to follow.
**Roadmap item:** C3.1 *Targeted sync of a single item* · 🟡 · L

## What this builds

When the panel recognises a page but the gateway has never indexed it, the user
can ask their gateway to fetch that one item through the connector that owns it,
then see the answer.

Today that miss is a dead end: the header says *"Not indexed."* and stops. The
`fetchable` flag needed to do better is already parsed, guarded and carried
across the message boundary by the resolve work (#38) — and read by nothing.
This slice gives it a consumer.

## The contract, read from merged upstream source

Verified against `C:/gitrep/Nimbus` at v1.26.0 — `packages/gateway/src/ipc/http-write-routes.ts`
(`ROUTE_ITEMS_FETCH`, `runItemsFetchRoute`) and `packages/gateway/src/sync/targeted-fetch.ts`
(`TargetedFetchOutcome`). Not from the roadmap, and not from the design doc that
predates the merge.

```
POST /v1/items/fetch      Authorization: Bearer <token>, scope `fetch`
Body: { url }

200 { status: "indexed", itemId }
200 { status: "not_found" }
200 { status: "unsupported_url" }
200 { status: "no_targeted_fetch", service }
200 { status: "not_configured" }
200 { status: "rate_limited" }
400 { error: "missing_url" }
403 { error: "insufficient_scope", required: "fetch", granted: [...] }
404 { error: "fetch_disabled", hint }
500 { error: "internal_error" }
```

Five facts that shape the design:

1. **This is a WRITE, deliberately.** Upstream: *"An explicit I13 WRITE: it causes
   an OUTBOUND request to a configured provider and a row in the local index. It
   is deliberately NOT modelled as a read that happens to have side effects —
   that reclassification is exactly how a write slips past the allowlist."* The
   consent model below follows from this, not from taste.

2. **Its scope is `fetch`, distinct from `resolve`.** Upstream is explicit that
   the split exists *"since this one makes an outbound request"*. A token that
   can resolve cannot fetch. Every pairing made today, including one made after
   #38, needs `fetch` granted separately.

3. **Every outcome is a 200.** *"Every TargetedFetchOutcome — `indexed` and every
   miss arm alike — is a 200: a miss is a legitimate answer to a well-formed
   request, not a client error."* Same shape as resolve: a miss is an answer.

4. **`indexed` returns ONLY `itemId`** — no title, url, or `modified_at`. The
   panel therefore cannot render a resolved header from a fetch response. It must
   re-resolve. This is a constraint, not a choice.

5. **`not_configured` carries NO service name.** Only `no_targeted_fetch` has a
   `service` field. So the panel cannot name the connector from the wire on the
   arm where naming it matters most. It names it from **recognition**, which
   already knows the product. No message text is ever derived from a field the
   wire does not send.

## Decisions

### Fetch is triggered by an explicit click, never automatically

A miss with `fetchable: true` renders *"Not indexed."* plus a button naming the
target — **"Fetch this from GitHub"**. Nothing outbound happens until it is
clicked.

This satisfies the principle roadmap **C4.2** already states — *"No gateway-side
fetch happens without the user having seen what it will fetch"* — at its cheapest:
the button itself names what will be fetched and from where. C4.2's fuller
confirm dialog, with its "don't ask again" toggle, stays in C4.2.

Automatic fetch-on-miss was rejected. It would mean that merely opening the panel
causes an outbound provider request under the user's stored credential, which
contradicts this repo's stated posture that the consent moment is explicit.

### The six arms collapse by "can the user act on it?"

| Wire | Panel |
| --- | --- |
| `indexed` | re-resolve, render the item |
| `not_found`, `unsupported_url`, `no_targeted_fetch` | one message: *"Nimbus can't fetch this page."* No action. |
| `not_configured` | *"No GitHub connector is configured on your gateway."* (product from recognition) |
| `rate_limited` | *"Rate limited — try again shortly."* + **Try again** |
| 403 | *"nimbus clip scopes `<label>` --set …,fetch"* |

The three collapsed arms differ in *why* the gateway declined but are identical
in what the user can do: nothing. Distinguishing them would add strings that
change no decision.

`not_configured` stays distinct because C3.1's done-when requires it: *"an
unconfigured connector says so plainly instead of retrying."* Collapsing it into
the generic message would leave a user retrying forever against something that
will never work.

### A timeout does not claim failure

The gateway polls up to 5s for a rate-limit token *before* it starts, then calls a
provider API. The client waits **30s**.

On timeout the panel says the gateway **may still be working**, and offers
**Check again** — which **re-resolves only**. It never re-fetches.

This is the honesty rule the resolve work established, applied to a new case: our
timeout tells us we stopped listening, not that nothing happened. Reporting
"couldn't fetch" would assert something we have not established, and a retry
button there would fire a second outbound request for work that may already be
done.

### Architecture: the panel orchestrates, the background stays a thin transport

One new message (`fetch`) returns a `FetchOutcome`. On `indexed`, the panel
re-issues the **existing** `resolve` message.

Rejected: having the service worker fetch *and* re-resolve behind one message. It
conflates two operations, and on a timeout the panel could not tell which half
stalled — destroying the distinction the timeout decision depends on.

Also rejected: reusing the clip machinery. Clip is a different route with a
different scope and its own queue and rate-limit-pause behaviour; sharing would
entangle two unrelated failure models.

The payoff: **"Check again" after a timeout is the same code path as the success
path** — re-resolve, nothing more. One mechanism, two uses.

## Components

### `src/shared/types.ts`

```ts
export type FetchOutcome =
  | { readonly kind: "indexed"; readonly itemId: string }
  /** not_found | unsupported_url | no_targeted_fetch — identical in what the user can do. */
  | { readonly kind: "unfetchable" }
  /** No `service` on the wire; the product name comes from Recognition. */
  | { readonly kind: "not-configured" }
  | { readonly kind: "rate-limited" };

export type FetchError =
  | "not_paired"
  | "unauthorized"
  | "insufficient_scope"
  /** 404 — this gateway has no fetch route, or the seam is disabled. */
  | "unsupported"
  /** OUR 30s timer fired. NOT a failure: the gateway may still be working. */
  | "timeout"
  | "unreachable"
  | "server_error";
```

### `src/background/gateway-client.ts`

```ts
export async function fetchItem(
  origin: string, token: string, pageUrl: string, doFetch?: FetchLike,
): Promise<{ ok: true; outcome: FetchOutcome } | { ok: false; reason: FetchError }>
```

`FETCH_TIMEOUT_MS = 30_000`. Parses the 200 body into `FetchOutcome`; an
unrecognised body is `server_error`, never a miss — the rule the resolve parser
already follows.

**The `catch` must split.** Every existing client in this file maps any thrown
error to `unreachable`. Here that is wrong:

```ts
catch (err) {
  return { ok: false, reason: isAbortError(err) ? "timeout" : "unreachable" };
}
```

Collapsing them inverts the honesty property in both directions: a genuinely-down
gateway would claim a fetch might be in flight, and a live fetch would be
reported as dead.

**Scoped to this function.** `confirmPair`, `postClip` and `postRelated` have the
same collapse. It is harmless there — those are fast, and none renders a
"may still be running" state. Fixing all four is a separate change.

### `src/shared/messages.ts`

`FetchRequest { kind: "fetch"; pageUrl: string }`, `FetchResponse` carrying the
recognition on both arms (as `ResolveResponse` does), plus guards over the
**domain** shape.

### `src/background/handlers.ts`

`handleFetch` re-runs `recognise()` and **refuses to call the gateway on an
unrecognised URL**, returning without a request.

Same boundary as `handleResolve`, and it matters more here: resolve is a
local-index read, this causes an outbound request under the user's stored
credential. The recogniser is what decides which URLs may reach the gateway at
all.

### `src/panel/panel-view.ts`

```ts
| { kind: "not-indexed"; surface: string; product: Product;
    fetchable: boolean }                                             // modified
| { kind: "fetching"; surface: string; product: Product }            // new
| { kind: "fetch-blocked"; surface: string; product: Product;
    reason: "unfetchable" | "not-configured" | "needs-fetch-scope" } // new, no action
| { kind: "fetch-retry"; surface: string;
    reason: "rate-limited" | "still-working" }                       // new
```

**The arms carry data, never prose.** Every existing `HeaderState` arm hands
`panel-view.ts` structured values and lets the pure module build the copy —
`needs-scope` builds its own strings from nothing but its `kind`. These follow
that. Passing a pre-built `message` in would move user-facing text out of the one
module whose copy is unit-tested, and the wording is the whole point of this
feature.

`product` is the `Product` enum, not a display string; `panel-view.ts` maps it to
a name ("GitHub") the way `surfaces-view.ts` already does. That keeps one table
of product names rather than a second spelling arriving from the panel wiring.

`reason` drives both the copy and the action, so the two retry paths stay one
mechanism: `rate-limited` retries the **fetch**; `still-working` retries the
**resolve**. A recovery click can never fire a second outbound request for work
already done.

The `never` exhaustiveness guard added in #38's fix wave makes forgetting to
render a new arm a compile error.

### `src/panel/panel-in-page.ts`

Holds the fetch state machine beside the existing chosen-candidate state, and
maps outcomes to header states. The button click sends `fetch`; `indexed` re-sends
`resolve`.

This module maps outcome → `kind` + `reason` and nothing more. It writes no
user-facing copy: every string lives in `panel-view.ts`, where a test can pin it.

## Data flow

```
resolve miss, fetchable:true
  └─ "Not indexed."  [ Fetch this from GitHub ]
        │ click
        ├─ panel → SW: { kind:"fetch", pageUrl }
        │     └─ recognise() gate → POST /v1/items/fetch (30s)
        │
        ├─ indexed        → panel re-sends { kind:"resolve" } → resolved header
        ├─ rate_limited   → "Try again shortly"  [Try again] → fetch again
        ├─ not_configured → "No GitHub connector is configured…"   (terminal)
        ├─ unfetchable    → "Nimbus can't fetch this page."        (terminal)
        ├─ 403            → "nimbus clip scopes <label> --set …,fetch"
        └─ timeout        → "Still working…"  [Check again] → resolve only
```

## Error handling

| Condition | Reason | Panel |
| --- | --- | --- |
| Not paired | `not_paired` | existing pairing guidance |
| 401 | `unauthorized` | existing re-pair guidance |
| 403 | `insufficient_scope` | `nimbus clip scopes <label> --set …,fetch` |
| 404 | `unsupported` | "This gateway can't fetch pages yet." |
| 30s elapsed | `timeout` | "Still working" + **Check again** (resolve only) |
| Transport error | `unreachable` | "Couldn't connect to Nimbus." |
| 400/500/malformed 200 | `server_error` | generic error |

The 403 copy must name the **`fetch`** scope, not `resolve`. A user who granted
`resolve` after #38 still cannot fetch, and telling them to grant `resolve` again
would be a dead end.

The exact CLI syntax is `nimbus clip scopes <label> --set <a,b>` — verified
against `nimbus clip --help` on the installed v1.26.0 and `CLIP_USAGE` in the
gateway source. **Do not** derive it from the gateway's IPC test file, which
yields `--label/--scopes`; that does not parse. This exact mistake reached a
user-facing string during #38 and was caught only by checking the installed
binary.

## Testing

Unit tests, node env; DOM tests opt into jsdom via a docblock.

- **`gateway-client`** — all six 200 arms; 400/401/403/404/500; **`AbortError` →
  `timeout` and connection-refused → `unreachable`, asserted separately** (they
  must not collapse); malformed 200 → `server_error`; the POST carries `{url}`
  and the bearer header, and the token appears nowhere else.
- **`messages`** — guards accept each outcome, reject an unknown `kind`, a missing
  `itemId` on `indexed`, and a bad recognition.
- **`handlers`** — an unrecognised page makes **no** gateway call (asserted by a
  spy that must not be invoked); not-paired short-circuits; the outcome is carried
  through with the recognition on both arms.
- **`panel-view`** — the button renders only when `fetchable`; each state's copy;
  the timeout copy never contains "failed" or "couldn't"; the 403 copy contains
  `--set` and `fetch`; every gateway string via `textContent` (an `<img onerror>`
  title renders as text and creates no element).
- **`panel-in-page`** — click → `fetching` → `indexed` → re-resolve renders the
  item; **timeout → "Check again" issues a `resolve` and NOT a `fetch`** (asserted
  by message kind, the property that stops a double outbound request).

## Out of scope

- **C4.2** — the confirm dialog and "don't ask again". The button is the consent
  moment for now.
- **C4.1** — the egress log. It needs a gateway read surface that does not exist.
- **C2 lanes.** C3.1's roadmap done-when says "and the lanes answer"; the lanes are
  C2 and unbuilt. This slice delivers *resolve after fetch*. The lanes will answer
  when they exist, with no further work here.
- Refactoring `unreachable` in the other three clients.
- The **`ambiguous`** outcome does not get a fetch button. Several indexed items
  already match; fetching another would not disambiguate them.

## Open question, deliberately left

Does `service` on resolve's `ambiguous` arm earn its place? It is parsed and
carried, but nothing renders it, and unlike `fetchable` it has no consumer
present or planned. Raised in #38's review and still unanswered. This slice does
not settle it; it should be decided before a third consumer inherits it.
