# Docs

Design reference for the Nimbus Web Clipper.

- **[`architecture.md`](./architecture.md)** — how the extension is built today:
  the load-bearing decisions, the layer map, the clip pipeline, and the two state
  machines (offline retry queue + rate-limit pause). Start here to understand the
  code. The forward-looking counterpart is [`../ROADMAP.md`](../ROADMAP.md).
- **[`superpowers/specs/`](./superpowers/specs/)** — the per-feature design specs (brainstormed and reviewed before
  implementation), one per slice and named by the date it was written: the
  original extension design (capture modes, pairing UX, related-items panel,
  storage, Chrome/Firefox differences, error/offline handling), the clipper
  slices that followed (related-items sidecar, offline retry queue, connection
  management, quick-clip entry points, gateway rate-limit handling), the
  store-submission + store-publish automation designs, and then the C-phase
  designs — page recognition and the ambient panel (C1), the agent and service
  lanes (C2), targeted fetch and capture-as-last-resort (C3), the activity
  ledger (C4), and research briefs and passages (C5). Some carry a matching
  `-review.md` where the design was reviewed before it was built.

These follow the [superpowers](https://github.com/nimbus-agent/Nimbus) spec→plan
layout. The implementation plans and point-in-time review notes are pruned once a
feature ships — they remain in git history, and `test/unit/doc-references.test.ts`
fails on a citation left dangling by a prune. The HTTP wire contract the
extension builds against is owned by the Nimbus gateway repository; its route
list is `GATEWAY_PATHS` in [`../src/shared/gateway.ts`](../src/shared/gateway.ts)
and it is summarized in [`../CLAUDE.md`](../CLAUDE.md).

Operational and release docs live outside this folder: the dev-load +
manual-verification checklist is in [`development.md`](./development.md), and the
store listing + publishing guide is in [`../store/`](../store/).
