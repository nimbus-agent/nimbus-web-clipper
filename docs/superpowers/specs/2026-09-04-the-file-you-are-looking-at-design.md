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
  five agent lanes — `impact`, `expert`, `ownership`, and the two new
  `ghost` and `conflicts` — answered about the file the page shows, resolved
  against the reader's own checkout by the gateway. A file the gateway cannot
  place gets one honest sentence and no lanes.
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
lane, rather than have five lanes each discover the same miss. That was right,
and it had nothing to call.

The v1 surface is twenty routes and none of them resolves a forge coordinate.
`GET /v1/items/resolve` takes a `url` and runs `resolveItemByUrl` — the indexed
item resolver; a blob URL misses it. Resolution happens **only inside an agent
invoke**, so learning whether a file is answerable costs a real agent run and an
egress row for a question the user did not ask.

F1 and F2 have one cause and therefore one fix.

### F3 — `needsItemArm` is a cross-product, and the `expert` switch breaks it

`agents-capability.ts` computes the arm gate as
`ITEM_ARM_LANES × ITEM_ARM_SURFACES` — `{why, expert, ownership}` ×
`{issue, incident}`. Its doc comment correctly explains why the arm table cannot
be derived from `LANE_RULES`; it did not anticipate the arm table itself needing
pair granularity.

Switching `expert` on `pr` to the item arm requires flooring that one pair. Add
`pr` to `ITEM_ARM_SURFACES` and the cross-product also floors **`why` on `pr`**,
which sends `prUrl` — an arm every released gateway has served. The refactor is
forced by the switch, not optional alongside it.

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
built and tested: the `file` `SurfaceKind`; all three forge matchers emitting
`Match.forgeFile` with the opaque `refAndPath`; the `file` `LaneScope`; the
`file` `RunSubject`; `resolveForAgent`'s `file` arm (which correctly makes no
resolve call); and `agentParams`' forge arm, which returns before the per-lane
switch because every file lane sends the same shape.

What remains is the lane table, the probe, and the panel.

### 4.2 · The route is the capability signal — there is no second floor

The obvious move, following C6.1's precedent, is a `FILE_ARM_FLOOR = "7.6.0"`
mirroring `ITEM_ARM_FLOOR`. **Do not add one.**

`ITEM_ARM_FLOOR` exists because `GET /v1/agents` lists agent *names*, not their
*arms*, so a roster cannot say whether `why` accepts an item URL. That reasoning
does not transfer here. `GET /v1/items/resolve-file` ships in a release strictly
after 7.6.0, so **its presence proves the forge arm exists**. The panel has to
call it anyway. A direct capability probe beats a version string, and it cannot
drift the way a floor constant needs raising.

So the gate is the probe's own outcome, in three states that must never collapse
into two:

| Probe | Lanes | Banner |
| --- | --- | --- |
| `200 { ok: true }` | all five offered | — |
| `200 { ok: false, reason }` | none | the reason's sentence |
| `404` / unreachable | none | — |

The third row is byte-identical to how a file page renders today, because the
`file` surface offers zero lanes now. The rule C6.1 established — *not knowing
must leave the panel exactly as it renders without the read at all* — is
therefore satisfied for free, by a route that did not exist, rather than by a
floor that would need maintaining.

C7 consequently never reads `roster.version`, and `ITEM_ARM_FLOOR` stays the
only floor in the file.

### 4.3 · The lane table

`AGENT_LANES` gains `ghost` and `conflicts`, **appended** after `ownership`.
Order is render order, and appending is the rule `why` already followed: adding
a lane must not reorder what existing users see. Both are in upstream's
`EXTERNAL_AGENT_NAMES` (eleven agents), so the roster's name filter covers them
with no special case.

`LANE_RULES` gains `file: "file"` on `impact`, `expert` and `ownership`; the two
new lanes are `file`-only:

```ts
ghost:     { input: "page", surfaces: { file: "file" } },
conflicts: { input: "page", surfaces: { file: "file" } },
```

The `AGENT_LANES` doc comment currently explains that `ghost` and `conflicts`
are absent "because both require `{ file }` — a local checkout the browser does
not have". That is now false and must be rewritten, not deleted: the forge arm
is exactly how the browser names a file it has no checkout of.

### 4.4 · Where the probe lives

In `handleResolve`, which the panel already calls once per page. **Not** in
`resolveForAgent`, whose `file` arm makes no call today and must keep making
none — the probe is a page-level fact, not a per-lane one. That is §5.4's "one
resolution, not five", landing in the code that already resolves once rather
than in a new mechanism beside it.

The resolve response carries the probe's outcome alongside `offeredLanes`.

### 4.5 · The two sentences

Branched on the value, never on the prose:

- `remote_not_tracked` — Nimbus has no local checkout of `acme/web`, so it
  cannot answer about its files. Permanent, and nothing the reader can do from
  this page.
- `file_not_indexed` — the checkout exists and this path is not in it. A
  different situation with a different remediation.

Neither renders five empty lanes. This is #76's connector-health rule: a lane
that will answer nothing is worse than no lane, because an empty answer reads as
*there is nothing* rather than *I cannot see*.

### 4.6 · Files

| File | Change |
| --- | --- |
| `src/shared/gateway.ts` | `resolveFile` in `GATEWAY_PATHS` |
| `src/shared/types.ts` | two lanes in `AGENT_LANES`; four `LANE_RULES` edits; the `FileResolution` type |
| `src/background/gateway-client.ts`, `http-json.ts` | the read and its parser — three outcomes, not two |
| `src/background/handlers.ts` | the probe in `handleResolve`; `expert`/`pr`'s arm (§5) |
| `src/background/agents-capability.ts` | `needsItemArm` becomes a pair table (§5) |
| `src/shared/messages.ts` | the probe's outcome on the resolve response |
| `src/panel/panel-in-page.ts`, `panel-view.ts` | file header, five lane titles, the two sentences |

---

## 5. The C6.1 close-out

### 5.1 · `needsItemArm` becomes a pair table

Per F3, the cross-product cannot express `expert`/`pr` without also capturing
`why`/`pr`. It becomes a table of pairs. Its existing doc comment — which
already argues that scope and arm are two questions — extends to say that the
arm question is per-pair, and why the cross-product was only ever adequate
because every item-arm lane happened to share one surface list.

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

Four pins, three inherited from §5 and one that emerged from the reading:

1. **Neither `ghost` nor `conflicts` ever sends `namespaces`.** §5 wanted this
   to prevent an extension whose premise is loopback-only from making
   federation peer calls. Upstream now *refuses* that combination outright, so
   the test today protects against a 400 rather than against silent egress —
   the rationale changes, the test does not.
2. **`conflicts` emits `kind: "conflict"`**, singular. Parsed, never derived
   from the lane name.
3. **Each miss reason renders its own sentence**, branched on the value.
4. **`offeredLanes(roster, "file")` returns `null` on an unreadable roster** —
   "do not filter", i.e. offer all five — because no file lane needs the item
   arm. That is safe *only* because the probe gates the lanes upstream of it.
   Two mechanisms, one outcome, and nothing in the type system connects them.
   This is the coupled-and-unenforced shape this repo keeps being bitten by, so
   it gets a test naming both halves rather than a comment.

Plus the ordinary coverage: the three forge matchers already have fixtures; the
lane table's additions ride the existing exhaustiveness properties.

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
- The five file lanes on a self-hosted forge: they come for free through the
  configured-origin path, and need no separate work here.
