# Web Clipper Extension — Connection Management (Options) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Options page a connection state — show the current pairing (label · gateway · since) and add an Unpair button (inline two-step confirm) — surfaced through the service worker as a token-free projection.

**Architecture:** Two new messages (`connection-status`, `unpair`) return a **token-free** `ConnectionResponse`; pure dep-injected handlers (`handleConnectionStatus`, `handleUnpair`) build the projection and call the existing `clearConnection`. The Options page renders one of two states (pairing form vs. paired panel) from the status response. The token never leaves the SW.

**Tech Stack:** TypeScript 6 strict, esbuild (run via `bun`), Vitest, Biome. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-28-web-clipper-extension-connection-management-design.md`. Builds on Slice 1 (the `Connection` record + `connection-store.ts`). No gateway change (the locked contract has no revoke endpoint — unpair is local-only).

## Global Constraints

- **TypeScript strict; no `any`.** Cross-boundary data (SW messages) is `unknown`, narrowed by a type guard. Biome enforces `noExplicitAny`, `noNonNullAssertion`, `useConst`.
- **No `console.*` in `src/`** (Biome `noConsole`). Tests/scripts may log.
- **The bearer token never leaves the SW.** `ConnectionResponse` has **no `token` field**; the handler builds the projection field-by-field. The token never enters the Options DOM or any message.
- **Unpair is local-only** — `clearConnection` deletes the stored record; no gateway call.
- **No new permission; loopback only** — this slice adds neither.
- **`exactOptionalPropertyTypes` is on** — never assign `undefined` to an optional field.
- **Biome requires a single `import` per module** — merge new bindings into existing import statements rather than adding a second import from the same module.
- **Each task ends green:** `bun run typecheck && bun run lint && bun run test` before its commit. Run `bun run build && bun run check-build` on tasks that touch a bundle (Tasks 4, 5).
- **Run via `bun`.** Tests: `bunx vitest run <file>`. Lint: `bun run lint`. Typecheck: `bun run typecheck`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/messages.ts` (modify) | `ConnectionStatusRequest`/`UnpairRequest` + `ConnectionResponse` + guards; extend the request/response unions. |
| `src/background/handlers.ts` (modify) | `handleConnectionStatus` (token-free projection) + `handleUnpair` (clear + return not-paired). |
| `src/background/service-worker.ts` (modify) | Route `connection-status` + `unpair` (fail-closed to not-paired). |
| `src/options/connection-view.ts` (new) | Pure `formatPairedSince(pairedAt)` — deterministic date string. |
| `src/options/options.{html,css,ts}` (modify) | Two-state UI (form vs. paired panel) + Unpair two-step confirm + render-on-load. |
| `docs/development.md` (modify) | Connection-management manual checklist. |
| `CHANGELOG.md` (modify) | Entry under `[Unreleased]`. |

---

## Task 1: Connection message envelope

**Files:**
- Modify: `src/shared/messages.ts`
- Test: `test/unit/messages.test.ts` (extend)

**Interfaces:**
- Produces:
  - `interface ConnectionStatusRequest { kind: "connection-status" }`
  - `interface UnpairRequest { kind: "unpair" }`
  - `type ConnectionResponse = { kind:"connection"; paired:false } | { kind:"connection"; paired:true; label:string; origin:string; pairedAt:number }`
  - `isConnectionStatusRequest`/`isUnpairRequest`/`isConnectionResponse`
  - `ExtensionRequest` += the two requests; `ExtensionResponse` += `ConnectionResponse`.

- [ ] **Step 1: Write the failing test (append to the existing file)**

