# Docs

Design reference for the Nimbus Companion.

- **[`architecture.md`](./architecture.md)** — how the extension is built today:
  the load-bearing decisions, the layer map, the clip pipeline, and the two state
  machines (offline retry queue + rate-limit pause). Start here to understand the
  code. It is also where a delivered feature's durable design decisions — and the
  alternatives it rejected — end up. The forward-looking counterpart is
  [`../ROADMAP.md`](../ROADMAP.md).
- **[`development.md`](./development.md)** — the dev-load steps and the
  per-feature manual-verification checklists; a step an automated suite in
  `test/e2e/` covers carries an `<!-- e2e:<id> -->` marker.
- **[`superpowers/specs/`](./superpowers/specs/)** — a workspace for design
  specs (and their reviews) still in flight, named by the date each was
  written. Today it holds nothing: the Phase C10 design and its review were pruned when
  C10.2 — the DORA metrics page — shipped, and their durable decisions live in
  `architecture.md`.

These follow the [superpowers](https://github.com/nimbus-agent/Nimbus) spec→plan
layout. Specs, implementation plans and point-in-time review notes are all
pruned once their feature ships, after anything still true has moved into
`architecture.md` — they remain in git history, and
`test/unit/doc-references.test.ts` fails on a citation left dangling by a prune.
The HTTP wire contract the extension builds against is owned by the Nimbus
gateway repository; its route list is `GATEWAY_PATHS` in
[`../src/shared/gateway.ts`](../src/shared/gateway.ts) and it is summarized in
[`../CLAUDE.md`](../CLAUDE.md).

The store listing, privacy policy and publishing guide live outside this folder,
in [`../store/`](../store/).
