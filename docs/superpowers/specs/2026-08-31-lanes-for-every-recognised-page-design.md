# Lanes for Every Recognised Page (C6 · C7)

> **Status:** design, 2026-08-31. **Not client-only** — every user-visible lane in this
> document depends on a gateway arm that does not exist yet. The upstream half is designed
> in the Nimbus repo as
> `docs/superpowers/specs/2026-08-31-agents-for-items-and-files-design.md`; that document
> owns the wire and this one consumes it. Where the two disagree, that one is correct.
>
> **Reviewed:** [design review](./2026-08-31-lanes-for-every-recognised-page-design-review.md)
> (Antigravity, 2026-08-31) — responses in §11.
>
> **Roadmap:** continues the C-series. **C6 — lanes on an item** (§4), **C7 — the file you
> are looking at** (§5). Both are recorded in `ROADMAP.md` by the last slice.
>
> **Amended 2026-09-02.** Slices 1 and 2 shipped in #94. Upstream PR 1 landed as Nimbus#1421
> (in the v7.5.0 release) and PR 2 as Nimbus#1424 (unreleased), so §4.2 and §5 are both
> unblocked. §4.4's version floor turned out to have no input — see the new **F7** — so it
> takes a small additive upstream change and §4.4 is rewritten to match.

---

## 1. What this delivers

Recognition covers nine products and six surface kinds. Agent lanes cover two of them.

A Jira issue, a Confluence page, a PagerDuty incident, a Linear issue and a CircleCI pipeline
each get a header, a freshness line, Related and the `glossary` term box — and **no agent
lane at all**. `LANE_RULES` (`src/shared/types.ts:449`) pins `impact`, `expert` and `why` to
`pr`, and `catchup`, `decisions` and `ownership` to `home`. Everything the C1.2 widening
added in #87 and #88 landed on surfaces with nothing to run.

This closes that, and adds a seventh surface kind — the source file you are reading — which
turns out to be the single richest page the client can recognise.

When it is done:

- **C6** — a Jira issue, a Linear issue and a PagerDuty incident offer *how did we get here*,
  *who should I talk to*, and (second half) *what is connected to this* and *is this still
  true*. A Confluence page does **not**: it has no graph entity for a lane to answer from
  (§4.2), and a lane that answers nothing is worse than no lane.
- **C7** — a file page on GitHub, GitLab or Bitbucket offers five lanes: *what breaks if I
  change this*, *who knows it*, *who owns it*, *whose knowledge left with them*, *who else is
  touching it*.
- The lane list stops being a hardcoded guess: the panel reads `GET /v1/agents` and offers
  only what the paired gateway actually serves.

---

## 2. Findings that shaped it

### F1 — the lane table cannot express what these surfaces need

`LANE_RULES` maps **one lane → one rule**, and `agentParams` (`src/background/handlers.ts:713`)
maps **one lane → one param shape**. That 1:1 holds today only because every item-scope lane
lives on exactly one surface. Three things break it at once:

- `ownership` must live on `home` (as `{ service }`) **and** on a file page (as a file
  coordinate). One lane, two scopes.
- `impact` sends a PR URL on `pr` and a file coordinate on `file` — same param name,
  different meaning.
- `expert` sends the item title on `pr` and a file coordinate on `file`.

So the table generalises from `lane → rule` to **`lane × surface → param shape`**. The switch
in `agentParams` already anticipates this: its comment records that a fourth item-scope lane
"would compile, render and invoke while silently sent `expert`'s params", and that the `why`
lane "would have shipped that exact bug had its own case been forgotten here". The
generalisation makes that structurally impossible instead of caught by a case.

This refactor is the load-bearing work in §4 and it is why §4 precedes §5 even though §5 is
the more interesting feature.

### F2 — a file page resolves to no indexed item, so it needs a scope that skips resolve

