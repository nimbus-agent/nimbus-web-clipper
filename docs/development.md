# Development

## Build & load

```bash
bun install
bun run build          # → dist/chrome and dist/firefox
```

- **Chrome:** chrome://extensions → Developer mode → Load unpacked → `dist/chrome`.
- **Firefox:** about:debugging#/runtime/this-firefox → Load Temporary Add-on → `dist/firefox/manifest.json`.

Reload the extension from the browser's extensions page after each `bun run build`.

## Manual verification (the parts not unit-tested)

Prereq: a Nimbus gateway running with `NIMBUS_HTTP_PORT` set; run `nimbus clip pair`
to get a code.

1. **Pair:** Options → enter `http://127.0.0.1:<port>` + the code → "Paired as …".
   - Wrong code → "Code wrong or expired".
   - Non-loopback URL → "Enter a 127.0.0.1 / localhost URL".
2. **Clip article:** open a news/blog article → popup → add a tag → Clip page →
   "Saved to Nimbus". Re-clip → "Updated in Nimbus".
3. **Clip selection:** select text → Clip selection → "Saved to Nimbus".
4. **Bookmark fallback:** open an SPA/app page Readability can't parse → Clip page →
   "Saved as a bookmark".
5. **Restricted page:** on chrome://extensions → Clip page → "Nimbus can't clip
   browser system or store pages."
6. **Offline:** stop the gateway → Clip page → "Can't reach Nimbus".
7. **Search:** in Nimbus, `nimbus search` for a word in the clip → it appears.
8. Repeat 1–4 in Firefox.

## Manual verification — Slice 2 (related panel)

Prereq: paired (Slice 1) and the gateway has some indexed items.

1. **Open from popup:** on an article, popup → **Show related** → the right-edge
   panel mounts and lists related items (title · service badge · snippet).
2. **Open from hotkey:** press `Alt+Shift+R` → the same panel opens. Re-press →
   it closes (toggle). Press again → opens; **Esc** closes it; the X button closes it.
3. **Esc isolation:** on an app that uses Esc (e.g. GitHub command palette), opening
   the panel and pressing Esc closes only the panel.
4. **Selection query:** select text → open the panel → results reflect the selection.
5. **Links:** a hit with a URL opens in a new tab; a URL-less hit is plain text.
6. **States:** with the gateway stopped → "Can't reach Nimbus…"; while unpaired →
   "Pair a browser first (Options)."; no matches → "No related items found."
7. **Restricted page:** on `chrome://extensions`, the popup **Show related** shows
   "Nimbus can't show related on browser system pages."; the hotkey does nothing.
8. **Dark mode:** with the OS in dark mode, the panel renders dark.
9. Repeat 1–6 in Firefox.

## Manual verification — Slice 3 (offline retry queue)

Prereq: paired (Slice 1). To force the transient path, stop the gateway (or point
the Options origin at an unused port) so clips fail with "Can't reach Nimbus".

1. **Queue on failure:** with the gateway stopped, Clip page → status reads
   "Saved offline — will sync when Nimbus is back."; the popup shows a "Waiting to
   sync (1)" section and the toolbar badge shows `1`.
2. **Dedup:** re-clip the same page → still one entry (payload replaced), badge `1`.
   Clip a second page → badge `2`, two rows.
3. **Auto-drain:** start the gateway and wait ~1 min (or reopen the popup) → the
   queue drains, the section hides, the badge clears.
4. **Manual retry:** queue some clips offline, start the gateway, open the popup,
   press **Retry all** (and a per-row **Retry**) → those entries sync and disappear.
5. **Remove:** press a row's **Remove** → the entry is dropped; badge decrements.
6. **Unpaired backlog:** with entries queued, unpair (Options) → the badge still
   shows the backlog; entries don't drain until re-paired.
7. **Restart persistence:** queue offline, then disable+enable the extension (or
   restart the browser) → the queue and badge survive; it drains when the gateway
   returns.
8. **Not-queued errors:** while paired but mid-session token loss (or a 400) → the
   clip reports its error and is **not** queued.
