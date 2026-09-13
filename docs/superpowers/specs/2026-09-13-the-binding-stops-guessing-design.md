# C10.3 — The binding stops guessing

> Status: design, approved. A slice of Phase C10, after C10.1 (shipped, v0.9.0)
> and alongside C10.2 (open).

## 1. The problem

C10.1 shipped the service binding: the deploy-readiness section needs a Nimbus
service id, the page only knows a repo coordinate, and nothing connected the
two. So the client asked the user, seeding the input with a **guess** derived
from the scope's last path segment.

That guess was a deliberate second-best. `src/shared/services.ts` opens by
saying why:

> The gateway holds the reverse map internally but exposes no route over it, so
> the user binds it here, once per scope.

That sentence was true when it was written on 2026-09-10. It stopped being true
on 2026-09-11, and this slice is the consequence.

## 2. What changed upstream

`GET /v1/services/resolve?repo=<urn>` — Nimbus#1491, landed 2026-09-11,
**released in gateway v7.19.0**. It answers exactly the question C10.1 could not
ask:

```json
{ "service": "checkout", "ambiguous": false, "candidates": ["checkout"] }
```

Four properties of it are load-bearing here, and each one shapes a decision
below:

1. **It is bearer-authed under the `resolve` scope** — the same scope
   `resolveFile` (C7) and `resolveIds` (C9) already use. No new scope, and no
   re-pairing for anyone those slices already work for. But `resolve` is **not**
   in `LEGACY_SCOPES` (`clips/api-scopes.ts`: `["clip", "briefs"]`), so a
   browser paired before scopes existed gets a 403, cleared with
   `nimbus clip scopes`.
2. **The key set is total.** `ambiguous` and `candidates` are present on every
   answer, including the null one, and `ambiguous` is derived from the candidate
   count rather than sent alongside it — so the two can never disagree, and a
   client cannot mistake "this gateway does not disclose ambiguity" for "this
   binding is uncontested".
3. **The match is an exact string comparison.** `resolveServicesByRepoUrn`
   tests `u.provider === query.provider && u.providerId === query.providerId`
   against the URNs in the owner's `nimbus.toml`. Nothing is normalised — not
   case, not coordinate form.
4. **Its 404 names a gate, not the route.** Upstream says so in the handler:
   `services_disabled` tests that the *clips surface is mounted*, not that the
   route exists, so a gateway too old to carry it and a new one with no paired
   client surface answer identically. A client cannot tell them apart. Benign —
   both readings lead to the same fallback — but it is why §5 stays silent
   there rather than reporting a cause it would have to guess at.

Upstream's own comment describes this route as scoped "rather than public beside
**the two routes it feeds**" — `/v1/preflight/deploy` and `/v1/metrics/dora`.
It was built for this client's problem. Adopting it is the intended move, not an
opportunistic one.

### 2.1 The invariant between `service` and `candidates`

Read off `resolveServicesByRepoUrn` and the handler that serialises it, because
the example body above does not show it and the wrong guess here is natural:

```ts
return { serviceId: claimants[0] ?? null, candidateServiceIds: claimants };
```

- **When `ambiguous` is true, `service` is `candidates[0]` — never `null`.** The
  gateway does not withhold a pick when several services claim the repo; it
  offers the first and discloses the rest. An implementer who assumed
  `ambiguous ⇒ service === null` would write a dead branch and seed an empty
  input on the one outcome that has the most to offer.
- **`service === null` if and only if `candidates` is empty.** `serviceId` is
  `claimants[0]`, so there is no answer in which the service is null and a
  candidate exists.

The client therefore seeds from `service` in **both** the single and ambiguous
cases, and `candidates` only ever adds the alternatives. `ambiguous` is not
read as a separate condition — `candidates.length > 1` is the same fact,
derived at the source (§2(2)) — but it is asserted in the guard, because a body
where the two disagree is a gateway this client does not understand.

### 2.2 Status mapping