`resolveForAgent` returns `service` / `term` / `item` scopes, and the `item` scope requires a
hit from `GET /v1/items/resolve`. A source file is not a connector item: there is no row to
resolve to, no miss state to recover from, and no targeted fetch that could ever create one.

So the file lanes get a fourth scope carrying the forge coordinate, and they run **without a
resolve call at all**. This is a simplification — no miss branch, no fetch-on-miss
confirmation, no C3.1 path — but it is a genuine change to `resolveForAgent`'s contract and to
`RunSubject`, which needs a matching `file` kind so runs cache per file rather than colliding.

### F3 — the client cannot turn a browser URL into something the file agents accept

This is the finding that reshaped the whole arc, and it is documented in full as F4 of the
upstream spec.

A file page gives `acme/web` and an addressable remainder — a forge coordinate. The gateway's
file entities are keyed to the reader's **local checkout**: `source_file` external ids are
`file:<repoRoot>:<path>`, and `ownership`'s path arm explicitly refuses a path "outside every
configured root". The bridge between the two — a `workspace --tracks_remote--> repo` edge —
exists in the graph and is not reachable from any agent parameter.

The client must not attempt to guess a local path. It sends the forge coordinate; the gateway
walks the bridge. That is upstream PR 2, and **§5 does not start until it lands**.

§5.1 shows this cuts deeper than it first looks: the client cannot even isolate the *path* part
of the URL by itself, because a branch name may contain slashes. Both halves of the coordinate
are resolved on the side that holds the index.

### F4 — `GET /v1/agents` tells you the names, not the arms

The client never reads `GET /v1/agents`, so `AGENT_LANES` is an assertion about a gateway the
user might not be running. Reading it is worth doing on its own merit (§4.4).

