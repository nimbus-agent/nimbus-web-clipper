# Web Clipper Extension — Slice 2 (Related-items sidecar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the on-demand related-items sidecar — a Shadow-DOM panel, injected from a popup button or a hotkey, that queries `POST /v1/clips/related` and lists related indexed items for the current page.

**Architecture:** A new esbuild entry `panel.js` is injected into the active tab (from the popup "Show related" button and from the SW on a `chrome.commands` hotkey). It is self-toggling: re-injection removes an existing panel. The injected panel reads the page context, messages the background service worker, and the SW (which owns the token + all gateway I/O) calls `postRelated`. Rendering uses `textContent` only. Pure logic (query building, guards, DOM builders) is unit-tested; the Shadow-DOM mount/toggle and DOM wiring are dev-loaded / manual.

**Tech Stack:** TypeScript 6 strict, esbuild (run via `bun`), Vitest (+ jsdom for the DOM-builder tests), Biome. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-23-web-clipper-extension-slice2-design.md` (and its design-review resolutions). Builds on Slice 1 (shipped on `main`). The HTTP contract is locked by Nimbus PR #718.

## Global Constraints

- **TypeScript strict; no `any`.** Cross-boundary data (the SW message, the gateway response) is `unknown`, narrowed by a type guard. Biome enforces `noExplicitAny`, `noNonNullAssertion`, `useConst`.
- **No `console.*` in `src/`** (Biome `noConsole`). Tests and `scripts/` may log.
- **Never log or DOM-expose the bearer token.** The token stays in the SW + `chrome.storage.local`; the injected panel only ever receives rendered `RelatedHit` data.
- **DOM-XSS backstop:** gateway-returned strings (`title`, `snippet`, `service`) render via `Element.textContent` / `createElement` — **never `innerHTML`**.
- **Loopback only.** No new `host_permissions`; no new fetch destinations. The panel reaches the active tab via the existing `activeTab` + `scripting` permissions (granted on click and on hotkey).
- **No new permissions** beyond the existing `activeTab`/`scripting`/`storage`. The only manifest addition is a `commands` entry.
- **Self-contained panel styles:** an inlined CSS string in a `<style>` element in the shadow root — no `<link>`, no `web_accessible_resources`, no `getURL`.
- **`exactOptionalPropertyTypes` is on** — build optional fields by conditional spread, never assign `undefined`.
- **Each task ends green:** `bun run typecheck && bun run lint && bun run test` must pass before its commit. Run `bun run build && bun run check-build` on tasks that touch the build (Tasks 7, 8).
- **Run via `bun`.** Tests: `bunx vitest run <file>`. Lint: `bun run lint`. Typecheck: `bun run typecheck`.
- **Merge imports when appending tests.** When a task appends test code whose `import` duplicates a module already imported at the top of that test file, **merge the new bindings into the existing import statement** rather than adding a second one — Biome requires a single import per module and `bun run lint` fails otherwise.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` (modify) | Add `RelatedHit`, `RelatedError`. |
| `src/shared/related.ts` (new) | `RelatedQuery` + `RELATED_LIMIT` + pure `buildRelatedQuery` + `isRelatedHit`. |
| `src/shared/messages.ts` (modify) | Add `RelatedRequest`/`RelatedResponse` + `isRelatedRequest`/`isRelatedResponse`; extend the request/response unions. |
| `src/background/gateway-client.ts` (modify) | Add `postRelated` (fetch + Bearer + timeout + status→reason). |
| `src/background/handlers.ts` (modify) | Add `RelatedDeps` + `handleRelated`. |
| `src/panel/panel-view.ts` (new) | Pure DOM builders (`renderHit`/`renderHits`/`renderError`) — `textContent` only; jsdom-tested. |
| `src/panel/panel-in-page.ts` (new) | Injected `panel.js` entry: self-toggle, mount Shadow-DOM overlay (inlined styles), read context, message SW, render, X+Esc+AbortController teardown. |
| `src/browser/scripting.ts` (modify) | Add `injectPanel(tabId)`. |
| `src/browser/runtime.ts` (modify) | Add `addCommandListener(fn)`. |
| `src/background/service-worker.ts` (modify) | Route `related` messages; `onCommand` → inject panel into the active tab. |
| `src/popup/popup.{html,ts}` (modify) | "Show related" button → inject panel → `window.close()`. |
| `src/manifest/manifest.ts` (modify) | Add the `commands.show_related` entry (+ interface). |
| `esbuild.mjs` (modify) | Add the `panel` entry. |
| `scripts/check-build.mjs` (modify) | Require `panel.js` per target. |
| `test/unit/chrome-stub.ts` (modify) | Record `executeScript` calls for the `injectPanel` test. |
| `docs/development.md` (modify) | Slice-2 manual checklist. |
| `CHANGELOG.md` (modify) | Slice 2 under `[Unreleased]`. |

---