`fetchServiceResolution` mirrors `egress-client.ts`'s ladder exactly rather than
inventing names for the same statuses — that client is the established
precedent for a scoped read here:

| Status | Outcome |
| --- | --- |
| 200 | parsed, or `server_error` when the guard rejects the body |
| 401 | `unauthorized` |
| 403 | `insufficient_scope`, with the parsed `scopeGap` when there is one |
| 404 | `unsupported` |
| 429 | `rate_limited` |
| anything else | `server_error` |

The 429 arm is carried for the same reason `egress-client` carries one on reads
that are not themselves rate-limited: the server has an
`HttpWriteRateLimiter` and does answer 429 on at least one route
(`/v1/egress/prove`), so a client that cannot represent the status would report
it as `server_error` and say something false. §7 is where it becomes visible.

## 3. The URN — how a scope becomes a repo coordinate

`parseDoraRepoUrn` takes `provider:providerId` and refuses any provider outside
`KNOWN_PROVIDERS`: `github`, `gitlab`, `bitbucket`, `jenkins`, `circleci`.

The client's binding-capable products are **exactly those five**, spelled
identically. `PRODUCT_IDS` carries nine, but only these five ever produce a
binding: a binding is keyed by `Recognition.scope`, and only `bitbucket.ts` /
`circleci.ts` / `github.ts` / `gitlab.ts` / `jenkins.ts` set one. The other four
(`confluence`, `jira`, `linear`, `pagerduty`) never reach this code — deploy
readiness mounts only on `pr` and `build` (`DEPLOY_SURFACES`), and neither
surface exists for them.

So `src/shared/services.ts` gains:

```ts
/** The `parseDoraRepoUrn` provider a product's scope is a coordinate for, or
 *  `null` for a product that never carries a scope. */
const URN_PROVIDER: Record<Product, string | null> = { /* … */ };

export function repoUrn(product: Product, scope: string): string | null;
```

A **`Record`, not a `switch`**. A switch whose arms return `string | null` fails
silently when a tenth product is added — the new key just answers `undefined`,
which reads as "no provider" and produces no error anywhere. A `Record` keyed by
`Product` is a compile error until the new product is spelled. This also avoids
a `satisfies never` backstop, whose two unreachable lines would be permanently
uncovered new code in the coverage gate.

`URN_PROVIDER` stays **module-private**. `repoUrn` is the only reader, and the
tests reach the mapping through it — an exported table invites a second caller
to read the provider for its own purposes and re-derive the URN slightly
differently, which is the one thing this function exists to prevent.
`repoUrn` also returns `null` for a scope that is blank or over `MAX_SCOPE_LEN`
after trimming, so an unsendable coordinate never becomes a query. Trimming is
correct rather than incidental: upstream's `coordinateParam` trims `?repo=` for
this route specifically, unlike `resolve-file`'s `refAndPath`, where a path's
own whitespace is real.

### 3.1 A known, deliberate limitation

Because the comparison in §2(3) is exact, `service: null` does **not** prove the
repo is unconfigured. It proves only that no configured service spells it the
way this client just did. Three real ways that happens:

- **Case.** GitHub treats `Acme/Web` and `acme/web` as one repo; this
  comparison does not.
- **Bitbucket Server.** The recogniser's scope is `projectKey/slug`, which is
  not necessarily the coordinate form the owner wrote.
- **Jenkins.** The scope is a job path, and whether an owner spells
  `jenkins:<job path>` the same way is not something this client can verify.

This is not fixed here, and it must not be papered over. It is the entire reason
§5.2's `null` note is worded the way it is, and the reason the guess survives as
the seed in that case rather than being replaced by an empty input.

## 4. Where the resolution is asked

**In the service worker, inside `handleDeployPreflight`'s existing `unbound`
arm.** Not in the panel.

Two reasons, and the first is not negotiable:

- The bearer token lives in the worker and never enters a page. A panel-side
  fetch would need the token in the content script, which is the one thing the
  architecture forbids outright.