9. Repeat 1–5 in Firefox.

## Manual verification — Connection management (Options)

1. **Unpaired state:** with no connection stored, open Options → the **pairing form**
   is shown (gateway URL + code + Pair); the Connection panel is hidden.
2. **Pair → paired panel:** complete a pairing → the form is replaced by
   *"Paired as "<label>" to <origin>, since <date>."* and an **Unpair** button.
3. **Persistence:** reload the Options page → it still shows the paired panel (state
   comes from the service worker, not the page).
4. **Unpair two-step:** click **Unpair** → it becomes *"Click again to confirm
   unpair"* with a **Cancel**; click **Cancel** → reverts (still paired); click
   **Unpair** twice → returns to the pairing form.
5. **Token never exposed:** with DevTools open on the Options page, confirm no
   bearer token appears in the DOM or in the `connection-status` message payload
   (only label/origin/pairedAt).
6. **Re-pair after unpair:** pairing again from the form returns to the paired panel.
7. **Queued clips survive unpair:** with offline clips queued (Slice 3), unpairing
   leaves them queued; after re-pairing they drain on the next flush.
8. Repeat 1–6 in Firefox.

## Manual verification — Quick clip (context menu + hotkeys)

Prereq: paired (Slice 1), gateway running. Reload the extension after building so
the context menus are re-registered.

1. **activeTab grant (do this first).** On a normal `https://` article, clip via the
   **context menu** (right-click → "Clip page to Nimbus") and then via the
   **hotkey** (`Alt+Shift+C`). Both must show the "Saved to Nimbus." toast. If
   either shows *"Nimbus can't clip browser system or store pages."* on an ordinary
   page, the `activeTab` grant did not apply for that entry point and `tab.url` came
   back empty — the manifest declares `activeTab` but deliberately not `tabs`, so
   this is the one thing unit tests (which fake `chrome.tabs.query`) cannot catch.
2. **Context menu — page:** right-click a page (no selection) → only "Clip page to
   Nimbus" is offered → click it → "Saved to Nimbus." toast; re-clip → "Updated
   in Nimbus.". Confirm it also lands in Nimbus (`nimbus search`).
3. **Context menu — selection:** select text → right-click → "Clip selection to
   Nimbus" → toast; the clipped body is the selection, not the whole article.
4. **Hotkeys:** `Alt+Shift+C` clips the page; with text selected, `Alt+Shift+S`
   clips the selection. Both show the same toasts.
5. **Nothing selected:** press `Alt+Shift+S` with no selection → "Select some text
   first." — nothing is sent to the gateway.
6. **Offline:** stop the gateway → quick-clip → "Saved offline — will sync when
   Nimbus is back." toast; the toolbar badge shows the pending count; restarting the
   gateway drains it (Slice 3 behaviour is unchanged).
7. **Unpaired:** unpair in Options → quick-clip → "Pair a browser first (Options)."
8. **Restricted page:** on `chrome://extensions` (no page script possible) →
   `Alt+Shift+C` → no toast; the toolbar badge flashes `!` for ~1.5s and then
   **returns to the queue count** (queue something offline first to see it restore
   to a number rather than blank).
9. **Toast lifecycle:** clip twice quickly → a single toast (not two stacked), its
   dismiss timer reset; the toast never appears in the page's own DOM tree
   (Shadow DOM) and does not shift page layout.
10. **No duplicate menus:** reload the extension a few times → still exactly two
    Nimbus items in the context menu.
11. **Clicked tab wins:** open two windows; with window B focused, right-click a page
    in window A → the clip and its toast belong to the page in window A.
12. Repeat 1–10 in Firefox (`about:debugging` → reload the temporary add-on; check
    the shortcuts in about:addons → Manage Extension Shortcuts).

## Manual verification — Gateway rate limiting

Prereq: paired (Slice 1), gateway running. The gateway caps `POST /v1/clips` at
20 requests/min on a sliding window; the rate bucket is global across all
paired devices.