## Task 1: Related types + pure query builder

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/shared/related.ts`
- Test: `test/unit/related.test.ts`

**Interfaces:**
- Produces:
  - `interface RelatedHit { id: string; title: string; service: string; snippet: string; url: string | null }`
  - `type RelatedError = "not_paired" | "unauthorized" | "unreachable" | "server_error"`
  - `interface RelatedQuery { title?: string; canonicalUrl?: string; selection?: string; limit: number }`
  - `const RELATED_LIMIT = 10`
  - `buildRelatedQuery(ctx: { title?: string; canonicalUrl?: string; selection?: string }, limit?: number): RelatedQuery`
  - `isRelatedHit(v: unknown): v is RelatedHit`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/related.test.ts
import { describe, expect, test } from "vitest";
import { RELATED_LIMIT, buildRelatedQuery, isRelatedHit } from "../../src/shared/related.ts";

describe("buildRelatedQuery", () => {
  test("includes only non-blank fields and the default limit", () => {
    expect(buildRelatedQuery({ title: "Hello", canonicalUrl: "https://ex.com/p", selection: "pick" })).toEqual({
      title: "Hello",
      canonicalUrl: "https://ex.com/p",
      selection: "pick",
      limit: RELATED_LIMIT,
    });
  });
  test("drops blank/whitespace fields (exactOptionalPropertyTypes — never undefined)", () => {
    const q = buildRelatedQuery({ title: "  ", canonicalUrl: "", selection: "  x " });
    expect(q).toEqual({ selection: "x", limit: RELATED_LIMIT });
    expect("title" in q).toBe(false);
    expect("canonicalUrl" in q).toBe(false);
  });
  test("empty context → just the limit", () => {
    expect(buildRelatedQuery({})).toEqual({ limit: RELATED_LIMIT });
  });
  test("honors an explicit limit override", () => {
    expect(buildRelatedQuery({ title: "T" }, 3)).toEqual({ title: "T", limit: 3 });
  });
});

describe("isRelatedHit", () => {
  const hit = { id: "1", title: "T", service: "gmail", snippet: "s", url: "https://ex.com" };
  test("accepts a well-formed hit (url string)", () => {
    expect(isRelatedHit(hit)).toBe(true);
  });
  test("accepts url === null", () => {
    expect(isRelatedHit({ ...hit, url: null })).toBe(true);
  });
  test("rejects a non-string/non-null url, missing fields, and non-objects", () => {
    expect(isRelatedHit({ ...hit, url: 123 })).toBe(false);
    expect(isRelatedHit({ id: "1", title: "T", service: "g", snippet: "s" })).toBe(false);
    expect(isRelatedHit(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/related.test.ts`
Expected: FAIL — module `../../src/shared/related.ts` not found.

- [ ] **Step 3: Write the implementation**

Append to `src/shared/types.ts`:

```typescript
export interface RelatedHit {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly snippet: string;
  readonly url: string | null;
}

export type RelatedError = "not_paired" | "unauthorized" | "unreachable" | "server_error";
```

Create `src/shared/related.ts`:

```typescript
import type { RelatedHit } from "./types.ts";

/** The gateway request body for POST /v1/clips/related. */
export interface RelatedQuery {
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly selection?: string;
  readonly limit: number;
}

/** Default number of related items to request for this slice. */
export const RELATED_LIMIT = 10;

/**
 * Build the related-query body from the page context: trim each field, drop the
 * blank ones (conditional spread keeps the object exactOptionalPropertyTypes-safe —
 * an absent field is omitted, never set to undefined), and attach the limit.
 */
export function buildRelatedQuery(
  ctx: { title?: string; canonicalUrl?: string; selection?: string },
  limit: number = RELATED_LIMIT,
): RelatedQuery {
  const title = ctx.title?.trim();
  const canonicalUrl = ctx.canonicalUrl?.trim();
  const selection = ctx.selection?.trim();
  return {
    ...(title !== undefined && title !== "" ? { title } : {}),
    ...(canonicalUrl !== undefined && canonicalUrl !== "" ? { canonicalUrl } : {}),
    ...(selection !== undefined && selection !== "" ? { selection } : {}),
    limit,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isRelatedHit(v: unknown): v is RelatedHit {
  return (
    isObject(v) &&
    typeof v["id"] === "string" &&
    typeof v["title"] === "string" &&
    typeof v["service"] === "string" &&
    typeof v["snippet"] === "string" &&
    (v["url"] === null || typeof v["url"] === "string")
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/related.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/related.ts test/unit/related.test.ts
git commit -m "feat(related): RelatedHit/RelatedError types + pure buildRelatedQuery + isRelatedHit"
```

---

## Task 2: Related message envelope

**Files:**
- Modify: `src/shared/messages.ts`
- Test: `test/unit/messages.test.ts` (extend)

**Interfaces:**
- Consumes: `RelatedHit`, `RelatedError` (`./types.ts`); `isRelatedHit` (`./related.ts`).
- Produces:
  - `interface RelatedRequest { kind: "related"; title?: string; canonicalUrl?: string; selection?: string }`
  - `type RelatedResponse = { kind:"related"; ok:true; items: RelatedHit[] } | { kind:"related"; ok:false; reason: RelatedError }`
  - `isRelatedRequest(v: unknown): v is RelatedRequest`
  - `isRelatedResponse(v: unknown): v is RelatedResponse`
  - `ExtensionRequest` now includes `RelatedRequest`; `ExtensionResponse` includes `RelatedResponse`.

- [ ] **Step 1: Write the failing test (append to the existing file)**

```typescript
// append to test/unit/messages.test.ts
import { isRelatedRequest, isRelatedResponse } from "../../src/shared/messages.ts";

describe("isRelatedRequest", () => {
  test("accepts a related request with all/optional fields", () => {
    expect(isRelatedRequest({ kind: "related", title: "T", canonicalUrl: "u", selection: "s" })).toBe(true);
    expect(isRelatedRequest({ kind: "related" })).toBe(true);
  });
  test("rejects wrong kind, non-string fields, and non-objects", () => {
    expect(isRelatedRequest({ kind: "clip" })).toBe(false);
    expect(isRelatedRequest({ kind: "related", title: 1 })).toBe(false);
    expect(isRelatedRequest(null)).toBe(false);
  });
});

describe("isRelatedResponse", () => {
  const hit = { id: "1", title: "T", service: "gmail", snippet: "s", url: null };
  test("accepts ok with a RelatedHit[] and a failure with a reason", () => {
    expect(isRelatedResponse({ kind: "related", ok: true, items: [hit] })).toBe(true);
    expect(isRelatedResponse({ kind: "related", ok: false, reason: "not_paired" })).toBe(true);
  });
  test("rejects malformed items, wrong kind, and missing ok", () => {
    expect(isRelatedResponse({ kind: "related", ok: true, items: [{ id: 1 }] })).toBe(false);
    expect(isRelatedResponse({ kind: "clip", ok: true, items: [] })).toBe(false);
    expect(isRelatedResponse({ kind: "related" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/messages.test.ts`
Expected: FAIL — `isRelatedRequest` / `isRelatedResponse` not exported.

- [ ] **Step 3: Write the implementation**

In `src/shared/messages.ts`, extend the import on line 5 and add the related types/guards. Change:

```typescript
import type { CaptureResult, ClipError, PairError } from "./types.ts";
```

to:

```typescript
import { isRelatedHit } from "./related.ts";
import type { CaptureResult, ClipError, PairError, RelatedError, RelatedHit } from "./types.ts";
```

Replace the `ExtensionRequest` line:

```typescript
export type ExtensionRequest = PairRequest | ClipRequest;
```

with:

```typescript
export interface RelatedRequest {
  readonly kind: "related";
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly selection?: string;
}

export type ExtensionRequest = PairRequest | ClipRequest | RelatedRequest;
```

Replace the `ExtensionResponse` line:

```typescript
export type ExtensionResponse = PairResponse | ClipResponse;
```

with:

```typescript
export type RelatedResponse =
  | { readonly kind: "related"; readonly ok: true; readonly items: RelatedHit[] }
  | { readonly kind: "related"; readonly ok: false; readonly reason: RelatedError };

export type ExtensionResponse = PairResponse | ClipResponse | RelatedResponse;
```

Append the guards at the end of the file:

```typescript
export function isRelatedRequest(v: unknown): v is RelatedRequest {
  return (
    isObject(v) &&
    v["kind"] === "related" &&
    (v["title"] === undefined || typeof v["title"] === "string") &&
    (v["canonicalUrl"] === undefined || typeof v["canonicalUrl"] === "string") &&
    (v["selection"] === undefined || typeof v["selection"] === "string")
  );
}

export function isRelatedResponse(v: unknown): v is RelatedResponse {
  if (!isObject(v) || v["kind"] !== "related") {
    return false;
  }
  if (v["ok"] === true) {
    return Array.isArray(v["items"]) && v["items"].every(isRelatedHit);
  }
  if (v["ok"] === false) {
    return typeof v["reason"] === "string";
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
git commit -m "feat(messages): related request/response envelope and guards"
```

---

## Task 3: Gateway client — postRelated

**Files:**
- Modify: `src/background/gateway-client.ts`
- Test: `test/unit/gateway-client.test.ts` (extend)

**Interfaces:**
- Consumes: `endpointUrl` (`../shared/gateway.ts`); `RelatedQuery`/`isRelatedHit` (`../shared/related.ts`); `RelatedError`/`RelatedHit` (`../shared/types.ts`); the existing `postJson`/`readJson`/`isObject`/`FetchLike` in this file.
- Produces:
  - `postRelated(origin: string, token: string, query: RelatedQuery, doFetch?: FetchLike): Promise<{ ok:true; items: RelatedHit[] } | { ok:false; reason: RelatedError }>`

- [ ] **Step 1: Write the failing test (append)**

```typescript
// append to test/unit/gateway-client.test.ts
// (also add `vi` to the existing `import { describe, expect, test } from "vitest";`
//  at the top of the file — merge, don't add a second vitest import)
import { postRelated } from "../../src/background/gateway-client.ts";
import type { RelatedQuery } from "../../src/shared/related.ts";

describe("postRelated", () => {
  const query: RelatedQuery = { title: "T", canonicalUrl: "https://ex.com/p", selection: "s", limit: 10 };
  const hit = { id: "nimbus:1", title: "Doc", service: "drive", snippet: "…", url: "https://ex.com/d" };

  test("200 → ok with items; sends Bearer + query to the related path", async () => {
    let seenUrl = "";
    let auth: string | null = null;
    let seenBody: unknown;
    const out = await postRelated("http://127.0.0.1:8765", "tok-abc", query, async (url, init) => {
      seenUrl = url;
      auth = new Headers(init?.headers).get("authorization");
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ items: [hit] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    expect(seenUrl).toBe("http://127.0.0.1:8765/v1/clips/related");
    expect(auth).toBe("Bearer tok-abc");
    expect(seenBody).toEqual(query);
    expect(out).toEqual({ ok: true, items: [hit] });
  });
  test("200 with a malformed item → server_error", async () => {
    const out = await postRelated("http://127.0.0.1:8765", "t", query, async () =>
      new Response(JSON.stringify({ items: [{ id: 1 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(out).toEqual({ ok: false, reason: "server_error" });
  });
  test("401 → unauthorized", async () => {
    expect(
      await postRelated("http://127.0.0.1:8765", "t", query, async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      ),
    ).toEqual({ ok: false, reason: "unauthorized" });
  });
  test("400/500 → server_error", async () => {
    expect(
      await postRelated("http://127.0.0.1:8765", "t", query, async () =>
        new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 }),
      ),
    ).toEqual({ ok: false, reason: "server_error" });
  });
  test("fetch throw → unreachable", async () => {
    expect(
      await postRelated("http://127.0.0.1:8765", "t", query, async () => {
        throw new Error("net");
      }),
    ).toEqual({ ok: false, reason: "unreachable" });
  });
  test("aborts and returns unreachable after the timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const result = postRelated(
        "http://127.0.0.1:8765",
        "t",
        query,
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await result).toEqual({ ok: false, reason: "unreachable" });
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/gateway-client.test.ts`
Expected: FAIL — `postRelated` not exported.

- [ ] **Step 3: Write the implementation**

In `src/background/gateway-client.ts`, extend the type imports to include the related types:

```typescript
import { type RelatedQuery, isRelatedHit } from "../shared/related.ts";
import type { ClipError, PairError, RelatedError, RelatedHit } from "../shared/types.ts";
```

(adjust the existing `import type { ClipError, PairError } from "../shared/types.ts";` line to the form above, and add the `related` import).

Add the timeout constant near the other timeouts:

```typescript
const RELATED_TIMEOUT_MS = 8_000;
```

Append the function:

```typescript
export async function postRelated(
  origin: string,
  token: string,
  query: RelatedQuery,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true; items: RelatedHit[] } | { ok: false; reason: RelatedError }> {
  let res: Response;
  try {
    res = await postJson(
      doFetch,
      origin,
      "related",
      query,
      { authorization: `Bearer ${token}` },
      RELATED_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    if (isObject(data) && Array.isArray(data["items"]) && data["items"].every(isRelatedHit)) {
      return { ok: true, items: data["items"] as RelatedHit[] };
    }
    return { ok: false, reason: "server_error" };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: false, reason: "server_error" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/gateway-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/gateway-client.ts test/unit/gateway-client.test.ts
git commit -m "feat(gateway-client): postRelated with Bearer + timeout + status mapping"
```