```typescript
// append to test/unit/messages.test.ts
// (merge these names into the existing import from "../../src/shared/messages.ts")
import {
  isConnectionResponse,
  isConnectionStatusRequest,
  isUnpairRequest,
} from "../../src/shared/messages.ts";

describe("connection request guards", () => {
  test("accept their kinds", () => {
    expect(isConnectionStatusRequest({ kind: "connection-status" })).toBe(true);
    expect(isUnpairRequest({ kind: "unpair" })).toBe(true);
  });
  test("reject wrong kinds and non-objects", () => {
    expect(isConnectionStatusRequest({ kind: "unpair" })).toBe(false);
    expect(isUnpairRequest({ kind: "connection-status" })).toBe(false);
    expect(isConnectionStatusRequest(null)).toBe(false);
  });
});

describe("isConnectionResponse", () => {
  test("accepts not-paired and a well-formed paired response", () => {
    expect(isConnectionResponse({ kind: "connection", paired: false })).toBe(true);
    expect(
      isConnectionResponse({
        kind: "connection",
        paired: true,
        label: "chrome",
        origin: "http://127.0.0.1:8765",
        pairedAt: 1,
      }),
    ).toBe(true);
  });
  test("rejects a paired response missing fields, the wrong kind, and a missing paired flag", () => {
    expect(isConnectionResponse({ kind: "connection", paired: true, label: "c" })).toBe(false);
    expect(isConnectionResponse({ kind: "clip", paired: false })).toBe(false);
    expect(isConnectionResponse({ kind: "connection" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/messages.test.ts`
Expected: FAIL — the connection guards are not exported.

- [ ] **Step 3: Write the implementation**

In `src/shared/messages.ts`, add the two request interfaces after the queue request interfaces (before the `ExtensionRequest` type):

```typescript
export interface ConnectionStatusRequest {
  readonly kind: "connection-status";
}

export interface UnpairRequest {
  readonly kind: "unpair";
}
```

Replace the `ExtensionRequest` type with:

```typescript
export type ExtensionRequest =
  | PairRequest
  | ClipRequest
  | RelatedRequest
  | QueueListRequest
  | QueueRetryRequest
  | QueueRemoveRequest
  | ConnectionStatusRequest
  | UnpairRequest;
```

Add the `ConnectionResponse` type next to the other response types (e.g. after `QueueResponse`):

```typescript
export type ConnectionResponse =
  | { readonly kind: "connection"; readonly paired: false }
  | {
      readonly kind: "connection";
      readonly paired: true;
      readonly label: string;
      readonly origin: string;
      readonly pairedAt: number;
    };
```

Replace the `ExtensionResponse` type with:

```typescript
export type ExtensionResponse =
  | PairResponse
  | ClipResponse
  | RelatedResponse
  | QueueResponse
  | ConnectionResponse;
```

Append the guards at the end of the file (reuse the existing `isObject` helper):

```typescript
export function isConnectionStatusRequest(v: unknown): v is ConnectionStatusRequest {
  return isObject(v) && v["kind"] === "connection-status";
}

export function isUnpairRequest(v: unknown): v is UnpairRequest {
  return isObject(v) && v["kind"] === "unpair";
}

export function isConnectionResponse(v: unknown): v is ConnectionResponse {
  if (!isObject(v) || v["kind"] !== "connection") {
    return false;
  }
  if (v["paired"] === false) {
    return true;
  }
  if (v["paired"] === true) {
    return (
      typeof v["label"] === "string" &&
      typeof v["origin"] === "string" &&
      typeof v["pairedAt"] === "number"
    );
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/messages.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/messages.ts test/unit/messages.test.ts
git commit -m "feat(messages): connection-status/unpair envelope + token-free ConnectionResponse + guards"
```

---

## Task 2: Connection handlers

**Files:**
- Modify: `src/background/handlers.ts`
- Test: `test/unit/handlers.test.ts` (extend)

**Interfaces:**
- Consumes: `Connection` (`../shared/types.ts`, already imported); `ConnectionResponse` (`../shared/messages.ts`).
- Produces:
  - `interface ConnectionStatusDeps { getConnection: () => Promise<Connection | null> }` + `handleConnectionStatus(deps): Promise<ConnectionResponse>`
  - `interface UnpairDeps { clearConnection: () => Promise<void> }` + `handleUnpair(deps): Promise<ConnectionResponse>`

- [ ] **Step 1: Write the failing test (append)**

