# Web Clipper Extension — Slice 1 (Pairing + Capture + Clip) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the end-to-end "save pages to Nimbus" core of the MV3 extension — pair a browser with the gateway, capture the readable article or selection, and POST it to `/v1/clips`.

**Architecture:** The background service worker owns the bearer token and all gateway I/O; the popup and options page message it. Page capture runs in the active tab via on-demand injection of a bundled `capture.js` (Mozilla Readability inlined). All `chrome.*` access is confined to a thin `src/browser/` seam, so the rest of the code is unit-tested against pure functions and fakes. Pure logic (tag parsing, payload building, origin validation, status→reason mapping, message guards, pair/clip orchestration) is fully unit-tested; the DOM/injection/UI pieces are dev-loaded and verified by a manual checklist.

**Tech Stack:** TypeScript 6 strict, esbuild (run via `bun`), Vitest, Biome, `@mozilla/readability` (build-time, bundled). No runtime npm dependencies — esbuild inlines everything.

**Spec:** `docs/superpowers/specs/2026-06-23-web-clipper-extension-design.md` (and its design-review addendum). The as-shipped HTTP contract is locked by Nimbus PR #718.

## Global Constraints

- **TypeScript strict; no `any`.** Use `unknown` for cross-boundary data (messages, gateway responses, injected-capture results) and narrow with a type guard. Biome enforces `noExplicitAny`, `noNonNullAssertion`, `useConst`.
- **No `console.*` in `src/`** (Biome `noConsole`); the extension ships to users. Tests and `scripts/` may log.
- **Never log or DOM-expose the bearer token or the pairing code.** The token lives only in `chrome.storage.local` and the service worker, and leaves solely as the `Authorization: Bearer` header on a loopback request.
- **Loopback only.** `host_permissions` stays `http://127.0.0.1/*` + `http://localhost/*`. Validate the user-entered origin with the `URL` constructor: `protocol === "http:"` and `hostname` ∈ {`localhost`, `[::1]`, `127.0.0.0/8`}.
- **No runtime dependencies.** Every dependency (incl. `@mozilla/readability`) is `devDependencies`, inlined by esbuild. The shipped extension has no `node_modules`.
- **`exactOptionalPropertyTypes` is on** — build optional fields (`canonicalUrl`) by conditional spread, never by assigning `undefined`.
- **Each task ends green:** `bun run typecheck && bun run lint && bun run test` must pass before its commit. Run `bun run build && bun run check-build` on tasks that touch the build (Task 9+).
- **Run via `bun`.** Tests: `bunx vitest run <file>`. Lint: `bun run lint`. Typecheck: `bun run typecheck`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` (new) | Cross-module data types: `CaptureResult`, `Connection`, `PairError`, `ClipError`. |
| `src/shared/clip.ts` (new) | `ClipPayload` + pure `parseTags`, `buildClipPayload`. |
| `src/capture/fallback.ts` (new) | Pure `fallbackBody(meta)`. |
| `src/shared/messages.ts` (modify) | Add `PairRequest`/`ClipRequest`/`PairResponse`/`ClipResponse` unions + guards (additive; keep `ping`). |
| `src/shared/gateway.ts` (modify) | Add pure `isLoopbackOrigin`; (Task 10) remove the placeholder `DEFAULT_GATEWAY_ORIGIN`. |
| `src/background/gateway-client.ts` (new) | `confirmPair`/`postClip` — `fetch` (injectable) + timeout + status→reason mapping. |
| `src/browser/storage.ts` (new) | `storageGet/Set/Remove` — `chrome.storage.local` wrapper. |
| `src/browser/tabs.ts` (new) | `activeTab()` — `chrome.tabs.query` wrapper. |
| `src/browser/scripting.ts` (new) | `runCapture(tabId, mode)` — inject `capture.js`, invoke `__nimbusCapture`, read result. |
| `src/browser/runtime.ts` (new) | Typed `sendMessage`/`addMessageListener`. |
| `src/background/connection-store.ts` (new) | Typed `getConnection/setConnection/clearConnection` over `browser/storage` + `isConnection` guard. |
| `src/background/handlers.ts` (new) | Pure `handlePair`/`handleClip` (injected deps). |
| `src/background/service-worker.ts` (modify) | Entry: build deps, route `onMessage` to the handlers. |
| `src/capture/capture-in-page.ts` (new) | Injected (standalone `capture.js` entry): Readability/selection → `CaptureResult`; sets `globalThis.__nimbusCapture`. |
| `src/popup/popup.{html,ts,css}` (modify) | Clip page / Clip selection / tags / status — orchestrates capture + clip message. |
| `src/options/options.{html,ts,css}` (modify) | Gateway URL + code → pair; show paired label. |
| `esbuild.mjs` (modify) | Add the `capture` entry. |
| `scripts/check-build.mjs` (modify) | Require `capture.js` per target. |
| `package.json` (modify) | Add `@mozilla/readability` to `devDependencies`. |
| `docs/development.md` (new) | Dev-load steps + manual verification checklist. |

---

## Task 1: Pure clip types + payload building

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/clip.ts`
- Test: `test/unit/clip.test.ts`

**Interfaces:**
- Produces:
  - `interface CaptureResult { url: string; canonicalUrl?: string; title: string; mode: "article"|"selection"; body: string; readableFound: boolean }`
  - `interface Connection { origin: string; token: string; label: string; pairedAt: number }`
  - `type PairError = "pairing_failed"|"bad_origin"|"unreachable"|"server_error"`
  - `type ClipError = "not_paired"|"unauthorized"|"invalid_request"|"unreachable"|"server_error"`
  - `interface ClipPayload { url: string; canonicalUrl?: string; title: string; mode: "article"|"selection"; body: string; tags: readonly string[]; capturedAt: number }`
  - `parseTags(input: string): string[]`
  - `buildClipPayload(c: CaptureResult, tags: string[], nowMs: number): ClipPayload`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/clip.test.ts
import { describe, expect, test } from "vitest";
import { buildClipPayload, parseTags } from "../../src/shared/clip.ts";
import type { CaptureResult } from "../../src/shared/types.ts";

describe("parseTags", () => {
  test("splits on commas, trims, drops empties, dedupes case-sensitively", () => {
    expect(parseTags("AI, machine learning ,AI, ")).toEqual(["AI", "machine learning"]);
  });
  test("keeps multi-word tags and preserves inner spaces", () => {
    expect(parseTags("vector index")).toEqual(["vector index"]);
  });
  test("case-sensitive: AI and ai are distinct", () => {
    expect(parseTags("AI, ai")).toEqual(["AI", "ai"]);
  });
  test("empty input → []", () => {
    expect(parseTags("   ")).toEqual([]);
  });
});