1. **Burst clip:** clip 25 distinct pages in under a minute.
2. **Queued responses:** the first ~20 save normally ("Saved to Nimbus"); the
   rest show "Nimbus is busy — queued, will retry shortly." in the popup
   status line and quick-clip toast; the popup queue section shows "Nimbus is
   busy" above those entries.
3. **Auto-drain:** the badge stops growing; the queue drains on its own within
   ~1–2 minutes, with no burst of failures in the gateway's audit log.
4. **Manual retry during pause:** with the queue paused (popup shows "Nimbus
   is busy"), press **Retry all** → it attempts immediately rather than
   waiting for the rate-limit pause to expire.

Note: When dev-loading the unpacked extension (not a store-shipped zip),
Chrome's 30-second minimum on alarm delays does not apply; retry timing
observed in dev mode will differ from the computed Retry-After. Verify pacing
with a shipped extension or configured interval for production accuracy.

## Manual verification — Page recognition (Phase C1)

Prereq: paired, gateway running. The gateway route is `GET /v1/items/resolve?url=`,
under a `resolve` token scope a browser paired before the gateway grew scopes will
not have — its header then correctly says the pairing needs the scope re-granted
(`nimbus clip scopes`). A gateway build with no resolve route at all 404s and the
header says *"This Nimbus gateway can't resolve pages yet."* To exercise the
resolved path reproducibly, run `bun run mock-gateway` and pair against
`http://127.0.0.1:8765` — its mock resolve route always returns a `found` item.

1. **Recognised, resolved:** open any GitHub PR (e.g.
   `https://github.com/acme/web/pull/482`) and press `Alt+Shift+R`.
   → The header reads `GitHub PR · acme/web #482` and names the resolved item.
   The Related lane is below it, collapsed/expandable.
2. **Sub-tabs still resolve:** navigate to the PR's *Files changed* tab and reopen
   the panel. → The header is unchanged; the client sends the address-bar URL
   as-is (it does no canonicalisation of its own) and the gateway's match ladder
   trims the sub-tab segment to find the PR, so the result may show as a
   closest, not exact, match.
3. **Unrecognised:** open any news article and press `Alt+Shift+R`.
   → *"Not a recognised Nimbus surface"*, and **the Related lane still renders**.
4. **Gateway down:** stop the gateway and repeat step 1. → The surface line still
   shows (recognition is local); the header reports it can't reach Nimbus.
5. **Self-hosted with a path prefix:** in Options → **Recognised surfaces**, add
   `https://corp.example/jira` as *Jira*. → A page at `/jira/browse/PLAT-9` is
   recognised as `Jira issue · PLAT-9`; a page at `/wiki/Home` on the same host
   is not.
6. **Case sensitivity:** add the same instance as `/Jira` instead. → Pages under
   `/jira` are **not** recognised. This is deliberate: the prefix is carried
   verbatim into the resolve key.
7. **Recognition works before any grant:** with no origin granted, steps 1–5 all
   still work — the `Alt+Shift+R` gesture supplies `activeTab`.
8. **Grant / revoke, in BOTH Chrome and Firefox:** click **Grant page access** on
   a row. → The browser's permission prompt appears; accepting flips the row to
   **Revoke page access**; declining leaves it on **Grant** with the status
   *"Page access was not granted."*; **Revoke** flips it back. Run this on both
   targets — the prompt and its gesture rules are the browser's, not ours, and a
   grant that silently resolved `false` on one would otherwise only show up in
   the wild.
9. **Shared-host note:** add two prefixed entries on one host (`/jira` and
   `/jenkins`), grant, then revoke one. → The status names the sibling origin the
   revoke also affects (grants are per host, not per prefix).

**Known limitation, confirm rather than fix:** on a client-side (SPA) navigation
— clicking from one PR to another without a page load — an open panel keeps
describing the page it was opened on. Close and reopen to correct it.
Recognition does not follow navigation in this phase; doing so needs the
gesture-free access Phase C2 is the first to require.

## Manual verification — Targeted fetch (C3.1)

Prereq: paired, gateway running, a token scoped with `fetch` (grant it if
needed: `nimbus clip scopes <label> --set clip,briefs,resolve,fetch`, replacing
`<label>` and the list with your device's real name and current scopes — see
`nimbus clip status`), and at least one connector (e.g. GitHub) configured on
the gateway.

1. **Recognised, unindexed, fetchable:** open a GitHub PR the gateway's index
   has never seen and press `Alt+Shift+R`. → The header reads "Not indexed."
   with a **"Fetch this from GitHub"** button. Click it. → The header shows
   "Fetching from GitHub…", then settles into the `resolved` state naming the
   item once the gateway answers `indexed` and the panel re-resolves. Reopen the
   same page's panel — the item now resolves without a fetch button.
2. **Not configured:** repeat step 1 against a service with no connector
   configured on this gateway. → "No <Product> connector is configured on your
   gateway." with **no button** — this is terminal, unlike a retryable error.
3. **403 with only `resolve` granted:** scope a token with `resolve` but not
   `fetch` (`nimbus clip scopes <label> --set clip,briefs,resolve`), open a
   recognised, unindexed page, and click Fetch. → "This pairing can't fetch
   pages yet." plus a pasteable `nimbus clip scopes <label> --set
   clip,briefs,resolve,fetch` command built from the gateway's own 403 response
   (your real device label and full scope set) — not the `resolve`-scope
   guidance from the page-recognition checklist above (a different scope, a
   different fix), and not a literal `<label>` you have to edit by hand.
4. **One fetch per panel:** after a fetch lands (step 1) or is declined
   (steps 2–3), the button never reappears for that same panel instance, even if
   you trigger a recovery re-resolve that comes back as another miss. Close and
   reopen the panel to get the offer back.
5. **Rate-limited → Try again → success:** trigger a fetch while the gateway's
   fetch route is itself rate-limited (e.g. fire several fetches back to back,
   or use `bun run mock-gateway` if it can simulate a `rate_limited` status) →
   the header reads "Rate limited — try again shortly." with a **Try again**
   button. Click it. → A second fetch goes out and, once the gateway allows it,
   settles normally (Fetching… → resolved). This is the one path where a second
   outbound fetch is deliberately permitted: `rate_limited` means nothing was
   sent the first time, unlike `timeout` (step 4's recovery), so retrying here
   is exactly as safe as the first attempt.
6. Repeat 1–3 in Firefox.

## Manual verification — Agent lanes (C2.1)

Prereq: paired, gateway running, a token scoped with `resolve`, `fetch` and
`agents` (grant it if needed: `nimbus clip scopes <label> --set
clip,briefs,resolve,fetch,agents`) for steps 1–2 below; step 3 deliberately
pairs with `agents` withheld to exercise the scope-gap guidance. To exercise
steps 1–2 reproducibly, run `bun run mock-gateway` and pair against
`http://127.0.0.1:8765` — its mock agent routes always return a fixed run id
and report the run `done` immediately with a fixed brief, so a lane never sits
in "Working…" long enough to make a manual pass flaky.

1. **Expand a lane on a resolved PR:** open a GitHub PR the gateway resolves
   (e.g. via the mock gateway's `/sample`, or a real recognised, indexed PR)
   and press `Alt+Shift+R`. → Below Related, two collapsed lanes read *"What
   breaks if it lands"* and *"Who should review it"*. Expand one. → It shows
   "Working…" briefly, then the brief as plain text (no bold, no links, no
   headings — even if the brief contains something that looks like markup).
   Collapse and re-expand it → the same brief reappears with no second
   "Working…" flash and no second network call (confirm in the gateway's own
   log, or DevTools' Network panel, that only one `POST /v1/agents/<lane>`
   fired).
2. **Close and reopen the panel mid-run:** against a gateway slow enough to
   stay `running` for a few seconds (a real gateway with an LLM configured;
   the mock gateway is too fast for this step), expand a lane, then close the
   panel (`Alt+Shift+R` or Esc) before it settles, and wait past however long
   the run takes. Reopen the panel and expand the same lane again. → The
   finished brief appears immediately, because the run kept polling in the
   worker after the panel closed and the result was cached in
   `chrome.storage.local`. **Expect a brief "Working…" flash first** — a
   reopened panel has no lane state, so this expand does send `agent-run`, and
   the panel paints "Working…" optimistically before the answer comes back;
   that is not a second run. What must NOT happen is a second
   `POST /v1/agents/<lane>` (confirm in the gateway's log or DevTools' Network
   panel): the cached `done` short-circuits inside the worker.
3. **Scope guidance, `resolve`+`fetch` only:** scope a token with `resolve` and
   `fetch` but not `agents` (`nimbus clip scopes <label> --set
   clip,briefs,resolve,fetch`), open a recognised, resolved page, and expand a
   lane. → "This pairing can't run agents yet." plus a pasteable
   `nimbus clip scopes <label> --set clip,briefs,resolve,fetch,agents` command
   built from the gateway's own 403 response (your real device label and full
   scope set, `agents` named as the missing one) — not a hand-edited
   placeholder, and not the `resolve`/`fetch` guidance from the checklists
   above (a different scope, a different fix).
4. Repeat 1 in Firefox.

### The eviction check — why this one stays manual

No unit test can cover a run surviving a *real* service-worker eviction: the
harness fakes the eviction net's alarm by calling its handler directly, so
whether Chrome actually preserves a registered `chrome.alarms` alarm across a
genuine eviction, and honours its one-minute period, is unverifiable in this
suite by construction — the test would be asserting behavior of Chrome's own
alarm scheduler, not of this code. See `AGENT_POLL_ALARM`'s doc comment
(`service-worker.ts`) for why the alarm exists only as that net, not as the
poll cadence itself.

Run this in **both** browsers separately — a pass in one is not evidence for
the other. Only Chrome uses `background.service_worker` (an event page that is
evicted after ~30s idle); Firefox runs `background.scripts` and evicts on
different rules entirely. That asymmetry is exactly what the C1 grant/revoke
manual check (above) found the hard way — the same reasoning applies here.

1. **Chrome:** pair, open a recognised resolved page, expand a lane so a run
   starts. Immediately open `chrome://serviceworker-internals`, find this
   extension's worker, and click **Stop** (or just wait out Chrome's ~30s idle
   timeout without touching the extension). Leave the panel closed until well
   past however long the run takes to finish. Reopen the panel and expand the
   same lane. → The brief is there — the alarm fired on a fresh worker start,
   resumed the poll, and the result made it into the store despite the
   worker having been fully torn down mid-run.
