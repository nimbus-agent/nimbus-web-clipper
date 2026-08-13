# Ambient surfacing — the panel finds you

**Date:** 2026-08-13
**Status:** Design, approved. Implementation plan to follow.
**Roadmap items:** lands the deferred half of **C1.3** ("ambient auto-surfacing
waits until C2 gives the lanes real answers" — C2 shipped) and supersedes **3.4**
*Proactive related-on-landing*, built as the roadmap directs: on C1.4's
per-origin permission, not as a standalone cue with its own opt-in. Closes an
unrecorded gap in **C1.4** along the way (§2).

## What this builds

On a host you have granted page access to **and** switched on, landing on a page
that resolves to exactly one indexed item mounts a small cue in the page corner
naming that item. Clicking it opens the panel that already exists. Dismissing it
silences that item in that tab.

Everything else is silence. A miss, an ambiguity, a resolve error, an unpaired
gateway, a restricted page: no cue.

Nothing runs. No agent is invoked and no lane expands — the ambient path buys
the knowledge that there is something here, and the click still spends
everything it spends today.

## Why now

C1.3 shipped the panel user-summoned and said why: ambient surfacing waits until
the lanes have real answers. C2.1 and C2.2 shipped those answers. C1.4 shipped
the per-origin permission and recorded honestly that "the grant currently buys
only gesture-free recognition, which **C2** is the first to need."

Nothing needs it yet. A user who grants page access today gets nothing for it
that they would not have got from the `activeTab` gesture. This slice is what
makes the grant worth making.

## The four decisions

Taken deliberately, each against a named alternative.

### 1. A quiet corner cue, not an auto-opening panel

The cue is its own small surface: a shadow-DOM overlay pinned to a page corner,
naming the recognised surface and the resolved item, with one dismiss control.
Clicking it injects the panel through the existing path.

Rejected: **auto-open the panel collapsed.** It reuses more code and costs
nothing to build, and it is the wrong trade at the moment of arrival — the panel
is a working surface roughly 340px wide, and mounting it unasked on every
resolved PR takes screen real estate from the page you actually came to read.
ROADMAP 3.4's own bar is "a quiet badge that never blocks the page."

Rejected: **toolbar badge only.** Zero intrusion, and easy to miss entirely,
which is most of what 3.4 exists to fix. A signal you have to go and look for is
the signal we already have.

### 2. Resolve first; cue only on a hit

The sequence is recognise (pure, local) → resolve (one loopback call) → cue only
on `found`. A page that does not resolve produces no cue and no trace.

Rejected: **cue on recognition alone**, resolving only when clicked. It makes no
unsolicited gateway call at all, which is genuinely cheaper, and it means the cue
appears on every pull request you open — including the ones Nimbus has never
heard of — and sometimes leads nowhere. A cue that is right about the *page* but
wrong about *whether we can help* trains people to ignore it. The recogniser
gates the cost either way: only a recognised page ever reaches the gateway.

Rejected for now: **cue on a fetchable miss too** ("not indexed yet — fetch
it?"), wiring C3.1's fetch button into the ambient path. More reach, and more
chances to appear when nothing was wanted. Revisit only if the hit-only cue earns
it.

### 3. Per-host toggle, default off

Each row in Options' Recognised surfaces list gains its own *surface
automatically* switch, off until set.

Rejected: **the grant is the opt-in.** Simplest, needs no new setting, and
silently changes what an existing grant means for anyone who already made one.
Granting page access and asking to be interrupted are different decisions —
someone may want gesture-free recognition on `github.com` and no cue there.

Rejected: **one global switch.** Coarse: on means on everywhere granted, with no
way to keep the cue on your team's Jira and off your own GitHub.

### 4. Dismissal is per item, per tab, in memory

The dismiss control hides the cue for the item you are looking at, in that tab,
until you navigate to a different item. Nothing is persisted.

Rejected: **permanent per-item suppression.** It needs a capped, evictable store
and gives no way back short of a reset — a suppression that outlives the reason
for it, which is worse than being cued once more.

Rejected: **per-host, per-session silence.** Blunt, and it discards the
granularity that makes the cue feel targeted.

## The prerequisite this slice discovered

`surfaceRows()` (`src/options/options.ts:176`) builds the Recognised surfaces
list from `getOrigins()` alone — the **stored, self-hosted** origins. The SaaS
hosts are not stored: `BUILT_IN_ORIGINS` (`src/shared/recognise.ts:13`) carries
`bitbucket.org`, `github.com` and `gitlab.com`, and Jira Cloud is matched by its
`.atlassian.net` suffix.

The Grant button lives on a row. Those hosts have no row. **So there is today no
way to grant page access to `github.com`** — short of hand-adding
`https://github.com` as though it were self-hosted, duplicating a built-in, which
nothing in the UI suggests.

That hole has been latent since C1.4 because nothing consumed the grant. This
slice is the first consumer and hits it immediately: the cue would be
unturnable-on for the three hosts most users have. So it is in scope here:

- The surfaces list renders **built-in rows** alongside stored ones: grant /
  revoke and the new toggle, and **no Remove** (they are not the user's entries
  to delete).
- Jira Cloud gets one row carrying the pattern `https://*.atlassian.net/*`. It is
  a legal WebExtension match pattern and sits inside the
  `optional_host_permissions` already shipped (`src/manifest/manifest.ts:111`),
  so it adds no manifest change and no new install-time warning.
- `hostPermissionPattern` (`src/shared/origins.ts:116`) is unchanged for stored
  origins; the built-in rows carry their pattern directly, since the Jira Cloud
  wildcard is not derivable from an origin string.

## Components

| Module | Kind | Job |
| --- | --- | --- |
| `src/browser/tabs.ts` | seam | grows `addNavigationListener` (`chrome.tabs.onUpdated`) and `addTabClosedListener` (`chrome.tabs.onRemoved`); still the only place `chrome.tabs` is touched |
| `src/background/ambient.ts` | **pure**, injected deps | the whole decision: url + tab state + prefs + recogniser + resolver → `show` or `none` |
| `src/background/ambient-prefs.ts` | store | which host patterns have the cue switched on |
| `src/panel/cue-view.ts` | **pure** | builds the cue DOM; `textContent` only, never `innerHTML` |
| `src/panel/cue-in-page.ts` | injected | mounts `cue.js` in a shadow root, two-step like `toast.js` |
| `src/shared/messages.ts` | seam | one new message + guard: cue → worker, "open the panel here" |
| `src/options/surfaces-view.ts` | pure | built-in rows and the per-host toggle |
| `src/options/options.ts` | glue | toggle click handler; rows merged from built-ins + stored |
| `src/background/service-worker.ts` | glue | wires the listener to `ambient.ts` with real deps |

Preferences live in their own store rather than as a field on `ConfiguredOrigin`
(`src/shared/types.ts`), because the built-in hosts are not in that list at all —
adding a flag to the stored shape would leave `github.com` with nowhere to put
its own setting. The store keys by **host permission pattern**, the same
identifier the grant is keyed by, so the toggle and the grant cannot describe
different hosts.

## The flow

```
chrome.tabs.onUpdated (changeInfo.url present)
  ├─ tab active? ───────────────────── no ──→ silence
  ├─ debounce ~600ms per tab (SPA churn)
  ├─ host granted AND toggled on? ──── no ──→ silence
  ├─ recognise(url, origins)  [pure] ─ no ──→ silence   ← no gateway call yet
  ├─ already cued or dismissed for this item in this tab? ─ yes ─→ silence
  ├─ resolve  [one loopback call]
  │    ├─ found ────────────→ inject cue.js → __nimbusCue({ label, ref })
  │    └─ anything else ────→ silence
  └─ in page: panel already mounted (#nimbus-related-host)? ─ yes ─→ don't mount
```

The permission boundary is enforced by the browser, not by us: Chrome populates
`changeInfo.url` only for tabs the extension holds host permission on, so an
ungranted host is invisible to the listener by construction. The explicit
granted-check above is the second lock, not the first. This is a property worth
asserting in a test so it stays a property rather than a coincidence.

Once mounted, the cue runs the same lightweight URL watch the panel already uses
(`NAV_CHECK_MS`, `src/panel/panel-in-page.ts:105`) and retracts itself when the
page moves to a different item. That is the defect the panel-page-context slice
fixed on 2026-08-11; the cue pays for the lesson once rather than re-learning it.

Clicking the cue sends the new message; the worker calls the existing
`injectPanel` (`src/browser/scripting.ts:42`). The cue removes itself first, so
the two surfaces are never on screen together.

Per-tab memory is a module-scope `Map<tabId, resolveUrl>` in the service worker,
cleared on `chrome.tabs.onRemoved`. Deliberately not persisted: a service-worker
eviction re-cues once, which is a better failure than a suppression that outlives
the reason for it. This is decision 4 applied to the implementation, not an
oversight.

## Error handling

**Every failure path is silence.** An unreachable gateway, an expired pairing, a
missing `resolve` scope, a restricted page that rejects injection, a storage read
that throws: no cue, no toast, no badge.

The panel is where errors get *spoken*, because the user asked it something. The
ambient path never earned the right to interrupt a page with a problem report.

The deliberate cost: a user who grants, toggles on and is not paired sees nothing
and is not told why. That is answered where the state lives — the Options row
shows the toggle as on, next to the existing connection status that reports the
pairing. A corner box announcing our own errors on a page someone is trying to
read is the worse trade.

## Cost and silence rules

The measures of success in the ROADMAP set the bar: a lane nobody expands is
removed, not tuned forever. The same applies here.

- One loopback resolve per *recognised* page on a *granted, enabled* host, on the
  *active* tab only. Middle-clicking fifteen PRs into background tabs costs
  nothing.
- Debounced per tab, so an SPA that rewrites its URL twice during one navigation
  resolves once.
- At most one cue per tab at a time, and none while the panel is open.
- The cue is fixed to a page corner, does not take focus, is not modal, and
  accepts pointer events only within itself.

## Testing

- `ambient.ts` — a decision table under Vitest (node): granted × enabled ×
  active × recognised × each resolve outcome (`found` / `not_indexed` /
  `unresolvable_url` / `ambiguous` / each error) × dedupe × dismissal. This is
  where the feature's behaviour actually lives.
- `cue-view.ts` — jsdom: renders the label and ref, dismiss and open targets
  exist, user-supplied text goes through `textContent`.
- `surfaces-view.ts` — jsdom: built-in rows render with grant/revoke and toggle
  and **without** Remove; a stored row keeps all four controls; toggle state
  reflects prefs.
- `messages.ts` — guards for the new message, matching the existing guard tests.
- `manifest.test.ts` — assert this slice adds **no new permission**. It genuinely
  does not, and that should fail loudly if it ever stops being true.
- `scripts/check-build.mjs` — `cue.js` joins the per-target completeness list
  (`scripts/check-build.mjs:18`), and `esbuild.mjs` gains the entry
  (`esbuild.mjs:29`).
- `docs/development.md` — the manual pass, since none of the injected surfaces
  are unit-testable end to end: SPA navigation retracts the cue, background tabs
  stay silent, a restricted page fails closed, revoking page access mid-session
  silences the host, and the cue does not appear while the panel is open.

## Out of scope

- Cue on a fetchable miss (decision 2's second rejection). Later, if earned.
- Persisted dismissal (decision 4).
- Background tabs.
- Any ambient agent invocation. Nothing runs without a click — that rule is the
  reason the panel is defensible, and the ambient path does not get an exception.
- Renaming, restyling or otherwise reworking the panel itself.

## Done when

A user grants page access to `github.com` from Options — possible for the first
time — switches the cue on for it, opens a pull request Nimbus has indexed, and
sees a corner cue naming that item. Clicking it opens today's panel on today's
item. Dismissing it silences that PR in that tab. Opening a PR Nimbus has never
seen shows nothing at all, and neither does any page on a host that is not
switched on.
