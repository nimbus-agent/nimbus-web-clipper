# "Why does this change exist", asked from a pull request page (C2.4)

> **Status:** design, approved 2026-08-19. The gateway params and the SDK type
> below are **proposed, not yet contracted** — per the roadmap's
> [gateway-dependent feature protocol](../../../ROADMAP.md#proposing-a-gateway-dependent-feature),
> the shape is decided in the Nimbus and nimbus-sdk repos, not here. This
> document is the whole cross-repo design; each upstream repo carries its own
> slice.

## The gap this closes

**C2.1** shipped two of the three review questions the demo pitch promised:
*what breaks if it lands* (`agents.impact`) and *who should review it*
(`agents.expert`). The third — *why does this change exist* — was dropped, and
the roadmap recorded why: `agents.why` takes `{ ref, line? }` where `ref` is a
**local filesystem path** resolved against configured `[[filesystem.roots]]` and
answered by **git blame on a local checkout**. A browser on a pull request page
has neither the path nor, necessarily, the repo cloned at all.

**C2.4** proposed two directions to close it: (a) a PR-shaped variant of `why`
the gateway exposes over HTTP, sketched as "resolving `ref` from the PR's diff
hunks against a checkout the *gateway* already has"; or (b) recasting the
question as "why was this PR opened" answered from `agents.expert`'s inputs.

**Neither is what this design does, because reading the upstream source made a
third, much smaller option visible.** Direction (a)'s sketch is unnecessary: no
diff hunks, no checkout, no blame.

## What upstream actually is

Read from `nimbus-agent/Nimbus` at `34a08e30`.

`agents.why` runs six lanes (`packages/gateway/src/agents/why.ts:91-96`):
authorship, pull_request, ticket, discussion, driver, downstream. **Only
authorship genuinely needs git blame.** Four of the remaining five open with
some variant of:

```ts
const sha = lane.blame?.commitSha;
const pr = sha === undefined ? null : findPrForSha(db, sha);
```

They are already PR-centric. Blame is not their subject — it is the *adapter*
that gets from "a file line" to "the pull request that changed it". A caller who
already has the pull request does not need the adapter.

Three further facts settle the shape:

1. **`why` is already reachable over HTTP.** `HTTP_EXCLUDED_AGENT_METHODS`
   (`packages/gateway/src/ipc/agents-rpc.ts:913`) holds only `preflight`,
   `premortem` and `whyPeek`. `POST /v1/agents/why` is callable from the
   extension today; it merely demands an input a browser cannot supply. So this
   is a **params-only** contract change: no new method, no allow-list edit, no
   clip-token scope change.
2. **The clipper never sees the gateway's brief types.** Its `done` arm carries
   `brief: string` — the gateway's *rendered* text — and `findings` is
   deliberately unmodelled (`src/shared/types.ts:432-438`). Every type decision
   below is invisible to this repo.
3. **PR-URL resolution already exists, and is wrong.** See §2.

## Decision

Extend `agents.why` with a second, explicit input: `{ prUrl }` **XOR**
`{ ref, line? }`. One method, one set of lanes, one result type; the caller says
at the type level which question it is asking.

Rejected alternatives:

- **Overload the existing `ref`** to also accept a PR URL. Smallest diff, but
  `ref` would mean three things (path, symbol, PR URL), `requireWhyParams` is
  shared with `whyPeek` — which would then have to reject a value its own
  validator accepts — and the returned `WhySubject` is file-shaped with nothing
  sensible to put in it.
- **A new agent, `agents.whyChange`.** Cleanest naming — *why does this line
  exist* and *why does this change exist* really are different questions — but
  it pays for that distinction by forking machinery (coordinator, emit-brief,
  synthesis, four lanes, the result type, a CLI command) that would immediately
  need re-sharing.

## 1. The contract

### 1.1 SDK (`nimbus-sdk`, TypeScript binding only)

`WhyBrief`, `WhySubject` and `WhyFinding` are SDK-owned
(`sdks/typescript/src/agents/brief-composites.ts:122`), consumed by the gateway
as `@nimbus-dev/sdk@^1.11.1`. The Python binding does **not** mirror brief types
(it carries `ipc`/negotiation only), so this is a TypeScript-only change.

```ts
export type WhyChangeSubject = {
  itemId: string;          // index item primary key, e.g. "github:acme/web#482"
  entityId: string;        // graph_entity.id for the pr
  repo: string;            // "acme/web"
  number: number | null;
  url: string;
  title: string;
  modifiedAt: number | null;
};

export type WhyBrief = AgentBriefBase & {
  kind: "why";
  query: { ref: string; line: number | null };
  subject: WhySubject | null;
  changeSubject?: WhyChangeSubject | null;   // NEW
  findings: WhyFinding[];
};
```

**Additive and optional, so the release is a minor, not a major.** `WhySubject`
is untouched; every existing consumer keeps compiling.

**Why `subject: null` alongside `changeSubject` is not the lie it looks like.**
`null` means "I could not resolve your ref", and today the CLI renders it as
``Could not resolve `<ref>` to an indexed location.`` — which would be flatly
false for a pull request that resolved fine. The closure argument is that a
brief carrying `changeSubject` can only exist if the caller passed `prUrl`,
which requires a gateway new enough to have shipped this design. A consumer that
never sends `prUrl` can never receive such a brief. The renderer in the same
slice (§4) branches before the null check, so no shipped surface prints the
false line.

**`query.ref` carries the PR URL on this arm**, with `line: null`. `query` is an
echo of what was asked, and `agents.impact` sets the precedent for one field
holding either shape (`query: { fileOrPrUrl }`).

### 1.2 Gateway params

```ts
export type WhyInput =
  | { ref: string; line?: number }
  | { prUrl: string };
```

`requireWhyParams` accepts exactly one of the two arms and rejects a payload
carrying both. `whyPeek` keeps a validator that accepts `ref` only — it stays
synchronous and HTTP-excluded, and nothing about this design changes that.

## 2. The shared PR resolver — and the impact defect it fixes

`agents.impact` resolves a PR URL by **reconstructing** an identity
(`packages/gateway/src/agents/impact.ts:136-158`):

```ts
const PR_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;
const service = HOST_TO_SERVICE[host] ?? hostFirstSegment;
const externalId = `${service}:${owner}/${repo}#${prNum}`;
```

That has three independent failure modes, and this repo's `recognise.ts` offers
the **impact** lane on pages hitting all three:

1. **The regex is GitHub-shaped.** GitLab's `/-/merge_requests/N` and
   Bitbucket's `/pull-requests/N` (Cloud and Server both) do not match, so those
   URLs fall through to a symbol lookup and then a `LIKE '%url%'` scan over item
   titles.
2. **The service is guessed from the hostname.** A self-hosted instance at
   `git.acme.com` derives `"git"`, which matches no connector's service id —
   and self-hosted origins are exactly what **C1.4** made configurable here.
3. **GitLab merge requests are keyed with a bang, not a hash.**
   `gitlabMrExternalId` produces `group/project!482`
   (`connectors/_lib/gitlab/events.ts:61`), matching GitLab's own `!482`
   convention, while GitLab *issues* use `#`. Even a corrected regex would never
   have matched a GitLab MR entity.

Nimbus indexes pull requests from all three forges (`github-sync.ts`,
`bitbucket-sync.ts`, `_lib/gitlab/events.ts` all upsert `type: "pr"`), so this
is coverage lost to parsing, not to missing data.

**The fix is to stop parsing and ask the index:**

```text
prUrl → resolveItemByUrl(db, url) → the item → graph_entity WHERE type = 'pr' AND external_id = item.id
```

The final join holds because `syncPrGraph` writes the pr entity's `external_id`
as the **item primary key** (`graph/graph-populator.ts:250`, `externalId: row.id`).

One new module, `packages/gateway/src/agents/_lib/pr-subject.ts`, exporting
`resolvePrSubject(db, url): WhyChangeSubject | PrResolveMiss`, where the miss
arm distinguishes `not_indexed`, `ambiguous` (`resolveItemByUrl` declines rather
than guessing between trimmed candidates) and `not_a_pr` (the URL resolved to an
indexed item that is not a pull request — a Jira issue, a wiki page).

This is correct for every forge, every URL shape and every self-hosted instance
without a host table, because the item was indexed under its own `canonicalUrl`
and the graph entity keys off the item id. It is the same resolution path
`/v1/items/resolve` already gives this extension.

**`agents.impact` moves onto it too.** Its symbol and topic fallbacks stay for
non-URL input; only the PR branch is replaced. The defect is confirmed with a
failing test on a GitLab MR URL before the fix lands — it is a claim about
upstream behaviour read from source, and it gets proven, not assumed.

## 3. The lanes

`LaneInput` grows a resolved `pr` field, filled from either entry point:

```ts
type LaneInput = {
  subject: WhySubject | null;        // file entry only
  blame: BlameLookup | null;         // file entry only
  pr: ResolvedPr | null;             // both entries
  occurredAt: number | null;         // blame author time, or the PR's own timestamp
};
```

On the file entry, `pr` is filled exactly as today (blame → sha →
`findPrForSha`). On the PR entry it comes from the resolver, and blame is never
spawned — no `[[filesystem.roots]]`, no checkout, no `git blame` process.

| Lane | PR entry |
| --- | --- |
| `pull_request` | works unchanged — the PR *is* the subject |
| `ticket` | works unchanged (`ticketRowsForPr`) |
| `discussion` | works via the PR; commit-message threads still need the `merged_as` SHA, which the graph holds when the connector recorded a merge |
| `driver` | works, keyed off `occurredAt` (the PR's timestamp instead of blame's author time) for its 48h window |
| `authorship` | **returns nothing.** Line-level blame has no meaning for a whole change |
| `downstream` | **returns nothing.** It needs a file subject — and the question it answers is the shipped **impact** lane, sitting directly above this one in the same panel |

The lanes stop knowing where their PR came from, which is the point: this design
adds an entry point, not a code path.

## 4. Saying what is missing, without a new gap category

Two lanes returning nothing must be disclosed — a silently shorter brief is the
kind of quiet betrayal C2.1's notes went out of their way to avoid.

**Gap notes are the wrong instrument here.** `GapCategory` is a closed
five-value union in the SDK (`missing_entity_type`, `missing_relation_emit`,
`missing_connector`, `missing_user_identity`, `empty_index`) and every member
describes *an absence in your index*. Two lanes that do not apply to the shape
of the question are not an index gap. Widening that union would break
consumers' exhaustive switches, turning a minor release into a major one to
solve a copy problem.

Instead `renderWhySubjectLine` (`agents/_lib/render.ts:283`) branches on
`changeSubject` **before** the existing null check, and names the pull request
it resolved along with what this entry point cannot answer and where to get it
(`nimbus why <file>:<line>` for authorship; the impact lane or
`nimbus impact <url>` for downstream). One render change, no type change — and
because the panel renders the gateway's text verbatim, the browser inherits the
disclosure with no client work.

## 5. The client lane (this repo)

Entirely on paths **C2.5** already paved:

- `src/shared/types.ts` — `AGENT_LANES` grows a `why` member; `LANE_RULES` gets
  an entry with `input: "page"` and `surfaces: ["pr"]`, so it gates exactly as
  `impact` and `expert` do. A Jira issue or a Jenkins build never offers it.
- `src/shared/messages.ts` — the lane id is a cross-boundary value; it is
  guarded like every other one.
- `src/background/handlers.ts` — `agentParams` sends `{ prUrl: resolveUrl }`,
  the same URL `impact` is already given.
- `src/panel/` — no new renderer. The `done` arm is `brief: string`, rendered
  with `textContent` as the other lanes are.

It appears under both the `resolved` and the `chosen` header, so a candidate
picked on an ambiguous page offers it too — the C2.5 rule that a user's answer
is not thrown away one control later.

**Lane title:** *Why does this change exist* — the roadmap's own words, and the
question the panel is answering.

## 6. Sequencing — three repos, one chain

The type is SDK-owned, so the ordering is forced:

1. **`nimbus-sdk`** (`dev/asafgolombek/why-pr-subject`) — `WhyChangeSubject`,
   the optional `WhyBrief` field, docs. Merge, then release-please cuts the
   minor and publishes to npm.
2. **`Nimbus`** (`dev/asafgolombek/why-from-a-pr`) — bump the dep, then:
   `pr-subject.ts`, the impact fix (failing test first), `why`'s `prUrl` arm,
   the lane refactor, the render branch, `nimbus why <url>` in the CLI, tests.
3. **`nimbus-web-clipper`** (`worktree-c2-4-why-from-a-pr`) — the lane, the
   gate, the guard, tests, `CHANGELOG.md`, and C2.4 in `ROADMAP.md` flips
   🟡 → ✅ with a status note recording what shipped versus what was briefed.

Steps 2 and 3 can be written before step 1 publishes; only step 2's dependency
bump blocks on it.

## 7. Testing

- **SDK** — a type-level test that an old-shaped `WhyBrief` still satisfies the
  new type (the non-breaking claim, enforced rather than asserted).
- **Gateway** — `pr-subject.test.ts` covering all four URL shapes, a
  self-hosted host, the GitLab bang key, and each miss arm; the GitLab-MR
  regression test for `impact`; `why` tests for the `prUrl` arm proving the four
  lanes answer and blame is never spawned; a render test for the subject line
  under `changeSubject`; an `agents-rpc.why` test rejecting both-arms and
  `whyPeek` rejecting `prUrl`.
- **Clipper** — `LANE_RULES` gating (the lane is offered on a PR and on no other
  recognised surface), the message guard, `agentParams`, and panel rendering
  under both `resolved` and `chosen`. The e2e checklist gate covers the panel
  surface as it does for the other lanes.

## Non-goals

- **Making `why` answer without an index.** If the PR is not indexed, the lane
  says so. Targeted sync (**C3.1**) is the existing answer to that, reachable
  from the same panel.
- **A `whyPeek` over HTTP.** Still synchronous, still excluded; unchanged.
- **Blame from the browser.** Nothing in this design spawns `git blame` for a PR
  entry, and no `[[filesystem.roots]]` configuration is required for the lane to
  work.
- **Recasting the question** (C2.4's direction (b)). The four surviving lanes
  answer *why does this change exist* from indexed evidence — tickets,
  discussions, drivers — which is a better answer than the PR description
  paraphrased back to the reader.