---

## Task 4: handleRelated handler

**Files:**
- Modify: `src/background/handlers.ts`
- Test: `test/unit/handlers.test.ts` (extend)

**Interfaces:**
- Consumes: `buildRelatedQuery`/`RelatedQuery` (`../shared/related.ts`); `RelatedRequest`/`RelatedResponse` (`../shared/messages.ts`); `Connection`/`RelatedError`/`RelatedHit` (`../shared/types.ts`).
- Produces:
  - `interface RelatedDeps { getConnection: () => Promise<Connection | null>; postRelated: (origin, token, query: RelatedQuery) => Promise<{ ok:true; items: RelatedHit[] } | { ok:false; reason: RelatedError }> }`
  - `handleRelated(deps: RelatedDeps, req: RelatedRequest): Promise<RelatedResponse>`

- [ ] **Step 1: Write the failing test (append)**

```typescript
// append to test/unit/handlers.test.ts
import { handleRelated } from "../../src/background/handlers.ts";

describe("handleRelated", () => {
  const conn: Connection = { origin: "http://127.0.0.1:8765", token: "tok", label: "chrome", pairedAt: 1 };
  const hit = { id: "1", title: "Doc", service: "drive", snippet: "…", url: null };

  test("not paired → not_paired without posting", async () => {
    let called = false;
    const res = await handleRelated(
      {
        getConnection: async () => null,
        postRelated: async () => {
          called = true;
          return { ok: true, items: [] };
        },
      },
      { kind: "related", title: "T" },
    );
    expect(res).toEqual({ kind: "related", ok: false, reason: "not_paired" });
    expect(called).toBe(false);
  });
  test("paired → builds the query, posts to the connection origin, returns items", async () => {
    let postedTo = "";
    let postedQuery: unknown;
    const res = await handleRelated(
      {
        getConnection: async () => conn,
        postRelated: async (origin, _token, query) => {
          postedTo = origin;
          postedQuery = query;
          return { ok: true, items: [hit] };
        },
      },
      { kind: "related", title: "  Hello  ", canonicalUrl: "https://ex.com/p", selection: "" },
    );
    expect(postedTo).toBe("http://127.0.0.1:8765");
    expect(postedQuery).toEqual({ title: "Hello", canonicalUrl: "https://ex.com/p", limit: 10 });
    expect(res).toEqual({ kind: "related", ok: true, items: [hit] });
  });
  test("propagates unauthorized", async () => {
    const res = await handleRelated(
      { getConnection: async () => conn, postRelated: async () => ({ ok: false, reason: "unauthorized" }) },
      { kind: "related", title: "T" },
    );
    expect(res).toEqual({ kind: "related", ok: false, reason: "unauthorized" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/handlers.test.ts`
Expected: FAIL — `handleRelated` not exported.

- [ ] **Step 3: Write the implementation**

In `src/background/handlers.ts`, extend the imports:

```typescript
import { buildClipPayload } from "../shared/clip.ts";
import { type RelatedQuery, buildRelatedQuery } from "../shared/related.ts";
import { isLoopbackOrigin } from "../shared/gateway.ts";
import type {
  ClipRequest,
  ClipResponse,
  PairRequest,
  PairResponse,
  RelatedRequest,
  RelatedResponse,
} from "../shared/messages.ts";
import type { ClipError, Connection, PairError, RelatedError, RelatedHit } from "../shared/types.ts";
```

(merge with the existing imports — add `RelatedQuery`/`buildRelatedQuery`, `RelatedRequest`/`RelatedResponse`, and `RelatedError`/`RelatedHit`.)

Append at the end of the file:

```typescript
export interface RelatedDeps {
  readonly getConnection: () => Promise<Connection | null>;
  readonly postRelated: (
    origin: string,
    token: string,
    query: RelatedQuery,
  ) => Promise<{ ok: true; items: RelatedHit[] } | { ok: false; reason: RelatedError }>;
}

export async function handleRelated(
  deps: RelatedDeps,
  req: RelatedRequest,
): Promise<RelatedResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "related", ok: false, reason: "not_paired" };
  }
  const r = await deps.postRelated(conn.origin, conn.token, buildRelatedQuery(req));
  if (!r.ok) {
    return { kind: "related", ok: false, reason: r.reason };
  }
  return { kind: "related", ok: true, items: r.items };
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
git commit -m "feat(background): handleRelated — getConnection → buildRelatedQuery → postRelated"
```

---

## Task 5: Panel-view pure DOM builders

**Files:**
- Create: `src/panel/panel-view.ts`
- Test: `test/unit/panel-view.test.ts` (jsdom)

**Interfaces:**
- Consumes: `RelatedHit` (`../shared/types.ts`).
- Produces:
  - `renderHit(doc: Document, hit: RelatedHit): HTMLElement`
  - `renderHits(doc: Document, items: RelatedHit[]): HTMLElement`
  - `renderError(doc: Document, message: string): HTMLElement`

- [ ] **Step 1: Write the failing test**

