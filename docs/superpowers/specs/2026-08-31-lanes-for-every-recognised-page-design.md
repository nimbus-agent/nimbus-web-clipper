# Lanes for Every Recognised Page (C6 · C7)

> **Status:** design, 2026-08-31. **Not client-only** — every user-visible lane in this
> document depends on a gateway arm that does not exist yet. The upstream half is designed
> in the Nimbus repo as
> `docs/superpowers/specs/2026-08-31-agents-for-items-and-files-design.md`; that document
> owns the wire and this one consumes it. Where the two disagree, that one is correct.
>
> **Roadmap:** continues the C-series. **C6 — lanes on an item** (§4), **C7 — the file you
> are looking at** (§5). Both are recorded in `ROADMAP.md` by the last slice.

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

- **C6** — an issue, doc, incident, Linear issue or CircleCI pipeline offers *how did we get
  here*, *who should I talk to*, and (second half) *what is connected to this* and *is this
  still true*.
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

A file page gives `acme/web` + `src/foo.ts` — a forge coordinate. The gateway's file entities
are keyed to the reader's **local checkout**: `source_file` external ids are
`file:<repoRoot>:<path>`, and `ownership`'s path arm explicitly refuses a path "outside every
configured root". The bridge between the two — a `workspace --tracks_remote--> repo` edge —
exists in the graph and is not reachable from any agent parameter.

The client must not attempt to guess a local path. It sends the forge coordinate; the gateway
walks the bridge. That is upstream PR 2, and **§5 does not start until it lands**.

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
The upstream resolver returns two distinct misses for exactly this reason (*no such remote is
tracked* vs *tracked, but that path is not indexed*), and §5.4 renders them differently.

### F6 — `impact` on a file used to answer about the wrong thing

Worth recording here because it shaped what the client may claim. `impact`'s non-PR arm
matched `type = 'symbol'` labels with a `LIKE`, and symbol labels are `"<name> — <file>"` — so
a file path returned the shortest-named symbol inside that file, confidently. Upstream PR 2
fixes it by preferring an exact `source_file` match.

The client-side consequence: **the impact lane on a file page must render the subject the
gateway resolved**, not just the finding. A lane that shows an answer without showing what it
is an answer about cannot be checked by the person reading it.

---

## 3. Dependencies and order

| Slice | Needs |
| --- | --- |
| §4.1 the `lane × surface` refactor | nothing — pure client, no behaviour change |
| §4.2 item lanes (`why`, `expert`, `ownership`) | upstream **PR 1** |
| §4.4 capability discovery + version floor | nothing |
| §5 the file surface | upstream **PR 2** |
| §6 `connections` + `currency` lanes | upstream **PR 3**, and the SDK's guards |

§4.1 and §4.4 can start immediately; they are the only parts of this document that are not
waiting on the gateway. Everything else lands in the order above.

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

Acceptance bar for this slice: **every existing test passes untouched**, no changelog entry, no
user-visible change. Same bar as slice 1 of the widening arc, and for the same reason — a
refactor that also changes behaviour cannot be reviewed as either.

### 4.2 · The three item lanes

With PR 1 landed, three lanes widen their surface list to `pr`, `issue`, `doc`, `incident`:

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
minimum gateway version. The version is read once, cached with the connection, and re-read on
pairing. Below the floor the lanes are not offered — not offered and failing are different
things, and only one of them is honest.

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

`Match` (`src/shared/recognise/rule.ts:9`) gains the forge coordinate — repo and repo-relative
path — as its own carried fields. Deriving them at the call site from `path` is precisely the
drift the registry exists to prevent, and the ref (branch or SHA) is deliberately **not** sent:
the gateway answers from the reader's checkout, not from the branch they happen to be viewing,
and pretending otherwise would be a claim the answer does not support.

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

`no such remote is tracked` → "Nimbus has no local checkout of `acme/web`, so it cannot answer
about its files." One sentence, no lanes. `tracked, but that path is not indexed` → the repo is
known and the file is not, which is a different sentence and a different remediation.

Neither renders five empty lanes. This is the same rule the dashboard connector-health gate
established in #76: a lane that will answer nothing is worse than no lane, because the empty
answer reads as "there is nothing", not as "I cannot see".

---

## 6. The last two lanes

With upstream PR 3 and the SDK's guards landed, `connections` and `currency` join
`AGENT_LANES` on the item surfaces.

- **`connections`** renders edge-typed neighbours — "PR #482 resolves this issue" — and must
  render the edge, not just the neighbour. Without the relationship it degenerates into a
  second Related, which already runs on the same page.
- **`currency`** renders a claim **with its evidence**, never a bare verdict. Upstream F6 binds
  the agent to that; the panel must not then collapse it to a badge. If the evidence cannot be
  shown in the space available, the lane shows fewer claims, not less evidence.

---

## 7. Testing

- **Recogniser fixtures** for the three forge file-URL shapes, plus the near-misses that must
  *not* match: a directory listing (`/tree/`), a raw URL, a blob URL with no path, and a PR
  files-changed tab (a `pr`, not a `file`).
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
  lane. This design does not refactor it — that is not this arc's work — but slice 4 should not
  be the slice that discovers the limit.
- **The version floor hardcodes a number** that only becomes true when upstream PR 1 is
  released. Until then the item lanes are off for everyone, including developers testing
  against a locally-built gateway. The floor must be a named constant with the reason next to
  it, and slice 3 must not land before the gateway release it names.

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
