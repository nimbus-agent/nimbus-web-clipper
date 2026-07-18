# Store Publish Automation — Design

**Date:** 2026-07-18
**Status:** Approved (brainstorming) — ready for implementation plan

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
  is run via `bunx` (official/community CLIs) rather than adding new third-party
  GitHub Actions, keeping the pinned-action surface unchanged.
- The bearer token / pairing code rules are irrelevant here (no runtime code
  changes) but nothing in this flow may log store credentials.
- The GitHub Release must remain durable regardless of store-upload outcome.

## Where it lives

Extend the existing `publish` job in `.github/workflows/publish.yml`. The
store-upload steps run **after** "Attach zips to Release", reusing the artifacts
already produced in the job:

- packaged zips: `dist-zip/nimbus-web-clipper-chrome-<v>.zip`,
  `dist-zip/nimbus-web-clipper-firefox-<v>.zip`
- unpacked target dirs: `dist/chrome`, `dist/firefox`

No second job, no artifact upload/download, no rebuild. Because "Attach zips to
Release" runs first, the GitHub Release is already created before any store step
runs — a store failure marks the workflow red but never loses the release.

## Flow

```
push tag vX.Y.Z
  └─ job: publish (existing)
       harden-runner → checkout → setup bun → install
       → typecheck → lint → test
       → resolve version from tag → stamp package.json
       → build → check-build → package
       → Attach zips to GitHub Release          (existing; durable point)
       → web-ext lint dist/firefox              (NEW, unconditional)
       → Chrome Web Store upload + publish       (NEW, guarded on CWS secrets)
       → build source archive (git archive)      (NEW, guarded on AMO secrets)
       → AMO sign --channel listed + source      (NEW, guarded on AMO secrets)
```

## Components

### 1. Pre-submit lint (unconditional, no secrets)

```yaml
- name: Lint the Firefox bundle (addons-linter)
  run: bunx web-ext@8 lint --source-dir dist/firefox
```

`web-ext lint` runs the same `addons-linter` AMO uses, so AMO-blocking problems
surface in CI before a submission is burned. Runs on every tag regardless of
whether store secrets are configured. Lint errors fail the workflow (the Release
is already attached, so nothing is lost).

### 2. Chrome Web Store upload

```yaml
- name: Chrome Web Store — upload + publish
  if: env.CWS_CLIENT_ID != ''
  env:
    CWS_EXTENSION_ID: ${{ secrets.CWS_EXTENSION_ID }}
    CWS_CLIENT_ID: ${{ secrets.CWS_CLIENT_ID }}
    CWS_CLIENT_SECRET: ${{ secrets.CWS_CLIENT_SECRET }}
    CWS_REFRESH_TOKEN: ${{ secrets.CWS_REFRESH_TOKEN }}
  run: |
    bunx chrome-webstore-upload-cli@3 upload \
      --source "dist-zip/nimbus-web-clipper-chrome-${VERSION}.zip" \
      --extension-id "$CWS_EXTENSION_ID" \
      --auto-publish
```

- Tool: `chrome-webstore-upload-cli` (MIT), run via `bunx`.
- `--auto-publish` submits for review and auto-publishes to users on approval.
- `VERSION` is the tag-derived version already computed by the existing
  "Resolve version from tag" step (exposed to later steps via `$GITHUB_ENV`).
- Auth via Google OAuth: client id/secret + a long-lived refresh token.

### 3. Firefox AMO upload (Approach B — bundle + source archive)

```yaml
- name: Build source archive for AMO review
  if: env.AMO_JWT_ISSUER != ''
  env:
    AMO_JWT_ISSUER: ${{ secrets.AMO_JWT_ISSUER }}
  run: git archive --format=zip -o "dist-zip/source-${VERSION}.zip" HEAD

- name: Firefox AMO — sign (listed) + submit
  if: env.AMO_JWT_ISSUER != ''
  env:
    AMO_JWT_ISSUER: ${{ secrets.AMO_JWT_ISSUER }}
    AMO_JWT_SECRET: ${{ secrets.AMO_JWT_SECRET }}
  run: |
    bunx web-ext@8 sign \
      --source-dir dist/firefox \
      --channel listed \
      --upload-source-code "dist-zip/source-${VERSION}.zip" \
      --api-key "$AMO_JWT_ISSUER" \
      --api-secret "$AMO_JWT_SECRET"
```

- Tool: Mozilla's official `web-ext` v8, run via `bunx`.
- `--channel listed` adds a version to the existing public AMO listing and
  submits it for review.