```typescript
// @vitest-environment jsdom
// test/unit/panel-view.test.ts
import { describe, expect, test } from "vitest";
import { renderError, renderHit, renderHits } from "../../src/panel/panel-view.ts";
import type { RelatedHit } from "../../src/shared/types.ts";

const base: RelatedHit = { id: "1", title: "Doc", service: "drive", snippet: "a snippet", url: "https://ex.com/d" };

describe("renderHit", () => {
  test("a url hit renders an anchor with safe target/rel and the title as text", () => {
    const el = renderHit(document, base);
    const a = el.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("https://ex.com/d");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a?.textContent).toBe("Doc");
  });
  test("a url:null hit renders the title as plain text (no anchor)", () => {
    const el = renderHit(document, { ...base, url: null });
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Doc");
  });
  test("XSS backstop — markup in title/snippet is inert text, not parsed nodes", () => {
    const el = renderHit(document, {
      ...base,
      url: null,
      title: "<img src=x onerror=alert(1)>",
      snippet: "<script>alert(2)</script>",
    });
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(el.textContent).toContain("<script>alert(2)</script>");
  });
});

describe("renderHits", () => {
  test("empty list → the empty-state message", () => {
    expect(renderHits(document, []).textContent).toBe("No related items found.");
  });
  test("renders one node per hit", () => {
    const list = renderHits(document, [base, { ...base, id: "2" }]);
    expect(list.querySelectorAll(".nimbus-related__item").length).toBe(2);
  });
});

describe("renderError", () => {
  test("renders the message as text", () => {
    expect(renderError(document, "Boom").textContent).toBe("Boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/panel-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/panel/panel-view.ts
// Pure DOM builders for the related-items panel. Every gateway-provided string is
// written via textContent (never innerHTML) — the indexed content is
// attacker-influenceable, so plain-text rendering is the XSS backstop.
import type { RelatedHit } from "../shared/types.ts";

export function renderError(doc: Document, message: string): HTMLElement {
  const p = doc.createElement("p");
  p.className = "nimbus-related__status";
  p.textContent = message;
  return p;
}

export function renderHit(doc: Document, hit: RelatedHit): HTMLElement {
  const item = doc.createElement("li");
  item.className = "nimbus-related__item";

  let title: HTMLElement;
  if (hit.url !== null) {
    const link = doc.createElement("a");
    link.href = hit.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = hit.title;
    title = link;
  } else {
    const span = doc.createElement("span");
    span.textContent = hit.title;
    title = span;
  }
  title.classList.add("nimbus-related__title");

  const badge = doc.createElement("span");
  badge.className = "nimbus-related__badge";
  badge.textContent = hit.service;

  const snippet = doc.createElement("p");
  snippet.className = "nimbus-related__snippet";
  snippet.textContent = hit.snippet;

  item.append(title, badge, snippet);
  return item;
}

export function renderHits(doc: Document, items: RelatedHit[]): HTMLElement {
  if (items.length === 0) {
    return renderError(doc, "No related items found.");
  }
  const list = doc.createElement("ul");
  list.className = "nimbus-related__list";
  for (const hit of items) {
    list.append(renderHit(doc, hit));
  }
  return list;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/panel-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/panel/panel-view.ts test/unit/panel-view.test.ts
git commit -m "feat(panel): pure textContent-only DOM builders (XSS backstop) + jsdom tests"
```

---

## Task 6: Browser seam (injectPanel + command listener) + manifest commands

**Files:**
- Modify: `src/browser/scripting.ts`, `src/browser/runtime.ts`, `src/manifest/manifest.ts`
- Modify: `test/unit/chrome-stub.ts` (record `executeScript` calls)
- Test: `test/unit/browser-seam.test.ts` (extend), `test/unit/manifest.test.ts` (extend)

**Interfaces:**
- Produces:
  - `injectPanel(tabId: number): Promise<void>` (`browser/scripting.ts`)
  - `addCommandListener(fn: (command: string) => void): void` (`browser/runtime.ts`)
  - `composeManifest(...).commands.show_related` with `suggested_key.default` + `description`.

- [ ] **Step 1: Write the failing tests**

First extend the shared stub to record injections. In `test/unit/chrome-stub.ts`, change the `scripting` block and the return value:

