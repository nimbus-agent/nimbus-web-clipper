# Store Publish Automation — Design

**Date:** 2026-07-18
**Status:** Approved (brainstorming) — revised after design review — ready for
implementation plan

## Goal

Make a `vX.Y.Z` tag ship the extension all the way to the stores. Today
`publish.yml` builds, packages, and attaches a zip per target to a GitHub
Release, but store upload is manual. This adds the missing step: on the same tag,
after the GitHub Release is cut, CI uploads the new build to the **Chrome Web
Store** and **Firefox AMO** and submits each for review, so a tagged release goes
live on store approval with no further human action.

This mirrors the tag-driven publish flow of the sibling Nimbus repos: one tag,
one automated pipeline, from source to published artifact.

## Non-goals

- **First-time store bootstrap.** Both stores require a one-time manual first
  submission to create the listing (CWS also mints the extension ID that
  automation targets). That bootstrap is documented, not automated.
- **Bypassing store human review.** "Submit for review" is the end of our
  pipeline; go-live is gated by each store's reviewers. Chrome is otherwise
  hands-off; Firefox is hands-off provided the source archive is accepted (see
  AMO source policy below).
- **Changing the contract, manifest composition, or build.** This is CI +
  documentation only.

## Constraints

- Preserve the repo's CI security posture: `harden-runner` on every job,
  SHA-pinned third-party actions, no new `<all_urls>`-style trust. Store tooling
  (`chrome-webstore-upload-cli`, `web-ext`) is added as **pinned
  devDependencies** and invoked via `bunx` from the local install — no new
  third-party GitHub Actions, and versions are locked in `bun.lock`.
- The bearer token / pairing code rules are irrelevant here (no runtime code
  changes) but nothing in this flow may log store credentials.
- The GitHub Release must remain durable regardless of store-upload outcome.

## Where it lives

Extend `.github/workflows/publish.yml` (same workflow file). The store uploads
become **two independent jobs** that run after the existing (extended) `publish`
job:

- **`publish`** (existing, extended) — typecheck / lint / test, build,
  `check-build`, package, run `web-ext lint`, build the AMO source archive,
  **attach zips to the GitHub Release** (durable point), then upload the release
  artifacts (`dist/`, `dist-zip/`) for the store jobs to consume. Also computes
  two boolean outputs, `has_cws` / `has_amo`, from the presence of the store
  secrets.
- **`store-chrome`** (`needs: publish`, `if: needs.publish.outputs.has_cws == 'true'`)
  — download the artifact, upload the Chrome zip to the Chrome Web Store.
- **`store-firefox`** (`needs: publish`, `if: needs.publish.outputs.has_amo == 'true'`)
  — download the artifact, sign + submit the Firefox build (with source archive)
  to AMO.

Rationale for the split (rather than one job):

- **Clean retries.** If one store fails (API downtime) the other stays green;
  "Re-run failed jobs" retries only the failed store, so a succeeded Chrome
  upload never blocks an AMO retry with a duplicate-version error.
- **Least-privilege secrets.** CWS credentials are exposed only to `store-chrome`,
  AMO credentials only to `store-firefox` — never to the build/test steps.
- **Durable release.** The Release is attached in `publish` before either store
  job runs, so a store failure never loses the release.

The store jobs consume the **byte-identical** artifact attached to the Release
(via `actions/upload-artifact` / `actions/download-artifact`), so what ships to
the stores is exactly the release download — no rebuild, no drift.

## Flow

```
push tag vX.Y.Z
  ├─ job: publish
  │    harden-runner → checkout → setup bun → install (incl. store CLIs)
  │    → typecheck → lint → test
  │    → resolve version (→ $GITHUB_ENV) → stamp package.json
  │    → build → check-build → package
  │    → web-ext lint dist/firefox
  │    → git archive HEAD → dist-zip/source-<v>.zip
  │    → Attach zips to GitHub Release          (durable point)
  │    → set outputs has_cws / has_amo
  │    → upload-artifact (dist/, dist-zip/)
  ├─ job: store-chrome   (needs: publish; if has_cws)
  │    download-artifact → chrome-webstore-upload-cli upload --auto-publish
  └─ job: store-firefox  (needs: publish; if has_amo)
       download-artifact → web-ext sign --channel listed --upload-source-code
```

## Components

### 1. Tooling as pinned devDependencies

Add to `package.json` `devDependencies` (exact versions resolved into `bun.lock`):

- `chrome-webstore-upload-cli` — Chrome Web Store upload (MIT).
- `web-ext` — Mozilla's official AMO signing/submission + linting tool.

Both are invoked via `bunx`, which resolves the **already-installed local**
version — no release-time network fetch, deterministic version, and the download
happens once during the existing `bun install --frozen-lockfile`. This is
consistent with `playwright` already being a heavy devDependency; the modest
extra install time on non-publish CI is the accepted trade-off for deterministic,
auditable release tooling.

### 2. Pre-submit lint (in `publish`, unconditional)

```yaml
- name: Lint the Firefox bundle (addons-linter)
  run: bunx web-ext lint --source-dir dist/firefox
```

