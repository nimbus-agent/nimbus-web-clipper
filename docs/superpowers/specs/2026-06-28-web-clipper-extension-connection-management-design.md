# Web Clipper Extension — Connection Management (Options) Design Addendum

**Date:** 2026-06-28
**Status:** Approved (brainstorm) — ready for implementation plan
**Repo:** `nimbus-agent/nimbus-web-clipper` (this repo)
**Parent spec:** [`2026-06-23-web-clipper-extension-design.md`](./2026-06-23-web-clipper-extension-design.md) (§ pairing / Options)
**Upstream contract:** unchanged — **no gateway call** is added (the locked contract has no token-revocation endpoint)

## Summary

Give the Options page a **connection state**. Today it only performs the initial
pairing (origin + 6-digit code → mint token); on reload it shows nothing, and the
`clearConnection()` helper in the connection store is **dead code with no UI**. This
slice surfaces the current pairing — *"Paired as "`<label>`" to `<origin>`, since
`<date>`"* — and adds an **Unpair** button (inline two-step confirm) wired to
`clearConnection`.

The load-bearing invariant: the Options page learns the connection state through the
service worker via a **token-free projection** — the bearer token never leaves the
SW. Unpair is **local-only**: it deletes the stored `Connection`; the token simply
stops being used. The gateway's locked contract exposes no revoke endpoint, so there
is no server-side call — and none is needed.

This builds on Slice 1 (shipped): the `Connection` record, `getConnection`/
`setConnection`/`clearConnection` (`connection-store.ts`), the typed message
envelope, the `src/browser/` seam, and the existing Options pairing flow.

## Goals

- **Show the current pairing** on the Options page: label, gateway origin, and the
  paired-since date — or a clear "not paired" state.
- **Unpair** the browser from the Options page, with a confirm step to prevent an
  accidental disconnect (re-pairing requires re-running `nimbus clip pair`).
- Keep the token confined to the SW — the UI receives only a **token-free**
  projection of the connection.
- Wire up the already-present but unused `clearConnection`.

## Non-Goals

- **Server-side token revocation.** The locked gateway contract
  (`pair/confirm`, `clips`, `related`) has no revoke endpoint; unpair is local-only.
  Adding one is a cross-repo gateway change, out of scope.
- **Queue-aware unpair.** Queued offline clips (Slice 3) persist across an
  unpair and drain automatically after re-pair (`flushQueue` no-ops while unpaired),
  so no data is lost. The Options flow stays decoupled from the queue store — no
  pending-count read, no warning. (The unpaired-with-backlog state is already on the
  Slice 3 manual checklist.)
- **Multiple paired gateways.** Still one `Connection` record (unchanged).
- **Editing the connection in place** (e.g. changing the origin without re-pairing) —
  re-pairing overwrites the record, as today.

## Interaction model (resolved at brainstorm, 2026-06-28)

1. **Status detail:** paired → *"Paired as "`<label>`" to `<origin>`, since `<date>`."*
   The status message returns `{ paired, label, origin, pairedAt }` — **no token**.
   (Rejected: label-only — doesn't confirm which gateway; label+gateway without the
   date.)
2. **Unpair confirm:** an **inline two-step confirm** — the first click turns the
   button into *"Click again to confirm unpair"* with a Cancel; the second click
   unpairs. No native `confirm()` dialog (jarring + hard to unit-test). (Rejected:
   `confirm()`; one-click.)
3. **Queue-aware unpair:** no — keep it simple; clips persist and drain after
   re-pair (see Non-Goals).

## Data model & messages

```ts
// src/shared/messages.ts — token-free by construction (no `token` field exists on it)
export type ConnectionResponse =
  | { readonly kind: "connection"; readonly paired: false }
  | {
      readonly kind: "connection";
      readonly paired: true;
      readonly label: string;
      readonly origin: string;
      readonly pairedAt: number;
    };

export interface ConnectionStatusRequest {
  readonly kind: "connection-status";
}

export interface UnpairRequest {
  readonly kind: "unpair";
}
```

- `ExtensionRequest` gains `ConnectionStatusRequest | UnpairRequest`;
  `ExtensionResponse` gains `ConnectionResponse`.
