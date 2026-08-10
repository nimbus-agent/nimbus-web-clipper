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

## Security check

- The bearer token never appears in the page DOM, the popup/options DOM, or any
  log. Confirm via DevTools that no `console` output or DOM node contains it.