```typescript
// append to test/unit/handlers.test.ts
// (merge these into the existing import from "../../src/background/handlers.ts")
import { handleConnectionStatus, handleUnpair } from "../../src/background/handlers.ts";

describe("handleConnectionStatus", () => {
  test("not paired → { paired: false }", async () => {
    const res = await handleConnectionStatus({ getConnection: async () => null });
    expect(res).toEqual({ kind: "connection", paired: false });
  });
  test("paired → token-free projection (label/origin/pairedAt; NO token)", async () => {
    // `conn` (defined at the top of this file) carries a token; the response must not.
    const res = await handleConnectionStatus({ getConnection: async () => conn });
    expect(res).toEqual({
      kind: "connection",
      paired: true,
      label: "chrome",
      origin: "http://127.0.0.1:8765",
      pairedAt: 100,
    });
    expect("token" in res).toBe(false);
  });
});

describe("handleUnpair", () => {
  test("clears the connection and returns { paired: false }", async () => {
    let cleared = false;
    const res = await handleUnpair({
      clearConnection: async () => {
        cleared = true;
      },
    });
    expect(cleared).toBe(true);
    expect(res).toEqual({ kind: "connection", paired: false });
  });
});
```

> The shared `conn: Connection = { origin: "http://127.0.0.1:8765", token: "tok", label: "chrome", pairedAt: 100 }` is already declared at the top of `handlers.test.ts` (used by the pair/clip tests) — reuse it; do not redeclare it.

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/handlers.test.ts`
Expected: FAIL — `handleConnectionStatus` / `handleUnpair` not exported.

- [ ] **Step 3: Write the implementation**

In `src/background/handlers.ts`, add `ConnectionResponse` to the existing `../shared/messages.ts` type import (merge into the existing `import type { … } from "../shared/messages.ts";` block):

```typescript
import type {
  ClipRequest,
  ClipResponse,
  ConnectionResponse,
  PairRequest,
  PairResponse,
  QueueRemoveRequest,
  QueueResponse,
  QueueRetryRequest,
  RelatedRequest,
  RelatedResponse,
} from "../shared/messages.ts";
```

(`Connection` is already imported from `../shared/types.ts` for the existing deps — no new types import needed.)

Append at the end of the file:

```typescript
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
  // Explicit field-by-field projection — the token is deliberately omitted so it
  // never crosses the messaging boundary into the Options page.
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/handlers.ts test/unit/handlers.test.ts
git commit -m "feat(background): handleConnectionStatus (token-free) + handleUnpair"
```

---

## Task 3: Pure date formatter

**Files:**
- Create: `src/options/connection-view.ts`
- Test: `test/unit/connection-view.test.ts`

**Interfaces:**
- Produces: `formatPairedSince(pairedAt: number): string`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/connection-view.test.ts
import { describe, expect, test } from "vitest";
import { formatPairedSince } from "../../src/options/connection-view.ts";

describe("formatPairedSince", () => {
  test("formats an epoch ms to an en-US/UTC date string", () => {
    // 2026-06-27T12:00:00Z
    expect(formatPairedSince(Date.UTC(2026, 5, 27, 12, 0, 0))).toBe("Jun 27, 2026");
  });
  test("uses UTC so it does not drift a day near midnight", () => {
    // 2026-01-01T00:30:00Z stays Jan 1 under UTC
    expect(formatPairedSince(Date.UTC(2026, 0, 1, 0, 30, 0))).toBe("Jan 1, 2026");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/connection-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/options/connection-view.ts
// Pure presentational helper for the Options connection panel. Formats the
// paired-since date deterministically (en-US, UTC) so it is unit-testable without
// locale/timezone flakiness.
export function formatPairedSince(pairedAt: number): string {
  return new Date(pairedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/connection-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/options/connection-view.ts test/unit/connection-view.test.ts
git commit -m "feat(options): pure formatPairedSince date helper (en-US/UTC, deterministic)"
```

---

## Task 4: Service-worker routing

**Files:**
- Modify: `src/background/service-worker.ts`