- The seam already exists. `DeployPreflightResponse`'s `unbound` arm already
  carries `guessServiceId?: string`, and `renderBindFormState(guess, note?)`
  already takes a seed plus an optional note. The seeding half of this feature
  therefore needs **no new message and no new panel round trip** — only a wider
  payload on an arm that is already there.

This is also the first **bearer-authed** read in the deploy family:
`preflightDeploy` and `items` are both on the gateway's public table. The family
gains the §2.2 outcomes it did not have, which §5 renders.

### 4.1 `DeployDeps` gains a token, by swapping `getOrigin` for `getConnection`

Today `DeployDeps` exposes `getOrigin: () => Promise<string | null>` — an
address and nothing else, which is all two public routes need. A bearer read
needs the token, and a 403 needs the device **label** as well: the pasteable
`nimbus clip scopes <label> --set …` command cannot be built without it, and the
403 body cannot carry it because the label is client-side state.

So `getOrigin` is **replaced** by `getConnection: () => Promise<Connection |
null>`, which is exactly what `EgressDeps` already does
(`egress-handlers.ts:26`). It is a superset, not a new dependency: `getOrigin`'s
own doc comment says the address is learned from the pairing, so every caller
that had an origin had a connection. One dep, not two, and no second way to ask
the same question.

The 403 path then reuses the existing machinery rather than a private copy:
`parseScopeGap` from `http-json.ts` — whose header records that three
hand-rolled copies of this parser once drifted — and `withLabel(conn.label,
gap)` from `egress-handlers.ts`, so `scopeCommand` can build the command. Note
`parseScopeGap`'s rule, which applies unchanged here: a gap parsed from a
partial body would build a `--set` command that silently **revokes** scopes the
token already has, so nothing short of the full shape may produce one.

### 4.2 The outcome is a structured union, never prose

The worker returns a discriminated union; `deploy-view.ts` owns every English
string. This is the layering the whole repo keeps — pure views hold the
wording, handlers hold the decision — and it is worth stating because the
tempting shortcut is to have the worker return the note it already knows.

```ts
export type ServiceResolutionOutcome =
  | { readonly kind: "resolved"; readonly serviceId: string }
  | { readonly kind: "ambiguous"; readonly serviceId: string;
      readonly candidates: readonly string[] }
  | { readonly kind: "unclaimed" }
  | { readonly kind: "forbidden"; readonly scopeGap?: ScopeGap }
  | { readonly kind: "silent" };
```

`ambiguous` carries `serviceId` alongside the candidates, per §2.1 — the seed is
the gateway's own first pick in both answering cases, so the view never has to
reach into `candidates[0]` itself.

`silent` folds 404, `unauthorized`, `rate_limited`, `unreachable` and
`server_error` together **at the response boundary**, because §5.1 renders them
identically. The distinctions are not lost — they exist on the client's own
result type (§2.2) and §7 reads them — they are merely not carried into a
panel that would say nothing with them.

And the `ok: false` arm is **split**, rather than widened with more optionals:

```ts
| { kind: "deploy-preflight"; ok: false; reason: "unbound";
    guessServiceId: string; resolution: ServiceResolutionOutcome }
| { kind: "deploy-preflight"; ok: false;
    reason: Exclude<DeployRefusal, "unbound"> }
```

`resolution` is then present exactly when `reason === "unbound"`, checked by the
compiler instead of by a convention. `guessServiceId` becomes **required** on
that arm in the same move: `guessServiceId(scope)` returns `string`, never
`undefined`, so the optional marker only ever forced a `?? ""` at the one call
site that reads it.

## 5. What the bind form says

### 5.1 The five outcomes

One seed rule, five notes:

