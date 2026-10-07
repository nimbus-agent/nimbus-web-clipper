# Contributing

Thanks for helping improve the Nimbus Companion!

## Where to start

The [roadmap](./ROADMAP.md) lays out where the extension is going, phase by phase.
Each feature is a self-contained brief — what it is, the files it touches, and how
you know it's done. New contributors: start with
[**Good first clips**](./ROADMAP.md#good-first-clips) (small, high-value, needs
nothing from another repo), and read the non-negotiable
[**guardrails**](./ROADMAP.md#contributor-guardrails) before you open a PR. For how
the code fits together, see [`docs/architecture.md`](./docs/architecture.md).

## Questions

Wondering how something works, or whether a change would be welcome before you build
it? Ask in [Nimbus Discussions](https://github.com/nimbus-agent/Nimbus/discussions) —
one board for Nimbus and all its clients, this extension included. A bug in the
extension, or a concrete change to the code here, is still an
[issue in this repo](https://github.com/nimbus-agent/nimbus-web-clipper/issues).
Anything that looks like a security problem goes to [SECURITY.md](./SECURITY.md)
instead — please don't post it publicly.

## Prerequisites

- [Bun](https://bun.sh) v1.2+
- Chrome 110+ and/or Firefox 121+ (for loading the extension)
- A running [Nimbus gateway](https://nimbus-agent.dev/user-guide/install/) with the
  web-clipper surface, for manual testing

## Setup

```bash
bun install
```

## Develop

```bash
bun run typecheck   # tsc --noEmit (strict)
bun run lint        # biome check . (src + test + scripts)
bun run test        # vitest run
bun run build       # esbuild → dist/chrome + dist/firefox
bun run watch       # rebuild on save
bun run test:e2e    # playwright test — run `bun run build` and
                    # `bunx playwright install chromium` first
```

### Loading the built extension

- **Chrome:** `chrome://extensions` → Developer mode → **Load unpacked** →
  `dist/chrome`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary
  Add-on** → `dist/firefox/manifest.json`.

After `bun run watch`, reload the extension from the browser's extensions page to
pick up a rebuild.

## Architecture notes

- **Loopback only.** The extension talks only to the Nimbus gateway on
  `127.0.0.1` / `localhost`. Do not add network calls or `host_permissions` for
  any other origin. Page access is a separate axis: `optional_host_permissions`
  carries broad patterns so recognition can read the URL of a self-hosted
  Jira/Jenkins/Bitbucket tab, but it is inert at install, granted per host from
  Options, and never a place the extension sends anything.
- **The bearer token is the only secret.** It lives in extension storage and is
  held by the background service worker. Never log the token or the pairing code,
  and never write either into the page DOM.
- **No `any`; TypeScript strict.** Use `unknown` for data crossing a boundary
  (messages, gateway responses) and narrow with a type guard. Biome enforces the
  rules in `biome.json`, including `noConsole` in `src/` — the extension ships to
  users, so there are no stray `console.*` calls in `src/`.
- The HTTP wire contract is owned by the Nimbus gateway repo — treat it as fixed
  here. Every route this client calls is listed once, in `GATEWAY_PATHS`
  (`src/shared/gateway.ts`): the three clip routes plus the `/v1/items/*` reads
  and targeted fetch, `/v1/agents/*`, `/v1/briefs*`, `/v1/egress*`,
  `/v1/services/resolve`, `/v1/preflight/deploy`, `/v1/connectors` and
  `/v1/health`, `/v1/metrics/dora` and `/v1/metrics/stats` (the DORA page). Most
  sit behind their own gateway token scope; `/v1/health`, `/v1/connectors`,
  `/v1/preflight/deploy`, the two metrics routes and `GET /v1/items/{id}` are on the
  gateway's public read-only table and carry no token.

## Pull requests

- Keep PRs focused; include tests for behavior changes.
- `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
  must pass (CI's `build-test` job runs exactly that on Ubuntu). CI also runs a
  second `e2e` job — `bun run test:e2e` — which those five do not cover.

## Updating dependencies

No bot updates dependencies here. A maintainer does it in periodic bulk PRs:
`bun outdated`, edit the ranges in `package.json`, `bun install`, then run the full
checks — the five commands under [Pull requests](#pull-requests) plus
`bun run test:e2e`.

- **Commit `bun.lock` with `package.json`.** CI installs with
  `bun install --frozen-lockfile`, so a range changed without regenerating the
  lockfile fails with `error: lockfile had changes, but lockfile is frozen`.
- **`bun audit` is the vulnerability check — run it on every bulk update.**
  Nothing opens a fix PR for a vulnerable package, and the Security tab is no
  substitute: Dependabot alerts are still enabled, but when Dependabot was retired
  this repo's dependency graph resolved no manifests, and not one alert had ever
  been raised while `bun audit` reported dozens of advisories against the same
  lockfile. That every package here is a devDependency does not make an advisory
  moot — `publish.yml` runs `web-ext` with the AMO credentials in its environment.
- **A transitive fix does not arrive on its own.** `bun install` with `bun.lock`
  present keeps each transitive version the lockfile pins for as long as it
  satisfies its range, even after a newer release inside that range fixes an
  advisory. So when `bun audit` still names a transitive package and
  `bun why <package>` shows a range that already admits the patched release:
  - **On Bun 1.4 or later** (CI runs `bun-version: latest`), run
    `bun audit fix --dry-run` to see the change, then `bun audit fix`. It moves
    each vulnerable package to the lowest safe version every dependent's range
    still allows, in `bun.lock` and `node_modules`, and leaves everything else
    alone. Then run `bun audit` and the full checks.
  - **On Bun 1.3, which has no `bun audit fix`,** or if it leaves an admissible
    fix unapplied, delete `bun.lock`, run `bun install` to resolve the whole tree
    afresh, and run `bun audit` again. On 1.3 the `bun update` that `bun audit`
    suggests does not move a transitive version either. This moves every
    transitive package to the newest release its range admits, not only the
    flagged one, so expect a large `bun.lock` diff and run the full checks on it.
- **Held advisories** — ones `bun audit` still reports after a bulk update, each
  with the date it was last checked. Delete an entry once `bun audit` drops it.
  - **`node-forge` GHSA-86w9-cpqp-85rv (high). Checked 2026-10-04; re-check at
    the next bulk update or by 2026-11-04, whichever comes first.** It arrives
    via `web-ext` → `@devicefarmer/adbkit` → `node-forge`, and no release fixes
    it: the advisory names no patched version, and the newest `web-ext` (10.7.0)
    pins the newest `adbkit` (3.3.9), whose `^1.3.1` range resolves to the
    newest `node-forge`, 1.4.0, which is inside the affected range. It is held
    because nothing here reaches it. `publish.yml` runs only `web-ext lint` and
    `web-ext sign`, and tracing what each loads found neither `adbkit` nor
    `node-forge`. Only `web-ext run --target firefox-android` loads them, and
    even that uses `adbkit` as an ADB client; the forgeable RSA signature check
    is in adbkit's TCP-USB bridge server, which `web-ext` never starts. Re-examine
    this if anything here starts running `web-ext run`. Re-check it against the
    advisory and the registry, not a pull request:
    `gh api advisories/GHSA-86w9-cpqp-85rv` gives the `first_patched_version`
    (still `null`) and the affected range (`<= 1.4.0`), and
    `npm view node-forge dist-tags` the newest release (still 1.4.0). Upstream
    tracks the bug in
    [digitalbazaar/forge#1149](https://github.com/digitalbazaar/forge/issues/1149).
    The candidate fixes are
    [#1152](https://github.com/digitalbazaar/forge/pull/1152), aimed at 1.4.1,
    and [#1157](https://github.com/digitalbazaar/forge/pull/1157), which builds on
    it. Either may be closed in favor of the other — the earlier
    [#1151](https://github.com/digitalbazaar/forge/pull/1151) was closed in favor
    of #1152 — so a closed PR does not mean the fix was dropped. A 1.x release
    falls inside `adbkit`'s `^1.3.1`, so no `overrides` entry should be needed,
    but the locked 1.4.0 will not move by itself: follow the transitive-fix rule
    above (`bun audit fix` on Bun 1.4 or later), then confirm with `bun audit`.
- **Read `bun outdated`'s Latest column, not just Update.** Update stays inside
  your range, and a caret range on a `0.x` package stops at the next minor
  (`^0.3.4` never reaches `0.4.0`). For those packages the minor *is* the breaking
  change: move the range by hand and expect type fixes. `@types/chrome` is one.
- **These move together:**
  - `vitest` and `@vitest/coverage-v8` — the coverage provider peer-depends on
    exactly its own version of `vitest`.
  - `playwright` and `@playwright/test` — the latter depends on exactly its own
    version of the former; keep both ranges equal so one copy is installed.
  - `@biomejs/biome` and the `$schema` URL in `biome.json`, which names the Biome
    version. `bunx biome migrate --write` updates it; a stale one only adds an
    info diagnostic to `bun run lint`, which still passes.
  - `github/codeql-action/init` and `github/codeql-action/analyze` in
    `codeql.yml` — one commit for both: `init` writes a config file that `analyze`
    reads back, and `analyze` refuses one written by a different release.
- **Update the pinned GitHub Actions in the same pass.**
  `gh api repos/<owner>/<repo>/releases/latest --jq .tag_name` names an action's
  newest release — except for `github/codeql-action`, whose latest release is a
  CodeQL bundle; take its newest `vN.x.y` tag instead. Each action is pinned to a
  full commit SHA (`workflow-hygiene.test.ts` fails a floating tag) with its
  version in a trailing comment; change both together. Resolve a tag with
  `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`, which returns the commit
  even for an annotated tag — whose own object SHA, the one
  `git ls-remote --tags <url> <tag>` prints, is not a commit.
- **The store CLIs first run on a release.** `web-ext` and
  `chrome-webstore-upload-cli` are invoked only by `publish.yml`, on a `v*` tag,
  so a changed flag passes PR CI unnoticed. Read their changelogs against the
  flags `publish.yml` passes; `bunx web-ext lint --source-dir dist/firefox`,
  after `bun run build`, runs its Firefox lint step locally.
- **Turning Dependabot back on takes more than a `dependabot.yml`.** Its runs get
  no Actions secrets, even under `pull_request_target`, so `cla.yml`'s token mint
  fails and the required `cla` check blocks every Dependabot PR — the guard that
  skipped those steps was removed with the config. The config must also declare
  the `bun` ecosystem: `npm` does not understand `bun.lock`, so its PRs fail
  `--frozen-lockfile`. Both files' git history holds the previous versions.

## Releases

Releases are tag-driven: pushing a `vX.Y.Z` tag runs `.github/workflows/publish.yml`,
which builds, zips each browser target, and attaches them to a GitHub Release. The
tag version is stamped into the manifest at build time.