`web-ext lint` runs the same `addons-linter` AMO uses, so AMO-blocking problems
surface in CI before a submission is burned. Runs on every tag regardless of
store secrets. Lint errors fail the workflow (the Release is attached afterward,
so a lint failure blocks a bad release before it is cut).

### 3. Secret-presence outputs (in `publish`)

Guarding must not depend on a step reading its own `env` in an `if:` (a step's
`if` is evaluated before its own `env` block exists) and cannot read `secrets`
directly in an `if:`. Instead, `publish` derives booleans and exposes them as job
outputs:

```yaml
jobs:
  publish:
    outputs:
      has_cws: ${{ steps.store_flags.outputs.has_cws }}
      has_amo: ${{ steps.store_flags.outputs.has_amo }}
    steps:
      # ...
      - name: Detect store secrets
        id: store_flags
        env:
          CWS_CLIENT_ID: ${{ secrets.CWS_CLIENT_ID }}
          AMO_JWT_ISSUER: ${{ secrets.AMO_JWT_ISSUER }}
        run: |
          [ -n "$CWS_CLIENT_ID" ]  && echo "has_cws=true"  >> "$GITHUB_OUTPUT" || echo "has_cws=false" >> "$GITHUB_OUTPUT"
          [ -n "$AMO_JWT_ISSUER" ] && echo "has_amo=true"  >> "$GITHUB_OUTPUT" || echo "has_amo=false" >> "$GITHUB_OUTPUT"
```

The store jobs gate on these via `if: needs.publish.outputs.has_cws == 'true'`
(job-level `if` can read the `needs` context). Before the manual bootstrap and
secrets exist, both store jobs are **skipped as whole jobs** — the tag still runs
`publish` and cuts the GitHub Release.

### 4. AMO source archive (in `publish`)

```yaml
- name: Build source archive for AMO review
  run: git archive --format=zip -o "dist-zip/source-${VERSION}.zip" HEAD
```

`git archive HEAD` = exactly the tracked files (`src/`, `esbuild.mjs`,
`package.json`, `bun.lock`, `store/amo-reviewer-notes.md`, …), no
`node_modules`/`dist`. It reproduces the build via the steps in
`store/amo-reviewer-notes.md`. Built unconditionally so it is included in the
uploaded artifact; only `store-firefox` consumes it. `VERSION` is the
tag-derived version exported to `$GITHUB_ENV` by the existing "Resolve version
from tag" step (a one-line addition alongside its existing `$GITHUB_OUTPUT`).

### 5. Chrome Web Store job

```yaml
store-chrome:
  needs: publish
  if: needs.publish.outputs.has_cws == 'true'
  runs-on: ubuntu-24.04
  steps:
    - harden-runner (egress-policy: audit)
    - checkout (persist-credentials: false)   # for bunx → local devDep
    - setup bun → bun install --frozen-lockfile
    - download-artifact (dist/, dist-zip/)
    - name: Chrome Web Store — upload + publish
      env:
        CWS_EXTENSION_ID: ${{ secrets.CWS_EXTENSION_ID }}
        CWS_CLIENT_ID: ${{ secrets.CWS_CLIENT_ID }}
        CWS_CLIENT_SECRET: ${{ secrets.CWS_CLIENT_SECRET }}
        CWS_REFRESH_TOKEN: ${{ secrets.CWS_REFRESH_TOKEN }}
      run: |
        bunx chrome-webstore-upload-cli upload \
          --source "dist-zip/nimbus-web-clipper-chrome-${VERSION}.zip" \
          --extension-id "$CWS_EXTENSION_ID" \
          --auto-publish
```

- `--auto-publish` submits for review and auto-publishes to users on approval.
- `VERSION` is re-derived in this job from `github.ref_name` (same strip-`v`
  logic) since `$GITHUB_ENV` does not cross jobs.

### 6. Firefox AMO job (Approach B — bundle + source archive)

```yaml
store-firefox:
  needs: publish
  if: needs.publish.outputs.has_amo == 'true'
  runs-on: ubuntu-24.04
  steps:
    - harden-runner (egress-policy: audit)
    - checkout (persist-credentials: false)
    - setup bun → bun install --frozen-lockfile
    - download-artifact (dist/, dist-zip/)
    - name: Firefox AMO — sign (listed) + submit
      env:
        AMO_JWT_ISSUER: ${{ secrets.AMO_JWT_ISSUER }}
        AMO_JWT_SECRET: ${{ secrets.AMO_JWT_SECRET }}
      run: |
        bunx web-ext sign \
          --source-dir dist/firefox \
          --channel listed \
          --upload-source-code "dist-zip/source-${VERSION}.zip" \
          --api-key "$AMO_JWT_ISSUER" \
          --api-secret "$AMO_JWT_SECRET"
```

- `--channel listed` adds a version to the existing public AMO listing and
  submits it for review.
- `--upload-source-code` attaches the source archive so AMO's "source required
  for machine-generated code" policy is satisfied up front, avoiding a mid-review
  "provide source" stall.
