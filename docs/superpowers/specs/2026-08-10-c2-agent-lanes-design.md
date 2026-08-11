# C2 — Agent lanes on a resolved pull request

**Date:** 2026-08-10
**Status:** Design, approved. Implementation plan to follow.
**Roadmap items:** C2.1 *The code-review lanes* · 🟡 · L, and C2.2 *Progress, abort
and delivery under MV3* · 🟢/🟡 · M — which are one slice in practice: a lane
cannot ship without the polling machinery beneath it.

## What this builds

On a pull request the panel has resolved, expanding a lane runs the agent that
answers it and renders the brief in place.

Two lanes ship:

| Lane | Agent | Question |
| --- | --- | --- |
| What breaks if it lands | `agents.impact` | reverse-dependency blast radius |
| Who should review it | `agents.expert` | who has context on this subject |

This is the phase the previous three slices were groundwork for. Resolution
(#38, #41) established *which item this page is*; targeted fetch (#40) made a miss
actionable. Neither answered a question. These lanes do.

## The contract, read from merged upstream source

Verified against `C:/gitrep/Nimbus` at v1.26.0 — `ipc/http-write-routes.ts`
(`runAgentInvokeRoute`), `ipc/http-server.ts` (`handleAgentRunGet`,
`handleAgentsList`), `agent-runs/agent-run-store.ts`, `ipc/agents-rpc.ts`. Not
from the roadmap, which is wrong about this surface in two ways recorded below.

```
POST /v1/agents/{agent}      Authorization: Bearer <token>, scope `agents`
  body → passed VERBATIM to the gateway's own validator; no schema mirrored here

  202 { runId }
  404 { error: "unknown_agent" }
  429 { error: "busy" }        + Retry-After: 1
  403 insufficient_scope · 401 unauthorized · 500 internal_error

GET /v1/agents/runs/{id}      scope `agents`
  200 { status: "running" | "done" | "failed", brief, findings, failureReason? }
  404 { error: "not_found" }   unknown OR lost to a gateway restart
  410 { error: "expired" }     known, and expired within this process lifetime
```

Store limits, all from `agent-run-store.ts`:

- `AGENT_RUN_TTL_MS` = **10 minutes**, and explicitly **not refreshed on access** —
  "a polling client must not pin memory".
- `MAX_CONCURRENT_AGENT_RUNS` = **3**.
- `MAX_RETAINED_TERMINAL_AGENT_RUNS` = **16**, oldest evicted first.
- `AGENT_BUSY_RETRY_AFTER_SECONDS` = **1**, chosen because "a slot frees when a run
  FINISHES, which for an agent brief is seconds — not when it EXPIRES".

Upstream states the client rule directly, and this design follows it verbatim:

> 404 means "unknown OR lost to a restart", and the client's response to both is
> to re-issue, never to keep waiting.

A gateway restart drops every run **deliberately** — persisting them would write
synthesised brief text derived from the private index into a new on-disk table,
a privacy expansion, to buy resumption of something already reproducible.

## Two things the roadmap gets wrong

Recorded because the C2.1 brief will otherwise be read as current, and because
this is the same failure that produced #36 — designing from a roadmap's account of
a contract rather than the contract.

**1. `agents.whyPeek` is not on this surface.** It is in
`HTTP_EXCLUDED_AGENT_METHODS`, with a stated reason: it is the namespace's one
*synchronous* method, returns its payload directly and never calls `notify`, so it
cannot be represented on the `{runId}` + poll contract — "the run would never
complete and the caller would poll until the TTL turned a success into a 410".
(`agents.preflight` is excluded too: it can queue consent prompts on the owner's
machine, so an external caller must never originate one.)

**2. `agents.why` cannot answer from a pull request.** Its input is
`{ ref: string, line?: number }`, and `ref` is a **local filesystem path**
(optionally `path:line`) resolved against configured `[[filesystem.roots]]`, then
answered by **git blame on a local checkout** (`_lib/why-subject.ts` `parseRef`,
`resolveWhySubject`). It answers "why does this *line* exist", not "why does this
*change* exist". A browser on a GitHub PR page has no local path, and the user may
not have the repo cloned at all.

So the roadmap's *"why does this change exist (`agents.why` / `agents.whyPeek`)"*
names one agent that is unreachable over HTTP and one that needs input the browser
cannot supply. **`why` is deferred to its own roadmap item** — it probably belongs
on a code-file surface, not a PR — and `ROADMAP.md` is corrected as part of this
slice.

## Decisions

### Two lanes, and what each is given

The request body passes through **verbatim** to the gateway's validator, so the
client must send exactly what each agent accepts. The three agents take three
different shapes:

```
agents.impact  { fileOrPrUrl: string, depth?: number, service?: string }
agents.expert  { topicOrFile: string, limit?: number }
agents.why     { ref: string, line?: number }          ← not usable here
```

- **`impact`** receives `recognition.resolveUrl` — the same address-bar URL already
  sent to resolve. `fileOrPrUrl` takes a PR URL directly; this is the one clean fit.
- **`expert`** receives the resolved **`item.title`**. Its sub-agents
  (`subPrAuthored`, `subChatMentions`, `subBlame`, …) match `topicOrFile` as free
  text against indexed titles and chat, so a title asks "who has context on this
  subject". The repo name would also parse but answers a broader question — the
  same people for every PR in the repo — which is not what the lane claims.

Neither client-side value is invented: both come from data the panel already holds.

### Expanding a lane runs it

Lanes render collapsed, as the shell already does. Expanding one invokes its agent.

This matters because the agents are **optionally LLM-backed**: `synthesize` returns
a deterministic rendering when no LLM is configured, and prompts a model when one
is. So on a configured gateway every run is a model call. Auto-running both lanes
on every panel open would spend two model calls on every PR glanced at, including
ones opened by accident.

Expanding is an intent signal that already exists in the UI, gives per-lane
control, and keeps the common case from saturating a 3-slot run store.

### Concurrent dispatch, with `Retry-After` honoured

When lanes are expanded together they are invoked concurrently rather than queued.
A `429 busy` is a normal, brief condition — upstream sized `Retry-After` at one
second precisely because slots free when a run finishes, in seconds — so the client
backs off by the header and retries automatically rather than surfacing an error.

With two lanes and a 3-slot store, this leaves a slot free for another client in
the common case.

### A run outlives the panel

Closing the panel does not stop a run. The service worker persists the run and
polls it to completion, storing the brief. Reopening the panel on the same item
shows finished lanes immediately — no re-invocation, no second run for work the
gateway already did.

This is C2.2's done-when: *"nothing is lost by closing the panel"*.

**The cache expiry mirrors the gateway's `AGENT_RUN_TTL_MS` (10 minutes) rather
than a number invented here**, so a cached brief can never outlive the run it came
from. A client-side TTL longer than the server's would surface a brief the gateway
has already forgotten, with no way to re-poll it.

### The service worker owns polling; alarms are the eviction net only

`chrome.alarms` has a **one-minute floor**. Agent runs finish in **seconds**. So
alarms cannot be the primary poll — they would turn a two-second answer into a
sixty-second wait.

- **While the worker is alive:** a `setTimeout` loop, ~500 ms backing off to ~2 s.
- **After eviction:** a `chrome.alarms` entry resumes polling for any persisted
  run still marked running.
- **Stop** at a terminal status, or when `expiresAtMs` passes.

Rejected: polling from the panel. It is simpler while open and fails the decision
above — closing the panel would lose the run. Rejected: panel-polls-then-hands-off
— two implementations and a handoff that races exactly when the panel is being
torn down.

## The security decision

**The brief is markdown, and on a configured gateway it is LLM-generated. It must
not be parsed into HTML.**

Lane bodies render as **pre-formatted text via `textContent`**, in a `<pre>`-styled
block — never `innerHTML`, never a markdown-to-HTML pass.

Parsing it would create an XSS path from model output into a Shadow DOM overlaying
the user's authenticated GitHub session. Every other gateway-supplied string in
this extension already goes through `textContent`; a brief is the largest and least
predictable of them, so it is the last place to make an exception.

The cost is real and accepted: no bold, no clickable links, no headings. A safe
renderer — an allow-listed subset, or a sanitiser — is a separate, deliberate
decision, not something bolted onto this slice.

## Components

### `src/shared/types.ts`

```ts
export const AGENT_LANES = ["impact", "expert"] as const;
export type AgentLane = (typeof AGENT_LANES)[number];

export type LaneState =
  | { readonly kind: "collapsed" }
  | { readonly kind: "running"; readonly runId: string }
  | { readonly kind: "done"; readonly brief: string }
  | { readonly kind: "failed"; readonly reason: AgentError };

/**
 * `stale` collapses the poll's 404 and 410. Upstream distinguishes them —
 * unknown-or-restart vs known-and-expired — but states the client response to both
 * is to re-issue, never to keep waiting. One state, one "Re-run" affordance.
 */
export type AgentError =
  | "not_paired"
  | "unauthorized"
  | "insufficient_scope"
  | "unsupported"
  | "stale"
  | "unreachable"
  | "server_error";
```

`findings` is deliberately **not** modelled. It is typed `unknown` upstream ("the
shape is per-agent") and nothing renders it; carrying it would be a field with no
consumer, which #40 already had to prune once.

### `src/background/agent-run-store.ts` — new

`chrome.storage.local`, keyed `${itemId}:${lane}`, holding
`{ runId, status, brief, expiresAtMs }`. Entries past `expiresAtMs` are dropped on
read. Follows `clip-queue-store.ts`.

**Cap: 16 entries, oldest evicted first** — deliberately the same number as the
gateway's `MAX_RETAINED_TERMINAL_AGENT_RUNS`. Holding more would cache briefs for
runs the gateway has already evicted, which cannot be re-polled; holding fewer
would discard briefs still live upstream. Two lanes per item means the cache spans
eight recently-visited items, which is more than a browsing session needs.

### `src/background/gateway-client.ts`

```ts
invokeAgent(origin, token, agent, params)
  → { ok: true; runId } | { ok: false; reason: AgentError; retryAfterMs?: number }

getAgentRun(origin, token, runId)
  → { ok: true; status; brief } | { ok: false; reason: AgentError }
```

`parseRetryAfterMs` already exists in this file (from the clip rate-limit work) and
is reused rather than duplicated.

### `src/shared/messages.ts`, `src/background/handlers.ts`

Two messages:

- **`agent-run`** `{ lane, pageUrl }` → starts a run (or returns the cached state if
  one already exists for this item and lane). Idempotent: expanding a `done` lane
  must not re-invoke.
- **`agent-state`** `{ lane, pageUrl }` → returns the current `LaneState`.

As with resolve and fetch, `handleAgentRun` re-runs `recognise()` and refuses to
invoke on an unrecognised page.

**How state reaches the panel: the panel asks; the worker does not push.** While a
lane is `running`, the panel polls `agent-state` on a UI cadence (~1 s). This is
deliberately a *second, separate* cadence from the worker's own poll of the
gateway, and the two must not be conflated:

- the **worker→gateway** poll is what makes a run complete, and must survive the
  panel closing;
- the **panel→worker** poll is only what repaints an open panel, and stops the
  moment the panel closes.

The alternative — the worker pushing to the content script via
`chrome.tabs.sendMessage` or a long-lived port — needs the worker to track which
tab holds which panel, and a port dies with the worker anyway. Asking is simpler
and has no lifecycle to get wrong.

### `src/panel/`

Lane bodies. `panel-view.ts` owns all copy and renders the brief as text;
`panel-in-page.ts` sends `agent-run` on expand and repaints on state changes.
`renderShell`'s lane loop stays untouched — it was built lane-agnostic for exactly
this, and has survived three slices unchanged.

## Data flow

```
resolved PR, lanes collapsed
  └─ user expands "What breaks if it lands"
       ├─ panel → SW: { kind:"agent-run", lane:"impact", pageUrl }
       │     └─ recognise() gate → POST /v1/agents/impact { fileOrPrUrl }
       │
       ├─ 202 {runId} → persist, poll (500ms → 2s)
       │     ├─ status:"running" → keep polling, lane shows progress
       │     ├─ status:"done"    → store brief, lane renders it
       │     ├─ status:"failed"  → lane states failureReason
       │     └─ 404 / 410        → "stale" + Re-run
       │
       ├─ 429 busy → back off by Retry-After, retry (not an error)
       └─ SW evicted mid-run → alarm resumes polling from persisted runId
```

## Error handling

| Condition | Reason | Lane shows |
| --- | --- | --- |
| Not paired | `not_paired` | existing pairing guidance |
| 401 | `unauthorized` | existing re-pair guidance |
| 403 | `insufficient_scope` | `scopeCommand` built for the `agents` scope |
| 404 `unknown_agent` / agents disabled | `unsupported` | "This gateway can't run agents yet." |
| 429 | — | not surfaced; backs off and retries |
| poll 404 / 410 | `stale` | "That run is gone — re-run it." + **Re-run** |
| Transport error | `unreachable` | "Couldn't connect to Nimbus." |
| 500 / malformed | `server_error` | generic error |
| `status:"failed"` | — | the run's own `failureReason`, rendered as text |

**Never a silent empty lane** — C2.1's done-when. Every terminal state renders
either a brief or a stated reason.

The 403 copy must name the **`agents`** scope. `scopeCommand` already builds from
the 403's own `granted` + `required`, so this needs no new logic — and inherits the
label and scope-name validation added in #40.

## Testing

- **Client:** 202 → `runId`; 429 → `retryAfterMs` parsed from the header; poll 404
  and 410 both → `stale`; malformed 200 → `server_error`; token in the header only.
- **Store:** expiry mirrors the gateway TTL; entries past expiry are dropped on
  read; bounded eviction is oldest-first.
- **Polling:** a run that completes **after** a simulated worker eviction still
  delivers its brief — the C2.2 done-when, asserted directly.
- **Panel:** expanding invokes exactly once; a second expand of a `done` lane does
  **not** re-invoke; `429` retries without surfacing an error; a brief containing
  `<img src=x onerror=...>` renders as literal text and creates **no element**.

## Out of scope

- **`agents.why`** — deferred to its own roadmap item, with the reason recorded.
- **A markdown renderer.** Briefs render as text; a safe subset is its own decision.
- **Abort.** C2.2's done-when names it, but no upstream cancel exists — `agents.*`
  contains no `AbortController` and the runs are not in a `LongRunningJobRegistry`
  (recorded in the C1 reconciliation note). A UI-only "abort" that merely stops
  polling would claim to cancel something still running. Deferred until upstream
  offers cancellation; the roadmap item is corrected to say so.
- **C2.3's remaining lanes** — one at a time, each earning its page.
- **Notifying when a brief lands while the panel is closed.** Results are cached
  and instant on reopen; a badge or toast is C4 territory.

## Open question, deliberately left

`MAX_RETAINED_TERMINAL_AGENT_RUNS` is 16, evicted oldest-first. A finished brief
can therefore be evicted before a slow client polls it, surfacing as `stale` even
though the run succeeded. With two lanes and a 10-minute TTL this is unlikely, and
the recovery ("Re-run") is correct either way. Worth measuring before adding
machinery for it — and worth raising upstream if it proves reachable in practice.
