# Store Submission — Design Spec

**Date:** 2026-07-17
**Status:** Approved (brainstorm) — ready for implementation plans
**Repo:** `nimbus-agent/nimbus-web-clipper` (this repo)

## Summary

The extension is feature-complete against the design spec (Slices 1–3 +
connection management shipped) and dev-loadable in Chrome and Firefox. This spec
covers the remaining work to make it **publishable**: the repo deliverables a
human needs to create the two store listings the first time, a scripted harness
to produce store screenshots deterministically, and CI automation that uploads
each subsequent tagged release's binary to the Chrome Web Store and AMO.

The build is phased into **two implementation plans** under this one spec:

- **Plan 1 — deliverables + screenshot harness:** listing copy, privacy-policy
  text, AMO reviewer notes, the loopback mock gateway, the Playwright capture
  script, and the committed screenshot assets.
- **Plan 2 — CI upload automation:** the secret-gated Chrome Web Store and AMO
  upload steps in `publish.yml`, plus the secrets-setup docs.

## Goals

- Ship, in-repo, every text and image asset needed to stand up the Chrome Web
  Store and AMO listings by hand for the **first** release.
- Produce store screenshots (popup, options, related-items panel) deterministically
  from a script, against an in-repo mock gateway — no dependency on a running
  Nimbus and no hand-cropping.
- Automate the **per-release binary upload** to both stores on tag, gated on
  credentials so the release flow is unchanged when they are absent.
- Keep listing copy honest against the manifest and the mock gateway honest
  against the locked HTTP contract, enforced by unit tests.

## Non-Goals

- **Creating the initial listing via automation.** Both store APIs can only
  *update an existing item* and only touch the binary/version — never the listing
  content. The first submission (create the item, set copy + screenshots + privacy
  URL, first review) is manual in each dashboard, by design. CI automation
  activates from the **second** release onward.
- **Uploading screenshots / descriptions through CI.** Listing content is
  dashboard-managed in both stores. The harness produces committed image assets
  that the owner uploads to each dashboard once, and re-uploads only on a visible
  UI change.
- **Hosting the privacy policy in this repo.** The policy text is authored here
  but published on `nimbus-agent.dev`; the listings reference the hosted URL.
- **Automated cross-repo privacy-policy sync.** Deploying `store/privacy-policy.md`
  to `nimbus-agent.dev`, or CI-checking that the hosted copy matches, would
  reintroduce the cross-repo dependency the external-hosting decision avoids, for a
  document that changes a handful of times over the extension's life. Instead,
  `docs/store-submission.md` documents the manual "republish after editing" step;
  this repo stays the source of truth.
- **Staged / percentage rollouts.** Releases submit for review outright.
- Safari packaging; store-optimization / A-B of listing copy.

## The load-bearing constraint

Neither the Chrome Web Store API (v1.1) nor the AMO addons API can create a new
listing or edit listing metadata (name, description, screenshots, category,
privacy URL). They accept a **new package/version** for an **already-existing**
item and submit it for review. Therefore:

1. **First release is manual.** The owner uses the `store/` deliverables to
   create each listing, upload the committed screenshots, paste the copy, set the
   privacy URL, and submit for the first review.
2. **Subsequent releases are automated.** From the second tag onward, CI uploads
   the freshly built zip to the existing item and submits it for review.

This split is the reason the deliverables (Plan 1) and the automation (Plan 2)
are both needed and are sequenced deliverables-first.

## Architecture

Three cohesive additions, each independently testable:

```text
store/                     # deliverables: text + committed image assets (source of truth)
  listing.md               #   canonical listing copy for BOTH dashboards
  privacy-policy.md        #   policy text → published to nimbus-agent.dev
  amo-reviewer-notes.md    #   how to build dist/firefox from source (AMO requirement)
  screenshots/
    chrome/*.png           #   1280×800 committed assets
    firefox/*.png          #   reused Chromium captures

scripts/screenshots/
  mock-gateway.mjs         # loopback HTTP fixture implementing the 3 contract endpoints
  capture.mjs              # Playwright driver: load dist/chrome, pair, snapshot surfaces

.github/workflows/
  publish.yml              # + secret-gated Chrome Web Store + AMO upload steps

docs/
  store-submission.md      # first-time manual checklist + required CI secrets and how to mint them
```

### Module boundaries

- **`store/listing.md`** — one document that both dashboards are filled from:
  name; short summary (Chrome Web Store ≤132 chars, AMO ≤250); full description;
  category; the Chrome Web Store **single-purpose** statement; per-permission
  justifications; and the three `nimbus-agent.dev` URLs (homepage, support,
  privacy). To keep the parity test robust rather than regex-parsing prose, the
  justifications live under a fixed `## Permission justifications` heading in a
  **machine-parseable** convention — one `` `permission`: reason `` bullet per API
  permission, plus a single `` `host_permissions` `` bullet (Chrome Web Store
  justifies host access as one group, not per-URL-pattern). It depends on nothing
  at runtime.