- The add-on id (`web-clipper@nimbus-agent.dev`) is already in the composed
  Firefox manifest, so `web-ext` targets the right listing; no id flag needed.

### 7. Bootstrap + operator documentation

New `store/publishing.md` (linked from `README.md` "Releasing" and referenced in
`CHANGELOG.md`). Contents:

1. **One-time accounts** — register a Chrome Web Store developer account (one-off
   USD 5 fee) and a Firefox AMO developer account.
2. **First manual submission** — upload the Chrome zip in the CWS dashboard to
   create the listing and obtain the **extension id**; submit the Firefox zip
   (plus the source archive) once in the AMO dashboard to create the listing.
3. **Credentials** — how to mint the CWS OAuth client id/secret + refresh token
   and the AMO JWT issuer/secret.
4. **GitHub secrets** — add the six repository secrets (below).
5. **Steady state** — after bootstrap, `git tag vX.Y.Z && git push --tags` builds,
   releases, and submits to both stores automatically.

### Required GitHub repository secrets

All six are **new** — no browser-store credentials exist in this repo, at the
`nimbus-agent` org level, or in any sibling repo (`nimbus-vscode` holds
`VSCE_PAT`/`OVSX_PAT`, but those are VS Code Marketplace / Open VSX tokens, not
Chrome Web Store / AMO — not reusable). They are scoped at **repository** level,
not org level: `nimbus-web-clipper` is the only browser extension in the org, so
org-scoping would grant publish credentials to repos that never use them (a
least-privilege violation). Org scope is reserved for genuinely cross-repo
secrets (already the case for `RELEASE_PLEASE_PAT` and `SONAR_TOKEN`). Per-job
scoping in the workflow further limits each secret to the one job that uses it.

| Secret | Store | Purpose |
|--------|-------|---------|
| `CWS_EXTENSION_ID` | Chrome | Target item id (from first manual submission) |
| `CWS_CLIENT_ID` | Chrome | Google OAuth client id |
| `CWS_CLIENT_SECRET` | Chrome | Google OAuth client secret |
| `CWS_REFRESH_TOKEN` | Chrome | Long-lived OAuth refresh token |
| `AMO_JWT_ISSUER` | Firefox | AMO API key (JWT issuer) |
| `AMO_JWT_SECRET` | Firefox | AMO API secret (JWT secret) |

## Error handling

- **One store fails, the other succeeds.** The stores are independent jobs, so the
  succeeded one stays green and "Re-run failed jobs" retries only the failed
  store — a succeeded Chrome upload never blocks an AMO retry.
  - *Residual edge:* if a store job fails *after* its own upload API call already
    succeeded, re-running that one job can hit a duplicate-version error for that
    store. This is rare (failures are typically auth/network, i.e. before upload).
    Recovery: cancel the in-review submission in that store's dashboard, or bump
    the patch version and re-tag. Documented in `store/publishing.md`.
- **Missing secrets:** `store-chrome` / `store-firefox` are skipped as whole jobs
  (via `has_cws` / `has_amo`); `publish` still cuts the Release.
- **`web-ext lint` failure:** fails `publish` before the Release is attached — an
  AMO-invalid bundle never reaches submission.
- **Credential handling:** credentials are only passed via `env` from `secrets.*`,
  scoped to the single store job that needs them; no step echoes them.

### Network egress (harden-runner)

Current posture is `egress-policy: audit` (non-blocking) — **no allowlist change
is required for the pipeline to function**. For reference, the store jobs reach:

- `accounts.google.com`, `www.googleapis.com` — Chrome Web Store OAuth + upload
- `addons.mozilla.org` (+ `addons.cdn.mozilla.net`) — AMO signing/submission
- `registry.npmjs.org` — only during `bun install` (bunx uses the local devDep)

**Optional hardening follow-up (deferred from v1):** switch the store jobs to
`egress-policy: block` with the above endpoints allowlisted. Deferred because the
store upload paths include CDN redirects that make a complete allowlist brittle;
an incomplete list would fail releases. The endpoint list above is recorded so
this switch is a small, well-scoped future change.

## Testing / verification

- **Workflow validity:** `actionlint` on the edited `publish.yml` (run locally;
  optionally added to `ci.yml`).
- **`web-ext lint`** passes against a freshly built `dist/firefox` (runnable now,
  no secrets).
- **Guard path:** a tag pushed before secrets exist cuts a GitHub Release with
  `store-chrome` / `store-firefox` shown as skipped — verifiable without any store
  account.
- **Source archive:** `git archive --format=zip HEAD` produces a zip that unpacks
  and, per `store/amo-reviewer-notes.md`, rebuilds the extension.
- **Full round-trip** (real upload to each store) can only be proven by the first
  real tagged release after bootstrap — it consumes a version number and is
  documented as the manual acceptance step, not automated.

## Out-of-repo prerequisites (operator, one-time)

Store accounts, the first manual submission per store, credential generation, and
adding the six secrets. Until these are done the automation is inert-but-safe: the
store jobs skip and `publish` keeps cutting GitHub Releases.