| `ServiceResolutionOutcome` | Input seeded with | Note |
| --- | --- | --- |
| `resolved` | `serviceId` | Nimbus maps this repo to it |
| `ambiguous` | `serviceId` (§2.1) | the candidates, as pickable options |
| `unclaimed` | today's guess | no configured service *names this repo* (§5.2) |
| `forbidden` | today's guess | names the missing scope and the pasteable `nimbus clip scopes` command |
| `silent` | today's guess | **nothing** — today's behaviour, unchanged |

The last row is the compatibility contract, and it is exact: on a gateway that
cannot answer, this feature is invisible and the section behaves as C10.1
shipped it. No version floor, no capability probe — the route's answer, or its
absence, is the whole signal. That is the pattern C7's file lanes and C9's links
both followed.

`config_unreadable` (500) maps to `server_error` and therefore to `silent`. It
means the owner's `nimbus.toml` does not parse — real, but not something this
panel can say anything useful about, and upstream deliberately strips the
parser's message before it crosses the wire because it embeds config values.

`unauthorized` (401) is in `silent` rather than beside `forbidden`, and the two
are not the same sentence: a 403 means this token lacks a scope the owner can
grant in place, which is actionable and named; a 401 means the token is not
accepted at all, which the pairing surfaces already report and which the deploy
section is the wrong place to re-litigate.

### 5.2 Why `null` must not claim the repo is unconfigured

Given §3.1, the note for `null` states what was actually established — that no
configured service **names this repo by this coordinate** — and never that the
repo is unconfigured, that DORA is not set up, or that the user should go add a
service. A confident wrong sentence here is worse than the guess it replaced:
the user would go edit a config that is already correct, when the real fault is
a spelling this client cannot see.

The guess stays in the input for the same reason. `null` is not evidence against
the guess.

### 5.3 Ambiguity

`candidates.length > 1` means two or more `[metrics.dora.*]` blocks name this
repo. The client does not pick for the user and does not hide the others: the
gateway's own `service` is seeded so the form is submittable (§2.1 — the client
does **not** index into `candidates` to find it), and the rest render as
pickable options that rewrite the input. Choosing one goes through the ordinary
submit path, so §6 applies unchanged.

The options are real `<button type="button">` elements in a container carrying
`role="group"` and an `aria-label`. Deliberately **no** `tabindex` and **no**
key handlers: a button is already focusable and already activates on Enter and
Space, so adding either re-implements native behaviour — and a keydown handler
beside the native activation is how one click becomes two.

## 6. Binding validation is unchanged

`handleServiceBind` is **not** touched. The two routes answer different
questions:

- `services/resolve` — *which service claims this repo?* It proposes an id.
- `preflight/deploy` — *is this id known?* It validates one.

A user who overrides the seed with their own id is proposing something the
resolve route was never asked about, so the existing preflight probe — and its
`unknown_service` refusal — remains the only thing that decides whether a
binding is saved. "A binding is never saved unverified" survives this slice
intact.

## 7. Options — checking what is already stored

A stored binding goes stale silently when the owner edits `nimbus.toml`.
`deploy-handlers.ts` already names this failure — "a stored wrong id produces a
permanently confusing section" — and until now nothing could detect it. Now
something can.

A **new message**, `service-bindings-check`, separate from
`service-bindings-list`. They are not merged: `list` is a local read that works
offline and costs nothing, and it is what paints the table. `check` costs one
request per binding and needs a paired, `resolve`-scoped gateway. Folding a
network cost into the read that renders the page would make the table's normal
path slower and failable for a check the user did not ask for.

The worker resolves every stored binding through **`Promise.allSettled`** —
never `Promise.all`, which would let one failure discard every good answer, the
same rule C10.2's three windows follow — and classifies each row:

