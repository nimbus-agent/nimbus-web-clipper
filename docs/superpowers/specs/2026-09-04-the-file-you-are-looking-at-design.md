# C7 — the file you are looking at, and the C6 close-out

**Status:** design, approved 2026-09-04.
**Supersedes §5 and §5.4** of
[`2026-08-31-lanes-for-every-recognised-page-design.md`](./2026-08-31-lanes-for-every-recognised-page-design.md)
where the two disagree. That document remains the authority on C6 §4 and on
§6's two remaining lanes.

---

## 1. What this delivers

Two things, in one branch, because the second is what the first's reading proved
was owed.

- **C7 — lanes on a source file.** A GitHub, GitLab or Bitbucket file page gains
  three agent lanes — `impact`, `expert` and `ownership` — answered about the
  file the page shows, resolved against the reader's own checkout by the
  gateway. A file the gateway cannot place gets one honest sentence and no
  lanes. **Three, not the five §5.3 named:** `ghost` and `conflicts` cannot
  answer under the forge arm at all, and §4.7 records why.
- **The C6.1 close-out.** Upstream shipped the two things C6.1 was waiting on.
  The client's floor now arms itself, `expert` on a pull request can finally
  send the arm its label promises, and roughly a dozen sentences across the
  repo that assert the old upstream state have to stop saying it.

---

## 2. What upstream shipped, and what it did not

C6.1 and §5 were both written against an upstream that has since moved. Three
facts, verified against `Nimbus/origin/main` on 2026-09-04 (gateway `7.8.1`):

