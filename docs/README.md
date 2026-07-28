# Docs

Design reference for the Nimbus Web Clipper.

- **[`architecture.md`](./architecture.md)** — how the extension is built today:
  the load-bearing decisions, the layer map, the clip pipeline, and the two state
  machines (offline retry queue + rate-limit pause). Start here to understand the
  code. The forward-looking counterpart is [`../ROADMAP.md`](../ROADMAP.md).
- **`specs/`** — the per-feature design specs (brainstormed and reviewed before
  implementation): the original extension design (capture modes, pairing UX,
  related-items panel, storage, Chrome/Firefox differences, error/offline
  handling), the later feature slices (related-items sidecar, offline retry
  queue, connection management, quick-clip entry points, gateway rate-limit
  handling), and the store-submission + store-publish automation designs.

These follow the [superpowers](https://github.com/nimbus-agent/Nimbus) spec→plan
layout. The implementation plans and point-in-time review notes are pruned once a
feature ships — they remain in git history. The HTTP wire contract the extension
builds against is owned by the Nimbus gateway repository and summarized in
[`../CLAUDE.md`](../CLAUDE.md).

Operational and release docs live outside this folder: the dev-load +
manual-verification checklist is in [`development.md`](./development.md), and the
store listing + publishing guide is in [`../store/`](../store/).
