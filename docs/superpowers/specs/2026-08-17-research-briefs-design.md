# Research briefs from your open tabs

**Status:** design, approved 2026-08-17. Implements a roadmap item that **does not exist
yet** — see *Corrections to the roadmap*. It supersedes **5.1**, re-aims **2.3**, and
delivers the first real half of **C4.1**.

**Upstream read at:** `Nimbus` @ `8a64e4f8` (`origin/main`, `chore: release main (#1233)`).
Every contract claim below was read from that source, not from a fixture in this repo.

**Branching:** on `main` (`fd07ef4`). Nothing is stacked.

## What this builds

You have six tabs open — four pull requests, two design docs — and a question that spans
them. Today the only way to ask it is to read all six yourself. This slice adds a page
that captures the tabs you pick, sends them to your gateway as the sources of a research
brief, and renders the answer: a summary, findings that cite the source they came from,
**conflicts** where two of your sources disagree, and an honest list of what the brief
could not cover.

The gateway surface this consumes already shipped. This is a client for it.

## Why this is unblocked now

The roadmap's **5.1 "Ask-your-clips"** is tagged 🟡 with the dependency *"a query/QA
endpoint on the gateway (e.g. `POST /v1/clips/ask` → answer + source hits). Propose there
first."*

That dependency landed, in a different and better shape than 5.1 guessed. There is no
`/v1/clips/ask`. There is a five-route **research briefs** surface, bearer-authed under
its own scope, already present in `HTTP_ROUTE_AUTH`:

| Step | Route | Shape |
| --- | --- | --- |
| create | `POST /v1/briefs` | `{brief, sources:[{url,title}], useIndex}` → `{id, status:"collecting", expected}` |
| feed | `POST /v1/briefs/{id}/sources` | `{url,title,body,capturedAt,truncated}` → `{accepted, received, expected}` |
| run | `POST /v1/briefs/{id}/run` | → `{status}` |
| poll | `GET /v1/briefs/{id}` | → `{status, report?, failureReason?}` |
| save | `POST /v1/briefs/{id}/save` | → `{itemId}` |

Two things make it clear this surface was designed for a client like this one.
`brief-constants.ts` sets `MAX_SOURCES_PER_RUN = 20` with the comment *"The client caps its
composer at this number"*, and sizes `MAX_SOURCE_BYTES` (256 KB) *"against the client's
200 KB extraction cap"*. It is waiting for a source collector. This extension is one.

The four caps this client must respect, all from `brief-constants.ts`:

| Cap | Value | Applies to |
| --- | --- | --- |
| `MAX_SOURCES_PER_RUN` | 20 | sources declared at create |
| `MAX_SOURCE_BYTES` | 256 KB | one source's body + title + url |
| `MAX_RUN_BYTES` | 4 MB | all held source text in one run |
| `MAX_BRIEF_CHARS` | 4000 | the question itself |
| *the client's own extraction cap* | **200 KB** | one source's body, before it is fed |

That last row is not ours to choose. `MAX_SOURCE_BYTES`'s comment reads *"256 KB against the
client's 200 KB extraction cap, leaving headroom for JSON escaping and multi-byte text"*, and
`MAX_RUN_BYTES`'s reads *"DELIBERATELY NOT `MAX_SOURCES_PER_RUN * MAX_SOURCE_BYTES` … A
conforming client (20 x 200 KB) lands exactly on it."* The gateway's per-source ceiling is
256 KB **with headroom**; 200 KB is the figure the run budget was sized against. Decision 5
is where that matters.

The report is richer than an agent lane's single `brief` string
(`briefs/brief-types.ts`):

```ts
type Report = {
  summary: string;
  findings: ReportItem[];
  conflicts: ReportItem[];   // every entry carries >= 2 distinct citations
  gaps: string[];
  synthesis: { model: string; remote: boolean; disclosure?: string };
};
type ReportItem = { text: string; citations: SourceRef[] };
```

Quotes inside a citation are verified verbatim against the fed body upstream
(`quote-verify.ts`), so a quote this client renders is a real span of a real source.

## The decisions

### 1. Sources are the tabs you have open

This is the one thing a browser surface can do that the terminal and the editor
structurally cannot: *"the six things I have open right now."* The reframe's whole
argument for a browser client is context the other surfaces don't have, and an open-tab
set is exactly that.

