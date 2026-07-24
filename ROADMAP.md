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

The bet underneath this is deliberate. The read-it-later graveyard is real —
Pocket sunset, Omnivore acquired and shut down, and everyone's carefully-clipped
libraries went with them. Every one of those was a cloud service that owned your
reading. **Local-first is the only durable answer**, and it is also the only one
that can make privacy a *feature you can see* rather than a promise you have to
trust. We turn the constraint into the pitch.

To be the best clipper in this space, we win on four axes at once. Not one — all
four. That combination is the moat: no cloud clipper can be this private, and no
private tool has this kind of on-device recall.

## The four pillars

Every feature in every phase serves one of these. If it doesn't, it's out of
scope.

### 1. AI-native retrieval — the moat

The Nimbus index is a semantic engine, not a bookmark list. The clipper's job is
to make that power feel like magic *while you browse*: ambient related-items,
never-clip-twice detection, asking questions of your own reading, and
auto-understanding every clip on arrival. This is the axis no cloud clipper can
match privately, and no private tool can match on recall.

### 2. Capture quality & coverage — clip *anything*, cleanly

A clip is only as good as what it captured. The widest coverage and highest
fidelity of any extension: beyond the readable article to PDFs, video transcripts,
and the hard cases (SPAs, infinite scroll), captured the way you read — full-page
or readable, region or highlight-stitched — with faithful author/date/canonical
metadata and preserved figures.

### 3. Frictionless UX — capture at the speed of thought

The best capture is the one you don't have to think about. Keyboard-first,
one-gesture paths that all land in the same place, honest instant feedback, smart
tag suggestions, a command palette, one-press undo, and a queue that heals itself
offline. Organization is a keystroke, not a chore.

### 4. Privacy & trust as a feature — provable, not promised

Local-first is worth nothing if the user can't *see* it. A visible trust surface
that answers "where does my data go?", a preview of exactly what gets sent, a
connection panel that names the single origin it talks to, a secret that never
touches a page, and an open, reproducible, dependency-free build.

---

## How to read the phases

Phases are ordered on one principle: **ship what we can build today first** — it
needs no other repo and delivers value now — then the work that needs the Nimbus
gateway/engine to grow a new surface, then the ecosystem bets. Within a phase,
highest value first.

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
- **Release** — tag-driven build/package + Chrome Web Store / Firefox AMO publish
  automation.

Read [`docs/architecture.md`](./docs/architecture.md) before your first change —
the load-bearing decisions and the two state machines are documented there.

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

### 1.2 "Where does my data go?" trust panel · 🟢 · S
> **What** A plain, always-reachable panel stating: one destination
> (`127.0.0.1`), no telemetry, no remote host, MIT + no runtime deps.
> **Why it wows** The privacy pitch becomes something a user can *read and verify*,
> not a claim they have to take on faith. Screenshot-worthy.
> **Touches** `src/options/options.html` + `options.ts`, or a new popup tab.
> **Approach** Static, honest copy driven by the real configured origin from the
> connection store; link to the source and the loopback check in `shared/gateway.ts`.
> **Done when** A user can see, in one place, exactly where clips go and what the
> extension can and cannot reach.

### 1.3 Show exactly what gets sent · 🟢 · M
> **What** A pre-send preview of the clip payload — title, URL, mode, tags, and a
> body excerpt — before it leaves the browser.
> **Why it wows** "Nothing leaves without you seeing it" is a promise you can now
> *demonstrate*. It also doubles as a capture-quality check.
> **Touches** `src/popup/popup.ts`, `src/shared/clip.ts` (payload builder).
> **Approach** Render the built `ClipPayload` (never the token) in a collapsible
> preview; optional as a setting so power users can turn it off.
> **Done when** The user can inspect the outgoing payload and confirm/cancel; the
> bearer token is never shown (invariant).

### 1.4 Connection health at a glance · 🟢 · S
> **What** A live indicator: paired/unpaired, the origin, last-successful-clip
> time, and pending-queue depth.
> **Why it wows** The tool feels *alive* and honest — you always know its state.
> **Touches** `src/options/connection-view.ts`, `src/popup/queue-view.ts`,
> `src/background/handlers.ts` (extend `handleConnectionStatus`).
> **Done when** Connection state and queue depth are visible without guessing;
> a dead token surfaces as "needs re-pairing," not a silent failure.

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