| State | Meaning |
| --- | --- |
| `agrees` | the gateway names the same id |
| `disagrees` | the gateway names a **different** id — the staleness case |
| `unclaimed` | `service: null` (with §5.2's wording, again) |
| `ambiguous` | more than one claimant |
| `unchecked` | every §2.2 outcome that is not an answer, carrying which one |

`disagrees` offers a one-click correction, which submits through the **existing
bind path** so §6's validation still applies — the gateway's newer answer is
proposed, not trusted blindly. `unchecked` says *could not check*, never
*wrong*: a 403 is a fact about this browser's token, not about the binding. It
keeps the §2.2 reason rather than collapsing to one state as §4.2's `silent`
does — this is the surface where the difference between "your token lacks
`resolve`", "this gateway has no such route" and "the gateway is rate-limiting"
is worth the words, because the user came here to manage bindings.

### 7.1 The check is user-initiated

A button above the table, not a fetch on page load. Options opens for many
reasons — pairing, surfaces, shortcuts, the brief log — and none of them should
spend one request per binding against a gateway that may not be running. The
button is disabled while unpaired and while a check is in flight; rows show
their own progress. The rendering detail beyond that (badges, wording, tooltip
copy) is the implementation plan's, not this spec's.

### 7.2 Fan-out is unbounded, deliberately, for now

`Promise.allSettled` over every binding, with no concurrency pool. Two facts
support that and one argues against it, so it is recorded rather than assumed:

- The destination is loopback, and this route is a **read** — the gateway's only
  rate limiter is `HttpWriteRateLimiter`, and the only 429 on this server is
  `/v1/egress/prove` (10 per 60s). Nothing throttles this route today.
- Bindings are one per `(origin, product, scope)` and are created by hand, one
  page at a time. A handful is the realistic count.
- Against: the handler **reads and parses `nimbus.toml` on every call**, left
  uncached upstream on purpose so it can never answer from a config the owner
  has since fixed. So N bindings is N parses, concurrently.

A pool is therefore deferred as unbuilt complexity, not rejected. If a user with
tens of bindings reports a slow or failing check, the fix is a small pool here —
and the 429 arm from §2.2 already exists to classify the outcome if the server
ever does throttle a read.

## 8. The clients and the message envelopes

- `src/shared/gateway.ts` — `servicesResolve: "/v1/services/resolve"`, with
  §2's four properties recorded in its doc comment. `GATEWAY_PATHS` remains the
  single list.
- `src/shared/services.ts` — `repoUrn` and `URN_PROVIDER` (§3); the opening
  comment's "exposes no route over it" sentence is **rewritten**, since it is
  now false.
- `src/shared/deploy.ts` — `ServiceResolution` (`service: string | null`,
  `ambiguous: boolean`, `candidates: readonly string[]`) and
  `parseServiceResolution`.
- `src/background/deploy-client.ts` — `fetchServiceResolution(origin, token,
  urn, doFetch)`, over `http-json.ts`'s `readJson` / `isObject` /
  `parseScopeGap`, with §2.2's ladder.
- `src/background/deploy-handlers.ts` — `DeployDeps.getConnection` replacing
  `getOrigin` (§4.1), the split `unbound` arm (§4.2), and
  `handleServiceBindingsCheck` (§7).
- `src/shared/messages.ts` — `ServiceResolutionOutcome`, the split
  `DeployPreflightResponse` arms, `service-bindings-check` and its response.

### 8.1 The guards validate rows, not shapes

Stated because the obvious guard is the wrong one here, and this repo has been
bitten by this class before — a guard that accepts `string` for a closed union,
or that checks a container and passes its contents through unvalidated:

- `parseServiceResolution` bounds every id it returns by `MAX_SERVICE_ID_LEN`,
  `service` and each candidate alike. An id longer than the gateway's own bound
  can never be sent back to it, so it must not be readable back as though it
  could — the rule `isServiceBinding` already applies to stored bindings.
- A member that fails **rejects the whole body**; it is not filtered out.
  `parseScopeGap` is the precedent and the reasoning transfers: a partially
  accepted body silently changes what the client believes the gateway said.
  Rejecting yields `server_error`, which §5.1 renders as `silent` — the guess,
  and no false sentence.
- It asserts §2.1's invariant rather than trusting either field alone:
  `ambiguous === candidates.length > 1`, and `service === null` exactly when
  `candidates` is empty.
- `isServiceBindingsCheckResponse` validates **each row** — the binding through
  `isServiceBinding`, the status `state` against the closed set, and
  `unchecked`'s `reason` against its own — never `Array.isArray(results)` alone
  and never `typeof reason === "string"`, both of which type-narrow far more
  than they actually check.
- `src/panel/deploy/deploy-view.ts` / `deploy-section.ts` — the notes and the
  candidate picker (§5).
- `src/options/` — the per-row check state and its correction action (§7).

## 9. Slices

- **S1 — the seed.** §3, §4, §5, and the gateway/client/message half of §8. The
  decision-shaped part, and the one that has to prove the `null` wording.
- **S2 — the check.** §7 and the Options half of §8, reusing S1's client and
  guard.

S1 is shippable alone and carries the whole user-facing claim; S2 is additive.

## 10. Testing, and the gates that will fire

Unit (Vitest): `services.test.ts` gains `repoUrn` (every product, including the
four `null` ones); `deploy-client.test.ts` gains `fetchServiceResolution` —
every outcome, the malformed body, and the total-key-set assumption;
`deploy-handlers.test.ts` gains the widened `unbound` arm and the check
classifier; `deploy-view.test.ts` / `deploy-section.test.ts` gain the five notes
and the candidate picker (jsdom via docblock).

E2E: `test/e2e/deploy-readiness.e2e.ts` extends rather than forks.
**`scripts/screenshots/mock-gateway.ts`** — not `scripts/mock-gateway.ts`, which
does not exist — must gain `GET /v1/services/resolve`, or neither the suite nor
the store screenshots have anything to answer it. It is also covered by
`test/unit/mock-gateway.test.ts`, so the route arrives with a unit test whether
or not one is written for it deliberately.

Its handler is `handleRequest`, which **returns a `Response`** (`jsonResponse`
is the helper); the `node:http` import is the listener in `serve`, not the
routing style. A branch written as `res.writeHead(...)` / `res.end(...)` does
not belong in that function. Fixtures need at minimum: a single claimant, an
ambiguous one, a `null` with `candidates: []` (§2.1), a 403 carrying a real
`{ required, granted }` gap so the pasteable command can be exercised, and the
404 default.

Gates that fire:

- **`build-artifacts.test.ts`** — untouched. No new build entry; this adds no
  page.
- **`store-listing.test.ts`** — expected green. Loopback only;
  `host_permissions` and `optional_host_permissions` are both unchanged. If that
  stops being true, `store/listing.md`'s permission justifications change in the
  same commit.
- **`e2e-coverage.test.ts`** — a new `COVERS` id needs its matching
  `<!-- e2e:<id> -->` marker in `development.md`.
- **`doc-references.test.ts`** — ROADMAP's link to this spec must resolve, and
  `docs/superpowers/plans/` must stay empty.

## 11. Before this spec is pruned

Durable content moves to `docs/architecture.md` **before** this file is deleted:

- §3.1 — the exact-comparison limitation and its three causes. This is the one
  most likely to be re-discovered painfully, as a bug report that the panel
  "says the repo isn't configured when it is".
- §2.1 — that `ambiguous` still carries a non-null `service`, and that
  `service: null` implies empty `candidates`. Not visible in any example body,
  and the natural wrong assumption produces a dead branch.
- §4 — why the resolution is asked in the worker, and that the `unbound` arm is
  the seam.
- §4.1 — why `DeployDeps` takes a whole `Connection` rather than an origin plus
  a token, and that the label exists for `scopeCommand`.
- §5.1's silent row and §2(4) — why there is no version floor, and why the 404
  cause is not reported.
- §6 — that `resolve` proposes and `preflight` validates, and that adopting the
  first did not weaken the second.
- §7 — why `list` and `check` are two messages.

`ROADMAP.md` gains the C10.3 brief; `CHANGELOG.md`'s `[Unreleased]` records the
user-facing half as each slice lands.
