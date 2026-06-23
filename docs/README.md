# Docs

Design and implementation reference for the Nimbus Web Clipper.

- **`specs/`** — the design spec (capture modes, pairing UX, related-items panel,
  storage, Chrome/Firefox differences, error/offline handling).
- **`plans/`** — the TDD implementation plan derived from the spec.

These follow the [superpowers](https://github.com/nimbus-agent/Nimbus) spec→plan
layout. The HTTP wire contract the extension builds against is owned by the Nimbus
gateway repository and summarized in [`../CLAUDE.md`](../CLAUDE.md).

> The spec and plan are authored during the design phase (brainstorm) and reviewed
> before feature implementation begins.