- Guards: `isConnectionStatusRequest`, `isUnpairRequest`, `isConnectionResponse`
  (reusing the file's existing `isObject` helper).

## Module layout (mirrors the Slice 1–3 split: pure logic vs. `chrome.*` seam)

| File | Kind | Responsibility |
| --- | --- | --- |
| `src/shared/messages.ts` | modify | The two requests + `ConnectionResponse` + guards. |
| `src/background/handlers.ts` | modify | `ConnectionStatusDeps` + `handleConnectionStatus`; `UnpairDeps` + `handleUnpair`. |
| `src/background/service-worker.ts` | modify | Route `connection-status` and `unpair` (fail-closed, like the others). |
| `src/options/connection-view.ts` | new, pure | `formatPairedSince(pairedAt)` — deterministic date string (unit-tested). |
| `src/options/options.{html,css,ts}` | modify | The two-state UI (form vs. paired panel) + Unpair two-step confirm + render-on-load. |

No new esbuild entry (`options` already exists); no new permission; `check-build`
unchanged.

## Data flow

### Handlers (pure, dep-injected)

```ts
export interface ConnectionStatusDeps {
  readonly getConnection: () => Promise<Connection | null>;
}
export async function handleConnectionStatus(
  deps: ConnectionStatusDeps,
): Promise<ConnectionResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "connection", paired: false };
  }
  // Explicit projection — the token is deliberately omitted.
  return {
    kind: "connection",
    paired: true,
    label: conn.label,
    origin: conn.origin,
    pairedAt: conn.pairedAt,
  };
}

export interface UnpairDeps {
  readonly clearConnection: () => Promise<void>;
}
export async function handleUnpair(deps: UnpairDeps): Promise<ConnectionResponse> {
  await deps.clearConnection();
  return { kind: "connection", paired: false };
}
```

### Service worker

Routes `connection-status` → `handleConnectionStatus({ getConnection })` and
`unpair` → `handleUnpair({ clearConnection })`, each `.then(respond)` with a
fail-closed `.catch` that responds `{ kind: "connection", paired: false }`. (Failing
closed to "not paired" is the safe default — the UI falls back to the pairing form.)

### Options UI (two states)

On `DOMContentLoaded` the page sends `connection-status` and renders:

- **`paired: false`** → the existing pairing form (origin + code + Pair button)
  visible; the paired panel hidden.
- **`paired: true`** → the paired panel visible (status line built from `label` /
  `origin` / `formatPairedSince(pairedAt)` + an **Unpair** button); the form hidden.

Transitions:
- A successful `pair` re-queries `connection-status` to render the paired panel —
  `PairResponse` carries only the `label`, so the page fetches the full
  `{ origin, pairedAt }` projection — then flips to the paired panel and clears the
  code field.
- **Unpair** is a two-step inline confirm: click → the button becomes *"Click again
  to confirm unpair"* and a **Cancel** appears; Cancel reverts; a second click sends
  `unpair` and renders the returned `{ paired: false }` → back to the form.

All rendered strings (`label`, `origin`) are page-trusted (the user typed the origin;
the label came from the gateway) and are written via `textContent` — consistent with
the project's DOM-safety posture; no `innerHTML`.

`formatPairedSince(pairedAt)` formats deterministically — `en-US`, UTC, e.g.
`"Jun 27, 2026"` — so it is unit-testable without locale/timezone flakiness.

## Security & invariants

- **Token confinement.** `ConnectionResponse` has no `token` field; the handler
  builds the projection field-by-field. The token never enters the Options DOM or any
  message. (A unit test asserts the response contains no `token` key.)
- **Local-only unpair.** No gateway call; `clearConnection` deletes the
  `chrome.storage.local` record. The minted token remains valid server-side (no
  revoke endpoint exists) — acceptable and unavoidable under the locked contract.
- **No new permission; loopback only** — this slice adds neither.
- **Fail-closed routing** — a handler rejection responds "not paired", so the UI
  degrades to the pairing form rather than a stuck state.

## Testing

Pure/dep-injected units carry the coverage; the Options DOM wiring (two-state render
+ two-step confirm) goes on the manual checklist, consistent with Slice 1 (the
Options pairing DOM was manual-verified).

- `handlers.test.ts` — `handleConnectionStatus` returns the token-free projection
  when paired and `{ paired: false }` when not; **asserts the response has no `token`
  key**. `handleUnpair` calls `clearConnection` and returns `{ paired: false }`.
- `messages.test.ts` — `isConnectionStatusRequest` / `isUnpairRequest` /
  `isConnectionResponse` accept/reject correctly (including a malformed paired
  response).
- `connection-view.test.ts` — `formatPairedSince` formats a known epoch to the
  expected `en-US`/UTC string.
- **Manual checklist** (`docs/development.md`) — load Options unpaired → form shown;
  pair → flips to the paired panel with label/origin/since; reload → still paired;
  Unpair → first click asks to confirm, Cancel reverts, second click → back to the
  form; re-pair works; queued clips (if any) survive an unpair and drain after
  re-pair. Repeat in Firefox.

## Scope note

A **small slice** (~6 implementation-plan tasks): the message envelope, two handlers,
SW routing, the pure date formatter, and the Options two-state UI + manual checklist /
changelog. No new permission, no gateway change.

## Deferred (out of scope; possible later work)

- **Server-side revoke** if the gateway ever grows a revoke endpoint.
- **Queue-aware unpair** warning (pending-count in the confirm step).
- **In-place origin edit** without a full re-pair.
