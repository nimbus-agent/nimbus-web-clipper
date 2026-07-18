# Publishing — Chrome Web Store + Firefox AMO

Releases are **tag-driven**. Pushing a `vX.Y.Z` tag runs
[`publish.yml`](../.github/workflows/publish.yml): it builds and packages the
extension, attaches a zip per target to a GitHub Release, and — once the store
credentials below are configured — uploads to the Chrome Web Store and Firefox
AMO and submits each for review.

The automated upload requires a **one-time manual bootstrap** (accounts, first
submission, and repository secrets). Until the secrets exist, a tag still cuts a
GitHub Release; the store jobs are skipped.

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
  Store API.
- **Firefox (AMO API):** generate an API key + secret at
  <https://addons.mozilla.org/developers/addon/api/key/> — these are the JWT
  issuer and JWT secret.

### 4. Repository secrets

Add these six secrets under **Settings → Secrets and variables → Actions** on the
GitHub repository (repo-scoped — this is the org's only browser extension):

| Secret | Source |
|--------|--------|
| `CWS_EXTENSION_ID` | Chrome Web Store item ID (from the first submission) |
| `CWS_CLIENT_ID` | Google OAuth client ID |
| `CWS_CLIENT_SECRET` | Google OAuth client secret |
| `CWS_REFRESH_TOKEN` | Google OAuth refresh token |
| `AMO_JWT_ISSUER` | AMO API key (JWT issuer) |
| `AMO_JWT_SECRET` | AMO API secret (JWT secret) |

Set **all** of a store's secrets or **none**. The workflow only gates each store
job on one secret (`CWS_CLIENT_ID` for Chrome, `AMO_JWT_ISSUER` for Firefox), so
a partial set makes the job run and fail at the CLI instead of skipping cleanly.

## Steady state — cutting a release

```bash
# update CHANGELOG.md [Unreleased] heading to the new version first, then:
git tag v0.1.0
git push origin v0.1.0
```

CI stamps the version into the manifest, builds, attaches the zips to a GitHub
Release, uploads to both stores, and submits each for review. Go-live is gated by
each store's human review.

## When one store fails

`store-chrome` and `store-firefox` are independent jobs. If one fails (e.g. store
API downtime) the other stays green, and **Re-run failed jobs** retries only the
failed store — a succeeded Chrome upload never blocks an AMO retry.

Rare edge: if a store job fails *after* its upload already reached the store,
re-running it can report "version already exists". Recover by cancelling the
in-review submission in that store's dashboard, or bump the patch version and
re-tag.