2. **Firefox:** same steps, but evict via `about:debugging` → **This
   Firefox** → this extension → **Terminate Service Worker** (or your Firefox
   build's equivalent for `background.scripts`).

## Manual verification — Ambient surfacing (Phase C1.3)

Prereq: paired, gateway running. Nothing here is unit-testable end to end — the
cue is injected into a real page, same as the panel/toast/capture surfaces
above. `bun run mock-gateway` (pair against `http://127.0.0.1:8765`) makes step
1's "indexed" case reproducible, same as the page-recognition and targeted-fetch
checklists above.

1. **Grant, then switch on:** Options → **Grant page access** on the
   `github.com` row (this row exists as of this release — see the C1.4 note
   below), then tick **Surface automatically**.
2. **Cue on a hit:** open an indexed pull request. Within a second a cue appears
   top-right naming it. Click it: the panel opens on that same item, and the
   cue disappears.
3. **Same item, no re-cue:** reload the same PR. No cue.
4. **Different item, new cue:** navigate (in the same tab) to a different
   indexed PR. A cue appears.
5. **Sub-tab is the same item:** switch to that PR's **Files** tab. No second
   cue — `sameItem` (product + kind + ref) treats it as unchanged.
6. **Miss is silence:** open a PR Nimbus has never indexed. Nothing appears at
   all.
7. **Toggle off:** untick **Surface automatically**, reload an indexed PR.
   Nothing appears.
8. **Revoke turns it off too:** re-tick the toggle, then revoke page access.
   The toggle greys out (never shows ticked-but-disabled) and no cue appears.
9. **Background tabs stay silent:** middle-click three PRs into background
   tabs. No cue in any of them until you focus one and navigate.
10. **A cue survives a tab switch:** open a PR, then quickly switch tabs and
    back. The cue is there when you return — the active-tab check runs only
    before the resolve, not after.
11. **Restricted page:** on `chrome://extensions` or another restricted page,
    nothing appears, and no error surfaces anywhere.
12. **Gateway down:** stop the gateway, then open an indexed PR. Nothing
    appears — silence, not an error toast.
13. Repeat steps 1–4 in Firefox.

**C1.4 note:** before this slice, `github.com`, `gitlab.com`, `bitbucket.org`
and Jira Cloud had no row in **Recognised surfaces** at all — only the user's
own self-hosted entries did — and since the Grant button lives on a row, there
was no way to grant page access to them. They're now listed alongside the
user's entries, each with its own grant/revoke and toggle, and no Remove
button (they aren't the user's to delete).

## Manual verification — Panel entry points (C1.5)

Prereq: paired, gateway running, a recognised page available (any GitHub/GitLab/
Bitbucket PR, Jenkins build or Jira issue works). Reload the extension after
building so the context menu is re-registered.

1. Right-click a normal page → **Show related in Nimbus** appears; clicking it
   opens the panel.
2. Right-click a page in a **non-focused** window → the panel opens in *that*
   tab, not the focused one.
3. On `chrome://extensions` → the entry either does not appear or does
   nothing; no error surfaces.
4. Options stage 2 lists all three commands with their real bindings.
5. Deliberately rebind `Alt+Shift+R` to something else in the browser's
   shortcut settings → Options reflects the change on reload.
6. Unbind it entirely → Options shows **Not set**, and the context-menu route
   still opens the panel.
7. Repeat 1–6 in Firefox, confirming the hint names `about:addons` rather than
   the Chrome path.

## Manual verification — Service lanes (C2.3)

**Outstanding — this pass has not yet been performed.** Its summary form is
folded into "Manual verification — Setup that works" below (item 8), so it is
tracked as one backlog item rather than two — run either checklist to clear
it.

Prereq: paired, gateway running, a token scoped with `agents` (`resolve` and
`fetch` are not required — a service lane needs neither, see
`docs/architecture.md`'s "Item lanes vs. service lanes"). `bun run mock-gateway`
(pair against `http://127.0.0.1:8765`) makes steps 1–5 reproducible, the same as
the checklists above — its mock agent routes always return a fixed run id and
report the run `done` immediately with a fixed brief (see the C2.1 section
above). **Step 6 requires a real gateway with no git-aware
`[[filesystem.roots]]` configured**: the gap brief it checks for comes from the
real `ownership` agent noticing the absence of a configured root, which the
mock's fixed brief cannot produce.

1. On `https://github.com/` with page access granted, open the panel. The header
   reads **GitHub dashboard** and names the scope; the three service lanes are
   present; there is no Related lane and no fetch button.
2. Expand *What happened while I was away*. It reaches `running`, then `done`
   with a brief — or a named failure. Never an empty lane.
3. Close and reopen the panel, then re-expand the same lane. The stored brief
   replays; no second run starts.
4. Open the panel on a pull request. Related, *What breaks if it lands* and
   *Who should review it* are present; none of the three service lanes are.
5. On the dashboard, confirm **no ambient cue** appears, with the per-host
   toggle on.
6. With no `[[filesystem.roots]]` configured, *Who owns what* renders the
   gateway's gap brief including its `nimbus index add` line — not a blank
   lane.

## Manual verification — Setup that works (discovery, connection health, the trust panel)

Prereq: a Nimbus gateway available to start/stop on demand. Step 1 needs a
fresh, never-paired profile; steps 2–6 need to be able to stop and restart the
gateway. Step 8 folds in the Service lanes (C2.3) manual pass below, which had
never been run — this is that backlog being cleared, not new work.

1. Load unpacked in Chrome. On a fresh profile, Options shows stage 1 active
   and 2–3 dimmed.
2. With the gateway stopped, press **Find my gateway** → "No gateway found",
   URL field still editable.
3. Start the gateway, press it again → the URL fills in.
4. Pair. Stages 2 and 3 open; the health line names the origin.
5. Clip a page, reopen Options → the health line reports the last clip.
6. Stop the gateway, reopen Options → "Can't reach …", and stages 2 and 3 are
   **still usable** (confirm Unpair is clickable).
7. Repeat 1–6 in Firefox.
8. **C2.3 backlog:** on a GitHub/GitLab/Bitbucket/Jira/Jenkins dashboard,
   confirm the three service lanes render and answer, and that the ambient cue
   stays silent there. See "Manual verification — Service lanes (C2.3)" above
   for the fuller six-step version of this pass.

## Manual verification — Show what leaves (1.3 / C4.2)

Prereq: paired, and a gateway you can watch the request log of (or a proxy) —
several steps assert that **nothing was sent**, which only the gateway side can
confirm.

The clip preview (popup):

1. On an article page, open the popup and press **Clip page**. The payload
   appears *before* anything is sent: Title, URL, Mode, Tags, and a body
   excerpt with a length. Confirm the gateway logged **no** request yet.
2. Press **Cancel** → still nothing sent, and the popup is usable again (you
   can immediately clip once more).
3. Press **Clip page** → **Send**. Exactly one clip lands, and the status
   reports it as before.
4. Type tags first, then clip → the preview lists those tags. With no tags it
   reads **none**, not a blank.
5. On a long article, check the excerpt is cut but the reported length is the
   **whole** body — the number is bigger than the text shown.
6. Repeat 1 and 3 with **Clip selection**: the preview says `selection` and
   shows the selected text.
7. Confirm the preview contains no token: DevTools → inspect the popup DOM.

The off switch:

8. Options stage 4 → uncheck **Show me the payload before sending…**. Reopen
   the popup and clip → it sends straight away, as it did before this slice.
9. Re-check it → the preview is back. Reload Options and confirm the checkbox
   still reflects the stored value.

The fetch preview (panel) — this one has **no** off switch:

10. On a fetchable-but-not-indexed item (see "Targeted fetch (C3.1)" above),
    open the panel and press **Fetch this from …**. The panel names Service,
    Type and Address. Confirm the gateway logged **no** `/v1/items/fetch`.
11. Press **Cancel** → nothing sent, **and the Fetch button still works**.
    Press it again → the preview reopens.
12. Press **Send** → exactly one fetch, then the re-resolve, as before.
13. Force a `rate_limited` outcome and press **Try again** → it opens a fresh
    preview rather than re-sending, and step 12's behaviour repeats.
14. Repeat 1, 3, 10 and 12 in Firefox.

## Manual verification — Lanes that take an input (C2.5 · glossary · 4.2)

Prereq: paired, with the `agents` scope. The glossary steps need at least one
term in your Nimbus glossary; the ambiguity step needs a URL that resolves to
more than one indexed item (the panel shows a chooser when it does).

1. On any page, select a word → right-click → **Define in Nimbus**. The panel
   opens, a lane titled with that term is **already expanded**, and it answers.
2. With the panel still open, select a *different* word → **Define in Nimbus**.
   The panel must **stay open** (this is the toggle hazard: the worker reaches
   the open panel through its hook, never by re-injecting `panel.js`), and the
   lane retitles and re-answers for the new term.
3. Select a whole paragraph → **Define in Nimbus**. The lane says *"That's a
   passage, not a term"*. Confirm in DevTools' network/SW logs that **no**
   `/v1/agents/glossary` call went out.
4. Repeat step 1 on a page Nimbus does **not** recognise — an internal wiki, a
   vendor console. The lane must still work; the page lanes must still be
   absent. This is the slice's central claim.
5. Select text inside a `<textarea>` or `<input>` and define it — it must work
   (this is why the entry reads the browser's captured `selectionText` rather
   than the page's own selection).
6. Select text → **What's related to this?**. The Related lane re-runs against
   the selection, and the glossary lane appears **collapsed and unrun** — no
   agent run is spent on a question nobody asked.
7. Open the panel with no selection anywhere: **no glossary lane at all**.
8. On an ambiguous page, pick a candidate. The two pull-request lanes now appear
   under the chosen header and answer **about that item** — never *"Nimbus
   couldn't pin this page to one indexed item."*
9. Navigate away within an SPA and re-read: the glossary lane is gone, because
   the selection belonged to the page the panel has stopped describing.
10. Repeat 1, 2, 6 and 8 in Firefox.

## Manual verification — Related lane (richer rows)

This is the first checklist section to carry all three coverage labels a step
can have, so later suites follow its lead: a step marked `<!-- e2e:<id> -->` is
asserted by the e2e suite and runs in CI; **(human — reason)** can never be
automated, and the reason says why; **(not yet automated — reason)** is
automatable but has no suite covering it yet, and the reason names what would.

Prereq: paired, gateway running, a resolved GitHub pull request available.

1. <!-- e2e:related-lane-1 --> On a resolved GitHub pull request, open the
   panel: Related must show items *from github.com* (the host filter is what
   used to hide them).
2. <!-- e2e:related-lane-2 --> Each row has a kind chip.
3. <!-- e2e:related-lane-3 --> Each row has an "Updated …" line.
4. <!-- e2e:related-lane-4 --> Rows group under a service heading with a count.
5. <!-- e2e:related-lane-5 --> The preview line is prose from the item, not its
   title repeated.
6. **(not yet automated — needs the selection-hook driving that the
   input-lanes suite establishes).** Select a phrase and run *What's related to
   this?* — the results must change, and the PR you are on must not appear
   among them.
7. **(human — a design judgement, not an assertion).** Note whether the groups
   are mostly one row each: if they are, the headings are noise and grouping
   should be dropped from the lane (see the spec's "Not in this slice").

## Manual verification — Capture as the last resort (C3.2)

Prereq: paired, gateway running. `capture-in-page.ts` is not unit-testable, the
same as the popup/options DOM and the SW glue.

1. On a real page Nimbus does not recognise (an internal wiki, a vendor
   console), open the panel. It offers to capture the page. Click it.
2. Confirm the copy is labelled as yours: the terminal *"Saved a copy of …"*
   line. This page never reaches resolve (see step 4), so this line — not a
   captured header — is the honest signal here.
3. On a **recognised** page (a self-hosted instance the gateway cannot fetch,
   e.g. a `not-configured` connector) run the same capture, then close and
   reopen the panel. → It still shows the captured header — the durability is
   real, because a recognised page's resolve reaches the gateway again on
   reopen and gets the same `web_clip` item back.
4. Repeat on the **unrecognised** page from step 1: close and reopen the panel.
   → No durable header — the page never reaches resolve at all, so reopening
   shows the ordinary `unrecognised` state. The one honest signal that the copy
   was saved is the terminal *"Saved a copy of …"* line shown right after step
   2's save; confirm it appeared then, not that it persists across a reopen.
5. Run **Update this copy** on a captured header. → The gateway reports
   `updated`, and `nimbus search` (or the Nimbus app) shows one item for that
   page, not two.
6. Navigate an SPA mid-capture (start a capture, then trigger a client-side
   route change before it resolves) → the panel reports `url-changed` rather
   than filing the new page's content under the old address.
7. In Options stage 4, switch the 1.3 preview off, then repeat step 1. →
   The offer button is replaced by status lines (*Capturing this page…*, then
   *Saving to Nimbus…*), and the run ends on the terminal *"Saved a copy of …"*
   line — the same end state as step 2, because this is step 1's unrecognised
   page and it never reaches resolve. What this step proves is that the
   in-flight feedback does not depend on the preview being on: with the confirm
   step gone, those two lines are the only evidence anything is happening.

   Repeat once on step 3's **recognised** page to see the other ending: there
   the captured header settles at the end, superseding the terminal line.

## Security check

- The bearer token never appears in the page DOM, the popup/options DOM, or any
  log. Confirm via DevTools that no `console` output or DOM node contains it.