But it lists agent **names**, and every lane in this document depends on a new **param arm** of
an agent whose name is already published. So discovery alone cannot tell the panel whether
`why` will accept an `itemUrl`. Two honest options: a minimum gateway version, or attempting
the call and hiding the lane after a `-32602` rejection. **This design takes the version
floor** — it fails before the request rather than after, and the client already understands
gateway version minimums (the `source` passthrough needs 2.12.0, the egress routes need the
Nimbus#1319 build). Discovering a lane by watching it fail is a bad experience and an egress
row for nothing.

### F5 — the file surface is honest only for repos you have cloned

Upstream F4's bridge is written by the ownership pass over git-aware filesystem roots. A
reader browsing a repo they have never checked out locally will get a miss — permanently, and
correctly.

That is a real bound, and the panel must say it in words rather than render five empty lanes.
The upstream resolver returns two distinct misses for exactly this reason —
`remote_not_tracked` vs `file_not_indexed`, a typed discriminant rather than prose — and §5.4
renders them differently, once per page rather than once per lane.

### F6 — `impact` on a file used to answer about the wrong thing

Worth recording here because it shaped what the client may claim. `impact`'s non-PR arm
matched `type = 'symbol'` labels with a `LIKE`, and symbol labels are `"<name> — <file>"` — so
a file path returned the shortest-named symbol inside that file, confidently. Upstream PR 2
fixes it by preferring an exact `source_file` match.

The client-side consequence: **the impact lane on a file page must render the subject the
gateway resolved**, not just the finding. A lane that shows an answer without showing what it
is an answer about cannot be checked by the person reading it.

### F7 — nothing on the HTTP surface serves a gateway version

Found while checking that upstream PR 1 had landed, and it invalidates an assumption §4.4 made
without stating it. The version floor has no input: `GET /v1/health` answers
`{ status: "ok", gateway: "read_only_http" }`, `GET /v1/agents` answers `{ agents: […] }`, and
`HTTP_ROUTES` carries no version route at all. `meetsFloor` fails closed on a `null` version —
correctly — so wiring the floor up as designed would withhold the item lanes from **every**
gateway.

`ITEM_ARM_FLOOR` is separately wrong: it reads `2.19.0`, a line the gateway had already left
when the constant was written. The gateway reports `7.5.0` today and has moved four majors in a
week, so a 2.x floor is satisfied by everything and gates nothing. Neither defect is live —
`ITEM_ARM_FLOOR` and `meetsFloor` have no callers until the item lanes wire them up — but this
slice is what wires them up.

The version therefore goes on **`GET /v1/agents`**, additively, as a small upstream change. Two
alternatives were considered and rejected:

- **`GET /v1/health`.** Tokenless, so it would be read at pair time and cached — which is where
  the staleness in the withdrawn §4.4 wording comes from. It also puts a version on the one
  route this client calls without a bearer; no CORS headers are set anywhere in
  `packages/gateway/src/ipc/`, so a page could not read the response, but the roster route is
  authed, already called here, and costs nothing extra.
- **Publishing the arms rather than a version** — `GET /v1/agents` describing what each agent
  *accepts*, which would retire F4's problem permanently instead of proxying it through a
  release number. This is the better long-run shape and this decision does not block it. It is
  not this slice: the arms live inside each handler's param types, so deriving them honestly is
  real upstream work, and hand-listing them is exactly the drift shape `EXTERNAL_AGENT_NAMES`
  exists to prevent — that constant is derived from `AGENTS_RPC_HANDLERS` for this reason.

---

## 3. Dependencies and order

| Slice | Needs | State |
| --- | --- | --- |
| §4.1 the `lane × surface` refactor | nothing — pure client, no behaviour change | ✅ #94 |
| §4.4 roster discovery | nothing | ✅ #94 |
| §4.4 the version floor | a `version` field on `GET /v1/agents` (F7) | upstream, not started |
| §4.2 item lanes (`why`, `expert`, `ownership`) | upstream **PR 1** — Nimbus#1421 | ✅ landed, v7.5.0 |
| §5 the file surface | upstream **PR 2** — Nimbus#1424 | ✅ landed, unreleased |
| §6 `connections` + `currency` lanes | upstream **PR 3**, and the SDK's guards | not started |

The roster half of §4.4 shipped without the floor half, which is why the floor's missing input
went unnoticed: `ITEM_ARM_FLOOR` and `meetsFloor` have no callers today. The floor's upstream
field is small and additive, and it gates §4.2 only — so it leads that slice rather than
standing as its own.

---

## 4. C6 — lanes on an item

### 4.1 · Generalising the lane table

`LaneRule`'s two arms (`page` with a surface list, `term`) become a mapping from surface kind
to the param shape that lane sends **on that surface**. Concretely, a lane declares the set of
surfaces it belongs on and, per surface, which scope supplies its input — service, term, item
or file.

Two properties must survive the refactor, because both are load-bearing today and both are
currently enforced by the type system rather than by a test:

- **A lane with no declared rule is a type error**, not a lane that appears everywhere.
- **A lane × surface pair with no declared param shape is a compile error**, by the same
  mechanism `agentParams` uses now: exhaustiveness lives in the return type, so a missing case
  makes control fall off the end of the function. There is deliberately no `default` arm, and
  the refactor must not introduce one. Per this repo's Sonar history, a `satisfies never`
  backstop would be permanently-uncovered new lines; keeping the check in the return type
  avoids that.

**The shape must not be a mapped type with optional members.** The obvious encoding —
`{ [L in AgentLane]: { [S in SurfaceKind]?: … } }` — was proposed in review and it defeats its
own purpose: an optional property may be omitted without error, so "lane declared on a surface
with no param builder" becomes exactly the silent hole the table exists to close. The
declaration must be **total over the pairs the lane claims** — the lane names its surfaces, and
every named surface is then a required key — so omitting one is a compile error rather than an
absent entry that reads as "not applicable".

Acceptance bar for this slice: **every existing test passes untouched**, no changelog entry, no
user-visible change. Same bar as slice 1 of the widening arc, and for the same reason — a
refactor that also changes behaviour cannot be reviewed as either.

### 4.2 · The three item lanes

With PR 1 landed, three lanes widen their surface list to `pr`, `issue` and `incident` — **not
`doc`**. Upstream F8 is the reason, and it was found while planning: a Confluence page indexes as
`type: "page"`, which appears in neither `ITEM_LINKED_ENTITY_TYPES` nor `GRAPH_SYNC_BY_TYPE`, so it
has **no graph entity**. Every one of these lanes answers from graph edges, so on a `doc` page they
would return an empty answer or a gap, permanently, for a reason no user could act on.

A Confluence page therefore keeps exactly what it has today — header, freshness, Related, glossary —
and this design does not pretend otherwise. Adding a `page` graph populator upstream would light all
three lanes up with no client change, since the surface list is a one-line table edit.

- **`why`** — *how did we get here*. Sends `{ itemUrl }`, the same `resolveUrl` the panel
  already computes for resolution. The brief answers on a **third** subject field —
  `itemSubject`, alongside the existing `subject` (the `ref` arm) and `changeSubject` (the
  `prUrl` arm) — so the panel's `why` renderer must switch on three cases, not two. A renderer
  written for two falls through silently on an item brief and shows a `why` lane with no
  subject at all. `WhyItemSubject` carries no `repo`: a Confluence page has none, and the
  header must not render an empty field where a fact used to be.
- **`expert`** — *who should I talk to*. Sends `{ itemUrl }` rather than today's
  `{ topicOrFile: item.title }`. This **removes** a piece of client-side dishonesty: the title
  arm answers "who has touched things whose titles look like this", which is not the question
  the lane's label promises. On `pr` the lane switches to the item arm too.
- **`ownership`** — *who owns this*. Currently `home`-only and service-scoped. It gains the
  item surfaces with an `itemUrl` param, and keeps its `home` behaviour byte-for-byte. This is
  the lane that forces F1's refactor.

`glossary` is unchanged: it is `term`-input, belongs on every page including unrecognised ones,
and sends no URL anywhere.

### 4.3 · What a miss looks like

The upstream arms return a gap naming the URL when it resolves to nothing. The panel must
render "this page is not in your index" distinctly from "the agent found nothing" — they are
different facts and they have different remediations (a targeted fetch versus nothing you can
do). The existing `not_resolved` `AgentError` already draws exactly this distinction for the
`pr` lanes and its comment explains why; the item lanes reuse it rather than inventing a
second vocabulary.

### 4.4 · Capability discovery and the version floor

The panel reads `GET /v1/agents` (already in `GATEWAY_PATHS` as `agents`, already under the
`agents` scope the client holds) and offers only the lanes the paired gateway publishes. A 404
means a gateway older than the route: fall back to the current hardcoded set, silently, exactly
as the connector-health gate degrades when `GET /v1/connectors` is absent.

Per F4, name discovery cannot prove an arm exists, so the item lanes additionally require a
minimum gateway version. **The version rides on the roster response** — `GET /v1/agents`
answers `{ agents: […], version }`, so the fact and the check arrive in the same request, at the
moment the floor is evaluated. Below the floor the lanes are not offered — not offered and
failing are different things, and only one of them is honest.

An earlier draft of this section said the version is "read once, cached with the connection, and
re-read on pairing." That is withdrawn, and F7 records why: a cache keyed to pairing goes stale
the moment a user upgrades their gateway without re-pairing, and the symptom is lanes that stay
off forever with nothing on screen to explain it. Reading it inline costs nothing, because the
request is one the panel already makes.

**The floor is `7.5.0`** — upstream #1421 landed before the v7.5.0 release, so that is the first
release serving the `itemUrl` arm. A consequence worth stating plainly: 7.5.0 *has* the arm and
does **not** report a version, so it fails closed and is offered no item lanes. The effective
floor is therefore the release that adds the version field. That is one release of lag for
anyone sitting exactly on 7.5.0, and it is the honest outcome — a gateway that cannot say what
it is does not get lanes. `meetsFloor` still earns its keep for the next floor: the file arms
(upstream #1424) are unreleased and will carry one of their own.

**A development build must satisfy the floor.** A gateway built from a feature branch reports
something like `0.0.0-dev` or a prerelease tag, and a naive `>=` comparison puts every such
build *below* any released floor — which would turn the lanes off for exactly the people
building them, including in the e2e job that is supposed to prove they work. The comparison
therefore treats a non-release version (`0.0.0`, or any prerelease of the floor or later) as
satisfying it. That is the right default for a loopback-only client: the gateway on
`127.0.0.1` is the user's own build, and being wrong about it costs a `-32602` the panel
already handles, not a leak.

---

## 5. C7 — the file you are looking at

**Blocked on upstream PR 2.** Nothing in this section is buildable before it.

### 5.1 · A seventh surface kind

`file`, matched on the three forges:

- `github.com/<owner>/<repo>/blob/<ref>/<path>`
- `gitlab.com/<group>/<project>/-/blob/<ref>/<path>`
- `bitbucket.org/<owner>/<repo>/src/<ref>/<path>`

Each is a local edit to that product's own `match` in `src/shared/recognise/`; the registry
does not change. Self-hosted origins inherit it for free, since a configured origin already
routes to the same module.

**The client cannot split the ref from the path, and must not try.** Branch names contain
slashes. `github.com/acme/web/blob/feat/auth-v2/src/index.ts` is ref `feat/auth-v2` + path
`src/index.ts` — or ref `feat` + path `auth-v2/src/index.ts`. Nothing in the URL distinguishes
them, and resolving it needs the repo's branch list, which is a forge API call this extension
will never make. An earlier draft of this section said "the ref is deliberately not sent" as
though that settled it; it does not, because you still have to know where the ref *ends* to
find the path.

So the recogniser carries the **opaque remainder** after `/blob/` (or Bitbucket's `/src/`) and
sends it as `refAndPath`. The gateway disambiguates it against the file list it already holds
for that repo — it knows which paths are indexed and the browser does not. This is the same
division of labour as F3: the client sends what the page shows, the gateway resolves it against
what it knows.

`Match` (`src/shared/recognise/rule.ts:9`) therefore gains two carried fields — the repo
coordinate and `refAndPath`. Deriving either at the call site is precisely the drift the
registry exists to prevent.

**Repo extraction is variable-depth on GitLab.** A project can nest under any number of
groups — `gitlab.com/group/subgroup/team/project/-/blob/main/src/app.ts` — so the repo
coordinate is everything before the `/-/` delimiter, not the first two segments. GitHub and
Bitbucket are fixed at `owner/repo`. The `/-/` delimiter is what makes GitLab's case
tractable at all, and the matcher keys on it rather than counting segments.

### 5.2 · A fourth scope

Per F2: a `file` scope carrying the coordinate, no resolve call, and a matching `RunSubject`
kind so two files on one host do not share a cached run.

### 5.3 · Five lanes

`impact`, `expert` and `ownership` gain `file` in their surface lists with the file param
shape. `ghost` and `conflicts` are **new members of `AGENT_LANES`** — the first lanes added
since C2.3 — and both are `file`-only.

Two things to pin with tests rather than comments:

- **Neither sends `namespaces`.** Upstream, `ghost` and `conflicts` fan out to federation peers
  only when namespaces are supplied. The client sends none, so both answer local-only. A future
  well-meaning addition of namespaces would turn two local reads into network calls made by an
  extension whose entire premise is loopback-only. That deserves a test, not a comment.
- **`conflicts` emits `kind: "conflict"`**, singular. The SDK documents this as the trap in its
  agents module; the client's parser must not derive one from the other.

### 5.4 · The two misses

`remote_not_tracked` → "Nimbus has no local checkout of `acme/web`, so it cannot answer about
its files." One sentence, no lanes. `file_not_indexed` → the repo is known and the file is not,
which is a different sentence and a different remediation. Upstream returns these as a **typed
discriminant**, not prose, so the panel branches on a value rather than matching on a sentence
that a later improvement to the wording would break.

Neither renders five empty lanes. This is the same rule the dashboard connector-health gate
established in #76: a lane that will answer nothing is worse than no lane, because the empty
answer reads as "there is nothing", not as "I cannot see".

**One resolution for the page, not five.** Five lanes each discovering the same miss
independently would mean five RPCs, five spinners resolving into five identical apologies, and
five egress rows for one fact. So the panel resolves the file **once** before offering any lane,
and renders the miss banner instead of the lanes when that resolution fails. On a hit, the lanes
run as usual.

This mirrors what the panel already does on item surfaces, where resolution precedes the lanes
rather than being repeated inside each one — and it is the same instinct behind the connector-
health gate: establish once whether an answer is possible, then decide what to offer.

---

## 6. The last two lanes

With upstream PR 3 and the SDK's guards landed, `connections` and `currency` join
`AGENT_LANES` on the item surfaces.

- **`connections`** renders edge-typed neighbours — "PR #482 resolves this issue" — and must
  render the edge, not just the neighbour. Without the relationship it degenerates into a
  second Related, which already runs on the same page. Upstream publishes `edgeType` as a
  **closed union**, so the renderer maps each edge to its own label exhaustively rather than
  printing a raw `snake_case` value at the reader.

  Because both appear on the same page, they must not read as one list: `connections` sits in
  its own section with the edge as a leading badge, and Related keeps its existing position.
  The distinction the user needs is *why* an item is here — a link someone made, or a
  resemblance the index computed — and only the badge carries that.
- **`currency`** renders a claim **with its evidence**, never a bare verdict. Upstream F6 binds
  the agent to that; the panel must not then collapse it to a badge. If the evidence cannot be
  shown in the space available, the lane shows fewer claims, not less evidence.

---

## 7. Testing

- **Recogniser fixtures** for the three forge file-URL shapes, plus the near-misses that must
  *not* match: a directory listing (`/tree/`), a raw URL, a blob URL with no path, and a PR
  files-changed tab (a `pr`, not a `file`).
- **Refs that are not one segment**: a branch with slashes (`feat/user-auth/src/file.ts`), a
  tag (`v1.0.0-rc.1/src/file.ts`) and a commit sha all produce the same `refAndPath` remainder
  without the client attempting a split.
- **GitLab nesting**: a project under three groups yields the full path before `/-/` as the
  repo coordinate, and a two-segment GitHub URL still yields `owner/repo`.
- **The version floor accepts a development build** — `0.0.0-dev` and a prerelease of the floor
  both satisfy it; a genuinely older release does not.
- **One resolution per page**: a file page with five lanes issues exactly one file-resolution
  request, and a miss renders the banner without dispatching any lane.
- **`lane × surface` exhaustiveness**: a lane declared on a surface with no param shape fails
  to compile. Asserted the way the existing exhaustiveness is — by a type-level test, not a
  runtime assertion.
- **`ownership` on `home` is unchanged** by the refactor: same params, byte for byte.
- **No `namespaces` ever reaches `ghost` or `conflicts`** (§5.3).
- **Version floor**: below it, the item lanes are absent — not present-and-erroring.
- **Discovery degradation**: a 404 from `GET /v1/agents` leaves the panel exactly as it renders
  today, with nothing said about it and no lane withheld.
- **DOM tests** for the two file misses, and for a `why` brief carrying each of the three
  subject fields — including the item arm, which a two-case renderer drops silently.
- Per this repo's conventions, several tests read prose rather than code: `ROADMAP.md`,
  `CHANGELOG.md`, `architecture.md` and `development.md` all change here, so `bun run test`
  runs after the docs slice too, not only after the code slices.

---

## 8. Slices

1. **The `lane × surface` refactor** — §4.1. No new lanes, no behaviour change, every existing
   test untouched. No changelog entry.
2. **Capability discovery + the version floor** — §4.4. Client-only; ships before the lanes
   that need it.
3. **The three item lanes** — §4.2, §4.3. Needs upstream PR 1.
4. **The `file` surface and its five lanes** — §5. Needs upstream PR 2. Splits in two if the
   recogniser and the lanes review better apart.
5. **`connections` + `currency`** — §6. Needs upstream PR 3 and the SDK.
6. **Docs** — `architecture.md` gains the fourth scope and the discovery read; `development.md`
   gains manual checks for the file surface and both misses; `ROADMAP.md` records C6 and C7;
   `CHANGELOG.md` under `## [Unreleased]`.

---

## 9. Risks and limitations

- **The file surface is silent for repos you have not cloned** (F5). This is the bound most
  likely to read as a bug. It is stated in the panel, in `development.md`, and in the changelog
  entry — not left for a user to infer from five empty lanes.
- **Two new lanes on a page that already has Related** — `connections` in particular. The
  edge-type rendering is what keeps them distinct; if in review it cannot be rendered
  legibly, the honest outcome is to ship `currency` alone and reconsider.
- **`panel-in-page.ts` is 2,001 lines** and this adds a surface kind, a scope and four lanes to
  it. The file was already flagged as oversized when C5.3 chose a context menu over a panel
  lane.

  Review proposed extracting lane rendering into per-lane modules before slice 4. **Deferred as
  a general refactor, accepted as a constraint on new code:** rewriting the existing renderers
  is a separate change with its own review, and bundling it into a slice that also adds lanes
  would make both unreviewable — the same argument that gives §4.1 its no-behaviour-change
  bar. What this design does commit to is that **the new renderers land as new modules**
  (file-lane rendering, the miss banner, the two brief renderers) rather than as additions to
  `panel-in-page.ts`, so the arc leaves the file no worse than it found it. If slice 4 cannot
  hold that line, the extraction stops being deferrable and becomes its own slice before it.
- **The version floor hardcodes a number** that only becomes true when upstream PR 1 is
  released. Until then the item lanes are off for everyone, including developers testing
  against a locally-built gateway. The floor must be a named constant with the reason next to
  it, and slice 3 must not land before the gateway release it names.

  **Update (2026-09-02, as shipped):** this is the branch's live state, and it is broader than
  the sentence above. The blocker is not the *release* of PR 1 — that landed — it is **F7**,
  which is still open: `GET /v1/agents` serves `{ agents }` with no `version`, so `meetsFloor`
  fails closed on every gateway, a locally-built one included. The floor is a named constant
  (`ITEM_ARM_FLOOR`) with its reasoning beside it, and the client is complete; the feature is
  gateway-blocked until F7 ships. Recorded in the changelog, **ROADMAP C6.1**, and the
  `development.md` pass, so no reader concludes from an absent lane that the client is broken.

- **An ambiguous page still disappoints, and now on four surfaces rather than one.** When a
  page resolves to several candidates and the user picks one, `why`, `expert` and `ownership`
  on an `issue` or an `incident` send `{ itemUrl: resolveUrl }` — the *page's* URL — which the
  gateway re-resolves and finds ambiguous again, so the lane reports a gap under a header
  naming the item the user just picked. Identical in shape to C2.4's known gap for `impact` and
  `why` on a PR, inherited rather than introduced by these lanes, and not fixable from here:
  `ResolveCandidate.url` does not help, because upstream `itemEntityFor` resolves whatever URL
  it receives. The fix is an upstream **`itemId` arm**. Named here so the limitation has one
  home rather than four silent copies; also in **ROADMAP C2.5** and **C6.1**.

---

## 10. Out of scope

- **`janitor` and `huddle`** — see the upstream spec's §8. Neither is a browser subject today.
- **Adopting the Nimbus SDK** (Phase 8.1). The client keeps hand-rolling its brief parsing here,
  including for the two new briefs. The SDK's guards are a reference for the shapes, not a
  dependency.
- **Refactoring `panel-in-page.ts`.** Noted as a risk, not scheduled here.
- **A targeted fetch for a file.** There is no fetch that would create a `source_file` entity;
  the C3.1 path does not apply and is not offered.
- **Widening `host_permissions`.** The file surface reads the tab URL under the same per-origin
  page access C1.4 established. No new network destination; loopback only, unchanged.
- **Extracting the existing `panel-in-page.ts` renderers.** Deferred, with the constraint in §9
  that new renderers land as new modules.

---

## 11. Review responses

Against [`2026-08-31-lanes-for-every-recognised-page-design-review.md`](./2026-08-31-lanes-for-every-recognised-page-design-review.md)
(Antigravity, 2026-08-31). Each finding was checked against the code before being accepted.

| Finding | Disposition |
| --- | --- |
| Q2.1 branch names contain slashes | **Accepted — the most consequential finding, and it changed the upstream contract too.** The client cannot split `/blob/<ref>/<path>` without the repo's branch list. §5.1 now sends the opaque `refAndPath` remainder and the gateway disambiguates against its indexed file list. The earlier "the ref is deliberately not sent" was answering a different question. |
| Q2.2 version floor vs development builds | **Accepted.** §4.4 treats `0.0.0`/prerelease as satisfying the floor. Without it the lanes would be off for the people building them and in the e2e job meant to prove them. |
| Q2.3 five lanes, five identical misses | **Accepted.** §5.4 resolves the file once per page before offering any lane; a miss renders the banner and dispatches nothing. |
| Q2.4 Related vs connections layout | **Accepted.** §6 puts `connections` in its own section with the edge as a leading badge. The reader's question is *why* an item is listed — a link someone made, or a resemblance the index computed. |
| I3.1 extract lane rendering from the monolith | **Deferred as a refactor, accepted as a constraint.** Rewriting existing renderers inside a slice that also adds lanes makes both unreviewable — the same argument behind §4.1's no-behaviour-change bar. §9 commits the *new* renderers to new modules, with the extraction promoted to its own slice if that line cannot hold. |
| I3.2 mapped type for `lane × surface` | **Accepted in intent, rejected as written.** `{ [S in SurfaceKind]?: … }` makes every pair optional, so an undeclared pair compiles — reintroducing the hole the table exists to close. §4.1 requires the declaration to be total over the surfaces a lane claims. |
| I3.3 GitLab nested groups | **Accepted.** §5.1 keys on the `/-/` delimiter rather than counting segments, so arbitrary group depth works. |

Against the whole-branch review of `feat/c6-item-lanes` (2026-09-02):

| Finding | Disposition |
| --- | --- |
| §4.2's `expert`-on-`pr` switch to `{ itemUrl }` was not implemented | **Deferred deliberately, with a trigger.** §4.2 is right that `{ topicOrFile: item.title }` answers a narrower question than the lane's label promises. But the item arm is gated on `ITEM_ARM_FLOOR`, and no gateway reports a version on `GET /v1/agents` (F7 is still open upstream), so `meetsFloor` fails closed for **every** gateway today. Switching now would withhold a working, shipped lane from 100% of users to fix a wording problem — the only option that does not break a lane in production is to hold. **Trigger:** switch `expert` on `pr` to the item arm once gateways commonly report a version. Also recorded in **ROADMAP C6.1**, which is where a maintainer looks. |
| the ambiguous-page limitation is now four surfaces, not one | **Accepted as a recording, not a fix.** See §9's new bullet and **ROADMAP C2.5**'s C6.1 correction. |
| the version floor has no gateway that satisfies it | **Accepted, and the prose corrected rather than the code.** The floor is right; what was wrong was the changelog, roadmap and `development.md` implying the lanes were live. Nimbus#1421 shipped the arm, not the field, so the client is complete and the feature is gateway-blocked. F7 remains the open upstream dependency. |