describe("buildClipPayload", () => {
  const cap: CaptureResult = {
    url: "https://ex.com/p",
    title: "Hello",
    mode: "article",
    body: "the body",
    readableFound: true,
  };
  test("maps capture + tags + capturedAt into the gateway request shape", () => {
    expect(buildClipPayload(cap, ["research"], 1750000000000)).toEqual({
      url: "https://ex.com/p",
      title: "Hello",
      mode: "article",
      body: "the body",
      tags: ["research"],
      capturedAt: 1750000000000,
    });
  });
  test("includes canonicalUrl only when present (exactOptionalPropertyTypes)", () => {
    const out = buildClipPayload({ ...cap, canonicalUrl: "https://ex.com/p?x" }, [], 1);
    expect(out.canonicalUrl).toBe("https://ex.com/p?x");
    expect("canonicalUrl" in buildClipPayload(cap, [], 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/clip.test.ts`
Expected: FAIL — modules `../../src/shared/clip.ts` / `types.ts` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/shared/types.ts
export interface CaptureResult {
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title: string;
  readonly mode: "article" | "selection";
  readonly body: string;
  readonly readableFound: boolean;
}

export interface Connection {
  readonly origin: string;
  readonly token: string;
  readonly label: string;
  readonly pairedAt: number;
}

export type PairError = "pairing_failed" | "bad_origin" | "unreachable" | "server_error";
export type ClipError =
  | "not_paired"
  | "unauthorized"
  | "invalid_request"
  | "unreachable"
  | "server_error";
```

```typescript
// src/shared/clip.ts
import type { CaptureResult } from "./types.ts";

export interface ClipPayload {
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title: string;
  readonly mode: "article" | "selection";
  readonly body: string;
  readonly tags: readonly string[];
  readonly capturedAt: number;
}

/** Comma-split, trim, drop empties, dedupe (case-sensitive, multi-word kept). */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const tag = raw.trim();
    if (tag !== "" && !out.includes(tag)) {
      out.push(tag);
    }
  }
  return out;
}

export function buildClipPayload(c: CaptureResult, tags: string[], nowMs: number): ClipPayload {
  return {
    url: c.url,
    ...(c.canonicalUrl !== undefined ? { canonicalUrl: c.canonicalUrl } : {}),
    title: c.title,
    mode: c.mode,
    body: c.body,
    tags,
    capturedAt: nowMs,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/clip.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/clip.ts test/unit/clip.test.ts
git commit -m "feat(clip): pure tag parsing + clip-payload builder"
```

---

## Task 2: Readability fallback body

**Files:**
- Create: `src/capture/fallback.ts`
- Test: `test/unit/fallback.test.ts`

**Interfaces:**
- Produces: `fallbackBody(meta: { description?: string; url: string }): string`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/fallback.test.ts
import { describe, expect, test } from "vitest";
import { fallbackBody } from "../../src/capture/fallback.ts";

describe("fallbackBody", () => {
  test("uses the description when present", () => {
    expect(fallbackBody({ description: "A summary", url: "https://ex.com" })).toBe("A summary");
  });
  test("falls back to the url when description is absent", () => {
    expect(fallbackBody({ url: "https://ex.com" })).toBe("https://ex.com");
  });
  test("treats a blank/whitespace description as absent", () => {
    expect(fallbackBody({ description: "   ", url: "https://ex.com" })).toBe("https://ex.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/fallback.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/capture/fallback.ts
/** Body to send when Readability finds no article: the meta description, else the URL. */
export function fallbackBody(meta: { description?: string; url: string }): string {
  const desc = meta.description?.trim();
  return desc !== undefined && desc !== "" ? desc : meta.url;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/fallback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capture/fallback.ts test/unit/fallback.test.ts
git commit -m "feat(capture): readability fallback body (description ?? url)"
```

---

## Task 3: Extend the message envelope

**Files:**
- Modify: `src/shared/messages.ts`
- Test: `test/unit/messages.test.ts` (extend)

**Interfaces:**
- Consumes: `CaptureResult`, `PairError`, `ClipError` from `./types.ts`.
- Produces:
  - `interface PairRequest { kind: "pair"; origin: string; code: string }`
  - `interface ClipRequest { kind: "clip"; capture: CaptureResult; tags: string[] }`
  - `type ExtensionRequest = PairRequest | ClipRequest`
  - `type PairResponse = { kind:"pair"; ok:true; label:string } | { kind:"pair"; ok:false; reason:PairError }`
  - `type ClipResponse = { kind:"clip"; ok:true; status:"created"|"updated"; bookmarked:boolean } | { kind:"clip"; ok:false; reason:ClipError }`
  - `isPairRequest(v: unknown): v is PairRequest`
  - `isClipRequest(v: unknown): v is ClipRequest`

- [ ] **Step 1: Write the failing test (append to the existing file)**

```typescript
// append to test/unit/messages.test.ts
import { isClipRequest, isPairRequest } from "../../src/shared/messages.ts";

describe("isPairRequest", () => {
  test("accepts a well-formed pair request", () => {
    expect(isPairRequest({ kind: "pair", origin: "http://127.0.0.1:8765", code: "429173" })).toBe(true);
  });
  test("rejects wrong kind / missing fields / non-object", () => {
    expect(isPairRequest({ kind: "clip" })).toBe(false);
    expect(isPairRequest({ kind: "pair", origin: "x" })).toBe(false);
    expect(isPairRequest(null)).toBe(false);
  });
});

describe("isClipRequest", () => {
  const capture = {
    url: "https://ex.com",
    title: "T",
    mode: "article",
    body: "b",
    readableFound: true,
  };
  test("accepts a well-formed clip request", () => {
    expect(isClipRequest({ kind: "clip", capture, tags: ["a"] })).toBe(true);
  });
  test("rejects bad tags / missing capture / non-object", () => {
    expect(isClipRequest({ kind: "clip", capture, tags: "a" })).toBe(false);
    expect(isClipRequest({ kind: "clip", tags: [] })).toBe(false);
    expect(isClipRequest("clip")).toBe(false);
  });
  test("rejects a capture whose optional canonicalUrl is present but not a string", () => {
    expect(isClipRequest({ kind: "clip", capture: { ...capture, canonicalUrl: 123 }, tags: [] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/messages.test.ts`
Expected: FAIL — `isPairRequest` / `isClipRequest` not exported.

- [ ] **Step 3: Write the implementation (append to `src/shared/messages.ts`)**

```typescript
// append to src/shared/messages.ts
import type { CaptureResult, ClipError, PairError } from "./types.ts";

export interface PairRequest {
  readonly kind: "pair";
  readonly origin: string;
  readonly code: string;
}

export interface ClipRequest {
  readonly kind: "clip";
  readonly capture: CaptureResult;
  readonly tags: string[];
}

export type ExtensionRequest = PairRequest | ClipRequest;

export type PairResponse =
  | { readonly kind: "pair"; readonly ok: true; readonly label: string }
  | { readonly kind: "pair"; readonly ok: false; readonly reason: PairError };

export type ClipResponse =
  | { readonly kind: "clip"; readonly ok: true; readonly status: "created" | "updated"; readonly bookmarked: boolean }
  | { readonly kind: "clip"; readonly ok: false; readonly reason: ClipError };

export type ExtensionResponse = PairResponse | ClipResponse;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isPairRequest(v: unknown): v is PairRequest {
  return (
    isObject(v) &&
    v["kind"] === "pair" &&
    typeof v["origin"] === "string" &&
    typeof v["code"] === "string"
  );
}

function isCaptureResult(v: unknown): v is CaptureResult {
  return (
    isObject(v) &&
    typeof v["url"] === "string" &&
    (v["canonicalUrl"] === undefined || typeof v["canonicalUrl"] === "string") &&
    typeof v["title"] === "string" &&
    (v["mode"] === "article" || v["mode"] === "selection") &&
    typeof v["body"] === "string" &&
    typeof v["readableFound"] === "boolean"
  );
}

export function isClipRequest(v: unknown): v is ClipRequest {
  return (
    isObject(v) &&
    v["kind"] === "clip" &&
    isCaptureResult(v["capture"]) &&
    Array.isArray(v["tags"]) &&
    v["tags"].every((t) => typeof t === "string")
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/messages.test.ts`
Expected: PASS (existing ping tests + the new ones).

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/messages.ts test/unit/messages.test.ts
git commit -m "feat(messages): pair/clip request+response envelope and guards"
```

---

## Task 4: Loopback origin validation

**Files:**
- Modify: `src/shared/gateway.ts`
- Test: `test/unit/gateway.test.ts` (extend)

**Interfaces:**
- Produces: `isLoopbackOrigin(origin: string): boolean`

- [ ] **Step 1: Write the failing test (append)**

```typescript
// append to test/unit/gateway.test.ts
import { isLoopbackOrigin } from "../../src/shared/gateway.ts";

describe("isLoopbackOrigin", () => {
  test("accepts http loopback hosts", () => {
    for (const o of ["http://127.0.0.1:8765", "http://127.0.0.5", "http://localhost:3000", "http://[::1]:8765"]) {
      expect(isLoopbackOrigin(o)).toBe(true);
    }
  });
  test("rejects non-loopback, https, lookalikes, and garbage", () => {
    for (const o of [
      "http://example.com",
      "https://127.0.0.1:8765",            // https excluded (gateway is http-only)
      "http://127.0.0.1.attacker.com",     // distinct host, not loopback
      "http://localhost.attacker.com",
      "http://10.0.0.1",
      "not a url",
    ]) {
      expect(isLoopbackOrigin(o)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/gateway.test.ts`
Expected: FAIL — `isLoopbackOrigin` not exported.

- [ ] **Step 3: Write the implementation (append to `src/shared/gateway.ts`)**

```typescript
// append to src/shared/gateway.ts
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True only for an http loopback origin. Uses the URL parser (never a substring
 * check) so lookalikes like 127.0.0.1.attacker.com are rejected. HTTPS is excluded
 * by design — the shipped gateway serves plain http on 127.0.0.1.
 */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") {
    return false;
  }
  // WHATWG URL serializes an IPv6 host WITH brackets, so url.hostname is "[::1]"
  // (never bare "::1"), consistently across Chrome/Firefox/Node.
  const host = url.hostname;
  return host === "localhost" || host === "[::1]" || LOOPBACK_V4.test(host);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/gateway.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/gateway.ts test/unit/gateway.test.ts
git commit -m "feat(gateway): URL-based loopback origin validation"
```

---

## Task 5: Gateway client (confirmPair + postClip)

**Files:**
- Create: `src/background/gateway-client.ts`
- Test: `test/unit/gateway-client.test.ts`

**Interfaces:**
- Consumes: `endpointUrl` from `../shared/gateway.ts`; `ClipPayload` from `../shared/clip.ts`; `PairError`/`ClipError` from `../shared/types.ts`.
- Produces:
  - `confirmPair(origin: string, code: string, doFetch?: FetchLike): Promise<{ ok:true; token:string; label:string } | { ok:false; reason:PairError }>`
  - `postClip(origin: string, token: string, payload: ClipPayload, doFetch?: FetchLike): Promise<{ ok:true; status:"created"|"updated" } | { ok:false; reason:ClipError }>`
  - `type FetchLike = (input: string, init?: RequestInit) => Promise<Response>`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/gateway-client.test.ts
import { describe, expect, test } from "vitest";
import { confirmPair, postClip } from "../../src/background/gateway-client.ts";
import type { ClipPayload } from "../../src/shared/clip.ts";

const ORIGIN = "http://127.0.0.1:8765";
function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("confirmPair", () => {
  test("200 → ok with token + label; posts code to the confirm path", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const out = await confirmPair(ORIGIN, "429173", async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body));
      return jsonRes(200, { token: "tok-abc", label: "chrome" });
    });
    expect(seenUrl).toBe("http://127.0.0.1:8765/v1/clips/pair/confirm");
    expect(seenBody).toEqual({ code: "429173" });
    expect(out).toEqual({ ok: true, token: "tok-abc", label: "chrome" });
  });
  test("403 → pairing_failed", async () => {
    expect(await confirmPair(ORIGIN, "x", async () => jsonRes(403, { error: "pairing_failed" }))).toEqual({
      ok: false,
      reason: "pairing_failed",
    });
  });
  test("fetch throw → unreachable", async () => {
    expect(await confirmPair(ORIGIN, "x", async () => { throw new Error("net"); })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
  test("5xx → server_error", async () => {
    expect(await confirmPair(ORIGIN, "x", async () => jsonRes(500, { error: "internal_error" }))).toEqual({
      ok: false,
      reason: "server_error",
    });
  });
});

describe("postClip", () => {
  const payload: ClipPayload = {
    url: "https://ex.com/p",
    title: "T",
    mode: "article",
    body: "b",
    tags: [],
    capturedAt: 1,
  };
  test("200 created → ok; sends Bearer header + payload to the ingest path", async () => {
    let seenUrl = "";
    let auth: string | null = null;
    let seenBody: unknown;
    const out = await postClip(ORIGIN, "tok-abc", payload, async (url, init) => {
      seenUrl = url;
      auth = new Headers(init?.headers).get("authorization");
      seenBody = JSON.parse(String(init?.body));
      return jsonRes(200, { id: "nimbus:clip:1", status: "created" });
    });
    expect(seenUrl).toBe("http://127.0.0.1:8765/v1/clips");
    expect(auth).toBe("Bearer tok-abc");
    expect(seenBody).toEqual(payload);
    expect(out).toEqual({ ok: true, status: "created" });
  });
  test("200 updated → ok updated", async () => {
    expect(await postClip(ORIGIN, "t", payload, async () => jsonRes(200, { id: "x", status: "updated" }))).toEqual({
      ok: true,
      status: "updated",
    });
  });
  test("401 → unauthorized", async () => {
    expect(await postClip(ORIGIN, "t", payload, async () => jsonRes(401, { error: "unauthorized" }))).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });
  test("400 → invalid_request", async () => {
    expect(await postClip(ORIGIN, "t", payload, async () => jsonRes(400, { error: "invalid_request" }))).toEqual({
      ok: false,
      reason: "invalid_request",
    });
  });
  test("fetch throw → unreachable", async () => {
    expect(await postClip(ORIGIN, "t", payload, async () => { throw new Error("net"); })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/gateway-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/background/gateway-client.ts
import type { ClipPayload } from "../shared/clip.ts";
import { type ClipEndpoint, endpointUrl } from "../shared/gateway.ts";
import type { ClipError, PairError } from "../shared/types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const PAIR_TIMEOUT_MS = 5_000;
const CLIP_TIMEOUT_MS = 10_000;

async function postJson(
  doFetch: FetchLike,
  origin: string,
  endpoint: ClipEndpoint,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(endpointUrl(origin, endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export async function confirmPair(
  origin: string,
  code: string,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true; token: string; label: string } | { ok: false; reason: PairError }> {
  let res: Response;
  try {
    res = await postJson(doFetch, origin, "pairConfirm", { code }, {}, PAIR_TIMEOUT_MS);
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    if (isObject(data) && typeof data["token"] === "string" && typeof data["label"] === "string") {
      return { ok: true, token: data["token"], label: data["label"] };
    }
    return { ok: false, reason: "server_error" };
  }
  if (res.status === 403) {
    return { ok: false, reason: "pairing_failed" };
  }
  return { ok: false, reason: "server_error" };
}

export async function postClip(
  origin: string,
  token: string,
  payload: ClipPayload,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true; status: "created" | "updated" } | { ok: false; reason: ClipError }> {
  let res: Response;
  try {
    res = await postJson(
      doFetch,
      origin,
      "ingest",
      payload,
      { authorization: `Bearer ${token}` },
      CLIP_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    if (isObject(data) && (data["status"] === "created" || data["status"] === "updated")) {
      return { ok: true, status: data["status"] };
    }
    return { ok: false, reason: "server_error" };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 400) {
    return { ok: false, reason: "invalid_request" };
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
git commit -m "feat(gateway-client): confirmPair + postClip with timeout and status mapping"
```

---

## Task 6: The browser seam

**Files:**
- Create: `src/browser/storage.ts`, `src/browser/tabs.ts`, `src/browser/scripting.ts`, `src/browser/runtime.ts`
- Create: `test/unit/chrome-stub.ts` (shared test fake)
- Test: `test/unit/browser-seam.test.ts`

**Interfaces:**
- Consumes: `CaptureResult` from `../shared/types.ts`; `ExtensionRequest` from `../shared/messages.ts`.
- Produces:
  - `storageGet(key: string): Promise<unknown>` · `storageSet(key, value): Promise<void>` · `storageRemove(key): Promise<void>`
  - `activeTab(): Promise<{ id: number; url: string; title: string }>`
  - `runCapture(tabId: number, mode: "article"|"selection"): Promise<CaptureResult>`
  - `sendMessage(req: ExtensionRequest): Promise<unknown>` · `addMessageListener(fn): void`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/chrome-stub.ts
interface StubOptions {
  storage?: Record<string, unknown>;
  tab?: { id?: number; url?: string; title?: string };
  executeResults?: Array<{ result?: unknown }>;
}

/** Install a minimal fake `chrome` on globalThis; returns the backing storage map. */
export function installChromeStub(opts: StubOptions = {}): { storage: Map<string, unknown> } {
  const storage = new Map<string, unknown>(Object.entries(opts.storage ?? {}));
  const fake = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage.get(key) }),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) storage.set(k, v);
        },
        remove: async (key: string) => void storage.delete(key),
      },
    },
    tabs: {
      query: async () => [{ id: opts.tab?.id ?? 1, url: opts.tab?.url ?? "https://ex.com", title: opts.tab?.title ?? "T" }],
    },
    scripting: {
      executeScript: async () => opts.executeResults ?? [{ result: undefined }],
    },
    runtime: {
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener: () => undefined },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { storage };
}
```

```typescript
// test/unit/browser-seam.test.ts
import { afterEach, describe, expect, test } from "vitest";
import { installChromeStub } from "./chrome-stub.ts";
import { storageGet, storageRemove, storageSet } from "../../src/browser/storage.ts";
import { activeTab } from "../../src/browser/tabs.ts";
import { runCapture } from "../../src/browser/scripting.ts";

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

describe("storage", () => {
  test("set then get round-trips; remove deletes", async () => {
    installChromeStub();
    await storageSet("k", { a: 1 });
    expect(await storageGet("k")).toEqual({ a: 1 });
    await storageRemove("k");
    expect(await storageGet("k")).toBeUndefined();
  });
});

describe("activeTab", () => {
  test("returns id/url/title from chrome.tabs.query", async () => {
    installChromeStub({ tab: { id: 7, url: "https://ex.com/p", title: "Page" } });
    expect(await activeTab()).toEqual({ id: 7, url: "https://ex.com/p", title: "Page" });
  });
});

describe("runCapture", () => {
  test("returns the CaptureResult the injected function yields", async () => {
    const capture = { url: "https://ex.com/p", title: "P", mode: "article", body: "b", readableFound: true };
    installChromeStub({ executeResults: [{ result: capture }] });
    expect(await runCapture(7, "article")).toEqual(capture);
  });
  test("throws when the injected result is not a CaptureResult", async () => {
    installChromeStub({ executeResults: [{ result: undefined }] });
    await expect(runCapture(7, "article")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/browser-seam.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

```typescript
// src/browser/storage.ts
export async function storageGet(key: string): Promise<unknown> {
  const got = await chrome.storage.local.get(key);
  return (got as Record<string, unknown>)[key];
}

export async function storageSet(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function storageRemove(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}
```

```typescript
// src/browser/tabs.ts
export async function activeTab(): Promise<{ id: number; url: string; title: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    throw new Error("no active tab");
  }
  return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
}
```

```typescript
// src/browser/scripting.ts
import type { CaptureResult } from "../shared/types.ts";

function isCaptureResult(v: unknown): v is CaptureResult {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    typeof o["url"] === "string" &&
    (o["canonicalUrl"] === undefined || typeof o["canonicalUrl"] === "string") &&
    typeof o["title"] === "string" &&
    (o["mode"] === "article" || o["mode"] === "selection") &&
    typeof o["body"] === "string" &&
    typeof o["readableFound"] === "boolean"
  );
}

/**
 * Inject the bundled capture.js (which sets globalThis.__nimbusCapture), then call it
 * via a tiny func injection whose completion value is the CaptureResult. The two-step
 * keeps the heavy Readability bundle out of the func body (func cannot carry imports).
 */
export async function runCapture(
  tabId: number,
  mode: "article" | "selection",
): Promise<CaptureResult> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["capture.js"] });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (m: "article" | "selection") =>
      (globalThis as unknown as { __nimbusCapture: (m: string) => unknown }).__nimbusCapture(m),
    args: [mode],
  });
  const value = results[0]?.result;
  if (!isCaptureResult(value)) {
    throw new Error("capture failed");
  }
  return value;
}
```

```typescript
// src/browser/runtime.ts
import type { ExtensionRequest } from "../shared/messages.ts";

export async function sendMessage(req: ExtensionRequest): Promise<unknown> {
  return chrome.runtime.sendMessage(req);
}

export function addMessageListener(
  fn: (message: unknown, respond: (response: unknown) => void) => boolean,
): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
    fn(message, sendResponse),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/browser-seam.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/browser/ test/unit/chrome-stub.ts test/unit/browser-seam.test.ts
git commit -m "feat(browser): thin typed seam over chrome.* (storage/tabs/scripting/runtime)"
```

---

## Task 7: Connection store

**Files:**
- Create: `src/background/connection-store.ts`
- Test: `test/unit/connection-store.test.ts`

**Interfaces:**
- Consumes: `storageGet/Set/Remove` from `../browser/storage.ts`; `Connection` from `../shared/types.ts`.
- Produces:
  - `getConnection(): Promise<Connection | null>`
  - `setConnection(c: Connection): Promise<void>`
  - `clearConnection(): Promise<void>`
  - `isConnection(v: unknown): v is Connection`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/connection-store.test.ts
import { afterEach, describe, expect, test } from "vitest";
import { installChromeStub } from "./chrome-stub.ts";
import { clearConnection, getConnection, setConnection } from "../../src/background/connection-store.ts";
import type { Connection } from "../../src/shared/types.ts";

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

const conn: Connection = { origin: "http://127.0.0.1:8765", token: "tok", label: "chrome", pairedAt: 1 };

describe("connection-store", () => {
  test("empty storage → null", async () => {
    installChromeStub();
    expect(await getConnection()).toBeNull();
  });
  test("set then get round-trips", async () => {
    installChromeStub();
    await setConnection(conn);
    expect(await getConnection()).toEqual(conn);
  });
  test("clear removes it", async () => {
    installChromeStub({ storage: { connection: conn } });
    await clearConnection();
    expect(await getConnection()).toBeNull();
  });
  test("a malformed stored value → null (not a throw)", async () => {
    installChromeStub({ storage: { connection: { origin: "x" } } });
    expect(await getConnection()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/connection-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/background/connection-store.ts
import { storageGet, storageRemove, storageSet } from "../browser/storage.ts";
import type { Connection } from "../shared/types.ts";

const CONNECTION_KEY = "connection";

export function isConnection(v: unknown): v is Connection {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>)["origin"] === "string" &&
    typeof (v as Record<string, unknown>)["token"] === "string" &&
    typeof (v as Record<string, unknown>)["label"] === "string" &&
    typeof (v as Record<string, unknown>)["pairedAt"] === "number"
  );
}

export async function getConnection(): Promise<Connection | null> {
  const value = await storageGet(CONNECTION_KEY);
  return isConnection(value) ? value : null;
}

export async function setConnection(c: Connection): Promise<void> {
  await storageSet(CONNECTION_KEY, c);
}

export async function clearConnection(): Promise<void> {
  await storageRemove(CONNECTION_KEY);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/connection-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/connection-store.ts test/unit/connection-store.test.ts
git commit -m "feat(background): typed connection store over chrome.storage.local"
```

---

## Task 8: Pair/clip handlers + service-worker routing

**Files:**
- Create: `src/background/handlers.ts`
- Modify: `src/background/service-worker.ts`
- Test: `test/unit/handlers.test.ts`

**Interfaces:**
- Consumes: `buildClipPayload` (`../shared/clip.ts`); `isLoopbackOrigin` (`../shared/gateway.ts`); `PairRequest`/`ClipRequest`/`PairResponse`/`ClipResponse`/`isPairRequest`/`isClipRequest` (`../shared/messages.ts`); `Connection`/`PairError`/`ClipError` (`../shared/types.ts`); `confirmPair`/`postClip` (`./gateway-client.ts`); `getConnection`/`setConnection` (`./connection-store.ts`); `addMessageListener` (`../browser/runtime.ts`).
- Produces:
  - `interface PairDeps { confirmPair: (origin, code) => Promise<…>; setConnection: (c: Connection) => Promise<void>; nowMs: () => number }`
  - `interface ClipDeps { getConnection: () => Promise<Connection | null>; postClip: (origin, token, payload) => Promise<…>; nowMs: () => number }`
  - `handlePair(deps: PairDeps, req: PairRequest): Promise<PairResponse>`
  - `handleClip(deps: ClipDeps, req: ClipRequest): Promise<ClipResponse>`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/handlers.test.ts
import { describe, expect, test } from "vitest";
import { handleClip, handlePair } from "../../src/background/handlers.ts";
import type { Connection } from "../../src/shared/types.ts";

const conn: Connection = { origin: "http://127.0.0.1:8765", token: "tok", label: "chrome", pairedAt: 100 };
const capture = { url: "https://ex.com/p", title: "T", mode: "article" as const, body: "b", readableFound: true };

describe("handlePair", () => {
  test("rejects a non-loopback origin without calling the gateway", async () => {
    let called = false;
    const res = await handlePair(
      { confirmPair: async () => { called = true; return { ok: true, token: "t", label: "l" }; }, setConnection: async () => undefined, nowMs: () => 1 },
      { kind: "pair", origin: "http://evil.com", code: "1" },
    );
    expect(res).toEqual({ kind: "pair", ok: false, reason: "bad_origin" });
    expect(called).toBe(false);
  });
  test("on 200 stores the connection and returns the label (never the token)", async () => {
    let stored: Connection | null = null;
    const res = await handlePair(
      {
        confirmPair: async () => ({ ok: true, token: "tok-xyz", label: "chrome" }),
        setConnection: async (c) => { stored = c; },
        nowMs: () => 100,
      },
      { kind: "pair", origin: "http://127.0.0.1:8765", code: "429173" },
    );
    expect(res).toEqual({ kind: "pair", ok: true, label: "chrome" });
    expect(JSON.stringify(res)).not.toContain("tok-xyz");
    expect(stored).toEqual({ origin: "http://127.0.0.1:8765", token: "tok-xyz", label: "chrome", pairedAt: 100 });
  });
  test("propagates a pairing failure", async () => {
    const res = await handlePair(
      { confirmPair: async () => ({ ok: false, reason: "pairing_failed" }), setConnection: async () => undefined, nowMs: () => 1 },
      { kind: "pair", origin: "http://127.0.0.1:8765", code: "000000" },
    );
    expect(res).toEqual({ kind: "pair", ok: false, reason: "pairing_failed" });
  });
});

describe("handleClip", () => {
  test("not paired → not_paired without posting", async () => {
    let called = false;
    const res = await handleClip(
      { getConnection: async () => null, postClip: async () => { called = true; return { ok: true, status: "created" }; }, nowMs: () => 1 },
      { kind: "clip", capture, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: false, reason: "not_paired" });
    expect(called).toBe(false);
  });
  test("paired → posts and returns status + bookmarked=false for a readable article", async () => {
    let postedTo = "";
    const res = await handleClip(
      {
        getConnection: async () => conn,
        postClip: async (origin) => { postedTo = origin; return { ok: true, status: "created" }; },
        nowMs: () => 1,
      },
      { kind: "clip", capture, tags: ["a"] },
    );
    expect(postedTo).toBe("http://127.0.0.1:8765");
    expect(res).toEqual({ kind: "clip", ok: true, status: "created", bookmarked: false });
  });
  test("bookmarked=true when the capture was a fallback", async () => {
    const res = await handleClip(
      { getConnection: async () => conn, postClip: async () => ({ ok: true, status: "created" }), nowMs: () => 1 },
      { kind: "clip", capture: { ...capture, readableFound: false }, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: true, status: "created", bookmarked: true });
  });
  test("propagates unauthorized", async () => {
    const res = await handleClip(
      { getConnection: async () => conn, postClip: async () => ({ ok: false, reason: "unauthorized" }), nowMs: () => 1 },
      { kind: "clip", capture, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: false, reason: "unauthorized" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/handlers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementations**

```typescript
// src/background/handlers.ts
import { buildClipPayload } from "../shared/clip.ts";
import { isLoopbackOrigin } from "../shared/gateway.ts";
import type { ClipRequest, ClipResponse, PairRequest, PairResponse } from "../shared/messages.ts";
import type { ClipError, Connection, PairError } from "../shared/types.ts";

export interface PairDeps {
  readonly confirmPair: (
    origin: string,
    code: string,
  ) => Promise<{ ok: true; token: string; label: string } | { ok: false; reason: PairError }>;
  readonly setConnection: (c: Connection) => Promise<void>;
  readonly nowMs: () => number;
}

export interface ClipDeps {
  readonly getConnection: () => Promise<Connection | null>;
  readonly postClip: (
    origin: string,
    token: string,
    payload: ReturnType<typeof buildClipPayload>,
  ) => Promise<{ ok: true; status: "created" | "updated" } | { ok: false; reason: ClipError }>;
  readonly nowMs: () => number;
}

export async function handlePair(deps: PairDeps, req: PairRequest): Promise<PairResponse> {
  if (!isLoopbackOrigin(req.origin)) {
    return { kind: "pair", ok: false, reason: "bad_origin" };
  }
  const r = await deps.confirmPair(req.origin, req.code);
  if (!r.ok) {
    // Intentional: a failed re-pair (e.g. wrong code) leaves any existing working
    // connection untouched — we overwrite it only on a confirmed new token.
    return { kind: "pair", ok: false, reason: r.reason };
  }
  await deps.setConnection({
    origin: req.origin,
    token: r.token,
    label: r.label,
    pairedAt: deps.nowMs(),
  });
  return { kind: "pair", ok: true, label: r.label };
}

export async function handleClip(deps: ClipDeps, req: ClipRequest): Promise<ClipResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "clip", ok: false, reason: "not_paired" };
  }
  const payload = buildClipPayload(req.capture, req.tags, deps.nowMs());
  const r = await deps.postClip(conn.origin, conn.token, payload);
  if (!r.ok) {
    return { kind: "clip", ok: false, reason: r.reason };
  }
  return { kind: "clip", ok: true, status: r.status, bookmarked: !req.capture.readableFound };
}
```

```typescript
// src/background/service-worker.ts  (REPLACE the file's contents)
// MV3 background service worker / Firefox event page. Owns the bearer token and all
// gateway I/O; the popup and options page reach it only via runtime messages.
import { addMessageListener } from "../browser/runtime.ts";
import { isClipRequest, isPairRequest } from "../shared/messages.ts";
import { getConnection, setConnection } from "./connection-store.ts";
import { confirmPair, postClip } from "./gateway-client.ts";
import { handleClip, handlePair } from "./handlers.ts";

addMessageListener((message, respond) => {
  if (isPairRequest(message)) {
    handlePair({ confirmPair, setConnection, nowMs: () => Date.now() }, message).then(respond);
    return true;
  }
  if (isClipRequest(message)) {
    handleClip({ getConnection, postClip, nowMs: () => Date.now() }, message).then(respond);
    return true;
  }
  return false;
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint (the SW rewrite drops the old ping handler)**

Run: `bun run typecheck && bun run lint`
Expected: PASS. (The `ping` message type is now unused by the SW but remains exported in `messages.ts`; that is fine — no lint error for an unused export.)

- [ ] **Step 6: Commit**

```bash
git add src/background/handlers.ts src/background/service-worker.ts test/unit/handlers.test.ts
git commit -m "feat(background): pair/clip handlers + service-worker message routing"
```

---

## Task 9: Capture-in-page script + build wiring

**Files:**
- Create: `src/capture/capture-in-page.ts`
- Modify: `esbuild.mjs` (add the `capture` entry)
- Modify: `scripts/check-build.mjs` (require `capture.js`)
- Modify: `package.json` (add `@mozilla/readability` devDependency)

**Interfaces:**
- Consumes: `fallbackBody` (`./fallback.ts`); `CaptureResult` (`../shared/types.ts`); `Readability` (`@mozilla/readability`).
- Produces: a side-effecting bundle that sets `globalThis.__nimbusCapture: (mode: string) => CaptureResult`.

> `capture-in-page.ts` runs in the page DOM and is verified by the manual dev-load checklist (Task 11), not a unit test — Readability needs a real document. Its only pure dependency (`fallbackBody`) is already unit-tested (Task 2).

- [ ] **Step 1: Add the dependency**

Run: `bun add -d @mozilla/readability`
Expected: `@mozilla/readability` appears under `devDependencies` and `bun.lock` updates.

- [ ] **Step 2: Write `capture-in-page.ts`**

```typescript
// src/capture/capture-in-page.ts
import { Readability } from "@mozilla/readability";
import type { CaptureResult } from "../shared/types.ts";
import { fallbackBody } from "./fallback.ts";

function metaDescription(doc: Document): string | undefined {
  const el = doc.querySelector('meta[name="description"]');
  const content = el?.getAttribute("content") ?? undefined;
  return content !== undefined && content.trim() !== "" ? content : undefined;
}

function canonicalUrl(doc: Document): string | undefined {
  const href = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? undefined;
  return href !== undefined && href !== "" ? href : undefined;
}

function capture(mode: string): CaptureResult {
  const url = location.href;
  const title = document.title;
  const canonical = canonicalUrl(document);
  const canonicalPart = canonical !== undefined ? { canonicalUrl: canonical } : {};

  if (mode === "selection") {
    const body = (window.getSelection()?.toString() ?? "").trim();
    return { url, ...canonicalPart, title, mode: "selection", body, readableFound: body !== "" };
  }

  // Readability mutates the DOM it parses — give it a clone. document.cloneNode(true)
  // is Mozilla's documented entry: `new Readability(document.cloneNode(true)).parse()`.
  const clone = document.cloneNode(true) as Document;
  const article = new Readability(clone).parse();
  const text = article?.textContent?.trim() ?? "";
  if (text !== "") {
    return {
      url,
      ...canonicalPart,
      title: article?.title !== undefined && article.title !== "" ? article.title : title,
      mode: "article",
      body: text,
      readableFound: true,
    };
  }
  return {
    url,
    ...canonicalPart,
    title,
    mode: "article",
    body: fallbackBody({ description: metaDescription(document), url }),
    readableFound: false,
  };
}

(globalThis as unknown as { __nimbusCapture: (mode: string) => CaptureResult }).__nimbusCapture =
  capture;
```

- [ ] **Step 3: Add the esbuild entry**

In `esbuild.mjs`, add `capture` to `ENTRIES`:

```javascript
const ENTRIES = [
  { in: "src/background/service-worker.ts", out: "background" },
  { in: "src/popup/popup.ts", out: "popup" },
  { in: "src/options/options.ts", out: "options" },
  { in: "src/capture/capture-in-page.ts", out: "capture" },
];
```

- [ ] **Step 4: Require `capture.js` in the build check**

In `scripts/check-build.mjs`, add `"capture.js"` to `REQUIRED_FILES` (after `"background.js"`):

```javascript
  "background.js",
  "capture.js",
```

- [ ] **Step 5: Build, check, typecheck, lint**

Run: `bun run build && bun run check-build && bun run typecheck && bun run lint`
Expected: PASS — `dist/chrome/capture.js` and `dist/firefox/capture.js` exist (Readability inlined); check-build OK.

- [ ] **Step 6: Run the full unit suite (no regressions)**

Run: `bun run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/capture/capture-in-page.ts esbuild.mjs scripts/check-build.mjs package.json bun.lock
git commit -m "feat(capture): bundled capture.js (Readability) + build wiring"
```

---

## Task 10: Popup + options UI

**Files:**
- Modify: `src/popup/popup.html`, `src/popup/popup.ts`, `src/popup/popup.css`
- Modify: `src/options/options.html`, `src/options/options.ts`, `src/options/options.css`
- Modify: `src/shared/gateway.ts` (remove the placeholder `DEFAULT_GATEWAY_ORIGIN`)
- Modify: `test/unit/gateway.test.ts` (drop the default-origin assertion)

**Interfaces:**
- Consumes: `activeTab` (`../browser/tabs.ts`); `runCapture` (`../browser/scripting.ts`); `sendMessage` (`../browser/runtime.ts`); `parseTags` (`../shared/clip.ts`); message/response types + guards (`../shared/messages.ts`).

> The popup/options DOM wiring is verified by the manual dev-load checklist (Task 11). Pure helpers they call (`parseTags`, the guards) are already unit-tested.

- [ ] **Step 1: Remove the placeholder default origin**

In `src/shared/gateway.ts`, delete the `DEFAULT_GATEWAY_ORIGIN` export (origin always comes from the stored `Connection` / the Options form). In `test/unit/gateway.test.ts`, delete the test `"the default origin is loopback"` and the `DEFAULT_GATEWAY_ORIGIN` import.

Run: `bunx vitest run test/unit/gateway.test.ts`
Expected: PASS (remaining `CLIP_PATHS`, `endpointUrl`, `isLoopbackOrigin` tests).

- [ ] **Step 2: Write the popup**

```html
<!-- src/popup/popup.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Clip to Nimbus</title>
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <main class="popup">
      <h1 class="popup__title">Nimbus Web Clipper</h1>
      <label class="popup__label" for="tags">Tags (comma-separated)</label>
      <input id="tags" class="popup__tags" type="text" placeholder="research, work" />
      <div class="popup__actions">
        <button id="clip-page" type="button">Clip page</button>
        <button id="clip-selection" type="button">Clip selection</button>
      </div>
      <p id="status" class="popup__status" role="status"></p>
    </main>
    <script src="popup.js"></script>
  </body>
</html>
```

```typescript
// src/popup/popup.ts
import { runCapture } from "../browser/scripting.ts";
import { sendMessage } from "../browser/runtime.ts";
import { activeTab } from "../browser/tabs.ts";
import { parseTags } from "../shared/clip.ts";
import type { ClipResponse } from "../shared/messages.ts";

const CLIP_MESSAGES: Record<string, string> = {
  not_paired: "Pair a browser first (Options).",
  unauthorized: "Pairing expired — re-pair in Options.",
  invalid_request: "Couldn't save this page.",
  unreachable: "Can't reach Nimbus — is the gateway running?",
  server_error: "Nimbus had an error saving this.",
};

function isClipResponse(v: unknown): v is ClipResponse {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "clip";
}

function setStatus(text: string): void {
  const el = document.getElementById("status");
  if (el !== null) {
    el.textContent = text;
  }
}

async function clip(mode: "article" | "selection"): Promise<void> {
  setStatus("Clipping…");
  const tagsInput = document.getElementById("tags");
  const tags = tagsInput instanceof HTMLInputElement ? parseTags(tagsInput.value) : [];
  let capture: Awaited<ReturnType<typeof runCapture>>;
  try {
    const tab = await activeTab();
    capture = await runCapture(tab.id, mode);
  } catch {
    setStatus("Nimbus can't clip browser system or store pages.");
    return;
  }
  if (mode === "selection" && capture.body === "") {
    setStatus("Select some text first.");
    return;
  }
  const res = await sendMessage({ kind: "clip", capture, tags });
  if (!isClipResponse(res)) {
    setStatus("Unexpected response.");
    return;
  }
  if (res.ok) {
    setStatus(res.bookmarked ? "Saved as a bookmark." : res.status === "updated" ? "Updated in Nimbus." : "Saved to Nimbus.");
  } else {
    setStatus(CLIP_MESSAGES[res.reason] ?? "Couldn't save this page.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("clip-page")?.addEventListener("click", () => void clip("article"));
  document.getElementById("clip-selection")?.addEventListener("click", () => void clip("selection"));
});
```

```css
/* src/popup/popup.css */
:root { color-scheme: light dark; }
body { margin: 0; font-family: system-ui, sans-serif; }
.popup { min-width: 280px; padding: 16px; }
.popup__title { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
.popup__label { display: block; font-size: 12px; opacity: 0.8; margin-bottom: 4px; }
.popup__tags { width: 100%; box-sizing: border-box; padding: 6px 8px; margin-bottom: 12px; }
.popup__actions { display: flex; gap: 8px; }
.popup__actions button { flex: 1; padding: 8px; cursor: pointer; }
.popup__status { margin: 12px 0 0; font-size: 13px; min-height: 1.2em; }
```

- [ ] **Step 3: Write the options page**

```html
<!-- src/options/options.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nimbus Web Clipper — Options</title>
    <link rel="stylesheet" href="options.css" />
  </head>
  <body>
    <main class="options">
      <h1>Nimbus Web Clipper</h1>
      <section>
        <h2>Pair this browser</h2>
        <p>Run <code>nimbus clip pair</code> on the machine running your Nimbus gateway, then enter its URL and the 6-digit code it prints.</p>
        <label for="origin">Gateway URL</label>
        <input id="origin" type="text" placeholder="http://127.0.0.1:8765" />
        <label for="code">Pairing code</label>
        <input id="code" type="text" inputmode="numeric" placeholder="429173" />
        <button id="pair" type="button">Pair this browser</button>
        <p id="pairing-status" class="options__status" role="status"></p>
      </section>
    </main>
    <script src="options.js"></script>
  </body>
</html>
```

```typescript
// src/options/options.ts
import { sendMessage } from "../browser/runtime.ts";
import type { PairResponse } from "../shared/messages.ts";

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
    setStatus(`Paired as "${res.label}".`);
    codeEl.value = "";
  } else {
    setStatus(PAIR_MESSAGES[res.reason] ?? "Pairing failed.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("pair")?.addEventListener("click", () => void pair());
});
```

```css
/* src/options/options.css */
:root { color-scheme: light dark; }
body { margin: 0; font-family: system-ui, sans-serif; line-height: 1.5; }
.options { max-width: 640px; margin: 0 auto; padding: 32px 24px; }
.options label { display: block; font-size: 12px; opacity: 0.8; margin: 12px 0 4px; }
.options input { width: 100%; box-sizing: border-box; padding: 8px; }
.options button { margin-top: 16px; padding: 8px 16px; cursor: pointer; }
.options__status { margin-top: 12px; font-size: 13px; min-height: 1.2em; }
code { font-family: ui-monospace, monospace; padding: 1px 4px; border-radius: 4px; background: rgba(127,127,127,0.18); }
```

- [ ] **Step 4: Build, check, typecheck, lint, test**

Run: `bun run build && bun run check-build && bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/popup/ src/options/ src/shared/gateway.ts test/unit/gateway.test.ts
git commit -m "feat(ui): popup clip actions + options pairing form"
```

---

## Task 11: Manual verification doc + full gate + PR

**Files:**
- Create: `docs/development.md`

- [ ] **Step 1: Write the dev-load + manual checklist**

```markdown
# Development

## Build & load

\`\`\`bash
bun install
bun run build          # → dist/chrome and dist/firefox
\`\`\`

- **Chrome:** chrome://extensions → Developer mode → Load unpacked → \`dist/chrome\`.
- **Firefox:** about:debugging#/runtime/this-firefox → Load Temporary Add-on → \`dist/firefox/manifest.json\`.

Reload the extension from the browser's extensions page after each \`bun run build\`.

## Manual verification (the parts not unit-tested)

Prereq: a Nimbus gateway running with \`NIMBUS_HTTP_PORT\` set; run \`nimbus clip pair\`
to get a code.

1. **Pair:** Options → enter \`http://127.0.0.1:<port>\` + the code → "Paired as …".
   - Wrong code → "Code wrong or expired".
   - Non-loopback URL → "Enter a 127.0.0.1 / localhost URL".
2. **Clip article:** open a news/blog article → popup → add a tag → Clip page →
   "Saved to Nimbus". Re-clip → "Updated in Nimbus".
3. **Clip selection:** select text → Clip selection → "Saved to Nimbus".
4. **Bookmark fallback:** open an SPA/app page Readability can't parse → Clip page →
   "Saved as a bookmark".
5. **Restricted page:** on chrome://extensions → Clip page → "Nimbus can't clip
   browser system or store pages."
6. **Offline:** stop the gateway → Clip page → "Can't reach Nimbus".
7. **Search:** in Nimbus, \`nimbus search\` for a word in the clip → it appears.
8. Repeat 1–4 in Firefox.

## Security check

- The bearer token never appears in the page DOM, the popup/options DOM, or any
  log. Confirm via DevTools that no \`console\` output or DOM node contains it.
\`\`\`
```

- [ ] **Step 2: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: ALL PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/development.md
git commit -m "docs: dev-load steps + manual verification checklist"
```

- [ ] **Step 4: Push the branch and open the PR**

```bash
git push -u origin <branch>
gh pr create --fill
```

Verify CI (build-test, CodeQL, Sonar) goes green on the PR before merge.

---

## Plan review resolutions (2026-06-23)

From [the plan review](./2026-06-23-web-clipper-extension-slice1-review.md):

1. **IPv6 loopback (fixed).** `URL.hostname` returns `[::1]` *with* brackets per
   WHATWG (verified across Node/Chrome/Firefox), so the bare `"::1"` branch was dead
   and is removed (Task 4).
2. **HTTPS local/reverse-proxy (deferred).** Consistent with the spec: the shipped
   gateway is HTTP-only on loopback. If a user-run HTTPS gateway is ever supported it
   is a one-line change (allow `https:` in `isLoopbackOrigin` + add the `https://`
   host permissions) — left out of Slice 1 as YAGNI.
3. **`isCaptureResult` optional `canonicalUrl` (fixed).** Both guards (Task 3 message
   guard, Task 6 scripting guard) now reject a present-but-non-string `canonicalUrl`;
   a guard test is added (Task 3).
4. **Readability clone (no change).** `document.cloneNode(true)` is Mozilla's
   documented entry point; comment added to make that explicit (Task 9).
5. **Options presence validation (fixed).** The options page short-circuits to a
   local error when the URL or code is empty, before messaging the SW (Task 10).
6. **Keep connection on failed pair (accepted as intended).** A failed re-pair leaves
   an existing working connection untouched; this is now documented in `handlePair`
   (Task 8).

## Self-Review Notes (author)

- **Spec coverage:** browser seam (T6), pairing flow (T4 origin-validate, T5 confirmPair, T7 store, T8 handlePair, T10 options), clip flow (T1 payload, T2 fallback, T6 runCapture, T9 capture-in-page, T8 handleClip, T10 popup), token-in-SW posture (T8 — token only in handlePair/connection-store, asserted never returned), error table (T5 status mapping + T10 message maps), restricted-page handling (T10 popup catch), split timeouts (T5), tag rules (T1), loopback validation incl. lookalikes (T4). Slice-2 sidecar is explicitly out of scope (separate plan). Deferred items (HTTPS, clip-status pre-fetch) are not implemented, per spec.
- **Type consistency:** `CaptureResult`/`Connection`/`PairError`/`ClipError` defined once in `types.ts` (T1) and consumed unchanged in T3/T5/T6/T7/T8; `confirmPair`/`postClip` return shapes (T5) match `PairDeps`/`ClipDeps` (T8); `endpointUrl(origin, "ingest"|"pairConfirm")` uses the existing `ClipEndpoint` keys.
- **Token safety:** the token is written only by `setConnection` (T7) inside `handlePair` (T8) and read only by `handleClip` for the `Authorization` header (T5); it is never in a response (asserted in T8) nor logged (Biome `noConsole`).
- **Intentional non-unit-tested surfaces:** `capture-in-page.ts`, popup/options DOM wiring, and the `service-worker.ts` glue — each covered by the Task 11 manual checklist; their pure dependencies are unit-tested.