```typescript
// in installChromeStub: declare a recorder above `const fake = {`
const executeCalls: unknown[] = [];
```

Change the `scripting` property to record its argument:

```typescript
    scripting: {
      executeScript: async (injection: unknown) => {
        executeCalls.push(injection);
        return opts.executeResults ?? [{ result: undefined }];
      },
    },
```

Change the return statement:

```typescript
  return { storage, executeCalls };
```

Then append the seam test:

```typescript
// append to test/unit/browser-seam.test.ts
import { injectPanel } from "../../src/browser/scripting.ts";

describe("injectPanel", () => {
  test("injects panel.js into the target tab", async () => {
    const { executeCalls } = installChromeStub();
    await injectPanel(7);
    expect(executeCalls).toEqual([{ target: { tabId: 7 }, files: ["panel.js"] }]);
  });
});
```

And the manifest test:

```typescript
// append to test/unit/manifest.test.ts
import { composeManifest } from "../../src/manifest/manifest.ts";

describe("composeManifest — commands", () => {
  for (const target of ["chrome", "firefox"] as const) {
    test(`${target} declares the show_related command with a suggested key`, () => {
      const m = composeManifest(target, "1.2.3");
      expect(m.commands.show_related.suggested_key.default).toBe("Alt+Shift+R");
      expect(m.commands.show_related.description.length).toBeGreaterThan(0);
    });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/browser-seam.test.ts test/unit/manifest.test.ts`
Expected: FAIL — `injectPanel` not exported; `commands` not on the manifest.

- [ ] **Step 3: Write the implementations**

Append to `src/browser/scripting.ts`:

```typescript
/** Inject the bundled panel.js into a tab. The script self-toggles on re-injection. */
export async function injectPanel(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["panel.js"] });
}
```

Append to `src/browser/runtime.ts`:

```typescript
export function addCommandListener(fn: (command: string) => void): void {
  chrome.commands.onCommand.addListener(fn);
}
```

In `src/manifest/manifest.ts`, add the commands interface after `interface ManifestAction { … }`:

```typescript
interface ManifestCommands {
  readonly show_related: {
    readonly suggested_key: { readonly default: string };
    readonly description: string;
  };
}
```

Add the field to `WebClipperManifest` (after `action`):

```typescript
  readonly commands: ManifestCommands;
```

Add the entry to the `base` object in `composeManifest` (after the `action: { … },` block):

```typescript
    // A separate trigger from the toolbar action (which opens the clip popup): this
    // hotkey injects the related-items panel. Users can rebind it at the browser's
    // extension-shortcuts page. Alt+Shift+R is chosen to avoid Chrome/Firefox defaults.
    commands: {
      show_related: {
        suggested_key: { default: "Alt+Shift+R" },
        description: "Show related items in Nimbus",
      },
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/browser-seam.test.ts test/unit/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + full test (stub change touches all seam tests)**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS (the `chrome-stub` change is additive — existing tests destructure `{ storage }` only).

- [ ] **Step 6: Commit**

```bash
git add src/browser/scripting.ts src/browser/runtime.ts src/manifest/manifest.ts test/unit/chrome-stub.ts test/unit/browser-seam.test.ts test/unit/manifest.test.ts
git commit -m "feat(seam): injectPanel + command listener + manifest show_related command"
```

---

## Task 7: Panel-in-page entry + build wiring

**Files:**
- Create: `src/panel/panel-in-page.ts`
- Modify: `esbuild.mjs` (add the `panel` entry)
- Modify: `scripts/check-build.mjs` (require `panel.js`)

**Interfaces:**
- Consumes: `sendMessage` (`../browser/runtime.ts`); `isRelatedResponse` (`../shared/messages.ts`); `renderError`/`renderHits` (`./panel-view.ts`).
- Produces: a side-effecting bundle `dist/<target>/panel.js` that self-toggles a Shadow-DOM panel.

> `panel-in-page.ts` runs in the page DOM (Shadow DOM, `document` listeners, `chrome.runtime`) and is verified by the manual dev-load checklist (Task 9), not a unit test. Its pure dependencies (`panel-view`, `buildRelatedQuery`, the guards) are already unit-tested.

- [ ] **Step 1: Write `panel-in-page.ts`**

```typescript
// src/panel/panel-in-page.ts
// Injected as dist/<target>/panel.js. Self-toggling: re-injection closes an open
// panel. Mounts a Shadow-DOM overlay (inlined styles — no web_accessible_resources),
// reads the page context, asks the SW for related items, and renders them.
import { sendMessage } from "../browser/runtime.ts";
import { isRelatedResponse } from "../shared/messages.ts";
import { renderError, renderHits } from "./panel-view.ts";

const HOST_ID = "nimbus-related-host";

const RELATED_MESSAGES: Record<string, string> = {
  not_paired: "Pair a browser first (Options).",
  unauthorized: "Pairing expired — re-pair in Options.",
  unreachable: "Can't reach Nimbus — is the gateway running?",
  server_error: "Nimbus had an error fetching related items.",
};

// Inlined so the panel is fully self-contained. `:host { all: initial }` drops
// inherited page styles; only our own --nimbus-* tokens are referenced, with a
// dark set behind prefers-color-scheme (custom props survive `all: initial`).
const STYLES = `
:host {
  all: initial;
  --nimbus-bg: #ffffff;
  --nimbus-fg: #1a1a1a;
  --nimbus-muted: #666666;
  --nimbus-border: rgba(0, 0, 0, 0.12);
  --nimbus-accent: #2d6cdf;
}
@media (prefers-color-scheme: dark) {
  :host {
    --nimbus-bg: #1e1e1e;
    --nimbus-fg: #eaeaea;
    --nimbus-muted: #a0a0a0;
    --nimbus-border: rgba(255, 255, 255, 0.16);
    --nimbus-accent: #6ea8ff;
  }
}
.nimbus-related {
  position: fixed;
  top: 0;
  right: 0;
  width: 340px;
  height: 100vh;
  box-sizing: border-box;
  background: var(--nimbus-bg);
  color: var(--nimbus-fg);
  font-family: system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.4;
  border-left: 1px solid var(--nimbus-border);
  box-shadow: -2px 0 12px rgba(0, 0, 0, 0.18);
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
}
.nimbus-related__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--nimbus-border);
}
.nimbus-related__heading { margin: 0; font-size: 14px; font-weight: 600; }
.nimbus-related__close {
  all: unset;
  cursor: pointer;
  padding: 2px 8px;
  font-size: 16px;
  color: var(--nimbus-muted);
}
.nimbus-related__body { overflow-y: auto; padding: 8px 0; }
.nimbus-related__list { list-style: none; margin: 0; padding: 0; }
.nimbus-related__item { padding: 10px 16px; border-bottom: 1px solid var(--nimbus-border); }
.nimbus-related__title { display: block; font-weight: 600; color: var(--nimbus-accent); text-decoration: none; }
.nimbus-related__badge {
  display: inline-block;
  margin: 4px 0;
  padding: 1px 6px;
  font-size: 11px;
  border-radius: 4px;
  background: var(--nimbus-border);
  color: var(--nimbus-muted);
}
.nimbus-related__snippet { margin: 4px 0 0; color: var(--nimbus-muted); }
.nimbus-related__status { padding: 16px; color: var(--nimbus-muted); }
`;

interface NimbusHost extends HTMLElement {
  __nimbusClose?: () => void;
}

function readContext(): { title: string; canonicalUrl?: string; selection: string } {
  const canonical =
    document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? undefined;
  const selection = window.getSelection()?.toString() ?? "";
  return {
    title: document.title,
    ...(canonical !== undefined && canonical !== "" ? { canonicalUrl: canonical } : {}),
    selection,
  };
}

async function query(body: HTMLElement): Promise<void> {
  const res = await sendMessage({ kind: "related", ...readContext() });
  body.replaceChildren();
  if (!isRelatedResponse(res)) {
    body.append(renderError(document, "Unexpected response."));
    return;
  }
  if (res.ok) {
    body.append(renderHits(document, res.items));
  } else {
    body.append(renderError(document, RELATED_MESSAGES[res.reason] ?? "Couldn't fetch related items."));
  }
}

function mount(): void {
  const host = document.createElement("div") as NimbusHost;
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;

  const panel = document.createElement("section");
  panel.className = "nimbus-related";
  // A non-modal landmark, NOT role="dialog": the user reads the page alongside the
  // panel, so focus is intentionally not trapped (a trap would fight that).
  panel.setAttribute("role", "complementary");
  panel.setAttribute("aria-label", "Related items in Nimbus");

  const header = document.createElement("header");
  header.className = "nimbus-related__header";
  const heading = document.createElement("h1");
  heading.className = "nimbus-related__heading";
  heading.textContent = "Related in Nimbus";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "nimbus-related__close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Close");
  header.append(heading, close);

  const body = document.createElement("div");
  body.className = "nimbus-related__body";
  body.append(renderError(document, "Loading…"));

  panel.append(header, body);
  root.append(style, panel);
  document.documentElement.append(host);

  // One AbortController detaches every listener on teardown — no orphans on toggle.
  const controller = new AbortController();
  const { signal } = controller;
  const teardown = (): void => {
    controller.abort();
    host.remove();
  };
  host.__nimbusClose = teardown;
  close.addEventListener("click", teardown, { signal });
  // Capture phase + stopPropagation so host apps (Docs/Jira/GitHub) don't also act on Esc.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        teardown();
      }
    },
    { signal, capture: true },
  );

  // Land keyboard/screen-reader users inside the panel (focus only — no trap).
  close.focus();
  void query(body);
}