- `--upload-source-code` attaches a source archive so AMO's "source required for
  machine-generated code" policy is satisfied up front, avoiding a mid-review
  "provide source" stall.
- The source archive is `git archive HEAD`: exactly the tracked files
  (`src/`, `esbuild.mjs`, `package.json`, `bun.lock`, `store/amo-reviewer-notes.md`,
  …), no `node_modules`/`dist`. It reproduces the build via the steps in
  `store/amo-reviewer-notes.md`.
- The add-on id (`web-clipper@nimbus-agent.dev`) is already in the composed
  Firefox manifest, so `web-ext` targets the right listing; no id flag needed.

### 4. Resilience to missing secrets (pre-bootstrap)

Store steps are guarded with `if: env.<SECRET> != ''`, where the secret is mapped
into the step (and/or job) `env`. Before the manual bootstrap is done and the
secrets exist:

- typecheck / lint / test / build / package / **GitHub Release** all run normally;
- `web-ext lint` runs (no secrets needed);
- the CWS and AMO steps are **skipped, not failed**.

A tag therefore always produces a GitHub Release; store publishing switches on the
moment the secrets are added. Each store block emits a one-line notice when
skipped so the run log explains why nothing was uploaded.

> GitHub Actions cannot reference `secrets.*` directly in a step `if:`; the
> secret is first mapped to an `env:` var and the guard tests `env.*`. This is a
> known-good pattern and part of the implementation plan.

### 5. Bootstrap + operator documentation

New `store/publishing.md` (linked from `README.md` "Releasing" and referenced in
`CHANGELOG.md`). Contents:

1. **One-time accounts** — register a Chrome Web Store developer account (one-off
   USD 5 fee) and a Firefox AMO developer account.
2. **First manual submission** — upload
   `dist-zip/nimbus-web-clipper-chrome-<v>.zip` in the CWS dashboard to create the
   listing and obtain the **extension id**; submit
   `dist-zip/nimbus-web-clipper-firefox-<v>.zip` (plus the source archive) once in
   the AMO dashboard to create the listing.
3. **Credentials** — how to mint the CWS OAuth client id/secret + refresh token
   and the AMO JWT issuer/secret.
4. **GitHub secrets** — add the six repository secrets (below).
5. **Steady state** — after bootstrap, `git tag vX.Y.Z && git push --tags` builds,
   releases, and submits to both stores automatically.

### Required GitHub repository secrets

| Secret | Store | Purpose |
|--------|-------|---------|
| `CWS_EXTENSION_ID` | Chrome | Target item id (from first manual submission) |
| `CWS_CLIENT_ID` | Chrome | Google OAuth client id |
| `CWS_CLIENT_SECRET` | Chrome | Google OAuth client secret |
| `CWS_REFRESH_TOKEN` | Chrome | Long-lived OAuth refresh token |
| `AMO_JWT_ISSUER` | Firefox | AMO API key (JWT issuer) |
| `AMO_JWT_SECRET` | Firefox | AMO API secret (JWT secret) |

## Error handling

- **Store failure after release:** workflow goes red; the GitHub Release is intact
  (created earlier). Re-running the failed job re-attempts upload — CWS/AMO reject
  a re-upload of an already-accepted version, which is the correct guard against
  double submission.
- **Missing secrets:** store steps skip (not fail); Release still cut.
- **`web-ext lint` failure:** fails the workflow before any upload — an
  AMO-invalid bundle never reaches submission.
- **Credential leakage:** credentials are only ever passed via `env` from
  `secrets.*`; no step echoes them; `harden-runner` audits egress
  (`googleapis.com`, `accounts.google.com`, `addons.mozilla.org`).

## Testing / verification

- **Workflow validity:** `actionlint` (run locally and/or added to `ci.yml`) on
  the edited `publish.yml`.
- **`web-ext lint`** passes against a freshly built `dist/firefox` (runnable now,
  no secrets).
- **Guard path:** a tag pushed before secrets exist cuts a GitHub Release with the
  CWS/AMO steps shown as skipped — verifiable without any store account.
- **Source archive:** `git archive --format=zip HEAD` produces a zip that unpacks
  and, per `store/amo-reviewer-notes.md`, rebuilds the extension.
- **Full round-trip** (real upload to each store) can only be proven by the first
  real tagged release after bootstrap — it consumes a version number and is
  documented as the manual acceptance step, not automated.

## Out-of-repo prerequisites (operator, one-time)

Store accounts, the first manual submission per store, credential generation, and
adding the six secrets. Until these are done the automation is inert-but-safe: it
skips the store steps and keeps cutting GitHub Releases.