It also uses the contract as built. Conflict detection needs ≥2 sources to say anything at
all, so a single-page brief would ship the feature with its most distinctive output
permanently empty.

### 2. No new manifest permission — and the permission axis lines up with the capability axis

`chrome.tabs.query` returns a `Tab` for every tab, but strips `url`, `title` and
`favIconUrl` unless the extension holds `tabs` **or** host permission for that tab's URL.
The composer must *extract* from each source tab, which needs host permission anyway. So
the set of tabs the picker can name is exactly the set it can use. Nothing is listed that
cannot be captured, and nothing capturable is hidden.

Adding `tabs` was considered and rejected on three counts: it reads to a Chrome user as
"read your browsing history" on an extension whose pitch is minimal permissions; it
contradicts the recorded `activeTab`-deliberately-not-`tabs` decision; and
`test/unit/store-listing.test.ts` asserts the back-ticked keys under
`## Permission justifications` equal `composeManifest().permissions` plus the two host
lists *exactly*, so it would fail `bun run test` until the store copy justified a
permission we do not need.

This is the second thing **C1.4**'s per-host grant buys, and the first that needs it on
more than one tab at a time.

**Tabs on ungranted hosts are counted, not named.** Without their URL the client cannot
honestly describe them, so the composer reports *"3 open tabs are on sites you haven't
granted page access to"* with a link to Options. Counting is possible because the `Tab`
object still arrives; naming is not.

**An inline `chrome.permissions.request` from the composer cannot work, and the reason is the
sentence above.** The API takes a concrete `origins` list, and the origins of exactly those
tabs are the thing this client cannot read — that is the whole point of the grant being
missing. The only request that *would* succeed is the broad `http://*/*` pattern, which is
what **C1.4** exists to refuse. Options stays the place a grant happens, from a row that names
a host the user chose.

What the composer does owe the user is that the round trip is not wasted: it re-enumerates on
`chrome.permissions.onAdded` and on regaining focus, so returning from Options shows the newly
granted tabs without a manual reload.

### 3. The question is scaffolded by what the tabs are

`ROADMAP.md`'s non-goals are explicit: *"Not a generic ask box. The surface should know
what page it is on. If a feature only works by asking the user to type what they are
looking at, it is the wrong feature for this client."*

A free-text `brief` field is exactly that ask box, so it does not lead. `recognise.ts`
already classifies each tab; the *shape of the set* selects a question list:

| Set shape | Offered questions |
| --- | --- |
| ≥2 pull requests, same product | *What do these changes disagree about?* · *What breaks if all of these land?* |
| ≥2 issues | *What is the common thread?* · *Where do these contradict each other?* |
| Mixed recognised surfaces | *How do these relate?* · *Where do these contradict each other?* |
| Nothing recognised | *Where do these contradict each other?* · *What do these agree on?* |

You pick one. A collapsed **Ask your own question** control sits below the list and expands a
plain text field — the surface leads with what it already knows, and typing is the fallback
rather than the entry.

It is a collapsed control, not a warning or a confirmation step: a user who arrived with a
specific question in mind should reach it in one click and meet no friction there. The
non-goal this decision serves is about which affordance *leads*, not about discouraging
anyone from typing. (An earlier draft of this spec called it "a disclosure", which read as a
privacy notice — this document uses "disclosure" throughout for the remote-model disclosure
of decisions 7 and 9, and reusing the word for a UI widget in the same breath was a genuine
collision.)

The mapping is a pure function of the recognised set, so it is a table plus a fixture
test, and adding a question is one row.

### 4. Declare everything you picked; feed what actually captures

`BriefRun.declared` is fixed at create and *"never grows"*, and the upstream e2e suite
proves a partial feed still finishes: *"feeding 1 of 3 sources still finishes, and the
report's `gaps` mention '2 of 3'"*.

So all picked tabs are declared at create, and a tab that cannot be read — restricted
page, navigated away between pick and capture, extraction failure — does not abort the
brief. The gateway's `gaps` reports the shortfall as a count; the client says *which*
tabs and *why*. Those are complementary, not duplicative.

The alternative — capture first, declare only the survivors — was rejected because it
produces a report with no `gaps` entry and therefore hides the shortfall. That is routing
around the contract's own honesty mechanism.

### 5. An over-cap body is truncated and declared, not dropped