**Interfaces:**
- Consumes: `clearConnection` (`./connection-store.ts`); `handleConnectionStatus`/`handleUnpair` (`./handlers.ts`); `isConnectionStatusRequest`/`isUnpairRequest` (`../shared/messages.ts`); `getConnection` (already imported).

> The SW routing glue has no unit test (verified by the build gate + the Task 6 manual checklist, consistent with prior slices).

- [ ] **Step 1: Extend the imports**

In `src/background/service-worker.ts`, add `clearConnection` to the connection-store import:

```typescript
import { clearConnection, getConnection, setConnection } from "./connection-store.ts";
```

Add the two handlers to the existing `./handlers.ts` import (merge into the existing block):

```typescript
import {
  handleClip,
  handleConnectionStatus,
  handlePair,
  handleQueueList,
  handleQueueRemove,
  handleQueueRetry,
  handleRelated,
  handleUnpair,
} from "./handlers.ts";
```

Add the two guards to the existing `../shared/messages.ts` import (merge):

```typescript
import {
  isClipRequest,
  isConnectionStatusRequest,
  isPairRequest,
  isQueueListRequest,
  isQueueRemoveRequest,
  isQueueRetryRequest,
  isRelatedRequest,
  isUnpairRequest,
} from "../shared/messages.ts";
```

- [ ] **Step 2: Add the two routes**

In the `addMessageListener` callback, add these two blocks immediately before the final `return false;`:

```typescript
  if (isConnectionStatusRequest(message)) {
    handleConnectionStatus({ getConnection })
      .then(respond)
      .catch(() => {
        respond({ kind: "connection", paired: false });
      });
    return true;
  }
  if (isUnpairRequest(message)) {
    handleUnpair({ clearConnection })
      .then(respond)
      .catch(() => {
        respond({ kind: "connection", paired: false });
      });
    return true;
  }
```

(Unpair does not touch the queue, so it does not call `syncQueueState` — the badge/alarm lifecycle is unchanged by unpairing.)

- [ ] **Step 3: Build, check, typecheck, lint, test**

Run: `bun run build && bun run check-build && bun run typecheck && bun run lint && bun run test`
Expected: PASS — both targets build; check-build OK; no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/background/service-worker.ts
git commit -m "feat(background): route connection-status + unpair messages (fail-closed)"
```

---

## Task 5: Options two-state UI

**Files:**
- Modify: `src/options/options.html`, `src/options/options.css`, `src/options/options.ts`

**Interfaces:**
- Consumes: `sendMessage` (`../browser/runtime.ts`, already imported); `isConnectionResponse` (`../shared/messages.ts`); `formatPairedSince` (`./connection-view.ts`).

> The Options DOM wiring (two-state render + two-step confirm) has no unit test — verified by the Task 6 manual checklist, consistent with Slice 1 (the pairing DOM was manual-verified). Its pure dependency (`formatPairedSince`) is unit-tested.

- [ ] **Step 1: Restructure the Options HTML into two sections**

Replace the `<main class="options"> … </main>` block in `src/options/options.html` with:

```html
    <main class="options">
      <h1>Nimbus Web Clipper</h1>
      <section id="pairing-section">
        <h2>Pair this browser</h2>
        <p>Run <code>nimbus clip pair</code> on the machine running your Nimbus gateway, then enter its URL and the 6-digit code it prints.</p>
        <label for="origin">Gateway URL</label>
        <input id="origin" type="text" placeholder="http://127.0.0.1:8765" />
        <label for="code">Pairing code</label>
        <input id="code" type="text" inputmode="numeric" placeholder="429173" />
        <button id="pair" type="button">Pair this browser</button>
        <p id="pairing-status" class="options__status" role="status"></p>
      </section>
      <section id="connection-section" hidden>
        <h2>Connection</h2>
        <p id="connection-status" class="options__status" role="status"></p>
        <button id="unpair" type="button">Unpair this browser</button>
        <button id="unpair-cancel" type="button" hidden>Cancel</button>
      </section>
    </main>
