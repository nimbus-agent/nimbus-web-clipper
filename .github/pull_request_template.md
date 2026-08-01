## Summary

<!-- What does this change and why? -->

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun run test` passes (tests added/updated for behavior changes)
- [ ] `bun run build` succeeds and `bun run check-build` passes
- [ ] **User-visible change → a `CHANGELOG.md` entry under `## [Unreleased]`.** This repo's changelog is hand-maintained ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)) because releases here are tag-driven — there is no Release Please. (Note: the sibling `nimbus-vscode` repo is the opposite; don't carry its checklist over.)
- [ ] No network calls or `host_permissions` beyond `127.0.0.1` / `localhost`
- [ ] The bearer token and pairing code are never logged or written to the page DOM