`BriefSource.truncated` is a contract field. That makes truncate-and-flag the sanctioned
behaviour here, and it is the exact opposite of this repo's clip path, which never
truncates — because `POST /v1/clips` has no way to *say* it did, so a truncated clip would
be a silent lie (the defect Nimbus#1005 actually was). Here the wire can say it, so we say
it: `truncated: true` goes on the payload and the composer names the shortened sources in
the result.

**The cut is at 200 KB, the client's own extraction cap — not at the gateway's 256 KB
ceiling.** This is load-bearing arithmetic, not a rounding preference.
`MAX_RUN_BYTES / MAX_SOURCE_BYTES` is exactly **16**, so a client that truncated at the
per-source ceiling would fit only sixteen sources into a run whose declared limit is twenty:
the seventeenth feed would be refused, every time, on any brief with seventeen or more tabs.
Truncating at 200 KB puts twenty sources at ~4.10 MB against a 4 MiB (4,194,304-byte) budget
— it fits, with room for the title and url bytes that also count toward it.

Feeding still guards against the refusal rather than assuming the arithmetic holds, because
`bytes` counts title and url too and neither is bounded by the extraction cap. The guard is
decision 5b below, not a byte budget the client recomputes: the gateway already reports the
condition precisely, and a partial run is a supported outcome.

### 5b. `run_capacity` and `source_too_large` are different answers to the same status code

Both arrive as `413` with `error: "payload_too_large"`, and the upstream e2e suite exists in
part to prove they stay distinguishable — the difference is the `detail` field:

| `detail` | Meaning | Client response |
| --- | --- | --- |
| `source_too_large` | This one source exceeds `MAX_SOURCE_BYTES` | Should not happen after decision 5's cut. If it does, re-cut that source and retry it once. |
| `run_capacity` | This source would push the *run* past `MAX_RUN_BYTES` | Stop feeding. The sources already accepted still produce a report, and its `gaps` name the shortfall. |

Collapsing both into "payload too large" would turn a run that is *complete enough to
answer* into what looks like a client bug. A client-side global byte allocator was considered
— dynamically lowering the per-source cut to `MAX_RUN_BYTES / count` — and rejected: it
duplicates accounting the gateway already does exactly (including the title and url bytes the
client would have to guess at), and it degrades every source on a run that the contract would
have answered fine with one source dropped and named.

### 6. Briefs are never queued, and no source text is ever persisted

The offline queue exists because a clip payload can be persisted and sent later. A brief's
source bodies are ephemeral by contract — `BriefSource.body` is *"EPHEMERAL — never
written to disk"*, cleared the moment a run goes terminal — and this client must not hold
what the gateway refuses to hold. An unreachable gateway mid-brief is therefore a plain
failure you re-run, not work that drains later.

The same rule bounds every write to `chrome.storage.local` in this slice: the in-flight run
record (`{id, declared, status, received, expected}`) and the disclosure log of decision 9.
Neither contains source text. The client's privacy promise stays identical to the gateway's
rather than quietly weaker than it.

### 7. Nothing claims the synthesis stayed local, because the client cannot know

This is the sharpest decision in the slice.

`createBriefLlm` (`briefs/brief-llm-adapter.ts`) resolves `[briefs].prefer_local` and falls
back to a remote provider *"only when no local provider is available"* — so even
`prefer_local = true` can go remote. And there is no pre-run signal the client could read:
`GET /v1/health` returns `{status:"ok", gateway:"read_only_http"}` and nothing else,
`/v1/admin/status` requires the **admin** token which this client does not hold, and
`[briefs].prefer_local` is gateway-side config with no read surface.

So the client would be sending the largest payload in its history — the full text of up to
twenty pages — without being able to say where it lands. Consequences:

- **The pre-run confirmation states the uncertainty plainly.** It names every source and
  the question, then says synthesis may run on a local or a remote model depending on
  gateway configuration. It never says "stays on your machine".
- **There is no off switch**, the same reasoning C4.2 applied to the targeted fetch: this
  is a larger egress than a fetch, not a smaller one.
- **The post-run banner is authoritative.** `synthesis.remote` and `synthesis.model` are
  what actually happened, reported after the fact.

One reframing keeps this proportionate: **feeding is not egress.** `POST
/v1/briefs/{id}/sources` goes to `127.0.0.1`, the same trust level as `POST /v1/clips`, and
the body is held in memory only. The egress moment is `/run`.

**The upstream half of this is being proposed in parallel**, in the `Nimbus` worktree
`briefs-prerun-disclosure`: a pre-run signal so a future version of this page can name the
destination instead of describing the uncertainty. This slice does not wait for it, and
does not pretend to it.

### 8. The egress ledger does not cover this, and that is why decisions 9 and 10 exist

**Corrected from an earlier draft of this spec, which claimed the ledger recorded a brief's
model call. It does not.**

`egress/egress-coverage.ts`'s `THIS_BINARY_COVERAGE` is the machine-readable claim about
what this gateway binary observes:

```
task: per-call   mcp: per-call   http: per-call   sync: per-run
session: none    model: none     peer: none
```

Two of those entries matter here, and both are narrower than their names suggest — the
file says so itself. The `http` entry is *"`per-call` over exactly one thing: an `agents.*`
brief served to a caller verified on the local HTTP API. It is NOT 'everything on the HTTP
API'."* And `model` — declared in `egress-source-type.ts` as *"inference + embeddings, local
or remote"* — is **`none`**, with the header noting that later phases raise it and that
*"raising an entry without landing its appender is the exact defect this vector exists to
prevent."*

So when a brief runs and its source text goes to a model, **no ledger row is appended** and
`nimbus prove` will not show it. The mistake is easy to make because
`egress/agent-brief-egress.ts` *does* exist and *does* append — for `agents.*` briefs
dispatched through `agents-rpc.ts`, which is a different route from `/v1/briefs`.

The only disclosure that exists anywhere is `synthesis` inside the report, and without
persistence that dies with the run's 30-minute TTL. A feature whose sole record of its most
sensitive action evaporates is not honest, so this slice makes that record durable twice
over — once in the user's index, once locally.

### 9. A local disclosure log, because for this egress class there is nothing to disagree with

An append-only local record, one entry per run that reached `/run`:

```
{ runId, at, question, sourceCount, truncatedCount, model, remote, savedItemId? }
```

No source text, no bodies, no URLs beyond what the user already picked. It lives in Options
**stage 4** — the "Where does my data go?" trust panel — which is where a user already goes
to ask this question, and which makes C4.1's future gateway-fetch list a sibling section
rather than a second place to look.

**C4.1's stated caution does not bind here.** Its brief says *"the client should read the
gateway's record rather than keep a private one it could quietly disagree with."* That is
right whenever a gateway record exists — and for `model`-class egress none does. A local
record cannot disagree with a record that was never written.

Bounded like every other store in this repo, but bounded *generously*: an entry is on the
order of 200 bytes, so a cap in the hundreds costs well under a megabyte of
`chrome.storage.local` and makes eviction a theoretical path rather than a routine one. FIFO,
oldest first, with a user-facing control to clear it. The cap is stated in the UI rather than
silent, because a log that quietly forgets is worse than one that says it only keeps the last
N.

**Eviction favours keeping *unsaved* runs, which is the opposite of the intuitive rule.** A
saved brief's disclosure is durable upstream — `brief-save.ts` persists `synthesis` as its own
metadata field on the `research_brief` item, not merely inside the report body — so evicting a
saved run's log entry loses a pointer, not the record. An unsaved run's log entry is the
*only* record that the egress happened anywhere. So if the cap is ever reached, unsaved
entries are the ones worth keeping.

This is also why the log's cap is the client's own number and unrelated to the gateway's
`MAX_RETAINED_TERMINAL_RUNS` (16). That constant bounds how many finished *runs* the gateway
holds for `GET`/save; it has no bearing on how many disclosures this client remembers, and
tying them together would shrink an egress record to the size of a server-side memory
budget.

### 10. Saving is the user's call, and the two records answer different questions

`POST /v1/briefs/{id}/save` mints a `research_brief` item carrying the report — the durable,
gateway-side home for the disclosure. It is an explicit button on a finished brief, never
automatic: what enters your index is your decision, and a brief you ran to answer a passing
question does not have to become a permanent item.

`MAX_RETAINED_TERMINAL_RUNS` is 16 and the TTL is not refreshed on access, so save can fail
with 404/410 on a run that finished a while ago. That is a real state, not a theoretical
one, and it renders as "this brief is no longer available to save" rather than an error.

**A saved brief can differ from the one you read, and the UI says so when it does.** Saving
bounds the report against the item metadata ceiling (64 KB); over it, `brief-save.ts` strips
the supporting quotes and appends the gap *"Supporting quotes were omitted from the saved copy
(size limit)."* The client does not need to implement that — but it must not present Save as a
lossless "keep this", so when the saved report comes back carrying that gap, the confirmation
names it. Silently saving a thinner copy of what the user just read is a small betrayal of
exactly the kind this design keeps refusing.

**The two records cannot contradict each other, by construction.** The local log records
*what this extension did* — on this date, N pages were sent for synthesis, the model was X,
remote yes/no. The saved item records *what the brief said*. If the user later deletes the
saved item, the log entry stays true, because it never claimed the item still exists; its
`savedItemId` is a pointer that may dangle, rendered as "no longer in your index" rather
than removed. Deleting a log entry because an index row went away would erase the record of
an egress that really happened, which is the one thing this log exists to prevent.

### 11. Its own page, because the panel pins one page on purpose

The panel deliberately sticks to the page it was opened on — the 2026-08-11 page-context
slice exists precisely so its header and its lanes cannot describe different items. A
brief spans many tabs. Putting it in a panel lane would fight that invariant rather than
extend it, in a file already 1,256 lines long.

The popup was ruled out on a harder mechanic: it is destroyed on blur, and a brief run
outlives it, so clicking away mid-run would lose the composer and the report.

So: `brief.html`, a normal extension page opened in a tab. Full width for a report with
findings, conflicts, citations and gaps; survives navigation and blur; needs no injection,
no `web_accessible_resources`, and no shadow-root style inlining.

**Two entry points, both click-driven** — a button in the popup and a link in Options
stage 2. Neither is a `commands` entry, which sidesteps the `suggested_key` trap **C1.5**
was written to fix: a shortcut the browser silently declines to bind.

## Shape

The service worker owns the run; the page subscribes. That mirrors the existing
`agent-run` / `agent-state` contract, so this codebase keeps **one** MV3 eviction story
rather than two.

```
composing ──pick tabs + question──▶ confirming ──Send──▶ creating
                                        │                    │
                                    (cancel)          POST /v1/briefs
                                        ▼                    ▼
                                    composing           feeding ──capture tab i, POST /sources──┐
                                                            │   ◀───────── i < expected ────────┘
                                                            ▼
                                                        running ──POST /run, then poll GET /{id}
                                                          │   │
                                                       done   failed
                                                          │
                                                    (Save) ▼
                                                        saved ──▶ {itemId} into the log entry
```

The disclosure-log entry is written when `/run` is accepted — the moment the egress
happens — not when the report arrives. A run that fails during synthesis still sent its
source text, so it still gets an entry, with the model fields absent and the failure
recorded. Writing the entry only on `done` would omit exactly the runs where something
went wrong.

Feeding is **sequential**, and the rate limit is not the reason — `brief-src` is its own
bucket at 60/min, commented upstream as ensuring *"a sweep feeding up to 20 sources
back-to-back cannot"* starve ordinary clipping, so twenty concurrent feeds would clear it
comfortably. Create, run and save share a separate `brief` bucket.

Three reasons that actually decide it, since a concurrency pool is the obvious optimisation
to reach for:

- **There is no network latency to hide.** Every feed goes to `127.0.0.1`. Sub-millisecond
  round trips do not benefit from pipelining, and the real cost of the collection phase is
  per-tab capture — `scripting.executeScript` plus Readability, running in each tab's own
  renderer — not the POST that follows it.
- **`run_capacity` attribution stops being deterministic.** Decision 5b relies on knowing
  *which* source was refused at the byte budget. Under concurrent feeds the gateway's
  `bytesHeld` accumulation decides that by arrival order, so the same twenty tabs could drop
  a different source on each attempt, and the report's `gaps` would vary run to run.
- **`received`/`expected` stops being a progress bar.** Sequential feeding makes it a
  monotonic count the page can render honestly; concurrent feeding makes it a number that
  jumps.

Pipelining *capture* one tab ahead of the feed would be safe on all three counts and is worth
revisiting if the collection phase measures slow on a real twenty-tab brief. It is not in this
slice: it adds an in-flight buffer to the state machine to solve a cost nobody has measured
yet.

Polling reuses the agent-lane pattern exactly, and **the ownership is not shared**:

- **The service worker is the only poller.** The live cadence is a `setTimeout` backoff in
  the worker (`service-worker.ts:397` is the existing one, generation-guarded), never in the
  page. `chrome.alarms` is the eviction net only — its one-minute floor is far slower than a
  poll cadence, and that floor matters more here than for agent lanes, since synthesis over
  up to 4 MB of source text can genuinely outlast a worker.
- **The page never polls and never talks to the gateway.** It sends a message and renders
  what comes back, exactly as `panel-in-page.ts` does for lanes: one sender of `brief-run`,
  and `brief-state` messages pushed from the worker as each transition is persisted.
- **A resurrected worker pushes, it does not answer a question nobody asked.** On the
  eviction-net alarm the worker resumes the run from `brief-run-store.ts` and broadcasts
  `brief-state`. If the page is open it re-renders; if it is closed the broadcast goes
  nowhere and the store is still correct.
- **Reopening the page re-reads the store**, it does not restart the run. Same rule the agent
  lanes settled on: a stored terminal result replays rather than re-invoking. Re-running a
  brief would mean feeding source text a second time, which is the one thing this design is
  most careful about.

So there is no duplicate-request window, because there is only ever one poller and it is not
in the page. This is stated explicitly because "the worker owns the run" plus "a `setTimeout`
backoff for the live cadence" left it genuinely ambiguous in an earlier draft.

`useIndex` is `false` for this slice. The tabs are the point, and an index toggle is a
second axis of explanation the first version does not need.

## Layers

| Module | Purpose | Kind |
| --- | --- | --- |
| `src/shared/brief.ts` | Recognised-set → question list; create/feed payload builders; the four caps | pure |
| `src/shared/brief-report.ts` | `Report` guards; the `gaps`/`disclosure` equality filter | pure |
| `src/shared/brief-log.ts` | Disclosure-log entry shape, guards, eviction rule | pure |
| `src/shared/preview.ts` | Extended: a third preview kind for a brief run | pure (exists) |
| `src/background/brief-client.ts` | The five routes + status mapping | fetch seam |
| `src/background/brief-run-store.ts` | In-flight run state, mirroring `agent-run-store.ts` | DI |
| `src/background/brief-log-store.ts` | Append-only disclosure log over `chrome.storage.local` | DI |
| `src/background/brief-handlers.ts` | Sub-router for the brief messages | DI |
| `src/browser/tabs.ts` | Extended: enumerate candidate tabs; count the unnamed ones | seam (exists) |
| `src/brief/brief-view.ts` | Pure render — composer, progress, report | pure |
| `src/brief/brief.ts` + `brief.html` | The page | entry |
| `src/options/brief-log-view.ts` | Pure render of the log in trust-panel stage 4 | pure |

**`brief-handlers.ts` is a sub-router for a reason, not for tidiness.** S3776 caps
cognitive complexity at 15, and `service-worker.ts` is already a fourteen-branch router
that had `openPanelForCue` extracted to fit under it. Six new message kinds routed inline
would break the Sonar gate. The worker gains **one** branch that delegates.

Couplings that nothing else will remind us of:

- `ENTRIES` in `esbuild.mjs` **and** `REQUIRED_FILES` in `scripts/check-build.mjs`. The
  second is a hand-written literal array: adding the entry without it leaves the new bundle
  unguarded while `check-build` still prints OK.
- `ROADMAP.md` gains the item (below) and `CHANGELOG.md` an `## [Unreleased]` entry.
- `docs/architecture.md` gains a research-briefs section.
- `test/unit/doc-references.test.ts` walks `ROADMAP.md`, `docs/*.md` and `src/**/*.ts` for
  spec references and fails on a dangling one, so any reference to this file must match its
  real path.
- No permission changes, so `store/listing.md` is untouched. If that ever stops being true,
  `store-listing.test.ts` fails first.

## Failure surface

| Wire | Client state | Retry |
| --- | --- | --- |
| 401 | Needs re-pairing (existing path) | after re-pair |
| 403 + `scopeGap` | Pasteable `nimbus clip scopes …` line | after re-grant |
| 404 `briefs_disabled` | Named plainly, with the hint the gateway supplies | terminal |
| 404 `not_found` / 410 `expired` | The run is gone: discard local state, offer a fresh start | terminal-discard |
| 404 / 410 on save | "No longer available to save" — the report stays on screen | terminal |
| 413 `detail: source_too_large` | That source only — re-cut and retry it once | once |
| 413 `detail: run_capacity` | Stop feeding; run what was accepted, `gaps` names the rest | no |
| 429 | Surfaced on the page | manual |
| 503 `briefs_busy` | *"Your gateway is already running three briefs"* | manual only |

`briefs_busy` carries **no `Retry-After`** (asserted upstream), so the client offers a
button and never guesses a delay.

The 429 deliberately does **not** enter `rate-limit-pause.ts`. That machinery pauses the
clip queue; the gateway keeps `brief-src` and clip buckets separate precisely so one cannot
starve the other, and folding them here would undo that.

**The `briefs` scope needs no re-grant**, which is unique among this client's capabilities.
`api-scopes.ts` sets `LEGACY_SCOPES = ["clip", "briefs"]`, so every token paired before
scopes existed already carries it — the inverse of `resolve`, `fetch` and `agents`, each of
which hits 403 on a legacy token. A token minted *after* scopes exist can still lack
`briefs` if the owner narrowed `--scopes`, so the `scopeGap` path stays as the net; it just
will not be the common case.

## Testing

Pure modules get direct unit tests: the question table against a fixture set of recognised
tab shapes, the payload builders against all four caps, the `Report` guards against the
upstream shapes including a remote `synthesis`, the `gaps`/`disclosure` equality filter,
and the log's eviction rule at its boundary. `brief-handlers.ts` and both stores take
injected deps — no `vi.mock()`, per the repo convention. `brief-view.ts` and
`brief-log-view.ts` need the `// @vitest-environment jsdom` docblock.

Four assertions worth writing as tests rather than trusting to review, each pinning a decision
a later refactor could quietly undo:

- No storage write in this slice contains a source body.
- A log entry is written on a run that subsequently **fails**, not only on one that succeeds.
- **Twenty sources cut at the extraction cap fit inside `MAX_RUN_BYTES`** — the arithmetic of
  decision 5, asserted against the real constants rather than left as a comment. Cutting at
  256 KB instead would fit sixteen, and this is the test that fails if someone "simplifies"
  the cut to the gateway's ceiling.
- A `413` carrying `detail: "run_capacity"` stops feeding and still reaches `/run`, while
  `detail: "source_too_large"` retries that one source. Same status code, different behaviour.

**What the suite cannot prove, stated rather than implied.** The mock gateway builds its
`Request` from method and headers only and **drops the POST body**, so a staged protocol
whose entire behaviour is body-driven — `expected`, `received`, `accepted`, every cap — is
invisible to it. Brief fixtures are added for rendering and screenshots only. The protocol
itself, the caps, `briefs_busy`, the disabled-seam 404, save's 404/410 and anything
auth-shaped need a real gateway, and `docs/development.md` gains that checklist. A pass
against the mock is not evidence for any of it.

## Not in this slice

- **`useIndex: true`**, and therefore `kind: "clip"` citations.
- **Selections as sources.** Page bodies only; the feed payload supports a selection shape
  but the composer does not offer it yet.
- **The pre-run local/remote signal**, which is upstream work in the parallel worktree.
- **Re-running or editing a finished brief.**
- **Reading the gateway's own egress record** — the other half of C4.1, still blocked on a
  read surface that does not exist.

## Corrections to the roadmap

1. **The feature has no roadmap entry.** It gets one — a new phase item rather than a
   retag, because the shape it consumes is not the shape 5.1 predicted.
2. **5.1 "Ask-your-clips" is superseded, not delivered.** Its stated dependency
   (`POST /v1/clips/ask`) does not exist and, on this evidence, will not. Recorded the same
   way 3.4 was recorded as superseded by C1.3's ambient half, rather than silently
   retagged.
3. **2.3 "Highlight-stitching" is re-aimed.** Its reframe note already says the collect UI
   would have to live as a panel lane. A brief's source list is the better home for
   "assemble several things into one", and the selection half becomes a follow-up to this
   slice.
4. **C4.1 is half-delivered here, and its approach note needs qualifying.** It says to read
   the gateway's record rather than keep a private one. True for fetches; false for
   `model`-class egress, where `THIS_BINARY_COVERAGE.model` is `none` and there is no record
   to read. The item should say which half is which.
5. **C1.4's status line is stale.** It says the per-host grant "buys only gesture-free
   recognition, which **C2** is the first to need". C1.3's ambient half already dated that;
   this slice is the first consumer that needs the grant on several tabs at once.
6. **The "thirteen agents" figure is still stale**, as the 2026-08-13 correction already
   flagged without fixing globally. Not fixed here either — this slice consumes no agent —
   but noted again so the next reader does not treat it as verified.
