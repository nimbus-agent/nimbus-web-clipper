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
  (`src/shared/gateway.ts`): the three clip routes plus `/v1/items/resolve`,
  `/v1/items/fetch`, `/v1/agents/*`, `/v1/briefs*`, `/v1/egress*` and
  `/v1/health`. Each of the later ones sits behind its own gateway token scope.

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