| Fact | Where | Release |
| --- | --- | --- |
| The forge file arm `{ service, repo, refAndPath }` | `agents-rpc.ts`'s `requireFileParam` | **v7.6.0** (Nimbus#1424) |
| `version` on the `GET /v1/agents` roster | `http-server.ts:867`, `json({ agents, version: GATEWAY_VERSION })` | **v7.7.0** (Nimbus#1428) |
| A route that resolves a forge coordinate | — | **does not exist** |

The first two unblock what they were meant to. The third is the gap this design
closes, and it is not the gap §5 thought it had.

### F1 — the miss discriminant shipped as prose, not as a field

§5.4 asserted that upstream "returns these as a **typed discriminant**, not
prose, so the panel branches on a value rather than matching on a sentence that
a later improvement to the wording would break."

`resolve-file-by-remote.ts` does model it exactly that way —
`{ ok: false, reason: "remote_not_tracked" | "file_not_indexed", repo }`. But
nothing exposes that shape. `requireFileParam` flattens it into a JSON-RPC
error:

```ts
throw new AgentsRpcError(-32602, `${resolved.reason}: \`${repo}\` — no file to answer about`);
```

which reaches an HTTP caller as `400 { error: "invalid_params", detail: "<that
string>" }`. Upstream's own comment says the client is meant to read the reason
off the front of the message. So the discriminant survives, as a **prefix of a
prose string** — which is the thing §5.4 named and refused.

### F2 — nothing resolves a file without running an agent

§5.4 also required the panel to resolve the file **once** before offering any
lane, rather than have each lane discover the same miss independently. That was
right, and it had nothing to call.

The v1 surface is twenty routes and none of them resolves a forge coordinate.
`GET /v1/items/resolve` takes a `url` and runs `resolveItemByUrl` — the indexed
item resolver; a blob URL misses it. Resolution happens **only inside an agent
invoke**, so learning whether a file is answerable costs a real agent run and an
egress row for a question the user did not ask.

F1 and F2 have one cause and therefore one fix.

### F3 — `ghost` and `conflicts` are federation-only, so the forge arm can never answer them

§5.3 made these two "new members of `AGENT_LANES`", `file`-only, and asked for a
test pinning that the client sends no `namespaces`. Both agents are structurally
incapable of answering without them.

`conflicts.ts` builds its entire `collisions` array inside
`input.namespaces.map(ns => fanOutQuery(...))`. With `namespaces: []` the map is
empty, the loop never runs, and `collisions` is `[]`. `ghost.ts` is subtler and
ends in the same place: `fanOutExpertise` runs without namespaces, so
`rankByPeer` can be non-empty — but each finding's `context` comes only from the
namespaced `fanOutQuery`, and `if (context.length === 0) continue` drops every
one. `findings` is `[]`.

And the forge arm **refuses** namespaces outright:

> `namespaces are not accepted with a forge coordinate — that shape answers locally only`

So there is no input a browser can send that makes either lane produce a row.
Not "usually empty" — empty by construction, permanently, on every gateway. The
SDK's own types say the same thing more quietly: `GhostFinding` and
`ConflictFinding` are both keyed by `peerId`, because both are federation
results.

`impact`, `expert` and `ownership` are unaffected — none of the three mentions
`namespaces`; all answer from the local graph.

This is the bound §5 already drew twice and did not apply to itself: the
Confluence `doc` case ("a permanently empty answer under a header that looks
like every other lane") and #76's rule ("a lane that will answer nothing is
worse than no lane, because the empty answer reads as *there is nothing*, not as
*I cannot see*"). C7 therefore ships **three** lanes.

### F4 — `needsItemArm` is a cross-product, and only a *floored* `expert` switch breaks it

`agents-capability.ts` computes the arm gate as
`ITEM_ARM_LANES × ITEM_ARM_SURFACES` — `{why, expert, ownership}` ×
`{issue, incident}`. Its doc comment correctly explains why the arm table cannot
be derived from `LANE_RULES`; it did not anticipate the arm table itself needing
pair granularity.

A *floored* switch of `expert` on `pr` would require flooring that one pair. Add
`pr` to `ITEM_ARM_SURFACES` and the cross-product also floors **`why` on `pr`**,
which sends `prUrl` — an arm every released gateway has served.

§5.2 chooses not to floor it, so **the cross-product is not forced to change by
the withholding gate**: `needsItemArm("expert", "pr")` must stay `false`, or
`offeredLanes` would withhold the very lane §5.2 promises never to withhold.

What *does* change is subtler, and it is why §5.1 still refactors. The table's
own doc comment says it is read by two callers asking "the same question" —
`offeredLanes` (withhold?) and `agentParams` (which arm?). After §5.2 those stop
being the same question for exactly one pair: `expert`/`pr` is never withheld
*and* sometimes sends `itemUrl`. Letting `agentParams` special-case that with
its own `meetsFloor` call is precisely the second copy the comment warns
against.

---

## 3. The upstream route

Proposed in the Nimbus repo, in its own worktree, in parallel. **The client work
in §4 does not wait on it**; only the miss banner and the lane gate do.

```
GET /v1/items/resolve-file?service=&repo=&refAndPath=     scope: resolve

  hit  → 200 { ok: true, path: "src/foo.ts" }
  miss → 200 { ok: false, reason: "remote_not_tracked" | "file_not_indexed", repo: "acme/web" }
```

It is a thin read over `resolveFileByRemote`, which already exists and already
returns this shape. Three choices in it, each deliberate:

- **`repoRoot` is never returned.** `ResolveFileResult` carries it and this
  route drops it. It is the reader's local filesystem path, and this route is
  reachable by any holder of a clipper token over HTTP. `path` is repo-relative
  — safe, and useful: it is precisely the ref/path split the browser could not
  perform. A local root is a disclosure with no client use.
- **The `resolve` scope, not `agents`.** It resolves; it runs nothing. A browser
  paired without the `agents` scope then gets an honest miss banner rather than
  a 403, and the route sits under the same gate as `GET /v1/items/resolve` next
  door.
- **No egress row**, matching `/v1/items/resolve`. Nothing leaves the machine,
  so nothing belongs in the ledger of what did.

The agent-invoke path keeps its `-32602` unchanged, for the terminal surface and
for any client that skips the probe. This route is additive; it deprecates
nothing.

---

## 4. C7 — the client

### 4.1 · Most of it already landed

PR #94 shipped C7's groundwork while building C6, and §5 predates that. Already
built: the `file` `SurfaceKind`; all three forge matchers emitting
`Match.forgeFile` with the opaque `refAndPath`; the `file` `LaneScope`; the
`file` `RunSubject` and its key in `subjectValue`; `resolveForAgent`'s
`scope: "file"` return arm; and `agentParams`' forge arm, which returns before
the per-lane switch because every file lane sends the same shape.

**That groundwork is not wired end to end, and reads as though it were.** Three
gaps, all of them currently unreachable — `LANE_RULES` has no `file` entry, so
`laneBelongsOnSurface(lane, "file")` is false for every lane and nothing gets
that far — and all three become live the moment §4.3 adds one:

1. **`recognise()` drops `forgeFile`.** `Match` carries it; the `Recognition`
   the function returns has no such field, so the coordinate is discarded at the
   boundary. `Recognition` must carry it and `isRecognition` must validate it.
2. **`resolveForAgent` has no `file` branch.** After the `home` branch it falls
   straight through to `deps.resolveItem`. Adding the lane-table entries without
   the branch does not fail — it sends a **blob URL to the item resolver**, which
   is the "resolving a file as an item" mistake the `file` scope exists to
   prevent. This is a trap, not an omission: the type system is satisfied either
   way.
3. **`isRunSubject` omits `file`.** `subjectValue` handles the `file` arm and
   the storage guard does not, so the store typechecks while silently
   discarding every persisted file run on read.

What remains is therefore those three, plus the lane table, the probe, and the
panel.

### 4.2 · The route is the capability signal — there is no second floor

The obvious move, following C6.1's precedent, is a `FILE_ARM_FLOOR = "7.6.0"`
mirroring `ITEM_ARM_FLOOR`. **Do not add one.**

`ITEM_ARM_FLOOR` exists because `GET /v1/agents` lists agent *names*, not their
*arms*, so a roster cannot say whether `why` accepts an item URL. That reasoning
does not transfer here. `GET /v1/items/resolve-file` ships in a release strictly
after 7.6.0, so **its presence proves the forge arm exists**. The panel has to
call it anyway. A direct capability probe beats a version string, and it cannot
drift the way a floor constant needs raising.

So the gate is the probe's own outcome, in four states that must never collapse
into fewer:

| Probe | Lanes | Banner |
| --- | --- | --- |
| `200 { ok: true }` | all three offered | — |
| `200 { ok: false, reason }` | none | the reason's sentence |
| `403 insufficient_scope` | none | the existing scope guidance, with its `nimbus clip scopes` command |
| `404` / unreachable | none | — |

The `403` row is not a detail. `LEGACY_SCOPES` is `["clip", "briefs"]`, so
**every browser paired before scopes existed lacks `resolve`** and lands there
first. Collapsing it into the silent row would show that population a recognised
file page with no lanes and no explanation, when one command fixes it. This is
the same 403 `resolveItem` already maps to `insufficient_scope` with a
`scopeGap`; choosing the `resolve` scope for the route (§3) is what makes the
probe inherit that path rather than invent a second one.

The last row is byte-identical to how a file page renders today, because the
`file` surface offers zero lanes now. The rule C6.1 established — *not knowing
must leave the panel exactly as it renders without the read at all* — is
therefore satisfied for free, by a route that did not exist, rather than by a
floor that would need maintaining.

C7 consequently never reads `roster.version`, and `ITEM_ARM_FLOOR` stays the
only floor in the file.

### 4.3 · The lane table

**`AGENT_LANES` does not change.** Per F3, `ghost` and `conflicts` stay out.

`LANE_RULES` gains one key each on three existing lanes:

```ts
impact:    { input: "page", surfaces: { pr: "item", file: "file" } },
expert:    { input: "page", surfaces: { pr: "item", issue: "item", incident: "item", file: "file" } },
ownership: { input: "page", surfaces: { home: "service", issue: "item", incident: "item", file: "file" } },
```

The `AGENT_LANES` doc comment currently explains that `ghost` and `conflicts`
are absent "because both require `{ file }` — a local checkout the browser does
not have". The conclusion survives and **the reason does not**: the forge arm is
exactly how a browser names a file it has no checkout of, so that sentence would
now be read as an obstacle already removed — an invitation to add them. Replace
it with F3's reason, which is permanent: both are federation-only, and the arm
that lets a browser name a file is the same arm that refuses the namespaces they
need.

### 4.3.1 · Titles

`LANE_TITLES` is written for a pull request; `SURFACE_LANE_TITLES` holds the
per-surface exceptions. `file` needs all three, since none of the shipped
phrasings is true of a file:

```ts
file: {
  impact: "What breaks if this changes",
  expert: "Who knows this file",
  ownership: "Who owns this",
},
```

`ownership` repeats `ITEM_SURFACE_TITLES`' wording, and gets its own entry
rather than sharing that object: `issue` and `incident` share one literal
because they are the same question about the same kind of thing, and a file is
not. Identical words today, independent reasons to change.

### 4.4 · Where the probe lives

In `handleResolve`, which the panel already calls once per page. **Not** in
`resolveForAgent`, whose `file` arm makes no call today and must keep making
none — the probe is a page-level fact, not a per-lane one. That is §5.4's "one
resolution, not five", landing in the code that already resolves once rather
than in a new mechanism beside it.

The resolve response carries the probe's outcome alongside `offeredLanes`.

**Concurrent with the roster read**, matching both existing branches:

```ts
const [file, offered] = await Promise.all([
  deps.resolveFile(conn.origin, conn.token, /* service, repo, refAndPath */),
  offeredFor(deps, conn.origin, conn.token, "file"),
]);
```

The reason is the one already written beside the other two: `offeredFor` reads
nothing the probe produces, and serialising them stacks the roster's 10s bound
behind the probe's before a header can render. Neither read may move above the
`getConnection()` null check — both carry the bearer token.

### 4.5 · The two sentences

Branched on the value, never on the prose:

- `remote_not_tracked` — Nimbus has no local checkout of `acme/web`, so it
  cannot answer about its files. Permanent, and nothing the reader can do from
  this page.
- `file_not_indexed` — the checkout exists and this path is not in it. A
  different situation with a different remediation.

Neither renders three empty lanes. This is #76's connector-health rule: a lane
that will answer nothing is worse than no lane, because an empty answer reads as
*there is nothing* rather than *I cannot see*.

**A file miss gets its own `HeaderState` arm — it must not reuse `not-indexed`.**
`offersCapture` returns `true` on `not-indexed` when `fetchable` is false, and
`panel-in-page.ts` already collapses `unresolvable` into `not-indexed`. Reusing
it would put *"Save a copy to Nimbus"* under a miss sentence — and clipping a
forge's rendered blob page gives Nimbus neither a checkout nor an indexed
repository, so the offer is false. A new arm:

```ts
| { readonly kind: "file"; readonly surface: string; readonly banner?: string }
```

`offersCapture` needs no edit — its `switch` ends in `default: return false`, so
a new arm is excluded by construction. That is worth a test rather than trust:
the exclusion is invisible at the call site, and the next arm someone adds may
want the opposite.

### 4.6 · Files

| File | Change |
| --- | --- |
| `src/shared/gateway.ts` | `resolveFile` in `GATEWAY_PATHS` |
| `src/shared/types.ts` | three `LANE_RULES` edits; `forgeFile` on `Recognition`; the `FileResolution` type |
| `src/shared/recognise/index.ts` | forward `match.forgeFile` into the `Recognition` |
| `src/background/gateway-client.ts`, `http-json.ts` | the read and its parser — four outcomes |
| `src/background/handlers.ts` | the `file` branch in `resolveForAgent`; the probe in `handleResolve`; `expert`/`pr`'s arm (§5) |
| `src/background/agent-run-store.ts` | the `file` arm in `isRunSubject` |
| `src/background/agents-capability.ts` | the arm-policy table (§5.1) |
| `src/shared/messages.ts` | `forgeFile` in `isRecognition`; the probe's outcome on the resolve response |
| `src/panel/panel-view.ts` | the `file` `HeaderState` arm |
| `src/panel/panel-in-page.ts` | file header, the `file` title overrides, the two sentences |

### 4.7 · Why `ghost` and `conflicts` are not here

Recorded in the spec rather than only in a code comment, because this is the
file a maintainer reads to find out why a roadmap entry shipped smaller than it
was written.

§5.3 named them "the first lanes added since C2.3". F3 shows both are
federation-only and the forge arm refuses the namespaces they need, so under the
one shape a browser can send, both return an empty array on every gateway,
forever. Offering them would mean two headers promising an answer that cannot
exist — the exact failure the `doc` surface is held back from, one section
later, in the same document.

**They become buildable if upstream gives them a local arm**, or if the forge
shape is allowed namespaces (it is not, deliberately: that would let any holder
of an `agents` token turn one file question into peer network calls from an
extension whose premise is loopback-only). Neither is proposed here. This is a
bound, not a deferral with a trigger.

---

## 5. The C6.1 close-out

### 5.1 · One arm-policy table, two readers

Per F4, the cross-product does **not** have to grow a pair to keep
`offeredLanes` correct — `expert`/`pr` is never withheld, so `pr` never enters
`ITEM_ARM_SURFACES`. Leaving the table alone and adding a `meetsFloor` check
inside `agentParams` is the tempting minimal change, and it is the one to
refuse: it puts the answer to "does this pair use the item arm" in two places,
which is what the table's own doc comment exists to prevent. (`ITEM_ARM_LANES`,
`ITEM_ARM_SURFACES` and `needsItemArm` name the table this section is arguing
*against* keeping; none of the three survived the change below — the shipped
symbol is `ITEM_ARM_POLICY` / `itemArmPolicy`.)

Instead the table stops being a boolean and starts naming the policy, so the two
readers ask their own question of one source:

```ts
type ArmPolicy = "item-required" | "item-preferred";
const ITEM_ARM_POLICY: ReadonlyMap<`${AgentLane}:${SurfaceKind}`, ArmPolicy>;
//  why:issue, why:incident, expert:issue, expert:incident,
//  ownership:issue, ownership:incident  → "item-required"
//  expert:pr                            → "item-preferred"
```

- `offeredLanes` withholds only on `item-required` below the floor. An unlisted
  pair and an `item-preferred` one are never withheld.
- `agentParams` sends `itemUrl` for `item-required` (guaranteed safe: the lane
  was only offered because the floor was met) and for `item-preferred` **when
  the floor is met**, falling back to `topicOrFile` otherwise.

A pair absent from the map keeps today's behaviour, so `why`/`pr` and every
service lane are untouched.

**The cost the reviewer missed, recorded because it is the reason this could
have been deferred instead.** `agentParams` has no roster today: `offeredFor`
reads it fresh in `handleResolve`, uncached, and `handleAgentRun` never sees it.
Sharpening at invoke time therefore needs a second roster read in
`handleAgentRun` — one extra loopback GET per lane expansion, which rides the
`Promise.all` beside the resolve it already makes. That is in line with what C6
already chose (read fresh every resolve rather than cache with the pairing), and
it is the whole price of never withholding a working lane.

### 5.2 · `expert` on `pr` sharpens, and is never withheld

`agentParams` sends `{ itemUrl }` when the gateway meets the floor and keeps
`{ topicOrFile: item.title }` when it does not.

The straight switch was rejected, and the reason belongs here rather than in a
commit message. 7.5.0 and 7.6.0 **have** the item arm and do not report a
version, so they fail closed; a floored switch would withhold a working,
shipped lane from every gateway below 7.7.0 to remove a wording problem. That
is the same regression the original deferral existed to prevent, and the
deferral's own trigger — "once gateways commonly report a version" — is a claim
about installed gateways that this repo cannot observe.

Sharpening instead of switching costs one version-aware pair in `agentParams`,
and settles the question permanently: no user loses the lane, and every user
gets the honest arm the moment their gateway can serve it. The deferral note in
`ROADMAP.md` is **removed**, not re-triggered.

### 5.3 · The prose that asserts the old state

Nothing gates prose; these are found by grep and must be corrected together.

- `src/background/agents-capability.ts` — the `ITEM_ARM_FLOOR` comment states
  *"As of 2026-09-02 that release does not exist"* and that the lanes are
  withheld on every gateway. Both are now false.
- `src/background/handlers.ts` — the `expert`/`pr` hold comment, replaced by
  §5.2's rule.
- `docs/development.md` — three sites, including a manual check that says no
  qualifying gateway exists. Those checks become runnable.
- `ROADMAP.md` — C6.1 flips 🟡 → 🟢: the *Depends* note, the *Done when*
  paragraph, the deferred-`expert` note, and the C7 line that calls upstream
  PR 2 unreleased.
- `docs/superpowers/specs/2026-08-31-…-design.md` — §3's dependency table, and
  a correction note on §5.4 pointing here.
- `CHANGELOG.md` — under `[Unreleased]`.

---

## 6. Testing

Seven pins. §5's first two are gone with the lanes they described — `conflicts`'
singular `kind: "conflict"` needs no parser now, and the `namespaces` test
protected a lane this design does not ship. What replaces them is the rule that
kept them out:

1. **`AGENT_LANES` does not contain `ghost` or `conflicts`**, asserted against
   the reason, not the membership: the pin belongs next to F3's finding so that
   whoever adds them has to answer it. A bare `toEqual` on the array says only
   that someone changed a list.
2. **Each miss reason renders its own sentence**, branched on the value.
3. **`403` yields the scope guidance**, not the silent row — the state a legacy
   pairing hits first.
4. **`offeredLanes(roster, "file")` returns `null` on an unreadable roster** —
   "do not filter", i.e. offer all three — because no file lane needs the item
   arm. That is safe *only* because the probe gates the lanes upstream of it.
   Two mechanisms, one outcome, and nothing in the type system connects them.
   This is the coupled-and-unenforced shape this repo keeps being bitten by, so
   it gets a test naming both halves rather than a comment.
5. **A `file` `RunSubject` round-trips `putRun`/`getRun`** — the §4.1 gap, which
   fails silently and only on the storage path, so no other test would see it.
6. **`offersCapture` is `false` for the `file` arm**, hit and miss alike.
7. **`ITEM_ARM_POLICY` over every `(lane, surface)` pair**, table-driven:
   `expert:pr` is `item-preferred`, `why:pr` is absent, and the six item pairs
   are `item-required`. Then the behaviour on both sides of the floor: below it,
   `expert` on a PR is **offered** and sends `topicOrFile`.

Plus the ordinary coverage: the three forge matchers have fixtures already, and
they gain an assertion that the `Recognition` — not just the `Match` — carries
`forgeFile`, which is the §4.1 gap that would otherwise typecheck green.

---

## 7. Risks and limitations

- **The banner depends on a route that does not exist yet.** Until it lands, a
  file page renders as it does today: recognised, no lanes, no banner. The
  client ships in that state honestly and improves when the gateway does.
- **`path` from the probe is not used as an agent param.** The lanes keep
  sending `refAndPath`, unsplit, so the gateway resolves once per invoke as it
  does for the terminal. Sending the split path would mean trusting a value
  round-tripped through the browser to name a file on the reader's disk.
- **The ambiguous-page gap does not apply here.** A file coordinate is not
  re-resolved against an item index, so C2.4's known gap — a lane asked with a
  URL the gateway re-resolves and finds ambiguous — has no analogue on `file`.
- **A Confluence page still gets none of this**, unchanged from C6.1: it
  indexes as `type: "page"`, which has no graph entity.

---

## 8. Out of scope

- §6's `connections` and `currency` lanes — still upstream PR 3, not started.
- Any rename of the extension.
- The three file lanes on a self-hosted forge: they come for free through the
  configured-origin path, and need no separate work here.
- `ghost` and `conflicts` in any form — see §4.7. Not deferred with a trigger;
  bounded.