- **`store/privacy-policy.md`** — standalone policy text. Content mirrors the
  security posture: no data collection, no telemetry, no cloud calls; loopback-only
  network surface; the bearer token is the only secret, stored in
  `chrome.storage.local`, never transmitted anywhere but the paired loopback
  gateway, revocable with `nimbus clip revoke`. Published to `nimbus-agent.dev`;
  the repo holds the source of truth.

- **`store/amo-reviewer-notes.md`** — AMO requires the human-readable source and
  exact build steps whenever shipped code is bundled/minified (our esbuild IIFE
  with `@mozilla/readability` inlined qualifies). Documents the toolchain
  (`bun install` → `bun run build` → `dist/firefox`), pinned versions, and what
  each output bundle (`background.js`, `popup.js`, `options.js`, `capture.js`) is.

- **`scripts/screenshots/mock-gateway.mjs`** — a small Node/Bun HTTP server bound
  to `127.0.0.1` implementing the three locked endpoints with canned, realistic
  responses:
  - `POST /v1/clips/pair/confirm` → `{ token, label }`
  - `POST /v1/clips` → `{ id, status: "created" }`
  - `POST /v1/clips/related` → `{ items: RelatedHit[] }` (a representative,
    fixed list, including one `url: null` hit to exercise the plain-text path)

  Deterministic (no randomness, fixed data), loopback-only, and reusable as a
  manual dev fixture. Exposed as `bun run mock-gateway`.

- **`scripts/screenshots/capture.mjs`** — Playwright (Chromium) launches a
  persistent context with the unpacked `dist/chrome` loaded, pairs the extension
  against the mock gateway, and captures each surface at the Chrome Web Store
  dimension (**1280×800**):
  - the **popup** in its meaningful states (default, saved, queue-manager),
  - the **options** page paired state,
  - the **related-items shadow-DOM panel** injected into a sample local page.

  **Extension id resolution.** Unpacked extensions get a *dynamically generated*
  id, so the script must not hard-code one, and we deliberately do **not** add a
  fixed `key` to the manifest (no dev key belongs in the repo). Playwright exposes
  the loaded MV3 service worker on the context — `context.serviceWorkers()[0]`
  (or awaiting the `serviceworker` event) — and the id is the host of its URL:
  `sw.url().split("/")[2]`. (Note: the Puppeteer `context.targets()` form does not
  exist in Playwright.)

  **Popup rendering.** Playwright cannot screenshot the native toolbar popup, so
  the script navigates directly to `chrome-extension://<id>/popup.html`. Because
  the popup renders at its own ~400px design width — far smaller than 1280×800 —
  the popup shots are captured at the popup's natural size and **composited
  centered onto a padded 1280×800 canvas** (clean background) to meet the store
  dimension. The options page and related-items panel fill a 1280×800 viewport
  directly.

  Fixed viewport + fixed mock data + disabled animations make the output stable.
  Writes to `store/screenshots/chrome/`; Firefox reuses the Chromium captures
  (AMO's dimension rules are looser). Exposed as `bun run screenshots`.

### CI upload automation (`publish.yml`)

Two steps added **after** the existing GitHub-Release attach, so that job is
untouched. GitHub does not allow gating a job `if:` directly on a secret, so a
**preflight step** maps `secrets.* != ''` into step outputs, and the upload steps
gate on those outputs — absent credentials skip cleanly (forks, and the pre-setup
window before store accounts exist):

- **Chrome Web Store** — CWS API v1.1: upload `dist-zip/…-chrome-*.zip` to the
  existing item, then submit for review. Secrets: `CWS_CLIENT_ID`,
  `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_EXTENSION_ID`.
- **AMO** — Mozilla `web-ext sign`, channel `listed`, submits the firefox build
  as a new version for review. AMO requires the matching **source zip** for any
  bundled/minified code; the workflow builds it with
  `git archive --format=zip --output=dist/source.zip HEAD`, which excludes
  `node_modules`, untracked files, and any local secrets by construction. The
  exact **upload mechanism** for that source zip (a `web-ext` flag vs. a direct
  AMO addons-API call) is **verified at plan time against the shipped `web-ext`
  version** rather than assumed here — as of writing, `web-ext sign` does not
  clearly expose a source-upload flag, so the plan confirms the current path
  before wiring it. Secrets: `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`.

The two store uploads are **independent steps**: a failure in one does not block
the other, and each surfaces its own status in the Actions run. Because a tag's
workflow can be re-run, both steps handle **"version already exists"** as a
non-fatal outcome (log and skip) so a partial release — e.g. Chrome Web Store
succeeded, AMO failed on a transient error — can be retried without the
already-uploaded store erroring the run.

Any new action is pinned by commit SHA, consistent with the repo's
`harden-runner` posture. `docs/store-submission.md` lists each secret and how to
mint it.

## Data flow

### First release (manual, one time)

1. `bun run build` → `bun run screenshots` produces `dist/*` and the committed
   `store/screenshots/**` assets.
2. Owner publishes `store/privacy-policy.md` to `nimbus-agent.dev`.
3. Owner creates each store item, pastes copy from `store/listing.md`, uploads the
   screenshots, sets the privacy/homepage/support URLs, attaches the release zip
   (or uploads the built package), and submits for first review. AMO additionally
   gets `store/amo-reviewer-notes.md` and the source upload.

### Subsequent releases (automated)

1. Owner pushes a `vX.Y.Z` tag.
2. `publish.yml` typechecks/lints/tests, stamps the version, builds, verifies the
   build invariant, packages zips, and attaches them to the GitHub Release
   (existing behavior, unchanged).
3. Preflight detects credentials; the Chrome Web Store step uploads the chrome zip
   to the existing item and submits it for review; the AMO step signs/submits the
   firefox build for review. Missing credentials → the step is skipped.

## Error / edge handling

| Condition | Handling |
| --- | --- |
| Store credentials absent | Upload steps skip via the preflight gate; release-attach still runs. |
| First-ever release (item does not exist yet) | API upload would 404; documented as manual — the owner creates the listing by hand before enabling automation. |
| Screenshot dimensions off | `capture.mjs` fixes viewport + output size to 1280×800; the popup is composited onto a padded canvas, not post-cropped. |
| Playwright can't find the extension id | Resolved from `context.serviceWorkers()[0].url()`; no hard-coded id or manifest `key`. |
| Mock gateway drifts from the contract | Unit test asserts contract-shaped responses; fails CI on drift. |
| New manifest permission added without justification | Parity test asserts `listing.md` justifies exactly the manifest's permissions; fails CI. |
| AMO rejects for missing source | `git archive HEAD` builds the matching source zip; reviewer notes document the build. Upload path verified at plan time against the shipped `web-ext`/AMO API. |
| One store upload fails, the other succeeds | Steps are independent; the run reports the failure, and re-running the tag treats "version already exists" as non-fatal so the failed store retries cleanly. |

## Testing

Vitest, matching the repo's existing posture (pure logic and seam-mocked units
carry coverage; browser-integration and CI are dev-run / manual).