// Self-toggle entry: an existing panel closes via its own teardown (aborting its
// listeners); otherwise mount a fresh one.
const existing = document.getElementById(HOST_ID) as NimbusHost | null;
if (existing !== null) {
  if (existing.__nimbusClose !== undefined) {
    existing.__nimbusClose();
  } else {
    existing.remove();
  }
} else {
  mount();
}
```

- [ ] **Step 2: Add the esbuild entry**

In `esbuild.mjs`, add `panel` to `ENTRIES`:

```javascript
const ENTRIES = [
  { in: "src/background/service-worker.ts", out: "background" },
  { in: "src/popup/popup.ts", out: "popup" },
  { in: "src/options/options.ts", out: "options" },
  { in: "src/capture/capture-in-page.ts", out: "capture" },
  { in: "src/panel/panel-in-page.ts", out: "panel" },
];
```

- [ ] **Step 3: Require `panel.js` in the build check**

In `scripts/check-build.mjs`, add `"panel.js"` to `REQUIRED_FILES` (after `"capture.js"`):

```javascript
  "capture.js",
  "panel.js",
```

- [ ] **Step 4: Build, check, typecheck, lint, test**

Run: `bun run build && bun run check-build && bun run typecheck && bun run lint && bun run test`
Expected: PASS — `dist/chrome/panel.js` and `dist/firefox/panel.js` exist; check-build OK; no test regressions.

- [ ] **Step 5: Commit**

```bash
git add src/panel/panel-in-page.ts esbuild.mjs scripts/check-build.mjs
git commit -m "feat(panel): bundled panel.js (Shadow-DOM sidecar, self-toggle) + build wiring"
```

---

## Task 8: Wire the triggers (SW routing + command + popup button)

**Files:**
- Modify: `src/background/service-worker.ts`
- Modify: `src/popup/popup.html`, `src/popup/popup.ts`

**Interfaces:**
- Consumes: `handleRelated` (`./handlers.ts`); `postRelated` (`./gateway-client.ts`); `getConnection` (`./connection-store.ts`); `isRelatedRequest` (`../shared/messages.ts`); `addCommandListener` (`../browser/runtime.ts`); `activeTab` (`../browser/tabs.ts`); `injectPanel` (`../browser/scripting.ts`).

> The SW routing/command glue and the popup DOM wiring are verified by the manual dev-load checklist (Task 9), not unit tests — consistent with Slice 1.

- [ ] **Step 1: Route related + handle the command in the service worker**

Replace the contents of `src/background/service-worker.ts` with:

```typescript
// MV3 background service worker / Firefox event page. Owns the bearer token and all
// gateway I/O; the popup, options page, and injected panel reach it via messages.
import { injectPanel } from "../browser/scripting.ts";
import { addCommandListener, addMessageListener } from "../browser/runtime.ts";
import { activeTab } from "../browser/tabs.ts";
import { isClipRequest, isPairRequest, isRelatedRequest } from "../shared/messages.ts";
import { getConnection, setConnection } from "./connection-store.ts";
import { confirmPair, postClip, postRelated } from "./gateway-client.ts";
import { handleClip, handlePair, handleRelated } from "./handlers.ts";

addMessageListener((message, respond) => {
  if (isPairRequest(message)) {
    handlePair({ confirmPair, setConnection, nowMs: () => Date.now() }, message)
      .then(respond)
      .catch(() => {
        respond({ kind: "pair", ok: false, reason: "server_error" });
      });
    return true;
  }
  if (isClipRequest(message)) {
    handleClip({ getConnection, postClip, nowMs: () => Date.now() }, message)
      .then(respond)
      .catch(() => {
        respond({ kind: "clip", ok: false, reason: "server_error" });
      });
    return true;
  }
  if (isRelatedRequest(message)) {
    handleRelated({ getConnection, postRelated }, message)
      .then(respond)
      .catch(() => {
        respond({ kind: "related", ok: false, reason: "server_error" });
      });
    return true;
  }
  return false;
});

// The hotkey injects the panel into the active tab. activeTab is granted on the
// command gesture. A restricted page (chrome://, store) rejects injection — there
// is no page surface to report on, so fail closed silently.
addCommandListener((command) => {
  if (command === "show_related") {
    activeTab()
      .then((tab) => injectPanel(tab.id))
      .catch(() => undefined);
  }
});
```

- [ ] **Step 2: Add the "Show related" button to the popup HTML**

In `src/popup/popup.html`, add a button after the `popup__actions` div (before the status `<p>`):

```html
      <div class="popup__actions">
        <button id="clip-page" type="button">Clip page</button>
        <button id="clip-selection" type="button">Clip selection</button>
      </div>
      <button id="show-related" type="button" class="popup__related">Show related</button>
      <p id="status" class="popup__status" role="status"></p>
```

- [ ] **Step 3: Style the new button**

Append to `src/popup/popup.css`:

```css
.popup__related { width: 100%; margin-top: 8px; padding: 8px; cursor: pointer; }
```

- [ ] **Step 4: Wire the button in the popup script**

In `src/popup/popup.ts`, add the import for `injectPanel` (merge with the existing `../browser/scripting.ts` import):

```typescript
import { injectPanel, runCapture } from "../browser/scripting.ts";
```

`activeTab` (from `../browser/tabs.ts`) and `setStatus` are **already** imported/defined in this file (used by the existing `clip()` flow) — `showRelated` reuses them, no new import for those.

Add a handler function before the `DOMContentLoaded` listener:

```typescript
async function showRelated(): Promise<void> {
  try {
    const tab = await activeTab();
    await injectPanel(tab.id);
    window.close();
  } catch {
    setStatus("Nimbus can't show related on browser system pages.");
  }
}
```

Add the listener inside the existing `DOMContentLoaded` callback:

```typescript
  document.getElementById("show-related")?.addEventListener("click", () => void showRelated());