```

- [ ] **Step 2: Style the unpair buttons**

Append to `src/options/options.css`:

```css
#unpair { cursor: pointer; }
#unpair-cancel { margin-left: 8px; cursor: pointer; }
```

- [ ] **Step 3: Rewrite the Options script**

Replace the entire contents of `src/options/options.ts` with:

```typescript
import { sendMessage } from "../browser/runtime.ts";
import { isConnectionResponse, type PairResponse } from "../shared/messages.ts";
import { formatPairedSince } from "./connection-view.ts";

const PAIR_MESSAGES: Record<string, string> = {
  bad_origin: "Enter a 127.0.0.1 / localhost URL.",
  pairing_failed: "Code wrong or expired — run `nimbus clip pair` again.",
  unreachable: "Can't reach Nimbus — is the gateway running?",
  server_error: "Nimbus had an error during pairing.",
};

function isPairResponse(v: unknown): v is PairResponse {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "pair";
}

function setStatus(text: string): void {
  const el = document.getElementById("pairing-status");
  if (el !== null) {
    el.textContent = text;
  }
}

let unpairArmed = false;

function disarmUnpair(): void {
  unpairArmed = false;
  const unpair = document.getElementById("unpair");
  const cancel = document.getElementById("unpair-cancel");
  if (unpair instanceof HTMLButtonElement) {
    unpair.textContent = "Unpair this browser";
  }
  if (cancel instanceof HTMLElement) {
    cancel.hidden = true;
  }
}

function renderConnection(res: unknown): void {
  const pairing = document.getElementById("pairing-section");
  const connection = document.getElementById("connection-section");
  const status = document.getElementById("connection-status");
  if (
    !(pairing instanceof HTMLElement) ||
    !(connection instanceof HTMLElement) ||
    status === null
  ) {
    return;
  }
  if (!isConnectionResponse(res) || !res.paired) {
    connection.hidden = true;
    pairing.hidden = false;
    disarmUnpair();
    return;
  }
  status.textContent = `Paired as "${res.label}" to ${res.origin}, since ${formatPairedSince(res.pairedAt)}.`;
  pairing.hidden = true;
  connection.hidden = false;
}

async function refreshConnection(): Promise<void> {
  renderConnection(await sendMessage({ kind: "connection-status" }));
}

async function pair(): Promise<void> {
  const originEl = document.getElementById("origin");
  const codeEl = document.getElementById("code");
  if (!(originEl instanceof HTMLInputElement) || !(codeEl instanceof HTMLInputElement)) {
    return;
  }
  const origin = originEl.value.trim();
  const code = codeEl.value.trim();
  if (origin === "" || code === "") {
    setStatus("Enter both the gateway URL and the pairing code.");
    return;
  }
  setStatus("Pairing…");
  const res = await sendMessage({ kind: "pair", origin, code });
  if (!isPairResponse(res)) {
    setStatus("Unexpected response.");
    return;
  }
  if (res.ok) {
    codeEl.value = "";
    setStatus("");
    await refreshConnection();
  } else {
    setStatus(PAIR_MESSAGES[res.reason] ?? "Pairing failed.");
  }
}

async function onUnpairClick(): Promise<void> {
  if (!unpairArmed) {
    unpairArmed = true;
    const unpair = document.getElementById("unpair");
    const cancel = document.getElementById("unpair-cancel");
    if (unpair instanceof HTMLButtonElement) {
      unpair.textContent = "Click again to confirm unpair";
    }
    if (cancel instanceof HTMLElement) {
      cancel.hidden = false;
    }
    return;
  }
  disarmUnpair();
  renderConnection(await sendMessage({ kind: "unpair" }));
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("pair")?.addEventListener("click", () => void pair());
  document.getElementById("unpair")?.addEventListener("click", () => void onUnpairClick());
  document.getElementById("unpair-cancel")?.addEventListener("click", () => disarmUnpair());
  void refreshConnection();
});
```

- [ ] **Step 4: Build, check, typecheck, lint, test**

Run: `bun run build && bun run check-build && bun run typecheck && bun run lint && bun run test`
Expected: PASS — both targets build; check-build OK; no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/options/options.html src/options/options.css src/options/options.ts
git commit -m "feat(options): two-state connection UI — paired status panel + unpair two-step confirm"
```

