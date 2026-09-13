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
gains a `forbidden` outcome it did not have, which §5 renders.

## 5. What the bind form says

### 5.1 The five outcomes

One seed rule, five notes:

| Gateway answer | Input seeded with | Note |
| --- | --- | --- |
| one service | that id | Nimbus maps this repo to it |
| `ambiguous` (candidates > 1) | first candidate | the candidates, as pickable options |
| `service: null` | today's guess | no configured service *names this repo* (§5.2) |
| 403 | today's guess | names the missing scope and `nimbus clip scopes` |
| 404 / unreachable / malformed | today's guess | **nothing** — today's behaviour, unchanged |

The last row is the compatibility contract, and it is exact: on a gateway that
cannot answer, this feature is invisible and the section behaves as C10.1
shipped it. No version floor, no capability probe — the route's answer, or its
absence, is the whole signal. That is the pattern C7's file lanes and C9's links
both followed.

`config_unreadable` (500) maps to `server_error` and therefore to the silent
row. It means the owner's `nimbus.toml` does not parse — real, but not something
this panel can say anything useful about, and upstream deliberately strips the
parser's message before it crosses the wire because it embeds config values.

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
first is seeded so the form is submittable, and the rest render as pickable
options that rewrite the input. Choosing one goes through the ordinary submit
path, so §6 applies unchanged.

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
| `unchecked` | 403 / 404 / unreachable / malformed |

`disagrees` offers a one-click correction, which submits through the **existing
bind path** so §6's validation still applies — the gateway's newer answer is
proposed, not trusted blindly. `unchecked` says *could not check*, never
*wrong*: a 403 is a fact about this browser's token, not about the binding.

## 8. The clients and the message envelopes

- `src/shared/gateway.ts` — `servicesResolve: "/v1/services/resolve"`, with
  §2's four properties recorded in its doc comment. `GATEWAY_PATHS` remains the
  single list.
- `src/shared/services.ts` — `repoUrn` and `URN_PROVIDER` (§3); the opening
  comment's "exposes no route over it" sentence is **rewritten**, since it is
  now false.
- `src/shared/deploy.ts` — the resolve envelope type and its guard.
- `src/background/deploy-client.ts` — `fetchServiceResolution`, over
  `http-json.ts`'s `readJson` / `isObject`, mapping 403 → `forbidden`,
  404 → `unavailable`, 500 → `server_error`.
- `src/background/deploy-handlers.ts` — the widened `unbound` arm (§4) and
  `handleServiceBindingsCheck` (§7).
- `src/shared/messages.ts` — the widened `DeployPreflightResponse` `unbound`
  arm, plus `service-bindings-check` and its response.
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
`scripts/mock-gateway.ts` **must** gain `GET /v1/services/resolve`, or neither
the suite nor the store screenshots have anything to answer it.

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
- §4 — why the resolution is asked in the worker, and that the `unbound` arm is
  the seam.
- §5.1's silent row and §2(4) — why there is no version floor, and why the 404
  cause is not reported.
- §6 — that `resolve` proposes and `preflight` validates, and that adopting the
  first did not weaken the second.
- §7 — why `list` and `check` are two messages.

`ROADMAP.md` gains the C10.3 brief; `CHANGELOG.md`'s `[Unreleased]` records the
user-facing half as each slice lands.
