# Publishing — Chrome Web Store + Firefox AMO

Releases are **tag-driven**. Pushing a `vX.Y.Z` tag runs
[`publish.yml`](../.github/workflows/publish.yml): it builds and packages the
extension, attaches a zip per target to a GitHub Release, and — once the store
credentials below are configured — uploads to the Chrome Web Store and Firefox
AMO and submits each for review.

The automated upload requires a **one-time manual bootstrap** (accounts, first
submission, and the `release` environment secrets). Until the secrets exist, a
tag still cuts a GitHub Release; the store jobs are skipped.

## One-time bootstrap

### 1. Accounts

- **Chrome Web Store:** register a developer account (a one-time registration
  fee) at <https://chrome.google.com/webstore/devconsole>.
- **Firefox AMO:** create a developer account at
  <https://addons.mozilla.org/developers/>.

### 2. First manual submission (creates the listing)

Build the artifacts locally (`bun run build && bun run package`), then:

- **Chrome:** in the Web Store developer console, create a new item and upload
  `dist-zip/nimbus-web-clipper-chrome-<version>.zip`. After it is created, copy
  the **item ID** — this is `CWS_EXTENSION_ID`.
- **Firefox:** in the AMO developer hub, submit
  `dist-zip/nimbus-web-clipper-firefox-<version>.zip` as a **listed** add-on. When
  prompted for source (the bundle is machine-generated), upload a
  `git archive --format=zip -o source.zip HEAD` archive. The add-on id is already
  fixed in the manifest (`web-clipper@nimbus-agent.dev`).

The first submission of each store must be done by hand; every release after that
is automated.

### 3. Credentials

- **Chrome (Google OAuth):** follow
  <https://github.com/fregante/chrome-webstore-upload-keys> to obtain a
  `CLIENT_ID`, `CLIENT_SECRET`, and `REFRESH_TOKEN` authorized for the Chrome Web
  Store API. The **publisher ID** is on the Chrome Web Store Developer Dashboard
  account settings page (`chrome-webstore-upload-cli` v4 requires it).
- **Firefox (AMO API):** generate an API key + secret at
  <https://addons.mozilla.org/developers/addon/api/key/> — these are the JWT
  issuer and JWT secret.

### 4. Environment secrets

Add these under **Settings → Environments → `release` → Environment secrets**.

They belong to the `release` environment, **not** to repo scope. A repo-scoped
secret is readable by every job in every workflow in the repository; a leaked
`CWS_REFRESH_TOKEN` lets an attacker push an arbitrary extension update to every
installed browser. Environment scope means only a job that declares
`environment: release` can read them, and the environment's deployment branch
policy admits only `main` and `v*` tags — so a workflow added on a feature
branch cannot reach these credentials.

| Secret | Source |
|--------|--------|
| `CWS_EXTENSION_ID` | Chrome Web Store item ID (from the first submission) |
| `CWS_PUBLISHER_ID` | Chrome Web Store publisher ID (dashboard account settings) |
| `CWS_CLIENT_ID` | Google OAuth client ID |
| `CWS_CLIENT_SECRET` | Google OAuth client secret |
| `CWS_REFRESH_TOKEN` | Google OAuth refresh token |
| `AMO_JWT_ISSUER` | AMO API key (JWT issuer) |
| `AMO_JWT_SECRET` | AMO API secret (JWT secret) |

The jobs cleared to read them are `publish`, `store-chrome` and `store-firefox`
in [`publish.yml`](../.github/workflows/publish.yml) plus `check` in
[`store-credential-check.yml`](../.github/workflows/store-credential-check.yml).
A regression test asserts every store-secret reader declares the environment.

Set **all** of a store's secrets or **none**. The workflow enables a store's job
only when that store's *complete* secret set is present, so a partial set is
treated as "not configured" and the store is skipped cleanly (it never half-runs
and fails at the CLI).

## Steady state — cutting a release

```bash
# update CHANGELOG.md [Unreleased] heading to the new version first, then:
git tag v0.1.0
git push origin v0.1.0
```

CI stamps the version into the manifest, builds, attaches the zips to a GitHub
Release, uploads to both stores, and submits each for review. Go-live is gated by
each store's human review.

## Don't tag while a review is still pending

Wait for a store's current review to finish before tagging the next version. A tag
still cuts the GitHub Release safely, but the store jobs behave badly against an
in-flight review:

- **Chrome fails, harmlessly.** The Web Store blocks uploads while an item is
  pending review (`ITEM_PENDING_REVIEW`; the dashboard's *Upload new package*
  button is disabled for the same reason), so the job errors with
  `pending review so can't be edited`. The pending review is unaffected — the only
  way to force the new version in is to cancel that review, forfeiting its place
  in the queue.
- **Firefox succeeds, and that is the problem.** AMO accepts a second queued
  version, but doing so can reset the add-on's position in the review queue
  ([bug 717495](https://bugzilla.mozilla.org/show_bug.cgi?id=717495), still open).

Both are recoverable — re-run the Chrome job once the review clears — but the
cheapest fix is to hold the tag.

## When one store fails

`store-chrome` and `store-firefox` are independent jobs. If one fails (e.g. store
API downtime) the other stays green, and **Re-run failed jobs** retries only the
failed store — a succeeded Chrome upload never blocks an AMO retry.

Rare edge: if a store job fails *after* its upload already reached the store,
re-running it can report "version already exists". Recover by cancelling the
in-review submission in that store's dashboard, or bump the patch version and
re-tag.