### 2.2 Video transcript capture · 🟢 · M
> **What** Clip the transcript of a YouTube (and similar) video.
> **Why it wows** Turns hours of video into searchable, quotable text in your index.
> **Touches** `src/capture/capture-in-page.ts` (site-aware extractor).
> **Approach** Pull the transcript track from the page when available; title +
> channel + URL as metadata; `mode: "article"`.
> **Done when** On a video with a transcript, the clip contains the transcript and
> source metadata; no transcript degrades to the bookmark fallback.

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

### 2.6 Hard-page robustness · 🟢 · M
> **What** Reliable capture on SPAs, infinite-scroll, and lazy-rendered content.
> **Why it wows** The pages that break other clippers just work.
> **Touches** `src/capture/capture-in-page.ts`, `src/capture/fallback.ts`.
> **Approach** Wait-for-content heuristics before extraction; smarter fallback
> chain (Readability → main-content heuristic → meta/bookmark).
> **Done when** A documented set of previously-failing pages capture correctly;
> the fallback never produces an empty clip.

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

### 3.4 Proactive related-on-landing · 🟢 · M
> **What** An unobtrusive ambient signal when you land on a page you have context
> for ("3 related items in Nimbus"), expandable into the panel.
> **Why it wows** Recall that finds *you* — the core magic, surfaced without a click.
> **Touches** `src/panel/panel-in-page.ts` + `panel-view.ts`,
> `src/background/service-worker.ts`, `src/manifest/manifest.ts`.
> **Approach** Opt-in; debounced `/v1/clips/related` on navigation; a quiet badge
> that never blocks the page. Respect activeTab/permission boundaries.
> **Done when** On pages with related context, a dismissible ambient cue appears;
> it is off by default or clearly opt-in and never noisy.

### 3.5 Zero-config gateway discovery · 🟢 · S
> **What** Find the local gateway automatically so pairing is the only setup step.
> **Why it wows** Ten-second onboarding; the URL field disappears for most users.
> **Touches** `src/shared/gateway.ts`, `src/options/options.ts`.
> **Approach** Probe the known loopback origin(s) within the allowed host
> permissions; never widen beyond loopback.
> **Done when** A running local gateway is detected without the user typing a URL;
> manual override remains available.

## Phase 4 — Ambient intelligence 🟢/🟡

*Theme: make the related panel feel less like search results and more like a
second memory. Mostly built on the existing `/related`; the deepest cuts need the
engine to grow.*

### 4.1 Richer related panel · 🟢 · M
> **What** Grouped, previewable related items (source type, snippet, date) with
> open-in-Nimbus.
> **Touches** `src/panel/panel-view.ts`, `src/shared/related.ts`.
> **Done when** Related items are scannable at a glance and openable in one click.

### 4.2 Related-on-selection · 🟢 · S
> **What** Highlight text → see what's related to *that*, not just the page.
> **Touches** `src/panel/`, `src/background/service-worker.ts` (selection payload
> already supported by `RelatedRequest`).
> **Done when** Selecting text updates the related panel to that selection.

### 4.3 "You've read N things about this" · 🟡 · M
> **What** A meaning-level ambient signal about a topic, not just page matches.
> **Depends** a richer relevance/topic signal from the engine beyond the current
> `/v1/clips/related` shape. **Propose in the gateway repo.**

## Phase 5 — Ask your reading 🟡

*Theme: the flagship AI feature — a question box answered from your own clips, on
your machine. The client is straightforward; the retrieval surface is the work.*

### 5.1 Ask-your-clips · 🟡 · L
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

## Phase 7 — Search & resurface 🟡

### 7.1 Search your clips from the toolbar · 🟡 · M
> **What** Full-text/semantic search of your index from the popup — without opening
> the main Nimbus app.
> **Depends** **a search/browse endpoint** on the gateway. **Propose there first.**

### 7.2 Resurfacing ("on this day", "continue reading") · 🟡 · M
> **What** Gentle resurfacing of past clips worth revisiting.
> **Depends** a browse/query surface (shares 7.1's dependency).

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

## Phase 9 — Extend the engine 🔵

### 9.1 Register as a first-class capture source · 🔵 · L
> **What** The clipper registers with Nimbus as a capture source rather than only
> calling it.
> **Depends** the engine's plugin/registration story (SDK Phase 3). **Propose /
> track in the gateway + SDK repos.**

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

- **1.2 Trust panel** — static, honest copy driven by the real origin. Pure UI.
- **1.4 Connection health at a glance** — extend an existing handler + view.
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

1. Write the client-side brief here (or in a `docs/specs/` design) — including the
   **shape** of the endpoint you'd need (request/response), tagged clearly as
   *proposed, not yet contracted*.
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
- **Related usefulness** — related items a user actually opens; the panel earns its
  place or it's noise.
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
