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

## Security check

- The bearer token never appears in the page DOM, the popup/options DOM, or any
  log. Confirm via DevTools that no `console` output or DOM node contains it.
