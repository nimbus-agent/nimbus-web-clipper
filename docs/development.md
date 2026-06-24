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

## Security check

- The bearer token never appears in the page DOM, the popup/options DOM, or any
  log. Confirm via DevTools that no `console` output or DOM node contains it.