```

- [ ] **Step 5: Build, check, typecheck, lint, test**

Run: `bun run build && bun run check-build && bun run typecheck && bun run lint && bun run test`
Expected: PASS — all green; bundles include the new wiring.

- [ ] **Step 6: Commit**

```bash
git add src/background/service-worker.ts src/popup/popup.html src/popup/popup.css src/popup/popup.ts
git commit -m "feat(panel): wire show-related triggers (SW route + command + popup button)"
```

---

## Task 9: Manual checklist + changelog + full gate

**Files:**
- Modify: `docs/development.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the Slice-2 manual checklist**

Append to `docs/development.md` (before the `## Security check` section):

```markdown
## Manual verification — Slice 2 (related panel)

Prereq: paired (Slice 1) and the gateway has some indexed items.

1. **Open from popup:** on an article, popup → **Show related** → the right-edge
   panel mounts and lists related items (title · service badge · snippet).
2. **Open from hotkey:** press `Alt+Shift+R` → the same panel opens. Re-press →
   it closes (toggle). Press again → opens; **Esc** closes it; the X button closes it.
3. **Esc isolation:** on an app that uses Esc (e.g. GitHub command palette), opening
   the panel and pressing Esc closes only the panel.
4. **Selection query:** select text → open the panel → results reflect the selection.
5. **Links:** a hit with a URL opens in a new tab; a URL-less hit is plain text.
6. **States:** with the gateway stopped → "Can't reach Nimbus…"; while unpaired →
   "Pair a browser first (Options)."; no matches → "No related items found."
7. **Restricted page:** on `chrome://extensions`, the popup **Show related** shows
   "Nimbus can't show related on browser system pages."; the hotkey does nothing.
8. **Dark mode:** with the OS in dark mode, the panel renders dark.
9. Repeat 1–6 in Firefox.
```

- [ ] **Step 2: Add the changelog entry**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, append:

```markdown
- **Slice 2 — related-items sidecar.** An on-demand Shadow-DOM panel (opened from a
  "Show related" popup button or the `Alt+Shift+R` hotkey) that queries
  `POST /v1/clips/related` and lists related indexed items for the current page
  (title, service badge, snippet, link). Query-once-on-open; toggle / X / Esc to
  close. Renders via `textContent` only (DOM-XSS backstop); honors
  `prefers-color-scheme`. No new permissions.
```

- [ ] **Step 3: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/development.md CHANGELOG.md
git commit -m "docs: Slice 2 manual checklist + changelog entry"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin spec/related-panel
gh pr create --base main --fill
```

Verify CI (build-test, CodeQL, Sonar) goes green on the PR before merge.

---

## Plan review resolutions (2026-06-23)

From [the Slice 2 plan review](./2026-06-23-web-clipper-extension-slice2-review.md):

1. **`activeTab` import in `popup.ts` (verified non-issue; clarified).** `popup.ts`
   already imports `activeTab` from `../browser/tabs.ts` for the existing `clip()`
   flow; `showRelated` reuses it. Task 8 now states this explicitly so the only
   new import is `injectPanel`.
2. **Focus management (fixed; full trap rejected).** Task 7 now focuses the close
   button on mount and marks the panel `role="complementary"` with an `aria-label`.
   A full focus **trap** is rejected: this is a non-modal sidecar the user reads
   alongside the page (no click-outside dismiss), so trapping focus would be a
   regression, not an improvement.
3. **Hotkey silent-failure feedback (deferred / rejected — already decided).** Same
   item the spec design-review resolved: `console.warn` is rejected (Biome
   `noConsole` bans `console.*` in `src/`); a temporary action-badge is deferred as
   YAGNI; a warning sound is rejected as intrusive. The popup-button path already
   shows a clear message; the hotkey path fails closed silently by design.
4. **Abort/timeout test for `postRelated` (fixed).** Task 3 adds a fake-timers test
   that wires the injected `fetch` to the abort signal, advances past
   `RELATED_TIMEOUT_MS` (8s), and asserts the result is `unreachable` — matching the
   abort coverage Slice 1 added to `gateway-client` in review.

## Self-Review Notes (author)

- **Spec coverage:** trigger button + hotkey (T6 manifest command, T8 SW command + popup button); injected Shadow-DOM panel with self-toggle + AbortController teardown + capture-phase Esc (T7); query once on open with title+canonicalUrl+selection (T1 `buildRelatedQuery`, T7 `readContext`, T4 `handleRelated`); `postRelated` to the locked path (T3); `RelatedHit` rendering with `textContent`-only + url:null-as-text + new-tab links (T5); inlined styles + `prefers-color-scheme` (T7); error vocabulary (T3 status mapping + T7 `RELATED_MESSAGES`); restricted-page handling both paths (T8); token-in-SW posture (T4 — token never returned, only items). Design-review resolutions: textContent XSS backstop (T5 + jsdom test), inlined `<style>` (T7), Esc capture/stopPropagation (T7), AbortController teardown (T7), dark mode (T7); deferred badge feedback not implemented (per spec).
- **Type consistency:** `RelatedHit`/`RelatedError` defined once in `types.ts` (T1); `RelatedQuery`/`buildRelatedQuery` in `related.ts` (T1) consumed by `postRelated` (T3) and `handleRelated` (T4); `RelatedRequest`/`RelatedResponse` + guards in `messages.ts` (T2) consumed by the SW (T8) and panel (T7); `injectPanel`/`addCommandListener` (T6) consumed by SW + popup (T8).
- **No new permissions / loopback only:** T6 adds only `commands`; injection rides existing `activeTab`+`scripting`; `postRelated` reuses the stored `Connection` origin.
- **Intentional non-unit-tested surfaces:** `panel-in-page.ts`, the popup DOM wiring, and the SW routing/command glue — each covered by the Task 9 manual checklist; their pure dependencies are unit-tested.
