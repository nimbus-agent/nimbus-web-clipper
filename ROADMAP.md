# Nimbus Web Clipper — Roadmap

> **Status:** a direction, not a commitment. This roadmap is vision-first: it
> states the end-state we're building toward, then breaks it into phases detailed
> enough to *pick up and build*. The [changelog](./CHANGELOG.md) is the record of
> what has actually shipped; [`docs/architecture.md`](./docs/architecture.md) is
> how today's code is built.
>
> **Contributor? Jump to [Good first clips](#good-first-clips) and the
> [contributor guardrails](#contributor-guardrails).** Every feature below is a
> self-contained brief — what it is, why it wows, the files it touches, a sketch
> of the approach, and how you know it's done.

## North star

**One gateway, N contextual surfaces — your agents where the work already is.**

Nimbus is one local gateway with N contextual surfaces. **The agents are the
product; a surface is only how you reach them without leaving where you already
are.** Every surface talks to the same gateway over the same contract and runs
the same agents — no surface owns an agent, and no agent is reimplemented per
surface; what differs is *context*. Today the terminal is the one first-class
surface, and the editor and the browser are treated as accessories — a
historical accident of build order, not a design decision. That is what this
roadmap changes.

This extension stops being a web clipper and becomes the **browser-side client
for the Nimbus gateway**. On a Bitbucket pull request or a Jenkins build, an
ambient panel recognises the page, resolves it to an item already in your index,
and runs the agents that already exist against it — *why does this change
exist*, *what breaks if it lands*, *who should review it* — with no context
switch to a terminal. The VS Code extension gets the same treatment from the
editor side, in its own repo.

Capture does not go away; it stops being the product. It becomes **one
capability of the client**: the fallback for surfaces the gateway has no
connector for, and for the pages a targeted sync can't fetch.

### The original north star still holds

The reframe widens the promise below; it does not retire it.

**Everything you read, made findable, connected, and private — on your own
machine, forever.**

Most clippers are filing cabinets. You clip a page, it drops into a folder or a
tag you never open again, and the value of the capture decays to zero the moment
the tab closes. The clipper becomes a place things go to be forgotten.

Nimbus Web Clipper is the opposite. A clip is not filed — it is **fed to a
private recall engine** that runs on your machine. What you save today makes what
you read tomorrow smarter: the moment you land on a page, the extension can tell
you *you've read three things about this before*, surface them in-context, and let
you pull the thread — without a single byte leaving `127.0.0.1`.

What the reframe changes is the scope of *what you read*: pull requests, builds,
issues and docs are reading too, and the connectors already index them. Findable,
connected, private, on your own machine — same promise, wider corpus.

### Why the reframe — plainly

The clipper is a decent clipper. It is also in a fight it cannot win:

- **Nobody is using it.** AMO reports `average_daily_users: 0` after two weeks
  on the store.
- **The category is occupied.** Obsidian Web Clipper has ~900k users at 4.8
  stars and already ships local Ollama. Karakeep has ~28k stars, the same
  AGPL licence, plus OCR, PDFs, mobile and an MCP server. Being a slightly
  better clipper than those two is not a plan.
- **The name is already taken.** "Web Clipper (Nimbus)" by Nimbus Web Inc has
  roughly 50,000 users, so we collide with it in every store search. What this
  extension should be *called* after the reframe is an **open question**, not a
  decision taken here.
- **The cross-corpus idea isn't unique either.** SurfSense (~15.7k stars) has a
  comparable architecture — Gmail/Slack/Jira/Confluence/Linear/GitHub
  connectors and an MCP server. Execution and the local-first guarantee are the
  difference, not the idea.

What is *not* commodity is what sits behind the gateway: thirteen working
agents over an index that already spans your pull requests, builds, issues and
docs. No clipper has that. Reaching it from the page you are already on is the
product.

### The name — proposed, not decided

**Status: a proposal. This roadmap renames nothing.** It records the option and
its constraints so the decision is taken deliberately rather than by drift.

The collision is real and it is not ours to win by argument. "Web Clipper
(Nimbus)" is published by **Nimbus Web Inc**, a Delaware company: roughly 50,000
users, 154 ratings, 3.4 stars, last updated 2026-04-30. They hold the name in
this category.

Under consideration: **"Nimbus — Change Impact Agent"** — the job, not the
mechanism. That is the shipped precedent from the editor side, where
[`nimbus-vscode`](https://github.com/nimbus-agent/nimbus-vscode) publishes as
*Nimbus — On-Call & Incident Agent*; two surfaces of one gateway should read as
siblings. Alternatives considered and not discarded: "PR & Build Context Agent",
"Merge Readiness Agent", "Blast Radius".

Two things constrain any rename:

- **`FIREFOX_ADDON_ID` must not change.** `src/manifest/manifest.ts:17` pins it
  to the literal `web-clipper@nimbus-agent.dev`, and Firefox keys an install to
  that gecko id — changing it orphans every existing Firefox install. A rename
  is therefore a `name` change plus store-listing copy, and nothing deeper: the
  Chrome item id is derived from the publisher's public key, not from `name`, so
  it survives a rename untouched.
- **Sequencing, re-opened: Nimbus#1006 closed 2026-08-11.** This bullet's
  premise was that relaunching under a new name while **Nimbus#1006** was live
  (the store listings claim clips stay local while `web_clip` routed to OpenAI
  embeddings when a key was set) would *increase* exposure: a fresh listing
  invites fresh scrutiny of a privacy claim we could not back. That premise no
  longer holds — #1006 is closed. Whether the sequencing argument still stands
  on some other ground, or the rename is now unblocked, needs its own re-read.
  **Not decided here:** the rename is not this slice's call to make.

### Why this is credible, not aspirational

Most of this was wiring existing capability to a new surface — and by now most
of that wiring has actually landed. Re-verified against merged upstream in the
[Nimbus gateway repo](https://github.com/nimbus-agent/Nimbus) (`main` at
commit `34601b24`, past the `v1.27.0` release), not against this roadmap's own
earlier account of it:

- **Thirteen agents ship today**, not the eleven this section originally
  counted — catchup, conflicts, decisions, expert, ghost, glossary, huddle,
  impact, janitor, ownership, preflight, why and why-peek, in
  `packages/gateway/src/agents/`. `ownership` and `decisions` are the two
  added since: `agents.ownership` (reads the ownership graph derived from
  already-indexed blame data, v1.24.0) and `agents.decisions` (the implicit
  ADR extractor).
- **An `agents.*` IPC namespace is already dispatched** — `agents.why`,
  `agents.impact`, `agents.expert`, `agents.whyPeek` and the rest, in
  `packages/gateway/src/ipc/agents-rpc.ts`.
- **Bitbucket, Jenkins, Jira, GitHub and GitLab are indexed connectors** with
  sync handlers (`packages/gateway/src/connectors/*-sync.ts`).
- **URL→item resolution has the data it needs** — `bitbucket-sync.ts` indexes
  `type: "pr"` with a `canonicalUrl`, `jenkins-sync.ts` indexes `type:
  "ci_run"`, and `canonical_url` is a real column on `item`
  (`packages/gateway/src/index/unified-item-v3-sql.ts`).

**Both gaps this section used to name as "honestly not built" are closed, and
this client is what closed them:**

- **The browser can reach `agents.*`.** `POST /v1/agents/{agent}` (202 +
  `runId`) and `GET /v1/agents/runs/{id}` shipped on the gateway's HTTP API,
  bearer-authed and recorded in the egress ledger (v1.23.0, "invoke read-only
  agents over the HTTP API"). This client calls both — see **C2.1**, shipped.
- **A resolve-by-URL read exists.** `GET /v1/items/resolve` shipped (v1.25.0),
  and the prediction this section made about *how* was specific and correct:
  it does bring a migration with it, but not an index on `canonical_url`
  directly. `canonical_url` itself is still un-indexed today — the read
  instead matches on a new **derived, indexed** `resolve_key` column (the
  "V52" migration), computed server-side from `canonicalUrl ?? url` through
  the same normalisation the client cannot run itself
  (`packages/gateway/src/index/resolve-key-v52-sql.ts`,
  `item-store.ts`). This client calls it — see **C1.1**, shipped.

What is genuinely still open is downstream of both routes existing, not a
missing route: the remaining items below (**C2.3**, **C2.4**, **C2.5**) are
about which agent goes on which page, in what shape, and against which item —
not about whether the browser can reach the gateway's agents at all.

The design spec for this client
(`docs/superpowers/specs/2026-08-01-browser-gateway-client-design.md`) was
written and merged in the gateway repo — then pruned from that repo once the
feature it specified shipped (it lives on in that repo's git history, the same
convention this repo's own `CLAUDE.md` documents for its own specs). The
briefs below, not that now-pruned document, are the current authority.

### The local-first bet is unchanged

The bet underneath this is deliberate. The read-it-later graveyard is real —
Pocket sunset, Omnivore acquired and shut down, and everyone's carefully-clipped
libraries went with them. Every one of those was a cloud service that owned your
reading. **Local-first is the only durable answer**, and it is also the only one
that can make privacy a *feature you can see* rather than a promise you have to
trust. We turn the constraint into the pitch.

It matters *more* now, not less. A clipper only ever pushed what you chose to
send. A client asks the gateway to **fetch things on your behalf**, so "where
does my data go?" gains a second half — "and what did it go and get?" — that we
have to answer just as visibly.

To be the best client in this space, we win on four axes at once. Not one — all
four. That combination is the moat: no cloud tool can be this private, and no
private tool has this much of your working context already indexed.

## The four pillars

Every feature in every phase serves one of these. If it doesn't, it's out of
scope.

### 1. AI-native retrieval — the moat

The Nimbus index is a semantic engine, not a bookmark list — and thirteen
agents already run on top of it. The client's job is to make that power feel
like magic *where you already are*: recognise the page, resolve it to the
indexed item, and put the agent lanes (why · impact · expert) one glance away.
Related-items, never-save-twice detection, asking questions of your own
reading, and auto-understanding every clip on arrival are the shallow end of
the same capability. This is the axis no cloud tool can match privately, and
no private tool can match on context.

### 2. Capture quality & coverage — reach what the connectors can't

A capture is only as good as what it captured — and capture is now the **last
resort, not the first move**. On a resolve miss the client asks the gateway to
sync that one item; capture is what's left for the surfaces with no connector at
all (an internal wiki, a vendor console) and for pages a sync can't reach. That
keeps the coverage and fidelity work valuable, but re-aims it: the pages worth
being excellent at are the ones your working day runs through, not the ones a
read-it-later app is judged on.

The bar for that work is unchanged — the widest coverage and highest fidelity of
any extension: beyond the readable article to PDFs, video transcripts, and the
hard cases (SPAs, infinite scroll), captured the way you read — full-page or
readable, region or highlight-stitched — with faithful author/date/canonical
metadata and preserved figures.

Two defects gated this pillar: **Nimbus#1005** (clip bodies truncated to 512
characters while `wordCount` reports the full length) and **Nimbus#1006**
(`web_clip` routes to OpenAI embeddings when a key is set, contradicting the
store listings' local-only claim). Both closed upstream on **2026-08-11**. The
gate held for a real reason — widening capture on top of a body that was
silently truncated, or an embedding path that left the machine, would have made
both problems bigger — and that reason is now cleared, not argued away:
**C3.2** shipped once both were closed.

### 3. Frictionless UX — no context switch

The best answer is the one you didn't have to go and fetch. The gesture we are
optimising is no longer "clip this" but "*don't make me open a terminal*": the
panel recognises where you are and offers what makes sense there, keyboard-first,
with honest instant feedback and a queue that heals itself offline. A generic ask
box is explicitly not the shape — the surface should already know what page it's
looking at.

The best capture is still the one you don't have to think about, and none of that
work is retired: one-gesture paths that all land in the same place, smart tag
suggestions, a command palette and one-press undo. Organization is a keystroke,
not a chore — and now so is getting an answer.

### 4. Privacy & trust as a feature — provable, not promised

Local-first is worth nothing if the user can't *see* it, and the bar rises the
moment the client can ask the gateway to fetch something. Keep everything that
exists — a visible trust surface that answers "where does my data go?", a
connection panel that names the single origin it talks to, a preview of exactly
what gets sent, a secret that never touches a page, an open, reproducible,
dependency-free build — and add the second half:
what the gateway went and did on your behalf, visibly, after the fact. The
fetch-and-index route is deliberately allowlisted as an **I13** write rather
than reclassified as a read, precisely so it stays on the surface that gets
audited.

---

## How to read the phases

Phases are ordered on one principle: **ship what we can build today first** — it
needs no other repo and delivers value now — then the work that needs the Nimbus
gateway/engine to grow a new surface, then the ecosystem bets. Within a phase,
highest value first.

The reframe adds a second, superseding lens: **the client phases come first.**
They are lettered **C1–C4** so nothing below has to be renumbered. The numbered
phases **1–10** are all still here and most are still wanted — they were written
for a clipper, so where the reframe changes an item's priority or shape it now
carries a `**Reframe**` line saying so, with the reason. Nothing was dropped
silently.

Every item carries three tags so you can pick work that fits:

| Tag | Meaning |
| --- | --- |
| 🟢 **client-only** | Buildable today against the existing locked contract (`/v1/clips`, `/v1/clips/pair/confirm`, `/v1/clips/related`). No other repo needed. |
| 🟡 **needs-gateway** | Client UI is ready; blocked on a **new gateway surface** proposed in the [Nimbus gateway repo](https://github.com/nimbus-agent/Nimbus). The brief names the surface it needs. |
| 🔵 **ecosystem** | Depends on a sibling repo landing (the Nimbus SDK, the engine's plugin story). |

Effort is a rough shirt-size: **S** ≈ one slice (a few focused days), **M** ≈ a
couple of slices, **L** ≈ multi-slice, needs its own design spec first.

Each brief follows the same shape:

> **What** · one line. **Why it wows** · the delight. **Touches** · where to start
> in the tree. **Approach** · a sketch, not a mandate. **Done when** · the
> acceptance bar. **Depends** · anything it waits on.

---

## Foundation — shipped ✅

The base you're building on is real, not a promise. Through **v0.2.0** the
end-to-end core works in both Chrome and Firefox:

- **Pairing** — redeem a 6-digit gateway code → long-lived bearer token
  (`/v1/clips/pair/confirm`), stored in `chrome.storage.local`, held by the SW.
- **Capture** — readable-article extraction (bundled Mozilla Readability) or the
  current selection, with a meta-description/URL bookmark fallback.
- **Clip ingest** — `POST /v1/clips`, with `created`/`updated` status surfaced.
- **Related-items panel** — on-demand, injected into the page (`/v1/clips/related`).
- **Offline retry queue** — persisted, self-draining, badge-tracked; terminal vs.
  transient failures handled distinctly.
- **Quick-clip** — context menu + `Alt+Shift+C`/`Alt+Shift+S` hotkeys + in-page
  toast confirmation.
- **Resilience** — 429 rate-limit pausing (persisted across SW eviction) and 413
  payload-too-large as a terminal reason.
- **Connection management** — pairing status + unpair.
- **Page recognition (Phase C1)** — pure surface recognisers for Bitbucket /
  GitHub / GitLab PRs, Jenkins builds and Jira issues (SaaS hosts are built in;
  self-hosted instances are configured per origin, with optional path prefixes);
  a lane-based panel shell that leads with the recognised surface and the
  resolved item; opt-in page access, granted per host. The resolve read is
  shipped against the gateway's real contract — see C1.1.
- **Release** — tag-driven build/package + Chrome Web Store / Firefox AMO publish
  automation.

Read [`docs/architecture.md`](./docs/architecture.md) before your first change —
the load-bearing decisions and the two state machines are documented there.

---

## Phase C1 — Know where you are 🟢/🟡

*Theme: the panel's first job is recognition. Turn "a tab is open" into "this is
a Bitbucket PR in repo X, and here is the indexed item for it". Everything in C2
is worthless without this — and half of C1 is buildable today.*

### C1.1 Page → indexed item resolution · 🟢 · M — ✅ shipped
> **What** Resolve the current page's URL to a single indexed item (service,
> type, id) — or an honest miss.
> **Why it wows** The panel stops guessing. Naming the item it resolved to is
> the whole difference between a search box and a client that knows the page.
> **Touches** `src/shared/recognise.ts`, `src/background/gateway-client.ts`,
> `src/shared/messages.ts`, `src/panel/panel-view.ts` (header states + the
> ambiguous-candidate chooser).
> **Approach** Send the page URL, get back at most one item, an honest miss, or
> a short list to choose from — resolution, not ranking. The client must not
> fall back to fuzzy hits and pretend they are the page.
> **Status** Shipped end to end, against the gateway's real contract:
> `GET /v1/items/resolve?url=`, its `resolve` token scope, and all four 200
> outcomes (`found` / `not_indexed` / `unresolvable_url` / `ambiguous`) as a
> closed union. The client does identity normalisation only (Jira issue-key
> upper-casing); the gateway owns canonicalisation and match confidence
> (`matchKind`) — see [`docs/architecture.md`](./docs/architecture.md#the-recognition-pipeline).
> A pairing made before the gateway grew token scopes gets a named re-grant
> path (`nimbus clip scopes`) instead of a generic error. `fetchable` — whether
> the gateway could fetch this URL itself — is parsed and carried through the
> message boundary on the `not-indexed` / `unresolvable` / `ambiguous` arms,
> unrendered for now; it is **C3.1**'s targeted-sync trigger.
> **This closes out the contract adaptation** tracked in
> [`docs/superpowers/specs/2026-08-07-c1-upstream-reconciliation.md`](./docs/superpowers/specs/2026-08-07-c1-upstream-reconciliation.md):
> the client was originally built against a guessed shape while the gateway
> route was still proposed; both landed, and this phase closed the gap between
> them.

### C1.2 Surface recognisers · 🟢 · M — ✅ shipped
> **What** Pure modules that classify the current page — Bitbucket PR, Jenkins
> build, Jira issue, GitHub/GitLab PR/MR — and extract the canonical URL for
> C1.1.
> **Why it wows** The panel is right about where you are before it says
> anything, and being wrong is cheap to fix in one pure file.
> **Touches** a new `src/shared/recognise.ts` (pure, unit-tested), consumed by
> `src/panel/` and `src/popup/`; `src/options/` for the origin list.
> **Approach** Origin + path patterns → a `SurfaceKind`. Bitbucket, Jenkins and
> Jira are routinely self-hosted, so hostnames cannot be hardcoded — the user's
> origins come from settings, and an unknown host is simply unrecognised.
> **Done when** A fixture set of real URLs per surface classifies correctly,
> ambiguous pages classify as unknown, and adding a surface is one pure module
> plus tests.

### C1.3 The ambient panel shell · 🟢 · M — ✅ shipped (panel user-summoned; ambient cue shipped opt-in, per host)
> **What** Grow the injected related-items panel into a lane-based shell: a
> header naming the resolved item, then one collapsed lane per available action.
> **Why it wows** It reads as *a client for this page*, not a results list that
> happens to be docked.
> **Touches** `src/panel/panel-view.ts` (pure render), `src/panel/panel-in-page.ts`.
> **Approach** Keep the render pure and lane-agnostic so C2 adds lanes without
> touching the shell. Related-items (4.1) becomes the first lane.
> **Done when** Resolved / unresolved / loading / error states all render from
> pure view code under unit tests, with no lane content yet.
> **Status** Shipped with related-items as the first lane. The panel stays
> **user-summoned** — opening it is still always a click or a hotkey, never
> automatic.
> Closed: the panel pins the page it was opened on, so its header and its lanes
> can no longer describe different items, and it offers a deliberate re-read when
> you navigate away — see
> `docs/superpowers/specs/2026-08-11-panel-page-context-design.md`.
> **The deferred ambient half has now landed too:** on a host the user has
> granted page access to and separately switched a per-host "Surface
> automatically" toggle on for, landing on a page that resolves to exactly one
> indexed item mounts a small corner cue naming it — before any click. Clicking
> it opens this same user-summoned panel; the panel itself is unchanged. Every
> non-`found` resolve outcome is silence, not a cue that leads nowhere, and
> nothing is invoked ambiently — no agent, no lane. See
> `docs/superpowers/specs/2026-08-13-ambient-surfacing-design.md`.

### C1.4 Per-origin, opt-in recognition · 🟢 · S — ✅ shipped
> **What** Recognition needs to see the URL of pages that are not the gateway —
> a permission the clipper never held (capture rides an `activeTab` gesture).
> Ask for it per origin, at runtime, only for the sites the user names.
> **Why it wows** The one genuinely new privacy cost of the reframe, handled in
> the open instead of buried in a manifest diff.
> **Touches** `src/manifest/manifest.ts` (`optional_host_permissions`), a
> permissions module in `src/browser/`, `src/options/`.
> **Approach** Never a static `<all_urls>`. The *network destination* stays
> loopback-only — this is page access, a different axis, and the UI and store
> listing must not blur the two.
> **Done when** A user grants recognition for exactly the hosts they choose,
> revoking one silences the panel there, and the shipped manifest still requests
> no broad host permission up front.
> **Status** Shipped: `optional_host_permissions` is inert at install, and Options
> grants/revokes **per host** from a user click. Recorded honestly — the panel
> works on `activeTab` alone today, so the grant currently buys only gesture-free
> recognition, which **C2** is the first to need. The store listing explains why
> the optional pattern is broad (self-hosted hostnames are not enumerable).
> **The grant now buys something concrete:** the ambient half of **C1.3**
> (shipped) is the first thing that actually consumes gesture-free recognition —
> it is what a granted, toggled-on host makes possible. That slice also closed a
> real gap this phase had left open: the **Recognised surfaces** list built its
> rows from the user's own stored, self-hosted origins only, so `github.com`,
> `gitlab.com`, `bitbucket.org` and Jira Cloud — recognised with no configuration
> — had no row at all. Since the Grant button lives on a row, there was until
> then no way to grant page access to any of them. Built-in rows (with grant/
> revoke and no Remove) now close that gap.

### C1.5 A second way into the panel · 🟢 · S — ✅ shipped
> **What** Add a panel entry point the browser cannot silently withhold — a
> context-menu item, and Options surfacing whether the `show_related` shortcut is
> actually bound.
> **Correction (2026-08-11):** this brief claimed the panel had "exactly **one**
> entry point". It did not. The popup's *Show related* button has existed since
> Slice 2 (`src/popup/popup.html`, commit `e99749b`), which is also why the
> `Alt+Shift+R` failure below was survivable rather than fatal. What remains is
> the context-menu trigger and the shortcut's visibility — the keyboard-only risk
> is real, the "unreachable" framing was not.
> **Why it wows** It stops the feature from disappearing. `suggested_key` is a
> *suggestion*: when something else already claims the combo, Chrome leaves the
> command unbound, reports nothing, and the keystroke goes to the page instead.
> The panel is then unreachable, with no error, no empty state, and nothing in
> the UI hinting that a shortcut exists. A user in that state concludes the
> feature is broken.
> **Found by** The Phase C1 manual pass (2026-08-09), first time it was run.
> `Alt+Shift+R` did not bind in Chrome; pressing it opened GitHub's own
> "switch repository" menu. Every other entry point in the extension has a
> click-driven fallback — clipping has the popup *and* the context menu — so
> this is the only capability reachable by hotkey alone. This roadmap also
> claimed C1.3 shipped with a "popup button"; it did not, which is part of why
> the gap went unnoticed. That claim is corrected above.
> **Touches** `src/background/quick-clip.ts` or a sibling for the context-menu
> registration, `src/browser/context-menus.ts`, `src/popup/`,
> `src/background/service-worker.ts` (route the new trigger into the same
> `injectPanel` path the command already uses).
> **Approach** One handler, several triggers — the command, the menu item and any
> popup button must converge on the existing injection path so the panel cannot
> drift between them. Keep the `activeTab` story intact: each trigger is a user
> gesture, so no new permission is needed. Consider surfacing the bound shortcut
> (or its absence) in Options, since the browser will not.
> **Done when** The panel can be opened without touching the keyboard, on a
> profile where the `show_related` shortcut is unbound, in both Chrome and
> Firefox.
> **Note (2026-08-14, Slice 1 — "Setup that works"):** that slice added a
> staged Options flow whose stage 2 (Connection) is the natural home for
> surfacing whether `show_related` is actually bound — but the readout itself
> did **not** ship there. It remains this item's own scope, arriving with
> Slice 2, not before.
> **Status** Shipped both halves this brief named. A **Show related in
> Nimbus** context-menu entry (`src/background/menus.ts`) opens the panel
> through the same `openPanel` path the hotkey and the C1.3 ambient cue use —
> right-clicking a page in a non-focused window opens the panel in the
> clicked tab, not the focused one. Options stage 2 now lists all three
> commands with the shortcut the browser actually bound
> (`src/browser/commands.ts`), never the manifest's `suggested_key`; an
> unbound command reads **Not set**, alongside a copyable per-target path
> (`chrome://extensions/shortcuts` / `about:addons`) to fix it — Chrome
> refuses to let an extension page link there directly. Closed along the way:
> the previous context-menu routing treated every unrecognised id as "clip
> the page," so adding this third entry without also fixing that would have
> made a right-click on it silently clip instead of opening the panel. See
> [`docs/architecture.md`](./docs/architecture.md#a-second-way-into-the-panel-phase-c15).

## Phase C2 — Run the agents from the page 🟢

*Theme: the payoff. Three questions on a code-review page, answered by agents
that already exist, without leaving the tab.*

### C2.1 The code-review lanes — impact · expert · 🟢 · L — ✅ shipped (two lanes, not three)
> **What** On a resolved pull request: *what breaks if it lands*
> (`agents.impact`), *who should review it* (`agents.expert`).
> **Why it wows** This is the demo. The answers already exist behind the
> gateway; today you must stop reviewing and open a terminal to get them.
> **Touches** `src/panel/`, `src/background/gateway-client.ts` +
> `handlers.ts`, `src/shared/messages.ts`.
> **Status** Shipped **two** lanes, not the three originally briefed here.
> *Why does this change exist* is **not** one of them — the roadmap named
> `agents.why` / `agents.whyPeek` for it, and neither fits this surface:
> `agents.why` takes `{ ref, line? }`, where `ref` is a **local filesystem
> path** resolved against configured `[[filesystem.roots]]` and answered by
> **git blame on a local checkout** — it answers "why does this *line*
> exist", not "why does this *change* exist", and a browser on a PR page has
> neither the path nor necessarily the repo cloned at all. `agents.whyPeek` is
> **excluded from the HTTP surface entirely** — it is the namespace's one
> *synchronous* method (it returns its payload directly and never calls
> `notify`), so it cannot be represented on the `{runId}` + poll contract this
> client depends on; polling it would just wait out its own TTL into a 410.
> See **C2.4** below for a browser-viable version of "why". This roadmap
> previously named both as if they were reachable here; that was wrong, not a
> simplification made for time — corrected as part of landing this phase. Full
> reasoning: `docs/superpowers/specs/2026-08-10-c2-agent-lanes-design.md`.
> **Done when** Each lane returns a cited brief for the resolved item, or a
> plain "couldn't answer, and here's why" — never a silent empty lane. ✅ — see
> `AGENT_ERRORS` (`src/shared/types.ts`) and `renderLaneBody`
> (`src/panel/panel-view.ts`).

### C2.2 Progress and delivery under MV3 · 🟢 · M — ✅ shipped (abort deferred)
> **What** Agent runs that outlive the service worker: start, poll, show
> progress.
> **Why it wows** Invisible when it works; the whole feature feels broken when
> it doesn't.
> **Touches** `src/browser/alarms.ts`, `src/background/service-worker.ts`,
> `src/background/agent-run-store.ts`.
> **Status** Shipped **polling plus `chrome.alarms`, not SSE** — MV3
> terminates idle service workers and a hanging stream dies with them. A run
> started before a service-worker eviction still delivers its result: every
> state transition is persisted to `chrome.storage.local`
> (`agent-run-store.ts`, TTL and eviction cap mirroring the gateway's own),
> `chrome.alarms` exists purely as the **eviction net** (a real poll cadence
> would need `chrome.alarms`' one-minute floor, which is far slower than an
> agent run actually takes), and the panel closing never loses a result —
> reopening it and re-expanding the lane replays the stored `done` brief
> instead of invoking the agent a second time. A lane left `failed`
> deliberately does re-invoke on that expand (a failure is not an answer, and
> the expand is an explicit user action) — see
> [`docs/architecture.md`](./docs/architecture.md#the-agent-lanes-phase-c21).
> **Abort is deferred, not shipped** — this roadmap item originally claimed
> it. There is no upstream cancellation to hook into: `agents.*` has no
> `AbortController` and runs are not tracked in any registry a cancel could
> target. A UI-only "abort" that merely stopped polling would claim to cancel
> a run that is, in fact, still going — that would be lying to the user about
> what happened, not a smaller version of abort. Deferred until upstream
> offers real cancellation. See `docs/architecture.md`'s agent-lanes section
> for the fuller reasoning.

### C2.3 The remaining lanes, surface by surface · 🟢 · M — ✅ shipped (three service-scoped lanes, on a new dashboard surface)
> **What** Map the other agents onto the pages they belong on —
> `agents.catchup` for a repo or board you have been away from,
> `agents.conflicts` and `agents.ghost` where ownership is unclear,
> `agents.preflight` on a deploy/build page, `agents.glossary` on an unfamiliar
> term, plus `agents.huddle` and `agents.janitor`.
> **Correction (2026-08-11), read from upstream source at `34601b24`+:** three of
> the agents named above are not reachable from a browser.
> `agents.preflight` is excluded from the HTTP surface deliberately — it is one of
> the three members of `HTTP_EXCLUDED_AGENT_METHODS` in
> `packages/gateway/src/ipc/agents-rpc.ts`, with `agents.premortem` and
> `agents.whyPeek`, though each is excluded for its own reason: `preflight`'s and
> `premortem`'s is side effects on the owner's machine an external caller should
> not trigger unprompted, while `whyPeek`'s is the one C2.1 already records above
> (it is the namespace's only synchronous method, so it cannot be represented on
> the `{runId}` + poll contract). So the deploy/build lane above cannot be built
> as briefed. `agents.ghost` and
> `agents.conflicts` both take `{ file: string }` (`requireFileParam`), the same
> local-checkout requirement that sent "why" to C2.4. What *is* browser-viable is
> the service-scoped set — `agents.catchup`, `agents.decisions` and
> `agents.ownership` all accept `{ service }`, which the recogniser already knows
> — plus `agents.glossary` (`{ term }`), which a selection supplies. Same class of
> error C2.1 had to correct for `agents.why`/`whyPeek`; recorded rather than
> silently edited.
> **The rule is now written down.** `LANE_SURFACES` (`src/shared/types.ts`) is
> where a new lane declares the surfaces it belongs on; adding a lane without one
> is a type error. This phase's done-when asked for that, and it shipped early
> with the page-context slice.
> **Correction (2026-08-13), read from upstream source at `ea37e0d0`:** three more
> stale claims, found while designing the service-scoped set — recorded rather
> than silently edited, same as the 2026-08-11 correction above.
> The **exclusion count above is wrong**: `HTTP_EXCLUDED_AGENT_METHODS` has
> **four** members, not three. `agents.negotiate` is the fourth, and it is
> excluded for a reason distinct from the other three — it has no side effects
> and its `{runId}` + poll shape fits the HTTP contract fine, but combined with
> `--person` it would let any holder of the `agents` token assemble a
> contribution dossier on any indexed person without the owner initiating it.
> The **"thirteen agents" figure used elsewhere in this roadmap** (the north
> star, pillar 1) is itself stale as of this same upstream read — there are more
> than thirteen now, `agents.negotiate` among them. Not corrected globally here;
> flagged where this slice's own research surfaced it.
> And the **framing above undersold what `catchup`, `decisions` and `ownership`
> needed**: "map the other agents onto the pages they belong on" implied an
> existing surface would do. It would not — those three answer about the whole
> connector, not a page's item, so dropping them onto an item page (a repo, a
> board) would put the same connector-wide answer on every page of that host.
> They needed a surface whose scope matches theirs, which did not exist. Full
> reasoning: `docs/superpowers/specs/2026-08-13-c2-3-service-lanes-design.md`.
> **Why it wows** Each surface grows its own reason to keep the panel open.
> **Approach** One lane at a time, each earning its place on a real page. A lane
> that fires everywhere is noise, and noise is how ambient UI dies.
> **Depends** C2.1's invocation surface.
> **Status** Shipped the service-scoped set only — `catchup`, `decisions` and
> `ownership` — on a new recognised surface, `SurfaceKind: "home"`: a product's
> own dashboard (GitHub root; GitLab root or `/dashboard`; Bitbucket
> `/dashboard/*`; Jira Cloud `/jira/your-work` and Server
> `/secure/Dashboard.jspa`; Jenkins instance root, past any configured path
> prefix). The three lanes render there and nowhere else. A dashboard makes
> **no resolve call** — `Recognition.product` is already the gateway's connector
> id, so the lane needs only the `agents` token scope, not `resolve` — and two
> self-hosted instances of one product share a single cached answer, because
> `service` is a flat connector id and both instances are one scope. The C1.3
> ambient cue stays silent on a dashboard: it gates on a `found` resolve, and a
> dashboard resolves to none. `agents.glossary` is not in this slice — it needs
> selection plumbing into the lane path that does not exist yet, its own slice.
> `agents.huddle` and `agents.janitor` are also unaddressed.
> **Update (2026-08-14): the glossary lane has now shipped**, in the slice that
> also closed **C2.5** and **4.2**. It is the first lane whose input is not the
> page, and it needed two things this brief did not anticipate. `LANE_SURFACES`
> became **`LANE_RULES`**, a discriminated union — `{input:"page", surfaces}` vs
> `{input:"term"}` — so a term lane cannot be given surfaces and a page lane
> cannot omit them. And the term arm declares **no surfaces at all**: the lane
> answers on any page the panel opens on, including one the recogniser rejects,
> because `POST /v1/agents/glossary` takes `{ term }` and no URL, so the gate that
> decides which page URLs may reach the gateway has nothing to gate here. The
> lane materialises only once a term exists — no term, no lane, anywhere — and an
> over-long selection is refused in the lane rather than truncated into a question
> nobody asked. Its three upstream modes (`list`/`term`/`miss`) need no client
> branch: the run route returns one `brief` string for every agent, so all three
> arrive as text. `agents.huddle` and `agents.janitor` remain unaddressed.
> **Done when** Every shipped lane appears only where it is useful, and the
> rule that put it there is written down. ✅ for the three lanes shipped here;
> unit suite green. The plan's manual dev-load pass (`docs/development.md`) is
> still outstanding — and now also covers the glossary lane's two menu entries.

### C2.4 A browser-viable "why" · 🟢 · M — ✅ shipped
> **What** Answer *why does this change exist* from the browser, without
> `agents.why`'s local-checkout requirement. Two directions worth spiking
> before committing to either: (a) a PR-shaped variant of `why` the gateway
> exposes over HTTP — e.g. resolving `ref` from the PR's diff hunks against a
> checkout the *gateway* already has, rather than one the browser needs; or
> (b) recasting the question as "why was this PR opened" and answering it from
> `agents.expert`'s own inputs (PR title/description/commits) instead of git
> blame, accepting a different, shallower answer than `why` gives on a file.
> **Why it wows** Closes the gap C2.1 opened: two of the three review
> questions from the original demo pitch now have a lane; this is the third.
> **Touches** Whichever surface the gateway spike lands on —
> `src/background/gateway-client.ts` + `handlers.ts`, `src/shared/types.ts`
> (`AGENT_LANES` grows a member), `src/panel/`.
> **Depends** A gateway-side decision on which direction (a)/(b) above — or a
> third — is worth building. **Propose there first**, same as C2.1 originally
> needed an HTTP agents surface at all.
> **Status** **Neither briefed direction shipped.** Reading the upstream
> source (`agents.why`, `packages/gateway/src/agents/why.ts`) showed the
> premise underneath both was wrong: four of `why`'s six lanes already
> discard the file and ask `findPrForSha` for the pull request it belongs to.
> Blame was never their subject — it is the *adapter* that gets from "a file
> line" to "the pull request that changed it", and a caller that already has
> the pull request does not need the adapter. So (a)'s diff-hunk checkout and
> (b)'s recast question were both solving a problem `why` didn't actually
> have. What shipped instead: the gateway gave `agents.why` a second, explicit
> entry point, `{ prUrl }`, alongside the existing `{ ref, line? }` — removing
> the adapter rather than routing around it. Four of the six lanes (pull
> request, ticket, discussion, driver) answer unchanged on this arm; two do
> not — `authorship` (line-level, and a whole change has no line) and
> `downstream` (the question the shipped **impact** lane already answers). The
> gateway's own subject line names both silences rather than the brief
> quietly coming back shorter, and that disclosure is registered against
> upstream invariant **I31** so an LLM rewrite of this brief cannot silently
> drop it.
> The work also fixed a live defect in the already-shipped **impact** lane
> found on the way: `agents.impact` resolved a PR URL by reconstructing an
> identity — a GitHub-shaped regex, a hostname-to-service guess, and a
> hash-keyed external id — and failed three independent ways on GitLab (its
> merge-request path doesn't match the regex, and its entities are keyed with
> `!` rather than `#` even when it does), on every self-hosted forge (the
> hostname guess matches no connector), and then fell through to a title
> scan that returned *something*, so the lane looked like it worked while
> silently missing coverage. Both agents now share one parse-free resolver
> that asks the index — `resolvePrSubject`, keyed off the same
> `resolveItemByUrl` path this extension's own resolve already uses — correct
> for every forge and every self-hosted instance without a host table.
> Full design: `docs/superpowers/specs/2026-08-19-why-from-a-pull-request-design.md`.
> **Done when** A lane answers "why does this change exist" for a resolved
> pull request, without requiring the browser to have a local checkout of
> anything. ✅ — the lane gates exactly as `impact`/`expert` do
> (`LANE_RULES.why`, `surfaces: ["pr"]`) and appears under both the
> `resolved` and `chosen` headers. **Appearing under `chosen` is not the same
> as answering about the item picked there** — see the known gap below;
> correct that claim if you are about to repeat it.
> **Known gap, recorded rather than fixed here.** `agentParams` sends
> `{ prUrl: resolved.resolveUrl }` — the **page's** URL, never the candidate a
> `chosen` header names — so on that header the gateway re-resolves the same
> page URL through `resolveItemByUrl` and, if it was ambiguous, resolves
> ambiguous again; `why` then returns its miss brief under a header naming the
> item the user just picked. That is the exact failure **C2.5** says it fixed,
> reappearing one layer down. Inherited, not introduced here — `impact` sends
> the same param through the same resolver since Nimbus#1260, so this is not
> this slice's to fix. `ResolveCandidate.url` (`src/shared/types.ts:199`)
> already carries the picked candidate's own URL; a future slice can send that
> instead of the page URL for both URL-parametrised lanes (`impact`, `why`).
> **Also: this lane needs gateway 2.8.0** (Nimbus#1260) for `why`'s `{ prUrl }`
> arm. A pre-2.8.0 gateway 400s the invoke, and `invokeAgent`
> (`gateway-client.ts`) has no 400 branch — it falls through to
> `server_error`, so the panel offers a Re-run that can never succeed.
> Recorded, not re-plumbed; mapping 400 to its own lane state is a larger
> change and a follow-up alongside the one above.

### C2.5 The lanes on a candidate you picked · 🟢 · S — ✅ shipped
> **Status** Shipped, together with the glossary lane C2.3 deferred and 4.2, as
> the "lane path takes an input" slice — the three share one contract change.
> `agent-run`/`agent-state` grew an optional `itemId`, guarded in `messages.ts`
> like every other cross-boundary value, and `resolveForAgent` honours it **only
> after confirming it appears in the candidate set that resolve produced** — an
> id the gateway never offered is refused. No extra call: the resolve had to
> happen anyway. The `item` the lane path carries is typed `ResolveCandidate`,
> not `ResolvedItem`, so nothing downstream can read a `modifiedAt` a picked
> candidate does not have. The panel's lane gate moved into a new pure
> `src/panel/lane-input.ts` rather than growing inside the 1,256-line
> `panel-in-page.ts`.
> **What** Offer the two C2.1 lanes on an **ambiguous** page once the user has
> picked which indexed item it is — today they appear only under a `resolved`
> header, so an ambiguous page shows no lanes at all, before or after the pick.
> **Why it wows** Ambiguity is the one case where the user has told the panel
> something it could not work out on its own. Throwing that answer away one
> control later is exactly the kind of small betrayal that trains people to
> stop using a panel.
> **Why it is deferred, not shipped with C2.1** The `agent-run` message carries
> only `{lane, pageUrl}` (`src/shared/messages.ts`), so `handleAgentRun`
> re-resolves the page for itself — and on an ambiguous page that second
> resolve is ambiguous again, which `resolveForAgent` refuses with
> `not_resolved`. Rendering the lanes on a `chosen` header would therefore put
> *"Nimbus couldn't pin this page to one indexed item."* directly under a
> header naming the item the user had just picked, and `not_resolved` withholds
> Re-run, so it would be terminal: two dead controls, every time. Carrying the
> picked id through the message is a contract change, not a render tweak, so it
> is its own slice.
> **Touches** `src/shared/messages.ts` (`agent-run` / `agent-state` grow an
> optional item id, plus its guard), `src/background/handlers.ts`
> (`resolveForAgent` honours a supplied id instead of re-resolving),
> `src/panel/panel-in-page.ts` (send the chosen id; render the lanes under
> `chosen`).
> **Approach** The id arrives from a content script, so it is untrusted input
> like every other cross-boundary value: guard it in `messages.ts`, and have
> the handler use it as the cache key and the `expert` lane's title source only
> after the resolve it came from is re-checked or the id is confirmed present
> in the ambiguous candidate set. Note a `chosen` candidate carries no
> `modifiedAt` — that is why it is a separate header state — so nothing in the
> lane path may assume a freshness it does not have.
> **Done when** Picking a candidate on an ambiguous page offers both lanes, and
> each answers about *that* item — never a re-resolve, and never a refusal
> contradicting the header above it.
> **Correction (C2.4):** that bar holds for `expert`, which is asked with the
> picked item's own title. It does **not** hold for the URL-parametrised lanes:
> `impact` and `why` are both asked with the *page's* `resolveUrl`, so the
> gateway re-resolves it and an ambiguous page answers with a miss under a header
> naming the item the user just picked — the exact refusal this bar forbids. See
> C2.4's **Known gap**; the fix is to send `ResolveCandidate.url` for those two
> lanes, and it is not done.

## Phase C3 — On a miss, sync — don't scrape 🟡

*Theme: what to do when the page is real but the index has never seen it. The
answer is to ask the gateway to go and get it, not to shred the DOM.*

### C3.1 Targeted sync of a single item · 🟢 · L — ✅ shipped (resolve-after-fetch)
> **What** On a resolve miss, ask the gateway to fetch and index *that one item*
> through the connector that owns it, then answer against it.
> **Why it wows** The client is never stuck on "I don't know that page" for a
> service you have already connected — and the answer comes from the connector's
> real data, not from whatever the page happened to render.
> **Touches** `src/background/gateway-client.ts`, `src/shared/messages.ts`,
> `src/panel/` (a miss → sync → answer state).
> **Approach** Recorded decision: this is a **fetch-and-index write**, added
> explicitly to the **I13** write allowlist rather than reclassified as a read,
> and scoped to the single resolved item. A DOM fallback was considered and
> rejected — it produces a second, lower-fidelity copy of data the connector
> already models.
> **Depends** the gateway surface above. **Propose there first.**
> **Done when** A PR the index has never seen resolves after a bounded sync and
> the lanes answer; an unconfigured connector says so plainly instead of
> retrying.
> **Status** Shipped against the gateway's real `POST /v1/items/fetch` contract
> (see [`docs/architecture.md`](./docs/architecture.md#the-targeted-fetch-path)):
> an explicit-click button on a fetchable miss, the six wire outcomes collapsed
> to four honestly-distinct client states, a client timeout that never reads as
> a failure, and one fetch per panel. Honest gap: the done-when above bundles two
> things — "a PR resolves after a fetch" **and** "the lanes answer". Only the
> first is delivered here; the lanes are **C2**, which is unbuilt. Once C2 lands,
> it answers against exactly the item this slice already knows how to fetch and
> resolve — no further work needed in this slice for that to happen.

### C3.2 Capture as the last resort · 🟢 · M — ✅ shipped
> **What** For a surface with no connector at all — an internal wiki, a vendor
> console — capture the page and ingest it so the agents have *something*.
> **Why it wows** The reframe doesn't abandon the long tail; it just stops
> pretending capture is the main road.
> **Touches** `src/capture/`, `src/shared/clip.ts`, `src/panel/` (offer capture
> only after resolution and sync have both missed).
> **Depends** **Nimbus#1005** and **Nimbus#1006** — both closed upstream on
> 2026-08-11 (see pillar 2).
> **Done when** An unconnectored page can be turned into an indexed item in one
> gesture, and the panel is honest that this is a captured copy, not connector
> data.
> **Status** Shipped: the offer is gated on the gateway having nothing left to
> try — a resolve miss with a fetch that is unfetchable, not configured, needs a
> re-grant, or was never a fetch candidate at all — never instead of a better
> answer that's still available. Re-capture ships in this slice too, as a
> low-prominence **Update this copy** control running the identical capture →
> preview → send flow; because ingest is an upsert, the result is one refreshed
> item, never a duplicate. The honesty is keyed on the item, not the moment —
> `service: "nimbus"` / `type: "web_clip"` renders the captured header whether
> the panel just captured the page or is opening on it a month later, so a copy
> never quietly ages into looking like connector data. Two known limitations,
> recorded rather than left to be discovered: the durable header holds only on a
> **recognised** page — an unrecognised page never reaches resolve at all, so
> the confirmation is a terminal "Saved a copy of …" line, not a durable header —
> and the offer does not appear while a fetch is merely rate-limited or still
> working — retrying beats scraping. See
> [`docs/architecture.md`](./docs/architecture.md#capture-as-the-last-resort-phase-c32).
> Full reasoning:
> `docs/superpowers/specs/2026-08-16-capture-as-last-resort-design.md`.

## Phase C4 — Trust for a client that fetches 🟢/🟡

*Theme: the extension can now cause the gateway to reach out. Pillar 4 has to
grow a second half to match.*

### C4.1 "What did the gateway do for me?" · 🟡 · M
> **What** A browser-side record of the actions this extension caused: what was
> fetched, when, for which page, and how it ended.
> **Why it wows** "Nothing leaves without you seeing it" stops being only about
> outbound clips and starts covering everything done on your behalf.
> **Touches** `src/options/` (a log view), `src/background/gateway-client.ts`.
> **Approach** The gateway already has the primitive — an append-only egress
> ledger with `nimbus prove` (**I29**). Whether a targeted sync lands in that
> ledger is a question for the upstream design, not something to assume here;
> the client should read the gateway's record rather than keep a private one it
> could quietly disagree with.
> **Depends** a read surface over that record. **Propose in the gateway repo.**
> **Done when** Every gateway-side fetch the panel triggered is listed with
> time, target and outcome, and the list does not contradict the gateway's own.
> **Status** Designed, not yet built — see
> [`docs/superpowers/specs/2026-08-23-gateway-activity-ledger-design.md`](./docs/superpowers/specs/2026-08-23-gateway-activity-ledger-design.md).
> The design reads the upstream and settles the question this brief left open:
> **yes, a targeted sync is ledgered.** `sync/targeted-fetch.ts` appends one row
> per fetch before calling the connector, and agent runs over HTTP append one
> `source_type='http'` row each. Three corrections to this brief follow from
> reading the rows themselves. **The dependency is narrower than "a read
> surface":** `egress.list`/`head`/`verify`/`proveWindow` already exist as IPC
> verbs — what is missing is an HTTP route over them, plus an `egress` scope,
> which means an already-paired user must re-pair. **The done-when is not
> reachable from today's rows:** a fetch row carries no item identity ("for
> which page") and is appended *before* the fetch, so it records authorization
> rather than outcome ("how it ended") — both are proposed upstream, outcome as
> its own design there. **The `Touches` line understates it:** the log outgrew
> an options section, so it is a summary line in the trust panel plus its own
> page, and the reads live in a new `egress-client.ts` rather than in
> `gateway-client.ts`. Still 🟡, and the client slices are sequenced to ship
> against the read route alone.

### C4.2 Preview before a fetch · 🟢 · S — ✅ shipped
> **What** Extend the pre-send preview (1.3) to cover fetch requests: show
> exactly which item you are asking the gateway to go and get, before it goes.
> **Why it wows** Same promise as 1.3, applied to the new direction of travel.
> **Touches** `src/popup/popup.ts`, `src/panel/panel-view.ts` — folds directly
> into 1.3's preview component.
> **Done when** No gateway-side fetch happens without the user having seen what
> it will fetch, or having turned the confirmation off deliberately.
> **Status** Shipped, folded into **1.3**'s preview exactly as briefed: one pure
> builder in `src/shared/preview.ts` produces both previews and one renderer
> draws both, so the fetch confirm and the clip confirm cannot drift from each
> other or from the request actually sent. The panel's fetch button now names
> the service, the type and the address and waits for Send. Unlike the clip
> preview, this one has **no off switch** — a targeted fetch is an I13 write
> under your own stored credential, so it is always confirmed.

## Phase C5 — Ask across what you have open 🟢

*Theme: the first capability whose input is a set of pages rather than the page
you are on — and the one thing a browser surface can do that the terminal and
the editor structurally cannot.*

### C5.1 Research briefs from your open tabs · 🟢 · L — ✅ shipped
> **What** Pick the tabs you have open, ask one question the recognised set
> scaffolds, and read a cited brief with findings, conflicts and gaps.
> **Why it wows** "The six things I have open right now" is context no other
> Nimbus surface has. Conflict detection across your own tabs is the output no
> clipper can produce at all.
> **Touches** `src/shared/brief.ts`, `brief-report.ts`, `brief-log.ts`,
> `safe-url.ts`; `src/background/brief-client.ts`, `brief-handlers.ts`,
> `brief-run-store.ts`, `brief-log-store.ts`; `src/brief/`;
> `src/options/brief-log-view.ts`.
> **Status** Shipped against the gateway's five-route research-briefs surface
> (`POST /v1/briefs` → `/sources` → `/run` → poll → `/save`), which was already
> built for a client like this one — `MAX_SOURCES_PER_RUN`'s comment reads "the
> client caps its composer at this number".
> **No new manifest permission, and that is not a compromise:** `tabs.query`
> withholds `url`/`title` without host permission for that tab, and host
> permission is exactly what capture needs — so the set the composer can *name*
> is the set it can *read*. An ungranted tab is counted, never guessed at. This
> is the second thing **C1.4**'s per-host grant buys, and the first that needs it
> on several tabs at once. **Qualifier (C5.3):** this holds for *enumeration* —
> `tabs.query` withholding a name without a host grant. A passage is named on an
> ungranted origin too, because the user selected the text and right-clicked it;
> the gesture is the grant, the same way it already is for `clip-selection`.
> **The question is scaffolded by the recognised set**, with free text behind a
> collapsed control — the non-goal below is about which affordance leads, not
> about forbidding typing.
> **The honest gap:** the client cannot promise synthesis stays local.
> `createBriefLlm` falls back to a remote provider when no local one is
> available, and no pre-run signal exists. So the confirmation names every source
> and states the uncertainty; the report says what actually happened. The
> upstream fix is proposed **in the gateway repo, not this one** — the
> `dev/asafgolombek/briefs-prerun-disclosure` branch's
> `2026-08-17-brief-synthesis-destination-design` spec: a synthesis policy echoed
> at create, a tighten-only `requireLocal`, and the `model` egress class raised.
> **Done when** A set of open tabs becomes one cited brief, a page that cannot be
> read is named rather than silently dropped, and nothing claims a destination it
> cannot know. ✅ Full reasoning:
> [`docs/superpowers/specs/2026-08-17-research-briefs-design.md`](./docs/superpowers/specs/2026-08-17-research-briefs-design.md).

### C5.2 Corrections this phase records
> **5.1 "Ask-your-clips" is superseded, not delivered.** Its stated dependency —
> "a query/QA endpoint on the gateway (e.g. `POST /v1/clips/ask`)" — does not
> exist and, on this evidence, will not. The capability landed in a different and
> better shape: a staged brief whose sources the client supplies. Recorded the
> same way **3.4** was recorded as superseded by C1.3's ambient half, rather than
> silently retagged. **Update (C5.4):** the one piece this correction still
> called *genuinely unbuilt* — a brief with `useIndex: true` — has since shipped.
> After C5.4, nothing in 5.1 remains unbuilt.
> **2.3 "Highlight-stitching" is re-aimed.** Its reframe note already said the
> collect UI would have to live as a panel lane. A brief's source list is the
> better home for "assemble several things into one"; the selection half becomes
> a follow-up to C5.1.
> **C4.1 is half-delivered, and its approach note needs qualifying.** It says to
> read the gateway's record rather than keep a private one that could disagree.
> True for fetches; **false for `model`-class egress**, where
> `THIS_BINARY_COVERAGE.model` is `none` and there is no record to read at all.
> C5.1's local disclosure log is that half; reading the gateway's own record for
> the other half is still blocked on a read surface that does not exist.
> **C1.4's status line is stale.** It says the per-host grant "buys only
> gesture-free recognition, which **C2** is the first to need". C1.3's ambient
> half already dated that, and C5.1 is the first consumer needing the grant on
> several tabs simultaneously.
> **The "thirteen agents" figure is still stale**, as the 2026-08-13 correction
> flagged without fixing globally. Not fixed here either — this phase consumes no
> agent — but noted again so the next reader does not treat it as verified.

### C5.3 Passages as brief sources · 🟢 · M — ✅ shipped
> **What** Right-click a selection anywhere → **Add to brief**. Passages
> accumulate across pages and across tabs; the brief composer shows each page
> as one row you can pick, passages by default; a page you highlighted three
> times arrives at the gateway as one source holding those three passages, in
> the order you collected them.
> **Why it wows** A brief's sources were whole pages; reading isn't — you find
> the three paragraphs that matter and want the brief built on those, not the
> navigation chrome and the eleven other sections that happened to share the
> URL. Because the text is captured *when you highlight it*, a passage
> survives closing the tab, and for the first time the pre-send preview can
> show the actual text that will leave rather than a description of it.
> **Touches** `src/shared/passage.ts` (new, pure); `src/background/passage-store.ts`,
> `passage-collect.ts` (new), `menus.ts`, `service-worker.ts`;
> `src/shared/messages.ts` (`BriefStartRequest.picks`'s shape guard — the outer fence, not the dedupe), `preview.ts`,
> `preview-view.ts`; `src/background/brief-handlers.ts`; `src/brief/brief-view.ts`,
> `brief.ts`, `brief.css`.
> **Approach** The collect gesture reuses `captureTab` — the same call the
> clip path already makes — never the menu click's `info.selectionText`, which
> the browser truncates without saying so; a passage is long by nature, so
> collecting off that field would file a silently cut excerpt under the user's
> own gesture. Passages sharing a fragment-stripped URL stitch into one source
> body joined by `PASSAGE_SEPARATOR`; `capturedAt` is the oldest passage's
> time, because a stitched body is only as fresh as its oldest text. One
> storage key, one pure rules module owning every cap, and a failed write
> refuses rather than evicts — a passage exists in exactly one place and was
> put there by hand.
> **Done when** A highlighted passage is named in the composer, its exact text
> is visible in the pre-send preview, and sending it removes it from the
> collection — while a run that fails, or a row sent as the whole page
> instead, leaves its passages untouched. ✅
> **Status** Shipped, with divergences from the plan worth recording. The
> whole-page toggle is reversible in both directions: a review caught that the
> first pass made passages vanish for the session once you clicked "Use the
> whole page instead", so a row already in whole-page mode now carries "Use
> its passages instead", and a tab closing releases whole-page mode rather
> than stranding the collection. "A URL is declared exactly once" is enforced
> in `handleBriefStart`, not the composer — the composer renders one row per
> page key, but the message guard checks shape, not uniqueness, so the dedupe
> lives at the layer that declares. A failed tab enumeration no longer hides
> the collection; a passage group needs no tab, so its rows render beneath the
> error line. And the preview shows the exact bytes: `stitch` and the
> preview's body join on the same imported `PASSAGE_SEPARATOR`, so what the
> preview shows is byte-for-byte what gets sent — asserted by
> `test/e2e/passages.e2e.ts` against what the mock gateway actually receives,
> which required fixing a real pre-existing bug: the mock gateway's `serve()`
> silently dropped every POST body, so no spec had ever been able to assert on
> one. This entry is itself a correction: Phase C5 had no brief for this work,
> only C5.2's note that it was coming. 2.3's status line below and C5.1's
> qualifier above record the other two the design's own *Corrections to the
> roadmap* lists. Full reasoning:
> [`docs/superpowers/specs/2026-08-18-passages-as-brief-sources-design.md`](./docs/superpowers/specs/2026-08-18-passages-as-brief-sources-design.md).

### C5.4 Briefs over your index · 🟢 · M — ✅ shipped
> **What** One checkbox in the composer — **Also search what Nimbus has
> indexed** — lets a brief's gateway search its own index with the question
> text and cite what it finds, alongside the tabs and passages you picked.
> **Why it wows** A brief has only ever been built from what you have open
> right now; everything Nimbus already knows sat one process away and was
> never consulted. One box lets a brief draw on
> your own saved context without you going to find and re-open it.
> **Touches** `src/shared/brief.ts`, `preview.ts`, `messages.ts`,
> `brief-report.ts`, `brief-log.ts`; `src/background/index-pref.ts` (new),
> `brief-handlers.ts`, `brief-client.ts`; `src/brief/brief.ts`,
> `brief-view.ts`; `src/options/options.ts`, `options.html`,
> `brief-log-view.ts`; `test/e2e/index-brief.e2e.ts`, `mock-gateway.ts` (taught
> to serve index hits, which it did not before).
> **Approach** `index-pref.ts` is modelled on `preview-pref.ts` but fails the
> opposite way — default **off**, fallback **off** — because the safe
> direction for a control that widens what a run consults is "don't", not
> "show something nobody asked for". The index is a checkbox, not a source
> row: the composer's rows are things the client *feeds*; the index is
> something the gateway supplies. Because the client cannot read the
> gateway's index in advance, the pre-send preview names the bound it may
> draw on (up to 8 items) and says plainly it cannot list them and that the
> question text is what gets searched, rather than guessing at a list the
> finished report might then contradict — the report is where every item
> actually used gets named, and an indexed citation carries a visible marker
> and a type label so it never reads like a tab you chose. `kind: "clip"` is
> kept on the wire and redocumented as "an item from your index" rather than
> renamed, because it is persisted in every saved brief upstream; the new
> `itemType` carries what the item actually is, and only the type is shown —
> never the item id, which is a hex digest useless to a person.
> **Done when** Ticking the box before Send is what decides whether the
> create body carries `useIndex: true`; the preview states the bound and
> that the question is the text searched; the finished report marks every
> indexed citation distinctly; the choice persists across sessions and is
> visible and resettable in Options; and none of this relaxes the
> at-least-one-pick rule the composer already enforced. ✅
> **Status** Shipped in two steps, and the second one is the point. It shipped
> with every user-facing string deliberately NARROW — *your saved clips* —
> because the gateway's brief search was still scoped to `itemType:
> "web_clip"`, and `publish.yml` puts this copy into two public store listings
> off a `v*` tag with no manual gate, so a claim true only of an unmerged
> branch would have reached users before the behaviour did. The widening then
> landed upstream (Nimbus#1253) and the nouns widened with it: the composer
> checkbox and its hint, the Options toggle and its hint, `INDEX_NOTICE`, the
> egress-log line, the changelog and the docs. A citation's "from your index"
> never moved — true on both sides, since a clip is in your index. The rule
> that produced the narrow phase is the durable part: a client string that
> describes gateway behaviour states what the SHIPPED gateway does, and
> `test/unit/preview.test.ts` pins whichever side is currently true.
> **The index cannot be a brief's sole corpus, and this does not
> change that:** `POST /v1/briefs` 400s on an empty `sources` array
> regardless of `useIndex`, so an index-only brief — almost exactly what 5.1
> originally asked for — stays unreachable from the composer; allowing
> `sources: []` is an upstream validation change with its own consequences
> and belongs in its own slice, not a clause in this one. **The honest gap
> this slice discloses rather than closes:** clips are embedded locally, but
> the search's *query* — your question — is routed through the gateway's
> ordinary embedding configuration and may leave the machine; the preview
> says so. This entry is itself a correction: Phase C5 had no brief for this
> work, only C5.2's note that it was coming, which this entry's update now
> marks resolved. Full reasoning:
> [`docs/superpowers/specs/2026-08-19-briefs-over-your-index-design.md`](./docs/superpowers/specs/2026-08-19-briefs-over-your-index-design.md).

---

## Phase 1 — Trust you can see 🟢

*Theme: turn the invisible privacy guarantee into a visible, provable feature —
and stop the single most common annoyance (clipping the same page twice). Cheap,
uniquely ours, and the fastest way to make the extension feel different.*

### 1.1 Never-clip-twice · 🟢 · S
> **What** Detect an already-indexed page and say so *before* the user clips.
> **Why it wows** No other clipper tells you "you already saved this" the instant
> you reach for the button — and offers a one-click jump to it.
> **Touches** `src/popup/popup.ts`, `src/shared/related.ts`,
> `src/background/handlers.ts` (a lightweight `handleLookup`).
> **Approach** On popup open, call `/v1/clips/related` with the canonical URL;
> an exact-URL hit means "already clipped." Reuse the `updated` status the ingest
> endpoint already returns as the post-clip confirmation.
> **Done when** Opening the popup on an indexed page shows an "Already in Nimbus"
> state with a jump action; clipping it reports "updated," not "created."
> **Reframe** Same feature, different plumbing: the approach above does not
> actually work against today's contract — `/v1/clips/related` uses
> `canonicalUrl` to *exclude* the current host, not to match it. This is the
> shallow case of **C1.1** and should be built on the resolve read, not before it.

### 1.2 "Where does my data go?" trust panel · 🟢 · S — ✅ shipped
> **What** A plain, always-reachable panel stating: one destination
> (`127.0.0.1`), no telemetry, no remote host, MIT + no runtime deps.
> **Why it wows** The privacy pitch becomes something a user can *read and verify*,
> not a claim they have to take on faith. Screenshot-worthy.
> **Touches** `src/options/options.html` + `options.ts`, or a new popup tab.
> **Approach** Static, honest copy driven by the real configured origin from the
> connection store; link to the source and the loopback check in `shared/gateway.ts`.
> **Done when** A user can see, in one place, exactly where clips go and what the
> extension can and cannot reach.
> **Status** Shipped as stage 4 of the staged Options flow — always open
> regardless of pairing state, because the answer has to be reachable before
> you commit to pairing, not only after. Driven by the real configured origin,
> the sites you have granted page access to, and the current settings, rather
> than fixed copy. See [`docs/architecture.md`](./docs/architecture.md#discovery-connection-health-and-the-trust-panel).

### 1.3 Show exactly what gets sent · 🟢 · M — ✅ shipped
> **What** A pre-send preview of the clip payload — title, URL, mode, tags, and a
> body excerpt — before it leaves the browser.
> **Why it wows** "Nothing leaves without you seeing it" is a promise you can now
> *demonstrate*. It also doubles as a capture-quality check.
> **Touches** `src/popup/popup.ts`, `src/shared/clip.ts` (payload builder).
> **Approach** Render the built `ClipPayload` (never the token) in a collapsible
> preview; optional as a setting so power users can turn it off.
> **Done when** The user can inspect the outgoing payload and confirm/cancel; the
> bearer token is never shown (invariant).
> **Status** Shipped for the **toolbar popup only** — the gesture that already
> had a surface to confirm on. The hotkey and the right-click menu stay one
> gesture and report in the toast afterwards; giving a one-gesture path a
> confirm step would defeat the point of the gesture, and there is no popup DOM
> to render into. Off switch in Options stage 4. The fields are named one by one
> in a pure builder rather than iterated off the payload, so a field added to
> `ClipPayload` later can never leak into the preview unnamed — the token
> invariant holds by construction, not by review. The excerpt is cut, but the
> reported length is of the **whole** body, so a cut excerpt can never
> understate what leaves. Extended to fetch requests by **C4.2** above.

### 1.4 Connection health at a glance · 🟢 · S — ✅ shipped
> **What** A live indicator: paired/unpaired, the origin, last-successful-clip
> time, and pending-queue depth.
> **Why it wows** The tool feels *alive* and honest — you always know its state.
> **Touches** `src/options/connection-view.ts`, `src/popup/queue-view.ts`,
> `src/background/handlers.ts` (extend `handleConnectionStatus`).
> **Done when** Connection state and queue depth are visible without guessing;
> a dead token surfaces as "needs re-pairing," not a silent failure.
> **Status** Shipped. `handleConnectionStatus` reports `{paired, origin, label,
> pairedAt, lastClipAt, queueDepth, reachable, stale}`; Options renders it as
> one honest line naming where you're connected, when the last clip landed,
> and how many clips are waiting to sync — and a token the gateway has
> rejected reads "Needs re-pairing" rather than leaving you to guess whether
> Nimbus is even running. See
> [`docs/architecture.md`](./docs/architecture.md#discovery-connection-health-and-the-trust-panel).

## Phase 2 — Capture anything, cleanly 🟢

*Theme: widen coverage and raise fidelity until "it didn't capture right" stops
happening. Each item is client-side capture feeding the unchanged ingest
endpoint.*

### 2.1 PDF capture · 🟢 · M
> **What** Clip a PDF open in the browser (local or remote) as readable text.
> **Why it wows** PDFs are where most clippers give up. Papers, docs, and manuals
> become first-class, searchable clips.
> **Touches** `src/capture/`, `src/manifest/manifest.ts` (PDF-viewer contexts).
> **Approach** Detect the PDF viewer/content-type; extract text (bundle a small
> PDF text extractor, keeping the no-runtime-deps rule) → `CaptureResult`.
> **Done when** Clipping a PDF produces a text clip with title + source URL and a
> graceful fallback when text can't be extracted (e.g. scanned/image PDFs).
> **Reframe** Lower priority. Still wanted for the long tail (**C3.2**), but it
> is a read-it-later strength where the incumbents are already strong — it wins
> us nothing on the surfaces the client is being built for.

### 2.2 Video transcript capture · 🟢 · M
> **What** Clip the transcript of a YouTube (and similar) video.
> **Why it wows** Turns hours of video into searchable, quotable text in your index.
> **Touches** `src/capture/capture-in-page.ts` (site-aware extractor).
> **Approach** Pull the transcript track from the page when available; title +
> channel + URL as metadata; `mode: "article"`.
> **Done when** On a video with a transcript, the clip contains the transcript and
> source metadata; no transcript degrades to the bookmark fallback.
> **Reframe** Lower priority — a reading-library feature, not a working-surface
> one. Kept because it is cheap and self-contained, not because it moves the
> north star.

### 2.3 Highlight-stitching · 🟢 · M
> **What** Collect several selections across a page into one coherent clip.
> **Why it wows** Matches how people actually read — grab the three paragraphs that
> matter, not the whole page or a single blob.
> **Touches** `src/capture/capture-in-page.ts`, `src/panel/` (a small collect UI),
> `src/shared/clip.ts`.
> **Approach** An in-page "add to clip" affordance accumulates ranges; assemble in
> selection order into one body with light separators.
> **Done when** Multiple highlights on a page become a single clip preserving order
> and source; clearing/committing the collection is obvious.
> **Reframe** Lower priority, and it now competes with **C1.3** for the same
> in-page real estate — if both ship, the collect UI has to live as a panel lane,
> not as a second overlay. **Correction (C5.3):** the overlay half of that
> sentence stands; the lane half does not. It was written before `panel-in-page.ts`
> reached 1,939 lines and before **C1.5** gave the panel a second entry point — a
> lane costs a gesture per page before you can highlight into it, which defeats
> the point of collecting being cheap. The collect UI is a context-menu entry;
> the collection is reviewed where sources are already picked, the brief
> composer. Nothing in `src/panel/` changed.
> **Status** Delivered, re-aimed — not as written. Its own acceptance bar
> ("multiple highlights on a page become a single clip") is deliberately
> **unmet**: **C5.2** re-aimed this item at a brief's source list rather than a
> clip, and **C5.3** is where it landed. See
> [`docs/superpowers/specs/2026-08-18-passages-as-brief-sources-design.md`](./docs/superpowers/specs/2026-08-18-passages-as-brief-sources-design.md).

### 2.4 Full-page vs. readable toggle · 🟢 · S
> **What** Let the user choose readable extraction or the full page content.
> **Why it wows** Readability is great until it isn't — give the escape hatch.
> **Touches** `src/popup/popup.ts`, `src/capture/capture-in-page.ts`.
> **Done when** The user can switch capture shape per-clip; the choice is
> remembered as a default.

### 2.5 Faithful metadata & figures · 🟢 · M
> **What** Extract author, publish date, canonical URL, site name, and preserve
> key figures/images references.
> **Why it wows** A clip becomes a real record you can cite, not a de-styled dump.
> **Touches** `src/capture/capture-in-page.ts`, `src/shared/clip.ts`,
> `src/shared/types.ts` (extend `CaptureResult` — keep guards in `messages.ts` in
> sync).
> **Done when** Clips carry structured metadata where the page exposes it, within
> the existing ingest body shape.
> **Reframe** Higher priority. The canonical URL is now the *resolution key* the
> whole client turns on (**C1.1**/**C1.2**) — getting it right on redirecting,
> tracking-parameter-laden and self-hosted URLs is load-bearing, not cosmetic.
> **Status** ✅ shipped across three slices, two repos — **S1** the canonical
> resolver (#67, #68), **S2** the `source` passthrough upstream (Nimbus#1288,
> released in gateway 2.12.0), **S3** extraction and threading. The brief's
> "preserve key figures/images references" is met by `leadImage` alone; inline
> figures are deferred, because `body` is plain `textContent` by contract and
> preserving them means redesigning body extraction — its own feature, with its
> own body-cap and embedding consequences. JSON-LD reaches the client only via
> Readability, which returns nothing at all on a page it cannot read, so hard
> pages get `<meta>` tags only. See
> [`docs/superpowers/specs/2026-08-20-faithful-metadata-and-canonical-url-design.md`](./docs/superpowers/specs/2026-08-20-faithful-metadata-and-canonical-url-design.md).

### 2.6 Hard-page robustness · 🟢 · M
> **What** Reliable capture on SPAs, infinite-scroll, and lazy-rendered content.
> **Why it wows** The pages that break other clippers just work.
> **Touches** `src/capture/capture-in-page.ts`, `src/capture/fallback.ts`.
> **Approach** Wait-for-content heuristics before extraction; smarter fallback
> chain (Readability → main-content heuristic → meta/bookmark).
> **Done when** A documented set of previously-failing pages capture correctly;
> the fallback never produces an empty clip.
> **Reframe** Narrowed, not demoted. The hard pages that matter are now the
> unconnectored internal tools of **C3.2**; a connectored page should be synced,
> never scraped harder.

## Phase 3 — Capture at the speed of thought 🟢

*Theme: strip every gram of friction from the capture gesture and from
organizing after.*

### 3.1 Command palette · 🟢 · M
> **What** A keyboard-summoned palette: clip · clip-selection · show-related ·
> (later) ask · open options.
> **Why it wows** Power-user speed; never hunt for a button again.
> **Touches** new `src/panel/`-style injected overlay, `src/background/service-worker.ts`
> (a `commands` entry + message).
> **Done when** A single shortcut opens the palette on any injectable page and runs
> each action; restricted pages fail closed with a toast.
> **Reframe** Retained and re-aimed: the palette becomes the keyboard route into
> the **C2** lanes for the resolved item, not a list of capture verbs. Still not
> a generic ask box.

### 3.2 One-press undo · 🟢 · S
> **What** Undo the last clip immediately after it lands.
> **Why it wows** Forgiving by default — wrong clip costs one keypress, not a trip
> to the index.
> **Touches** `src/capture/toast-view.ts` (an undo affordance), `src/background/handlers.ts`.
> **Approach** Within a short window, offer undo from the toast; for a just-created
> clip, delete/soft-remove via the appropriate gateway call.
> **Done when** Undo from the confirmation toast reverses a just-made clip within
> the window; after it, undo is unavailable and says so.
> **Depends** may need a delete affordance on the gateway if none exists → if so,
> re-tag 🟡 and propose it (see [gateway proposals](#proposing-a-gateway-dependent-feature)).
> **Reframe** Lower priority — it protects the capture gesture, which is no
> longer the primary one. Still a good first contribution.

### 3.3 Smart tag suggestions + tag memory · 🟢 · M
> **What** Suggest tags as you clip — from your recently-used tags and from tags on
> related indexed items.
> **Why it wows** Organization becomes a tap, informed by your own history.
> **Touches** `src/popup/popup.ts`, `src/shared/clip.ts`, `src/shared/related.ts`,
> a small tag store in `src/background/`.
> **Approach** Local frequency/recency memory of tags; augment with tags from
> `/v1/clips/related` hits. Purely additive to the current free-text tag input.
> **Done when** The tag field offers relevant suggestions; accepting one is a
> single interaction; suggestions improve with use.
> **Reframe** Lower priority — tagging is a filing behaviour, and filing is not
> what the client is for. Connector-sourced items arrive with their own metadata.

### 3.4 Proactive related-on-landing · 🟢 · M — superseded, shipped as C1.3's ambient half
> **What** An unobtrusive ambient signal when you land on a page you have context
> for ("3 related items in Nimbus"), expandable into the panel.
> **Why it wows** Recall that finds *you* — the core magic, surfaced without a click.
> **Touches** `src/panel/panel-in-page.ts` + `panel-view.ts`,
> `src/background/service-worker.ts`, `src/manifest/manifest.ts`.
> **Approach** Opt-in; debounced `/v1/clips/related` on navigation; a quiet badge
> that never blocks the page. Respect activeTab/permission boundaries.
> **Done when** On pages with related context, a dismissible ambient cue appears;
> it is off by default or clearly opt-in and never noisy.
> **Reframe** Superseded, not dropped — this is the ancestor of the ambient
> panel. Build it as the related lane of **C1.3**, on **C1.4**'s per-origin
> permission, rather than as a standalone cue with its own opt-in.
> **Status** Shipped, exactly as the reframe directed: built on **C1.4**'s
> per-origin permission (a per-host toggle, off by default), as part of the
> **C1.3** panel's ambient half rather than a standalone feature with its own
> opt-in. It resolves the page to a single indexed item and names it, rather
> than counting related hits — a stronger, narrower claim than "3 related items
> in Nimbus" that only fires when there is one real answer. See **C1.3** above
> and `docs/superpowers/specs/2026-08-13-ambient-surfacing-design.md`.

### 3.5 Zero-config gateway discovery · 🟢 · S — ✅ shipped
> **What** Find the local gateway automatically so pairing is the only setup step.
> **Why it wows** Ten-second onboarding; the URL field disappears for most users.
> **Touches** `src/shared/gateway.ts`, `src/options/options.ts`.
> **Approach** Probe the known loopback origin(s) within the allowed host
> permissions; never widen beyond loopback.
> **Done when** A running local gateway is detected without the user typing a URL;
> manual override remains available.
> **Reframe** Higher priority. A client you have to configure before it can
> recognise anything is a client nobody keeps installed.
> **Status** Shipped as a sequential probe of exactly two loopback
> candidates — `http://127.0.0.1:7474`, then `http://localhost:7474` — never a
> port scan. `127.0.0.1` goes first because that is the literal address
> invariant I6 binds the gateway to; `localhost` is the fallback for dual-stack
> resolution quirks. The manual URL field stays exactly as briefed: no match is
> not a failure state, it's "ask the user." See
> [`src/shared/discovery.ts`](./src/shared/discovery.ts) and
> [`docs/architecture.md`](./docs/architecture.md#discovery-connection-health-and-the-trust-panel).

## Phase 4 — Ambient intelligence 🟢/🟡

*Theme: make the related panel feel less like search results and more like a
second memory. Mostly built on the existing `/related`; the deepest cuts need the
engine to grow.*

### 4.1 Richer related panel · 🟢/🟡 · M — ✅ shipped (open-in-Nimbus dropped)
> **What** Grouped, previewable related items (source type, snippet, date) with
> open-in-Nimbus.
> **Touches** `src/panel/panel-view.ts`, `src/shared/related.ts`.
> **Done when** Related items are scannable at a glance and openable in one click.
> **Reframe** Retained as the first lane of the **C1.3** shell — same content,
> rendered inside the panel's lane contract instead of alongside it.
> **Status** Shipped, and two thirds of the brief turned out to be a correction
> rather than an addition. The **snippet was an extract of the title** —
> `snippet()`'s second argument is an FTS5 column index and V48 re-pointed
> `item_fts` to `(title, body)`, so index `0` returned the title the client was
> already printing above it. And the lane **excluded its own best results**: the
> gateway drops every hit sharing the host of the `canonicalUrl` sent, which on a
> GitHub pull request is every other github.com item. Both shipped as defects,
> not as gaps awaiting polish.
> `type` and `date` were **not buildable against the locked contract** — the wire
> hit was five fields — so this item is retagged 🟢 → 🟢/🟡: the projection was
> proposed and landed upstream, and the client consumes it.
> **`open-in-Nimbus` is dropped, not deferred.** It presumes a way to address an
> indexed item from outside the gateway and there is none: no route, and
> `grep -rn "nimbus://" packages` returns zero matches. The link to the item's
> source, which the lane already renders, is the only "open" that exists. If a
> deep-link primitive is ever proposed upstream this becomes a one-line client
> change.
> Design: `docs/superpowers/specs/2026-08-16-richer-related-lane-design.md`.

### 4.2 Related-on-selection · 🟢 · S — ✅ shipped
> **What** Highlight text → see what's related to *that*, not just the page.
> **Touches** `src/panel/`, `src/background/service-worker.ts` (selection payload
> already supported by `RelatedRequest`).
> **Done when** Selecting text updates the related panel to that selection.
> **Status** Shipped with **C2.5** and the glossary lane. Half of it turned out
> to exist already: `readContext()` has always sent the live selection with the
> related request at panel-open. What was missing was re-running related with a
> NEW selection while the panel is open — a **What's related to this?**
> context-menu entry now does exactly that, and unlike *Define in Nimbus* it
> spends no agent run: the glossary lane appears for the same selection, but
> collapsed and unasked.

### 4.3 "You've read N things about this" · 🟡 · M
> **What** A meaning-level ambient signal about a topic, not just page matches.
> **Depends** a richer relevance/topic signal from the engine beyond the current
> `/v1/clips/related` shape. **Propose in the gateway repo.**

## Phase 5 — Ask your reading 🟡

*Theme: the flagship AI feature — a question box answered from your own clips, on
your machine. The client is straightforward; the retrieval surface is the work.*

### 5.1 Ask-your-clips · 🟡 · L — superseded by C5.1
> **Superseded, not delivered.** The dependency this item named —
> `POST /v1/clips/ask` — does not exist upstream and, on the evidence of the
> read that produced **C5.1**, will not. What landed instead is the staged
> research-briefs surface, where the *client* supplies the sources rather than
> the gateway searching its own index. **C5.1** consumes it. What remains
> genuinely unbuilt from this brief is the index-backed half — a brief with
> `useIndex: true` — which is a follow-up to C5.1, not a separate feature.
> **What** A question box (popup + command palette) that answers from the local
> index with citations back to your clips.
> **Why it wows** The thing no cloud clipper can safely offer and no local tool has
> the recall to. This is the "wow" people screenshot.
> **Touches** `src/popup/`, `src/panel/`, `src/shared/messages.ts` (a new
> request/response pair), `src/background/handlers.ts` + `gateway-client.ts`.
> **Depends** **a query/QA endpoint on the gateway** (e.g. `POST /v1/clips/ask` →
> answer + source hits). Contract owned and designed in the gateway repo; this repo
> consumes it. **Propose there first.**
> **Done when** A user asks a natural-language question and gets an answer grounded
> in citeable local clips, entirely over loopback.
> **Reframe** Reshaped and sequenced after **C2**. A generic ask box is
> explicitly *not* the direction — the recognised page is the better prompt, and
> the agents are better answers than a bare QA endpoint. Keep this as the escape
> hatch for "I have a question this page's lanes don't cover", built on whatever
> invocation surface **C2.1** lands.

## Phase 6 — Understand on clip 🟡

### 6.1 Auto-tags + one-line summary on clip · 🟡 · M
> **What** Every clip lands with suggested tags and a summary already attached.
> **Why it wows** A clip is useful the *second* it's saved — no manual triage.
> **Touches** `src/popup/popup.ts` (surface + accept suggestions),
> `src/shared/messages.ts`, `src/background/gateway-client.ts`. Folds directly into
> the tag UI from **3.3**.
> **Depends** **the ingest response (or an enrichment read) returning suggested
> tags + summary.** Design in the gateway repo. **Propose there first.**
> **Done when** After a clip, engine-suggested tags/summary are shown and one-tap
> acceptable; absent the surface, the client degrades to local suggestions (3.3).
> **Reframe** Lower priority — it rides on the capture path (**C3.2**) and
> inherits its gating defects (**Nimbus#1005**/**#1006**).

## Phase 7 — Search & resurface 🟡

### 7.1 Search your clips from the toolbar · 🟡 · M
> **What** Full-text/semantic search of your index from the popup — without opening
> the main Nimbus app.
> **Depends** **a search/browse endpoint** on the gateway. **Propose there first.**

### 7.2 Resurfacing ("on this day", "continue reading") · 🟡 · M
> **What** Gentle resurfacing of past clips worth revisiting.
> **Depends** a browse/query surface (shares 7.1's dependency).
> **Reframe** Lower priority — a reading-library ritual. The client's version of
> resurfacing is `agents.catchup` on a surface you have been away from (**C2.3**).

## Phase 8 — Adopt the Nimbus SDK 🔵

*Theme: delete the duplication. This repo is the SDK's Phase 1 proof surface.*

### 8.1 Migrate onto the Nimbus SDK · 🔵 · L
> **What** Replace hand-rolled `gateway-client.ts`, `handlers.ts`, and
> `connection-store.ts` with SDK calls — identical behavior and invariants.
> **Why it wows** Less surface to maintain, and the same client spine every Nimbus
> tool shares. Proof that "any repo can build on it" is real.
> **Touches** `src/background/*`; the message routing, capture pipeline, and state
> machines are untouched by design (see
> [architecture: the SDK seam](./docs/architecture.md#the-sdk-seam-where-this-goes-next)).
> **Depends** the Nimbus SDK reaching its Phase 1 (roadmapped in the SDK repo).
> **Done when** The bespoke gateway code is gone, the test suite is green against
> the SDK's `MockNimbusGateway`, and behavior is unchanged.
> **Reframe** Higher priority. Once the browser and the editor are both clients
> of the same gateway running the same agents, the duplicated client spine stops
> being tidiness and starts being the thing that keeps two surfaces in step.

## Phase 9 — Extend the engine 🔵

### 9.1 Register as a first-class capture source · 🔵 · L
> **What** The clipper registers with Nimbus as a capture source rather than only
> calling it.
> **Depends** the engine's plugin/registration story (SDK Phase 3). **Propose /
> track in the gateway + SDK repos.**
> **Reframe** Broadened: the interesting registration is as a *surface* — a
> client the engine can address and notify — with capture as one of the things
> it can offer. Unbuilt and unspecified on either side; this is a bet, not a plan.

## Phase 10 — Reach 🔵

### 10.1 More browsers & surfaces · 🔵 · M
> **What** Additional Chromium browsers and, where feasible, mobile, sharing the
> same pure core.
> **Why it wows** The same private recall, everywhere you read.
> **Touches** `src/manifest/manifest.ts` (new targets), `scripts/`.
> **Done when** A new target builds, passes `check-build`, and ships through the
> existing tag-driven release.

---

## Good first clips

New here? These are small, self-contained, high-value, and need nothing from
another repo — ideal first contributions:

- **Add a surface recogniser** — `src/shared/recognise.ts` is one table entry plus
  fixtures per product; the cleanest entry point into the reframe now that C1.2
  has shipped the scaffolding.
- **2.4 Full-page vs. readable toggle** — one setting, one capture branch.
- **3.2 One-press undo** — a toast affordance + a short window (mind the gateway
  note).
- **4.2 Related-on-selection** — the selection payload is already supported.

Each maps to the codebase via its **Touches** line. Read
[`docs/architecture.md`](./docs/architecture.md) and
[`docs/development.md`](./docs/development.md) first, then pick one.

## Contributor guardrails

The vision is bold; these boundaries are not negotiable. A change that breaks one
of these will not be accepted, no matter how good the feature.

- **Loopback only.** The one network destination is the gateway on `127.0.0.1` /
  `localhost`. Never add `<all_urls>` or a remote origin. Origin validation lives
  in `src/shared/gateway.ts` (**I6**).
- **Page access is a separate axis from network access, and it is opt-in.**
  Recognition needs to see the URL of pages that aren't the gateway; that is
  granted per origin at runtime (**C1.4**), never as a static broad host
  permission, and it never changes where the client can *send* anything.
- **The token is the only secret, and it stays invisible.** Never in a page DOM,
  never logged, never displayed. The pairing code is treated the same. `noConsole`
  in `src/` is enforced by Biome.
- **Don't redesign the wire contract here.** It's owned and versioned by the
  gateway repo. A feature needing a new surface is 🟡 — propose it there (below).
- **Bundled, no runtime deps.** The shipped extension has no `node_modules`. New
  capability = bundle it or inject it; heavy deps are a smell.
- **Keep pure logic out of the `chrome.*` seam** so it stays unit-testable. New
  decision logic goes in a pure module with injected deps + a Vitest test.
- **Strict TypeScript, no `any`.** Cross-boundary data is `unknown`, narrowed by a
  guard in `src/shared/messages.ts`.

Every PR runs `typecheck`, `lint`, `test`, `build`, and `check-build` (see
[`CLAUDE.md`](./CLAUDE.md#commands)). Green is the bar.

## Proposing a gateway-dependent feature

A 🟡 item is blocked on the Nimbus gateway growing a new surface. The client work
can be *designed* and even *stubbed* here, but the contract is decided upstream:

1. Write the client-side brief here (or in a `docs/superpowers/specs/` design) —
   including the **shape** of the endpoint you'd need (request/response), tagged
   clearly as *proposed, not yet contracted*.
2. Open the contract proposal in the [Nimbus gateway repo](https://github.com/nimbus-agent/Nimbus).
   The gateway is the authority; it decides the versioned shape.
3. Once the surface ships and is versioned, the item flips 🟡 → 🟢 and the client
   consumes it. Never fork or fake the contract client-side.

## Measures of success

"Best clipper" is measurable. We hold ourselves to:

- **Capture success rate** — the fraction of clip attempts that produce a faithful,
  non-empty clip, tracked against a fixed corpus of hard pages (locally, never as
  telemetry).
- **Time-to-clip** — from gesture to confirmation, kept sub-second on the happy
  path.
- **Resolve rate** — the fraction of recognised work pages that resolve to an
  indexed item without a targeted sync. This is the number that says whether the
  client knows where you are.
- **Time-to-answer** — from landing on a page to a lane's first useful line, with
  the sync path measured separately and honestly (it is slower, and saying so is
  part of the design).
- **Related usefulness** — related items a user actually opens; the panel earns its
  place or it's noise. The same bar applies per agent lane: a lane nobody expands
  is removed, not tuned forever.
- **Zero-leak** — provably one destination, no telemetry, verifiable by the trust
  surface and the source. Non-negotiable, not a metric to trade off.

## Non-goals

The vision is bold, but the boundaries are not. These keep us honest:

- **No cloud, no telemetry, no remote host.** If a feature needs a server we don't
  own, it's not this product.
- **We do not redesign the gateway contract here.** New surfaces are proposed
  upstream and land here as consumers — never forked or faked client-side.
- **The token is the only secret, and it stays invisible.**
- **Not another read-it-later silo.** No competing cloud library, no social layer.
  The value is private recall, not a walled garden.
- **Not a generic ask box.** The surface should know what page it is on. If a
  feature only works by asking the user to type what they are looking at, it is
  the wrong feature for this client.
- **We don't scrape what a connector already models.** On a resolve miss the
  client asks the gateway to sync that item; shredding the DOM for a second,
  lower-fidelity copy was considered and rejected (**C3.1**).
