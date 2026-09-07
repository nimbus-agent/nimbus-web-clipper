# Nimbus Web Clipper — Claude Code Context

## What this is

`nimbus-web-clipper` is a Chrome + Firefox **MV3 browser extension** that clips
web pages (readable article or selection) into the user's local-first
[Nimbus](https://github.com/nimbus-agent/Nimbus) index, and surfaces related
indexed items in an on-demand panel. Phases C1–C7 grew it past clipping: it
recognises the page you are on (PR / build / issue / incident / source file),
runs the
gateway's agents against it as panel lanes — offering only the lanes the paired
gateway publishes, whenever it can say what those are — asks research briefs across your open tabs, and
reads the gateway's egress ledger back as an activity page. It is a **thin client**:
it talks only to a
Nimbus gateway on `127.0.0.1` over a locked HTTP contract. No cloud calls, no
telemetry.

It mirrors the `nimbus-vscode` satellite-repo template (own CI, Biome, esbuild,
Sonar, MIT) and is the browser-side **Plan B** of the web clipper; the gateway
side (**Plan A**) shipped in the Nimbus monorepo (PR #718).

## The locked HTTP contract (do NOT redesign)

The gateway surface is shipped and versioned. Build against it; don't change its
shape here.

- `POST /v1/clips` — ingest a clip. `Authorization: Bearer <paired token>`.
  Body: `{ url, canonicalUrl?, title, mode: "article"|"selection", body, tags?,
  capturedAt, source? }` — `source` is
  `{ author?, publishedAt?, siteName?, lang?, leadImage? }` and needs the
  **gateway release that added it, 2.12.0**, or later; an older gateway accepts
  the clip and drops it silently. That release is old news by now — the
  gateway's own version has since passed **7.5.0** — 2.12.0 is a floor from the
  past, not a claim about the gateway's current line.
  Returns `{ id, status: "created"|"updated" }`.
- `POST /v1/clips/pair/confirm` — redeem a 6-digit pairing code. Body `{ code }`.
  Returns `{ token, label }` (or 403 fail-closed when no pairing window is open).
- `POST /v1/clips/related` — bearer-authed read; related indexed items for the
  current page. Body `{ title?, canonicalUrl?, selection?, limit? }`.

Those three are the original surface. Phases C1–C7 added more, each behind its
own token scope: `GET /v1/items/resolve` (`resolve`),
`GET /v1/items/resolve-file` (`resolve` too — it maps a forge file coordinate
`{service, repo, refAndPath}` to a path in the reader's own checkout. Landed
upstream in Nimbus#1447, ships after gateway 7.9.0, and its **presence is the
capability signal** — do NOT add a version floor for it), `POST /v1/items/fetch`
(`fetch` — an I13 **write**, it causes an outbound provider request),
`POST /v1/agents/{agent}` + `GET /v1/agents/runs/{id}` + the `GET /v1/agents`
roster C6 reads to decide which lanes to offer (`agents`), the five
`/v1/briefs` routes (`briefs`), the four `/v1/egress` reads (`egress`), and the
tokenless `GET /v1/health`. **`src/shared/gateway.ts`'s `GATEWAY_PATHS` is the
single list — read it rather than an enumeration in a doc.** Upstream,
`clips/api-scopes.ts` sets `LEGACY_SCOPES = ["clip", "briefs"]`, so a browser
paired before scopes existed lacks `resolve` / `fetch` / `agents` / `egress` and
gets a 403 the owner clears with `nimbus clip scopes`, without re-pairing.

Pairing: the owner runs `nimbus clip pair` on the gateway to open a short
in-memory window (TTL ~120s, attempt-capped, single-use); the extension POSTs the
printed code to `/pair/confirm` to mint a long-lived token. The gateway binds
`127.0.0.1` only (invariant **I6**); minting is fail-closed (invariant **I30**).

Reference (in the Nimbus monorepo): the gateway surface itself lives in
`packages/gateway/src/clips/` (shipped in PR #718), and the fail-closed minting
rule is the **I30** row in `docs/SECURITY-INVARIANTS.md`. (The original design
spec and gateway plan were pruned once the feature shipped — they live on in the
monorepo's git history.)

## Architecture (load-bearing)

- **Loopback-only.** The only network destination is the gateway on
  `127.0.0.1` / `localhost`. `host_permissions` is restricted to those origins —
  never `<all_urls>`, never a remote host. **Page access is a different axis:**
  `optional_host_permissions` does carry broad patterns (`http://*/*`,
  `https://*/*`), inert at install and granted per host from Options, because
  self-hosted Jira/Jenkins/Bitbucket hostnames cannot be enumerated in advance.
  A grant lets recognition read a tab's URL without a gesture; it never changes
  where the extension *sends* anything. See
  [`docs/architecture.md` § Page access is a different axis from network access](./docs/architecture.md).
- **The bearer token is the only secret.** It lives in extension storage
  (`chrome.storage`), is held by the background service worker, and is **never
  logged** and never put in the page DOM. The pairing code is likewise never
  logged.
- **Bundled, no runtime deps.** `esbuild.mjs` bundles each entry
  (`background`, `popup`, `options`, `capture`, `panel`, `toast`, `cue`,
  `brief`, `ledger` — `ENTRIES` there is the list) into `dist/<target>/` as
  fully-inlined IIFE. `@mozilla/readability` is a devDependency inlined into
  `capture.js`. The shipped extension has no `node_modules`. A new entry must
  also be added to `REQUIRED_FILES` in `scripts/check-build.mjs`.
- **One manifest, two targets.** `src/manifest/manifest.ts` composes the MV3
  manifest per browser. Chrome → `background.service_worker`; Firefox →
  `background.scripts` + `browser_specific_settings.gecko.id`. Everything else is
  shared; a drift between targets is a type error.

## Layout

- `src/manifest/` — typed manifest compose (`composeManifest(target, version)`)
- `src/background/` — MV3 service worker: `connection-store.ts` (token store over
  `chrome.storage.local`), `gateway-client.ts` (`confirmPair`/`postClip`/
  `postRelated` fetch + timeout + status mapping), `handlers.ts` (pure
  `handlePair`/`handleClip` with injected deps), `service-worker.ts` (message
  routing), plus the offline + quick-clip machinery: `clip-queue-store.ts`,
  `queue-flush.ts`, `rate-limit-pause.ts`, `single-flight.ts`, `quick-clip.ts`,
  `feedback.ts`; and the later surfaces — `brief-client.ts`/`brief-handlers.ts`,
  `egress-client.ts`/`egress-handlers.ts`, the `*-store.ts` persistence set
  (`agent-run`, `brief-run`, `brief-log`, `passage`, `origin`, of which the two
  run stores share `keyed-store.ts` and the rest deliberately do not — see that
  file's header), `http-json.ts` (the wire-shape parsers the three gateway
  clients share), `ambient.ts`, `capture-tab.ts`, `menus.ts`
- `src/browser/` — the thin typed seam over `chrome.*` (`storage`, `tabs`,
  `scripting`, `runtime`, `action`, `alarms`, `context-menus`, `commands`,
  `permissions`); the only place WebExtension APIs are touched directly
- `src/capture/` — page capture: `capture-in-page.ts` (injected `capture.js`,
  Mozilla Readability / selection → `CaptureResult`) + pure `fallback.ts`, plus the
  injected result toast (`toast-in-page.ts` → `toast.js`, pure `toast-view.ts`)
- `src/panel/` — the injected related-items + agent-lane panel (`panel-in-page.ts`
  → `panel.js`, pure `panel-view.ts`), plus the ambient cue (`cue-in-page.ts` →
  `cue.js`, pure `cue-view.ts`) and `lane-input.ts` / `related-groups.ts`
- `src/brief/` — the research-briefs page (`brief.ts` → `brief.js` +
  `brief.html`/`brief.css`, pure `brief-view.ts`)
- `src/ledger/` — the activity page over the gateway's egress ledger (`ledger.ts`
  → `ledger.js` + `ledger.html`/`ledger.css`, pure `ledger-view.ts`)
- `src/popup/` — toolbar popup (clip page / clip selection + tags + status) plus the
  pure `queue-view.ts` (offline-queue manager rendering)
- `src/options/` — options page (gateway URL + 6-digit code → pairing form) plus the
  pure views it composes: `connection-view.ts` (pairing status + unpair),
  `setup-view.ts`, `surfaces-view.ts`, `shortcuts-view.ts`,
  `brief-log-view.ts`, `ledger-summary-view.ts`
- `src/shared/` — pure modules shared across entries (`types.ts` cross-module
  types, `clip.ts` tag parsing + payload builder, `gateway.ts` endpoints +
  loopback origin validation, `messages.ts` typed message envelope + guards,
  `queue.ts`, `related.ts`, `origins.ts` + `recognise/` (page recognition —
  one module per product behind a registry table), `canonical.ts`,
  `preview.ts`, `brief.ts`, `passage.ts`, `egress.ts`, …) —
  `ls src/shared` is the current list, not this parenthesis
- `test/unit/` — Vitest unit tests (node env; DOM tests opt into jsdom via a docblock)
- `test/e2e/` — Playwright suites (`bun run test:e2e`), run by the `e2e` job in
  `ci.yml`; `test/unit/e2e-coverage.test.ts` keeps their `COVERS` ids and
  `development.md`'s `<!-- e2e:<id> -->` markers in step
- `esbuild.mjs` — build (run via `bun`, imports the TS manifest module)
- `scripts/` — `clean.mjs`, `check-build.mjs` (guards per-target completeness),
  `package.mjs` (zips each target), `gen-icons.py` (reproducible extension icons),
  `gen-promo.ts` (store promo tiles), `verify-setup.ts` (drives steps 1–6 of
  `development.md`'s "Setup that works"), `e2e/launch.ts` (the Playwright
  extension launcher), `screenshots/` (store screenshots driven against
  `mock-gateway.ts`)
- `docs/` — `architecture.md` is the how-it's-built reference (load-bearing
  decisions, layer map, clip pipeline, the offline-queue + rate-limit-pause state
  machines) and is where a durable decision LIVES; `docs/superpowers/` is a
  workspace for work in flight — specs, plans and review notes are all **pruned
  once the feature ships** and live on in git history, so anything still true
  after delivery must be written into `architecture.md` (or this file) BEFORE
  its spec is deleted, never left only in the spec; `development.md` is the
  dev-load + manual-verification checklist
  for the surfaces that aren't unit-tested (capture-in-page, popup/options DOM, SW
  glue); `store/` holds the store listing + publishing docs
- `ROADMAP.md` (repo root) — the vision-first roadmap: north star, the four
  pillars, and contributor-ready phases (each feature a brief with touches +
  done-when) ordered client-buildable-first → needs-gateway → ecosystem

## Direction

The gateway client, pairing orchestration, token store, and 429/413/offline
handling in `src/background/` are currently hand-rolled here — and duplicated in
`nimbus-vscode`. The proposed **Nimbus SDK** (roadmapped in the SDK repo, not
here) extracts that into one spec-driven, multi-language package that every
surface consumes via small per-runtime adapters. This repo is a Phase 1 consumer
and proof surface:
once the SDK lands, `gateway-client.ts` / `handlers.ts` / `connection-store.ts`
get replaced by SDK calls, keeping identical behavior and invariants. Until then,
this repo's local implementation is the reference the SDK generalizes from — so
treat changes to it as potential contributions upstream.

## Commands

```bash
bun install
bun run typecheck     # tsc --noEmit (strict)
bun run lint          # biome check . (src + test + scripts, per biome.json overrides)
bun run format        # biome check --write . (apply fixes)
bun run test          # vitest run
bun run test:coverage # vitest run --coverage → coverage/lcov.info (SonarCloud gate)
bun run build         # esbuild → dist/chrome + dist/firefox
bun run watch         # rebuild on save
bun run check-build   # assert each target is a complete MV3 extension (run after build)
bun run package       # zip dist/<target> → dist-zip/ for sideload/store
bun run clean         # remove dist/ + dist-zip/
bun run test:e2e      # playwright test (needs `bun run build` + browsers first)
```

CI runs `typecheck` / `lint` / `test` / `build` / `check-build` in the
`build-test` job **and** `test:e2e` in a second `e2e` job — see `ci.yml`.

Store-asset tooling (regenerates `store/screenshots/` and `store/promo/`; not part
of the extension build): `bun run mock-gateway`, `bun run screenshots:setup`,
`bun run screenshots`, `bun run promo`.

Manual-pass automation (not in CI): `bun run verify:setup` drives steps 1–6 of
`development.md`'s "Setup that works" against the mock gateway; steps 7–8 stay
manual and it says so on screen.

## Conventions / non-negotiables

- TypeScript **strict**; **no `any`** — use `unknown` for external/cross-boundary
  data and narrow with a type guard. Biome enforces this (`noExplicitAny`,
  `noConsole` in `src/`, `noNonNullAssertion`, …) — see `biome.json`.
- **No `console.*` in `src/`** — the extension ships to users. (Tests and
  `scripts/` may log.)
- **Never log the bearer token or the pairing code.**
- **Loopback only** — do not add a fetch destination beyond `127.0.0.1` /
  `localhost`, and do not widen `host_permissions`. The broad patterns in
  `optional_host_permissions` are page access, not a network destination: they
  are inert at install, granted per host from Options, and adding *or* removing
  any permission key fails `bun run test` until `store/listing.md`'s
  "Permission justifications" is updated to match (`store-listing.test.ts`).
- Local-first: the engine never pulls; the browser pushes. Clip ingest is
  inbound and not egress/HITL-gated (the consent moment is `nimbus clip pair`).
- WebExtension APIs (`chrome.*`) are used directly; both Chrome and Firefox
  expose the `chrome.*` namespace for MV3. Keep pure logic out of the API surface
  so it stays unit-testable.
- **Several unit tests read config and prose, not code** — so editing a workflow,
  a doc or a store file can turn `bun run test` red without a line of `src/`
  changing: `workflow-hygiene.test.ts` (every `.github/workflows/*.yml`),
  `publish-workflow.test.ts`, `build-artifacts.test.ts` (esbuild `ENTRIES` ↔
  check-build `REQUIRED_FILES`), `store-listing.test.ts`,
  `store-publishing-doc.test.ts`, `doc-references.test.ts` and
  `e2e-coverage.test.ts`. Run the suite after a docs-only change too.
- **When you change a shape, grep the sentence that described the old one.**
  Nothing gates prose. A complexity refactor once left three comments in two
  files calling a router "a fourteen-branch function", one of them directly above
  the code saying it is now four.

## Releasing

Record user-facing changes in `CHANGELOG.md` under `## [Unreleased]` as you go;
on release that heading becomes the version.

Tag-driven (`vX.Y.Z`): `publish.yml` builds, packages a zip per target, and
attaches them to a GitHub Release. The tag version is stamped into the manifest at
build time; the `version` in `package.json` is only a baseline. After the Release
is cut, the workflow's `store-chrome` / `store-firefox` jobs upload the same build
to the Chrome Web Store and Firefox AMO and submit each for review — gated on the
store credentials being configured, so a tag still cuts a Release when they are
absent. The one-time store bootstrap (accounts, first manual submission, and the
seven repository secrets) is documented in `store/publishing.md` — and is done, so
the next tag uploads to both stores.