**Unit-tested:**
- **Mock gateway contract shape** — each endpoint returns a response that
  satisfies the existing response types (reuse `shared/` types), so the fixture
  cannot silently diverge from the locked contract.
- **Listing ↔ manifest permission parity** — the parser reads the back-ticked
  keys under `store/listing.md`'s `## Permission justifications` heading and
  asserts they equal `composeManifest(...).permissions` **plus** the single
  `host_permissions` group key. Adding an API permission to the manifest later
  fails CI until it is justified. (Host patterns are justified as one group, per
  the Chrome Web Store's own model, not enumerated per URL.)

**Manual / integration (documented, not unit-tested):**
- `bun run screenshots` against `bun run mock-gateway` renders every surface at
  the right dimensions.
- A `publish.yml` dry-run confirms the preflight gate skips cleanly without
  secrets and the upload steps wire up with them.

No new local coverage thresholds; SonarCloud's gate governs, as elsewhere.

## Security posture

- The mock gateway binds `127.0.0.1` only and ships canned data — it is a dev/CI
  fixture, never bundled into `dist/`. No secret ever passes through it.
- Store credentials live only as GitHub Actions secrets, referenced in
  `publish.yml`; they are never written to the repo. New actions are SHA-pinned.
- The screenshot flow uses the mock's fake token; the real bearer token is never
  involved. Committed screenshots are reviewed to ensure no real token/PII appears.
- The extension's shipped surface is unchanged — no new permissions, no new hosts,
  no runtime code added. This spec adds only repo tooling, docs, and CI steps.

## Decomposition into plans

1. **Plan 1 — deliverables + screenshot harness:** `store/listing.md`,
   `store/privacy-policy.md`, `store/amo-reviewer-notes.md`,
   `scripts/screenshots/mock-gateway.mjs`, `scripts/screenshots/capture.mjs`,
   committed `store/screenshots/**`, the Playwright devDependency and
   `mock-gateway` / `screenshots` package scripts, and the two drift-guard unit
   tests.
2. **Plan 2 — CI upload automation:** the secret-gated Chrome Web Store and AMO
   upload steps in `publish.yml` (including the `git archive` source zip and the
   plan-time verification of the AMO source-upload path) and
   `docs/store-submission.md` (first-time manual checklist, the manual
   privacy-policy republish step, and the required secrets + how to mint them).

Each plan gets its own implementation plan document and review.