---

## Task 6: Manual checklist + changelog + full gate

**Files:**
- Modify: `docs/development.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the manual checklist**

Append to `docs/development.md` (before the `## Security check` section):

```markdown
## Manual verification — Connection management (Options)

1. **Unpaired state:** with no connection stored, open Options → the **pairing form**
   is shown (gateway URL + code + Pair); the Connection panel is hidden.
2. **Pair → paired panel:** complete a pairing → the form is replaced by
   *"Paired as "<label>" to <origin>, since <date>."* and an **Unpair** button.
3. **Persistence:** reload the Options page → it still shows the paired panel (state
   comes from the service worker, not the page).
4. **Unpair two-step:** click **Unpair** → it becomes *"Click again to confirm
   unpair"* with a **Cancel**; click **Cancel** → reverts (still paired); click
   **Unpair** twice → returns to the pairing form.
5. **Token never exposed:** with DevTools open on the Options page, confirm no
   bearer token appears in the DOM or in the `connection-status` message payload
   (only label/origin/pairedAt).
6. **Re-pair after unpair:** pairing again from the form returns to the paired panel.
7. **Queued clips survive unpair:** with offline clips queued (Slice 3), unpairing
   leaves them queued; after re-pairing they drain on the next flush.
8. Repeat 1–6 in Firefox.
```

- [ ] **Step 2: Add the changelog entry**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, append:

```markdown
- **Connection management (Options).** The Options page now shows the current
  pairing — *"Paired as "<label>" to <origin>, since <date>."* — and adds an
  **Unpair** button (inline two-step confirm) that clears the stored connection. The
  state is fetched from the service worker as a **token-free** projection (the bearer
  token never enters the Options page). Unpair is local-only (the gateway contract has
  no revoke endpoint); queued offline clips survive an unpair and drain after
  re-pairing. No new permission.
```

- [ ] **Step 3: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/development.md CHANGELOG.md
git commit -m "docs: connection-management manual checklist + changelog entry"
```

- [ ] **Step 5: Push and open the PR (once GitHub access is restored)**

```bash
git push -u origin spec/connection-mgmt
gh pr create --base main --fill
```

> **Blocked locally:** the GitHub account is suspended, so this step is deferred. The branch is complete and green; push + PR when access returns. Note `spec/connection-mgmt` is stacked on the unmerged Slice 1–3 branches — base the PR appropriately (or merge the earlier slices first).

---

## Self-Review Notes (author)

- **Spec coverage:** token-free `ConnectionResponse` + guards (T1); `handleConnectionStatus` projection with the explicit no-token test + `handleUnpair` wiring `clearConnection` (T2); deterministic `formatPairedSince` (T3); SW routing fail-closed to not-paired (T4); two-state Options UI with the inline two-step unpair confirm + render-on-load + pair→refresh (T5); manual checklist (incl. the token-not-exposed and queued-clips-survive checks) + changelog (T6). Local-only unpair (no gateway call) holds — no fetch is added anywhere. Queue stays decoupled (T4 unpair route does not call `syncQueueState`).
- **Type consistency:** `ConnectionResponse` defined once in `messages.ts` (T1), consumed by the handlers (T2), the SW routes (T4), and the Options guard `isConnectionResponse` (T5); `formatPairedSince(pairedAt: number)` defined in T3 and consumed by `renderConnection` in T5; `getConnection`/`clearConnection` injected from `connection-store.ts` (T4).
- **Token posture:** the only place a `Connection` (with its token) is read is inside `handleConnectionStatus`, which projects field-by-field and omits the token; the T2 test asserts `"token" in res === false`. No token in any message or the Options DOM.
- **No new permission / loopback only / no gateway change** — confirmed; unpair never calls the gateway.
- **Intentional non-unit-tested surfaces:** the SW routes (T4) and the Options DOM wiring (T5) — covered by the T6 manual checklist; their pure dependencies (handlers, guards, `formatPairedSince`) are unit-tested.
```
