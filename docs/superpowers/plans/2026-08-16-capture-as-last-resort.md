# Capture as the Last Resort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a page the gateway cannot help with, let the panel capture and ingest it — and say permanently that the result is a copy you saved, not connector data.

**Architecture:** A pure predicate decides which of the panel's dead ends offer capture. The worker owns the inject-and-read step (shared with the hotkey path), the restricted-scheme guard, and the pinned-URL equality check; the panel owns a small state machine that renders capture → preview → send → re-resolve. The captured-copy header keys off the resolved item being a `web_clip`, so the honesty outlives the capture.

**Tech Stack:** TypeScript strict (no `any`), Vitest + jsdom, Biome, esbuild, MV3 (`chrome.*`).

**Spec:** `docs/superpowers/specs/2026-08-16-capture-as-last-resort-design.md` — read it before Task 1; the plan argues from it.

## Global Constraints

- **Worktree:** `C:\gitrep\nimbus-web-clipper\.claude\worktrees\capture-last-resort`, branch `feat/capture-as-last-resort`. **Never edit the main checkout.** This branch is stacked on `feat/richer-related-lane` (PR #57), which merges first.
- **TypeScript strict, no `any`.** Cross-boundary data is `unknown`, narrowed by a guard in `src/shared/messages.ts`.
- **No `console.*` anywhere in `src/`.** Biome fails the build. Tests may log.
- **Never log, render, or preview the bearer token or the pairing code.**
- **Loopback only** — no new host permissions, no fetch target beyond `127.0.0.1` / `localhost`.
- `exactOptionalPropertyTypes` is on: omit optional properties with conditional spread, never set them to `undefined`.
- The captured-copy discriminator is exactly `service === "nimbus" && type === "web_clip"` (upstream `packages/gateway/src/clips/clip-ingest.ts:7-8`).
- Capture mode is always `"article"`. Tags are always `[]`.
- Commit messages: Conventional Commits, each ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Do NOT `git push` and do NOT open a pull request.** Stop after the local commit.
- Commands: `bun run typecheck` · `bun run lint` (then `bun run format` if it reports) · `bunx vitest run <paths>` · `bun run test` · `bun run build` · `bun run check-build` (after build).

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/capture-offer.ts` | **New, pure.** Which header states offer capture; whether a resolved item is a captured copy. |
| `src/background/capture-tab.ts` | **New.** Inject-and-read one tab, with the restricted-scheme guard. Shared by the hotkey and panel paths. |
| `src/background/quick-clip.ts` | Delegates its capture step to `capture-tab.ts`; keeps its toast vocabulary. |
| `src/background/handlers.ts` | `handleCapture` — pure, injected deps: guard, URL match, capture, build preview or not. |
| `src/background/service-worker.ts` | Routes `capture`, supplying `sender.tabId`. |
| `src/shared/messages.ts` | `CaptureRequest` / `CaptureResponse` + guards. |
| `src/shared/types.ts` | `CaptureError`, the `captured` header arm, the two clip constants. |
| `src/panel/panel-view.ts` | The offer button, the in-flight status lines, the captured header, **Update this copy**. |
| `src/panel/panel-in-page.ts` | The capture state machine. |
| `CHANGELOG.md`, `ROADMAP.md`, `docs/architecture.md`, `docs/development.md` | Docs + the three stale roadmap claims. |

---

## Task 1: The pure offer rules

**Files:**
- Create: `src/shared/capture-offer.ts`
- Modify: `src/shared/types.ts`
- Test: `test/unit/capture-offer.test.ts` (new)

**Interfaces:**
- Consumes: `HeaderState` from `src/panel/panel-view.ts`, `ResolveCandidate` from `src/shared/types.ts`.
- Produces:
  - `export const CLIP_SERVICE = "nimbus"` and `export const CLIP_TYPE = "web_clip"` in `src/shared/types.ts`
  - `export function offersCapture(state: HeaderState): boolean`
  - `export function isCapturedCopy(item: { service: string; type: string }): boolean`
  Tasks 5 and 6 consume all three.

**Context you need.** The panel has seven settled header states. Capture is the *worse* answer — a connector models a pull request properly, a DOM scrape does not — so it is offered only where the gateway has nothing left to try. A `not-indexed` page that is still `fetchable` must NOT offer capture: C3.1's fetch button is right there and is the better answer. A rate-limited fetch retry must not offer it either — a retry beats a scrape.

- [ ] **Step 1: Add the two constants**

In `src/shared/types.ts`, near the other cross-module constants:

```ts
/**
 * What the gateway writes for a clip it ingested, from
 * `packages/gateway/src/clips/clip-ingest.ts:7-8` (upstream repo `Nimbus`).
 *
 * Duplicated here rather than imported: the gateway is a SEPARATE repository, and
 * this extension ships with no `node_modules` ("bundled, no runtime deps"), so
 * there is nothing to import from and a vendored package would drift the same way
 * a literal does. Roadmap Phase 8 (the Nimbus SDK) is where a genuinely shared
 * constant can live. If upstream renames either value, the captured-copy header
 * silently degrades to the ordinary resolved arm — it does not break, it stops
 * being honest. That is the failure mode to know about.
 */
export const CLIP_SERVICE = "nimbus";
export const CLIP_TYPE = "web_clip";

/** Why a capture could not be produced. Each maps to its own panel line. */
export type CaptureError = "restricted" | "url-changed" | "injection-failed" | "empty";
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/capture-offer.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { isCapturedCopy, offersCapture } from "../../src/shared/capture-offer.ts";
import type { HeaderState } from "../../src/panel/panel-view.ts";

const SURFACE = "GitHub pull request";

describe("offersCapture", () => {
  test("unrecognised offers capture — the internal-wiki case", () => {
    expect(offersCapture({ kind: "unrecognised" })).toBe(true);
  });

  test("a fetchable miss does NOT offer capture — fetch is the better answer", () => {
    expect(
      offersCapture({
        kind: "not-indexed",
        surface: SURFACE,
        product: "github",
        fetchable: true,
      }),
    ).toBe(false);
  });

  test("an unfetchable miss offers capture", () => {
    expect(
      offersCapture({
        kind: "not-indexed",
        surface: SURFACE,
        product: "github",
        fetchable: false,
      }),
    ).toBe(true);
  });

  test("every terminal fetch-blocked reason offers capture", () => {
    for (const reason of ["unfetchable", "not-configured", "needs-fetch-scope"] as const) {
      expect(
        offersCapture({ kind: "fetch-blocked", surface: SURFACE, product: "github", reason }),
      ).toBe(true);
    }
  });

  test("unresolvable offers capture", () => {
    expect(
      offersCapture({ kind: "unresolvable", surface: SURFACE, product: "github", fetchable: false }),
    ).toBe(true);
  });

  test("loading, resolved, service and error never offer capture", () => {
    expect(offersCapture({ kind: "loading" })).toBe(false);
    expect(offersCapture({ kind: "error", surface: null, message: "x" })).toBe(false);
  });
});

describe("isCapturedCopy", () => {
  test("a gateway-ingested clip is a captured copy", () => {
    expect(isCapturedCopy({ service: "nimbus", type: "web_clip" })).toBe(true);
  });

  test("connector items are not", () => {
    expect(isCapturedCopy({ service: "github", type: "pr" })).toBe(false);
  });

  test("service alone is not enough", () => {
    expect(isCapturedCopy({ service: "nimbus", type: "note" })).toBe(false);
  });

  test("type alone is not enough", () => {
    expect(isCapturedCopy({ service: "obsidian", type: "web_clip" })).toBe(false);
  });
});
```

**Important:** `HeaderState`'s arms carry exact fields. Before writing the implementation, open `src/panel/panel-view.ts` and read the `HeaderState` union — if any literal above does not typecheck against a real arm, fix the *test literal* to match the real shape, never the union.

- [ ] **Step 3: Run the test to verify it fails**

Run: `bunx vitest run test/unit/capture-offer.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/capture-offer.ts`.

- [ ] **Step 4: Implement**

Create `src/shared/capture-offer.ts`:

```ts
// src/shared/capture-offer.ts
// Where the panel offers to capture the page, and what makes a resolved item a
// captured copy. Pure — no DOM, no messaging — because both rules are consulted
// from two files and neither belongs inside a 900-line renderer.
import type { HeaderState } from "../panel/panel-view.ts";
import { CLIP_SERVICE, CLIP_TYPE } from "./types.ts";

/**
 * True when the gateway has nothing left to try, so a captured copy is better
 * than nothing.
 *
 * Capture is deliberately the WORSE answer: a connector models a pull request
 * properly and a DOM scrape produces a lower-fidelity copy of the same thing. So
 * a `not-indexed` page that is still `fetchable` returns false — C3.1's fetch
 * button is on that state and is the better answer. Capture becomes reachable
 * there only once a fetch has failed terminally, which moves the panel to
 * `fetch-blocked`, one of the arms below.
 *
 * A rate-limited fetch retry is likewise not an offer: it lives in
 * `fetch-retry`, which is not listed here, because waiting seconds beats
 * scraping.
 */
export function offersCapture(state: HeaderState): boolean {
  switch (state.kind) {
    case "unrecognised":
    case "unresolvable":
    case "fetch-blocked":
      return true;
    case "not-indexed":
      return !state.fetchable;
    default:
      return false;
  }
}

/**
 * True when this item is a copy the user captured, rather than data a connector
 * synced.
 *
 * Keyed on the ITEM, never on "we just captured it" — a page captured last week
 * resolves like anything else, and flagging only the fresh case would present it
 * as connector data seven days later. Same state, same words, no expiry.
 */
export function isCapturedCopy(item: { service: string; type: string }): boolean {
  return item.service === CLIP_SERVICE && item.type === CLIP_TYPE;
}
```

If `HeaderState` has arms whose `kind` values differ from those above, match the real union — the `default: return false` keeps every unlisted arm safe.

- [ ] **Step 5: Run the tests and the typechecker**

Run: `bunx vitest run test/unit/capture-offer.test.ts && bun run typecheck`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared/capture-offer.ts src/shared/types.ts test/unit/capture-offer.test.ts
git commit -m "feat(capture): the rules for offering capture and naming a copy

Capture is the worse answer, so it is offered only where the gateway has
nothing left to try: a still-fetchable miss keeps C3.1's fetch button and
no capture offer, and a rate-limited retry keeps its retry.

The captured-copy test is keyed on the ITEM being a web_clip rather than
on having just captured it — a page captured last week resolves like
anything else, and flagging only the fresh case would present it as
connector data a week later.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `capture-tab.ts` — one injection path, one scheme guard

**Files:**
- Create: `src/background/capture-tab.ts`
- Modify: `src/background/quick-clip.ts`
- Test: `test/unit/capture-tab.test.ts` (new)

**Interfaces:**
- Consumes: `CaptureError` (Task 1), `CaptureResult` from `src/shared/types.ts`.
- Produces:
  ```ts
  export interface CaptureTabDeps {
    readonly tabUrl: (tabId: number) => Promise<string | null>;
    readonly runCapture: (tabId: number, mode: "article" | "selection") => Promise<CaptureResult>;
  }
  export type CaptureOutcome =
    | { readonly ok: true; readonly capture: CaptureResult }
    | { readonly ok: false; readonly reason: CaptureError };
  export async function captureTab(
    deps: CaptureTabDeps,
    tabId: number,
    mode: "article" | "selection",
    expectedUrl?: string,
  ): Promise<CaptureOutcome>;
  ```
  Task 4 consumes `captureTab`.

**Context you need.** `isRestrictedUrl` already lives in `quick-clip.ts:14` and must move to (or be re-exported from) this module so both callers share it. The scheme guard is a **security requirement, not tidiness**: the panel that renders the offer is a *content script*, so any `pageUrl` it sends crosses an untrusted boundary. A hostile page script can send anything; the worker must validate before injecting.

`expectedUrl` is the pinned-URL equality check. When supplied and the tab's live URL differs, return `url-changed` **without injecting** — capturing the live DOM under a stale URL would file the new page's content against the old page's address, which is a corrupt index entry, worse than refusing.

- [ ] **Step 1: Write the failing test**

Create `test/unit/capture-tab.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { captureTab } from "../../src/background/capture-tab.ts";
import type { CaptureResult } from "../../src/shared/types.ts";

const PAGE = "https://wiki.example.com/runbook";
function result(url = PAGE): CaptureResult {
  return { url, title: "Runbook", mode: "article", body: "text", readableFound: true };
}

describe("captureTab", () => {
  test("captures when the tab url matches the expected url", async () => {
    const out = await captureTab(
      { tabUrl: async () => PAGE, runCapture: async () => result() },
      7,
      "article",
      PAGE,
    );
    expect(out).toEqual({ ok: true, capture: result() });
  });

  test("refuses a restricted scheme WITHOUT injecting", async () => {
    let injected = false;
    const out = await captureTab(
      {
        tabUrl: async () => "chrome://extensions",
        runCapture: async () => {
          injected = true;
          return result();
        },
      },
      7,
      "article",
    );
    expect(out).toEqual({ ok: false, reason: "restricted" });
    expect(injected).toBe(false);
  });

  test("refuses when the tab moved off the expected url, WITHOUT injecting", async () => {
    let injected = false;
    const out = await captureTab(
      {
        tabUrl: async () => "https://wiki.example.com/other",
        runCapture: async () => {
          injected = true;
          return result();
        },
      },
      7,
      "article",
      PAGE,
    );
    expect(out).toEqual({ ok: false, reason: "url-changed" });
    expect(injected).toBe(false);
  });

  test("no expectedUrl means no url check (the hotkey path)", async () => {
    const out = await captureTab(
      { tabUrl: async () => PAGE, runCapture: async () => result() },
      7,
      "article",
    );
    expect(out.ok).toBe(true);
  });

  test("an unknown tab url is refused as restricted, not assumed safe", async () => {
    const out = await captureTab(
      { tabUrl: async () => null, runCapture: async () => result() },
      7,
      "article",
    );
    expect(out).toEqual({ ok: false, reason: "restricted" });
  });

  test("a throwing injection becomes injection-failed", async () => {
    const out = await captureTab(
      {
        tabUrl: async () => PAGE,
        runCapture: async () => {
          throw new Error("no");
        },
      },
      7,
      "article",
    );
    expect(out).toEqual({ ok: false, reason: "injection-failed" });
  });

  test("an empty body becomes empty", async () => {
    const out = await captureTab(
      { tabUrl: async () => PAGE, runCapture: async () => ({ ...result(), body: "" }) },
      7,
      "article",
    );
    expect(out).toEqual({ ok: false, reason: "empty" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/capture-tab.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/background/capture-tab.ts`:

```ts
// src/background/capture-tab.ts
// Inject capture.js into one tab and read the result back, with the two refusals
// that must happen BEFORE injection. Shared by the hotkey path (quick-clip.ts)
// and the panel's capture offer so there is one injection, one scheme guard and
// one failure vocabulary rather than two that drift.
import type { CaptureError, CaptureResult } from "../shared/types.ts";

const RESTRICTED_SCHEMES = new Set([
  "chrome:",
  "chrome-extension:",
  "moz-extension:",
  "about:",
  "edge:",
  "view-source:",
]);

/** True for pages a content script can't be injected into (also un-capturable). */
export function isRestrictedUrl(url: string): boolean {
  try {
    return RESTRICTED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return true;
  }
}

export interface CaptureTabDeps {
  readonly tabUrl: (tabId: number) => Promise<string | null>;
  readonly runCapture: (tabId: number, mode: "article" | "selection") => Promise<CaptureResult>;
}

export type CaptureOutcome =
  | { readonly ok: true; readonly capture: CaptureResult }
  | { readonly ok: false; readonly reason: CaptureError };

/**
 * `expectedUrl` is the panel's PINNED url. When given, the tab must still be on
 * it or this refuses with `url-changed`.
 *
 * The DOM cannot be pinned: on an SPA the pinned url is a string the panel
 * remembers while the live DOM is wherever the user navigated. Capturing that DOM
 * under the pinned url would file the new page's content against the old page's
 * address — a corrupt index entry, and worse than refusing. The hotkey path omits
 * `expectedUrl` because it has no pinned page to be wrong about.
 *
 * Both refusals happen BEFORE `runCapture`, deliberately: the scheme guard is a
 * security boundary (the caller may be a content script sending an arbitrary url),
 * and injecting first would defeat it.
 */
export async function captureTab(
  deps: CaptureTabDeps,
  tabId: number,
  mode: "article" | "selection",
  expectedUrl?: string,
): Promise<CaptureOutcome> {
  const live = await deps.tabUrl(tabId).catch(() => null);
  // Fail closed on an unknown url: "we could not read the tab" is not evidence
  // the tab is safe to inject into.
  if (live === null || isRestrictedUrl(live)) {
    return { ok: false, reason: "restricted" };
  }
  if (expectedUrl !== undefined && live !== expectedUrl) {
    return { ok: false, reason: "url-changed" };
  }
  let capture: CaptureResult;
  try {
    capture = await deps.runCapture(tabId, mode);
  } catch {
    return { ok: false, reason: "injection-failed" };
  }
  if (capture.body === "") {
    return { ok: false, reason: "empty" };
  }
  return { ok: true, capture };
}
```

- [ ] **Step 4: Point `quick-clip.ts` at the shared guard**

In `src/background/quick-clip.ts`, delete its local `RESTRICTED_SCHEMES` set and its `isRestrictedUrl` definition, and re-export the shared one so existing importers are untouched:

```ts
export { isRestrictedUrl } from "./capture-tab.ts";
```

Leave the rest of `quickClip` alone — its toast vocabulary, its `clickedTabId` handling and its selection-empty check are its own and are not this slice's business.

- [ ] **Step 5: Run the tests and the gates**

Run: `bunx vitest run test/unit/capture-tab.test.ts test/unit/quick-clip.test.ts test/unit/context-menus.test.ts && bun run typecheck && bun run lint`
Expected: PASS. If `quick-clip.test.ts` does not exist under that name, run `bunx vitest run` and confirm nothing regressed.

- [ ] **Step 6: Commit**

```bash
git add src/background/capture-tab.ts src/background/quick-clip.ts test/unit/capture-tab.test.ts
git commit -m "feat(capture): one injection path, guarded before it injects

capture-tab.ts owns injecting capture.js and reading the result, so the
hotkey path and the panel's coming capture offer share one scheme guard
and one failure vocabulary.

Both refusals run BEFORE injection. The scheme check is a security
boundary rather than tidiness — the panel that will call this is a
content script, so the url it sends is untrusted input. The pinned-url
check exists because the DOM cannot be pinned: capturing a navigated SPA
under the old url would file new content against an old address.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The message contract

**Files:**
- Modify: `src/shared/messages.ts`
- Test: `test/unit/messages.test.ts`

**Interfaces:**
- Consumes: `CaptureError` (Task 1), `CaptureResult`, `ClipPreview` from `src/shared/preview.ts`.
- Produces:
  ```ts
  export interface CaptureRequest { readonly kind: "capture"; readonly pageUrl: string }
  export type CaptureResponse =
    | { readonly kind: "capture"; readonly ok: true; readonly capture: CaptureResult;
        readonly preview: ClipPreview | null }
    | { readonly kind: "capture"; readonly ok: false; readonly reason: CaptureError };
  export function isCaptureRequest(v: unknown): v is CaptureRequest;
  export function isCaptureResponse(v: unknown): v is CaptureResponse;
  ```
  Tasks 4 and 6 consume these.

**Context you need.** `preview: ClipPreview | null` is how the 1.3 preference reaches the panel. The panel is a content script and cannot read `chrome.storage` for the pref, and `isPreviewEnabled` already lives in `src/background/preview-pref.ts` — so the **worker** reads the pref and either builds the preview or sends `null` meaning "the user turned it off; send it straight away". The panel stays dumb and never builds a `ClipPayload` itself, which keeps `shared/preview.ts`'s one-place-builds-the-preview invariant intact.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/messages.test.ts`:

```ts
  test("isCaptureRequest accepts a pageUrl and rejects a missing or non-string one", () => {
    expect(isCaptureRequest({ kind: "capture", pageUrl: "https://x.test/a" })).toBe(true);
    expect(isCaptureRequest({ kind: "capture" })).toBe(false);
    expect(isCaptureRequest({ kind: "capture", pageUrl: 7 })).toBe(false);
    expect(isCaptureRequest({ kind: "clip", pageUrl: "https://x.test/a" })).toBe(false);
  });

  test("isCaptureResponse accepts both arms and a null preview", () => {
    const capture = {
      url: "https://x.test/a",
      title: "T",
      mode: "article",
      body: "b",
      readableFound: true,
    };
    expect(isCaptureResponse({ kind: "capture", ok: true, capture, preview: null })).toBe(true);
    expect(
      isCaptureResponse({
        kind: "capture",
        ok: true,
        capture,
        preview: { fields: [], excerpt: "b", bodyLength: 1, truncated: false },
      }),
    ).toBe(true);
    expect(isCaptureResponse({ kind: "capture", ok: false, reason: "url-changed" })).toBe(true);
  });

  test("isCaptureResponse rejects a success arm with no capture", () => {
    expect(isCaptureResponse({ kind: "capture", ok: true, preview: null })).toBe(false);
  });
```

Import `isCaptureRequest` and `isCaptureResponse` alongside the file's existing imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/messages.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `src/shared/messages.ts`, add the interfaces beside the other request/response pairs, add both to the `Request`/`Response` unions, and add the guards. Reuse the file's existing `isObject` helper and its `CaptureResult` guard if one exists (search for `isCaptureResult`); if there is none, check the five `CaptureResult` fields inline the way the neighbouring guards check theirs.

```ts
export interface CaptureRequest {
  readonly kind: "capture";
  /** The panel's PINNED page. Untrusted — it arrives from a content script — so
   *  it is guarded here and re-checked against the live tab in capture-tab.ts. */
  readonly pageUrl: string;
}

/**
 * `preview: null` means the user switched the 1.3 preview off, so the panel
 * sends the clip without a confirm step. The WORKER decides this, because the
 * pref lives in `chrome.storage` (background/preview-pref.ts) and the panel is a
 * content script — and because keeping preview construction in one place is what
 * stops a second code path from building a payload preview differently.
 */
export type CaptureResponse =
  | {
      readonly kind: "capture";
      readonly ok: true;
      readonly capture: CaptureResult;
      readonly preview: ClipPreview | null;
    }
  | { readonly kind: "capture"; readonly ok: false; readonly reason: CaptureError };
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `bunx vitest run test/unit/messages.test.ts && bun run typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/shared/messages.ts test/unit/messages.test.ts
git commit -m "feat(capture): the capture request/response pair, guarded

pageUrl crosses the content-script boundary, so it is guarded here like
every other cross-boundary value.

The response carries preview: ClipPreview | null because the 1.3 pref
lives in chrome.storage and the panel is a content script that cannot
read it. The worker decides, and null means 'send it straight away' —
which also keeps preview construction in exactly one place.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `handleCapture` in the worker

**Files:**
- Modify: `src/background/handlers.ts`
- Modify: `src/background/service-worker.ts`
- Test: `test/unit/handlers.test.ts`

**Interfaces:**
- Consumes: `captureTab` / `CaptureTabDeps` (Task 2), `CaptureRequest` / `CaptureResponse` (Task 3), `buildClipPayload` from `src/shared/clip.ts`, `buildClipPreview` from `src/shared/preview.ts`, `isPreviewEnabled` from `src/background/preview-pref.ts`.
- Produces:
  ```ts
  export interface CaptureDeps {
    readonly captureTab: (tabId: number, expectedUrl: string) => Promise<CaptureOutcome>;
    readonly previewEnabled: () => Promise<boolean>;
    readonly now: () => number;
  }
  export async function handleCapture(
    deps: CaptureDeps, req: CaptureRequest, tabId: number,
  ): Promise<CaptureResponse>;
  ```

**Context you need.** `handlers.ts` holds pure handlers with injected deps — follow that shape exactly; no `chrome.*` in this file. The worker's message listener signature is `addMessageListener((message, rawRespond, sender) => …)` and `sender.tabId` is available (it is already used at `service-worker.ts:803` for the ambient cue). Mode is always `"article"` and tags always `[]`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/handlers.test.ts`:

```ts
describe("handleCapture", () => {
  const PAGE = "https://wiki.example.com/runbook";
  const capture = {
    url: PAGE,
    title: "Runbook",
    mode: "article" as const,
    body: "the body text",
    readableFound: true,
  };

  test("preview on → returns the capture and a built preview", async () => {
    const res = await handleCapture(
      {
        captureTab: async () => ({ ok: true, capture }),
        previewEnabled: async () => true,
        now: () => 1_700_000_000_000,
      },
      { kind: "capture", pageUrl: PAGE },
      7,
    );
    expect(res.kind).toBe("capture");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.capture).toEqual(capture);
      expect(res.preview).not.toBeNull();
      // The token invariant: a preview names its fields explicitly and can never
      // carry a secret. Assert the shape rather than trusting the builder.
      expect(res.preview?.fields.some((f) => /token/i.test(f.label))).toBe(false);
    }
  });

  test("preview off → preview is null so the panel sends immediately", async () => {
    const res = await handleCapture(
      {
        captureTab: async () => ({ ok: true, capture }),
        previewEnabled: async () => false,
        now: () => 1,
      },
      { kind: "capture", pageUrl: PAGE },
      7,
    );
    expect(res.ok && res.preview).toBeNull();
  });

  test("a refusal from captureTab is passed through with its reason", async () => {
    const res = await handleCapture(
      {
        captureTab: async () => ({ ok: false, reason: "url-changed" }),
        previewEnabled: async () => true,
        now: () => 1,
      },
      { kind: "capture", pageUrl: PAGE },
      7,
    );
    expect(res).toEqual({ kind: "capture", ok: false, reason: "url-changed" });
  });

  test("the pinned url is passed to captureTab as the expected url", async () => {
    let seen: string | null = null;
    await handleCapture(
      {
        captureTab: async (_tabId, expected) => {
          seen = expected;
          return { ok: true, capture };
        },
        previewEnabled: async () => false,
        now: () => 1,
      },
      { kind: "capture", pageUrl: PAGE },
      7,
    );
    expect(seen).toBe(PAGE);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/handlers.test.ts`
Expected: FAIL — `handleCapture` is not exported.

- [ ] **Step 3: Implement the handler**

In `src/background/handlers.ts`:

```ts
/**
 * Capture the panel's pinned page and, if the user still wants the 1.3 confirm,
 * build the preview for it. Ingest is NOT done here: the panel sends the existing
 * `clip` request on Send, so there stays exactly one path that turns a
 * CaptureResult into an outbound clip.
 */
export async function handleCapture(
  deps: CaptureDeps,
  req: CaptureRequest,
  tabId: number,
): Promise<CaptureResponse> {
  const out = await deps.captureTab(tabId, req.pageUrl);
  if (!out.ok) {
    return { kind: "capture", ok: false, reason: out.reason };
  }
  const enabled = await deps.previewEnabled();
  if (!enabled) {
    return { kind: "capture", ok: true, capture: out.capture, preview: null };
  }
  const preview = buildClipPreview(buildClipPayload(out.capture, [], deps.now()));
  return { kind: "capture", ok: true, capture: out.capture, preview };
}
```

- [ ] **Step 4: Route it in the worker**

In `src/background/service-worker.ts`, beside the other `is*Request` branches in the message listener:

```ts
  if (isCaptureRequest(message)) {
    const tabId = sender.tabId;
    if (tabId === undefined) {
      // No tab means no page to capture. Fail closed with the same vocabulary the
      // panel already renders rather than inventing a branch for "impossible".
      respond({ kind: "capture", ok: false, reason: "injection-failed" });
      return true;
    }
    handleCapture(
      {
        captureTab: (id, expected) => captureTab({ tabUrl, runCapture }, id, "article", expected),
        previewEnabled: isPreviewEnabled,
        now: () => Date.now(),
      },
      message,
      tabId,
    )
      .then(respond)
      .catch(() => {
        respond({ kind: "capture", ok: false, reason: "injection-failed" });
      });
    return true;
  }
```

**`tabUrl` already exists** — `src/browser/tabs.ts:49`, signature `(tabId: number) => Promise<string | null>`. Import it; do **not** add a second one, and do not touch `chrome.tabs` anywhere else (that file is the only place allowed to).

Match the surrounding branches' exact `respond` / `return true` convention — read two neighbours before writing this one.

- [ ] **Step 5: Run the tests and the gates**

Run: `bunx vitest run test/unit/handlers.test.ts test/unit/browser-seam.test.ts && bun run typecheck && bun run lint`
Expected: PASS, exit 0, clean.

- [ ] **Step 6: Commit**

```bash
git add src/background/handlers.ts src/background/service-worker.ts src/browser/tabs.ts test/unit/
git commit -m "feat(capture): handle the panel's capture request

The worker captures the pinned page and, when the 1.3 preview is still
on, builds the preview for it. It deliberately does NOT ingest: the panel
sends the existing clip request on Send, so exactly one path turns a
CaptureResult into an outbound clip.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: The captured-copy header and the offer button

**Files:**
- Modify: `src/panel/panel-view.ts`
- Modify: `src/panel/panel-in-page.ts` (the `STYLES` constant only)
- Test: `test/unit/panel-view.test.ts`

**Interfaces:**
- Consumes: `offersCapture`, `isCapturedCopy` (Task 1); `formatAge` from `src/shared/freshness.ts`.
- Produces: `HeaderState` gains
  `{ readonly kind: "captured"; readonly item: ResolvedItem; readonly ageNowMs: number }`,
  and `renderHeader` gains two optional callbacks:
  `onCapture?: () => void`, `onRecapture?: () => void`. Task 6 supplies both.

**Context you need.** Every gateway-supplied string reaches the DOM via `textContent`, never `innerHTML` — indexed content is attacker-influenceable. The captured arm renders **no surface line**: an unrecognised page has no recognition to source one from, and that absence is part of the honesty. Read how the existing `resolved` arm renders its freshness line and reuse the exact wording (`Updated <age>`) so two freshness claims in one panel cannot disagree.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/panel-view.test.ts` (it already has a jsdom docblock and a `doc` helper):

```ts
describe("the captured-copy header", () => {
  const NOW = 1_700_000_000_000;
  const item = {
    id: "nimbus:clip:1",
    service: "nimbus",
    type: "web_clip",
    title: "Runbook",
    url: "https://wiki.example.com/runbook",
    modifiedAt: NOW - 3 * 24 * 60 * 60 * 1000,
  };

  test("names the item and says it is a copy you saved", () => {
    const el = renderHeader(doc, { kind: "captured", item, ageNowMs: NOW });
    expect(el.textContent).toContain("Runbook");
    expect(el.textContent).toContain("Updated 3 days ago");
    expect(el.textContent?.toLowerCase()).toContain("copy");
  });

  test("renders NO surface line — an unrecognised page has no surface", () => {
    const el = renderHeader(doc, { kind: "captured", item, ageNowMs: NOW });
    expect(el.querySelector(".nimbus-related__surface")).toBeNull();
  });

  test("offers Update this copy", () => {
    let called = false;
    const el = renderHeader(doc, { kind: "captured", item, ageNowMs: NOW }, undefined, undefined, undefined, () => {
      called = true;
    });
    const btn = el.querySelector(".nimbus-related__recapture") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn?.click();
    expect(called).toBe(true);
  });

  test("a captured title is never treated as markup", () => {
    const el = renderHeader(
      doc,
      { kind: "captured", item: { ...item, title: "<img src=x onerror=alert(1)>" }, ageNowMs: NOW },
    );
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("the capture offer", () => {
  test("an unrecognised page offers capture and keeps the Options hint", () => {
    let called = false;
    const el = renderHeader(doc, { kind: "unrecognised" }, undefined, undefined, () => {
      called = true;
    });
    expect(el.textContent).toContain("Options");
    const btn = el.querySelector(".nimbus-related__capture") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn?.click();
    expect(called).toBe(true);
  });

  test("a fetchable miss shows the fetch button and NO capture button", () => {
    const el = renderHeader(doc, {
      kind: "not-indexed",
      surface: "GitHub pull request",
      product: "github",
      fetchable: true,
    });
    expect(el.querySelector(".nimbus-related__fetch")).not.toBeNull();
    expect(el.querySelector(".nimbus-related__capture")).toBeNull();
  });
});
```

**The real signature** is `renderHeader(doc, state, onChoose?, onFetch?)` (`panel-view.ts:477`). Add the two new callbacks as parameters **5 and 6** — `onCapture?: () => void`, then `onRecapture?: () => void` — so every existing caller keeps compiling untouched. That is why the tests above pass `undefined` for the middle arguments.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/panel-view.test.ts`
Expected: FAIL — no `captured` arm, no `.nimbus-related__capture`.

- [ ] **Step 3: Add the header arm and the renders**

Add to the `HeaderState` union in `src/panel/panel-view.ts`:

```ts
  | {
      /**
       * A copy the user captured, not connector data. Reached by capturing just
       * now OR by opening the panel on a page captured weeks ago — the panel
       * cannot tell the two apart and must not try, because presenting an old
       * copy as connector data is the dishonesty this arm exists to prevent.
       *
       * NO surface line: an unrecognised page has no recognition to source one
       * from, and its absence is part of the honesty.
       */
      readonly kind: "captured";
      readonly item: ResolvedItem;
      /** Frozen at the moment the header was built, like `resolved`'s own age. */
      readonly ageNowMs: number;
    }
```

Render it with the item's title, the shared `Updated <age>` line, a plain sentence naming it a copy you saved rather than connector data, and an **Update this copy** button carrying class `nimbus-related__recapture`. Append the capture offer — class `nimbus-related__capture`, label **Save a copy to Nimbus** — to every state for which `offersCapture(state)` is true, after that state's own content, so the Options hint on `unrecognised` survives above it.

- [ ] **Step 4: Add the styles**

In `src/panel/panel-in-page.ts`'s `STYLES` template literal, beside the existing action rules:

```css
.nimbus-related__recapture { margin-top: 6px; font-size: 11px; opacity: .75; }
```

`.nimbus-related__capture` needs no rule of its own — it also carries `nimbus-related__action`, which is already styled.

- [ ] **Step 5: Run the tests and the gates**

Run: `bunx vitest run test/unit/panel-view.test.ts && bun run typecheck && bun run lint`
Expected: PASS, exit 0, clean.

- [ ] **Step 6: Commit**

```bash
git add src/panel/panel-view.ts src/panel/panel-in-page.ts test/unit/panel-view.test.ts
git commit -m "feat(panel): a captured-copy header, and the offer that leads to it

The captured arm names the item, dates it with the same Updated wording
the resolved arm uses, and says plainly that this is a copy you saved
rather than connector data. It renders no surface line, because an
unrecognised page has none — and that absence is part of the honesty.

The offer appears on every state offersCapture() allows, appended after
that state's own content so the unrecognised page keeps its Options hint
above it: a real connector still beats a scrape.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: The capture state machine

**Files:**
- Modify: `src/panel/panel-in-page.ts`
- Test: `test/unit/panel-in-page.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: no exported surface; the panel wires `onCapture` / `onRecapture` and owns the flow.

**Context you need.** C3.1's `sendFetch` (`panel-in-page.ts:1226`) is the precedent for this whole shape: a latch flag, a `fetchState` override that wins in `shownHeader()`, a `generation` guard after every `await`, and a `paint()` per transition. **Read `sendFetch` and `shownHeader()` before writing this** and mirror them; do not invent a second pattern for the same job.

The states are: idle → capturing → previewing → sending → (re-resolve). Each non-idle state replaces the offer button with a status line, and that matters most when the preview is OFF — with no confirm step, those lines are the *only* feedback across an injection, a POST and a resolve, and a button that does nothing visible reads as broken.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/panel-in-page.test.ts`, following the file's existing per-message-kind resolver style:

```ts
  test("capture: preview OFF sends the clip and then re-resolves", async () => {
    const sent: string[] = [];
    // resolve → unrecognised, capture → ok with no preview, clip → created
    mountPanelWith((msg) => {
      sent.push(msg.kind);
      if (msg.kind === "capture") {
        return { kind: "capture", ok: true, capture: CAPTURE, preview: null };
      }
      if (msg.kind === "clip") return { kind: "clip", ok: true, status: "created" };
      return UNRECOGNISED_RESOLVE;
    });
    await flush();
    clickCapture();
    await flush();
    expect(sent).toContain("capture");
    expect(sent).toContain("clip");
    // The re-resolve is what turns the header into the captured arm.
    expect(sent.filter((k) => k === "resolve").length).toBeGreaterThan(1);
  });

  test("capture: preview ON does NOT clip until Send is clicked", async () => {
    const sent: string[] = [];
    mountPanelWith((msg) => {
      sent.push(msg.kind);
      if (msg.kind === "capture") {
        return { kind: "capture", ok: true, capture: CAPTURE, preview: PREVIEW };
      }
      return UNRECOGNISED_RESOLVE;
    });
    await flush();
    clickCapture();
    await flush();
    expect(sent).not.toContain("clip");
    clickSend();
    await flush();
    expect(sent).toContain("clip");
  });

  test("capture: a url-changed refusal says so and does not clip", async () => {
    const sent: string[] = [];
    mountPanelWith((msg) => {
      sent.push(msg.kind);
      if (msg.kind === "capture") return { kind: "capture", ok: false, reason: "url-changed" };
      return UNRECOGNISED_RESOLVE;
    });
    await flush();
    clickCapture();
    await flush();
    expect(sent).not.toContain("clip");
    expect(panelText()).toMatch(/moved|changed/i);
  });

  test("capture: a second click while one is in flight sends only one capture", async () => {
    const sent: string[] = [];
    mountPanelWith((msg) => {
      sent.push(msg.kind);
      if (msg.kind === "capture") {
        return { kind: "capture", ok: true, capture: CAPTURE, preview: PREVIEW };
      }
      return UNRECOGNISED_RESOLVE;
    });
    await flush();
    clickCapture();
    clickCapture();
    await flush();
    expect(sent.filter((k) => k === "capture")).toHaveLength(1);
  });
```

**The real harness, so you write against it rather than inventing one.** `test/unit/panel-in-page.test.ts` defines `mountPanelWithScript(sent, script)` (`:105`), which mocks `harness.sendMessage` and **throws on any kind other than `resolve`, `fetch` or `related`**. So your first change is to extend its `script` parameter and its allow-list to accept `capture` and `clip` — extend the existing helper, do not fork it.

Also already present and to be reused: `flush()` (`:30`), `headerText()` (`:60`), `clickFetch(root)` (`:144`), `clickPreviewSend(root)` (`:150`), `clickPreviewCancel(root)` (`:156`). Add `clickCapture(root)` and `clickRecapture(root)` next to `clickFetch`, in the same by-class style and for the same stated reason — selecting "the first button" is ambiguous once a preview can be open:

```ts
/** Selects the capture offer — by CLASS, for the same reason as `clickFetch`. */
function clickCapture(root: ParentNode): void {
  root.querySelector<HTMLButtonElement>("button.nimbus-related__capture")?.click();
}

/** Selects the captured header's "Update this copy" control — by class, same reason. */
function clickRecapture(root: ParentNode): void {
  root.querySelector<HTMLButtonElement>("button.nimbus-related__recapture")?.click();
}
```

In the test bodies above, read `panelText()` as `headerText()`, `mountPanelWith(...)` as the extended `mountPanelWithScript(sent, script)`, and `clickSend()` as `clickPreviewSend(body)` — the preview's Send control is shared with the fetch confirm, so it keeps its existing class and helper.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/panel-in-page.test.ts`
Expected: FAIL — there is no capture button to click.

- [ ] **Step 3: Implement the state machine**

Mirror `sendFetch`'s structure:

```ts
  /** Mirrors `fetchState`: an override that wins in `shownHeader()` while a
   *  capture is in flight or awaiting confirmation. */
  let captureState: HeaderState | null = null;
  /** The captured page, held between the preview and Send. */
  let pendingCapture: CaptureResult | null = null;
  /** One capture at a time — the same rule, and the same reason, as `fetchSent`. */
  let capturing = false;
```

`sendCapture()`: return early if `capturing`; set `capturing = true`, set the "Capturing this page…" state, `paint()`, `await sendMessage({kind: "capture", pageUrl: pinnedUrl})`, re-check `generation` after the await. On refusal, render the reason and clear `capturing`. On success with `preview === null`, go straight to `sendCapturedClip()`. On success with a preview, stash `pendingCapture`, render the preview with Send/Cancel.

`sendCapturedClip()`: set "Saving to Nimbus…", `paint()`, `await sendMessage({kind: "clip", capture: pendingCapture, tags: []})`, re-check `generation`. On success clear `captureState` and `await loadHeader()` — the re-resolve is what produces the captured header, exactly as `sendFetch` re-resolves after an `indexed` outcome. On failure render an honest error and clear `capturing`.

Cancel clears `pendingCapture`, `captureState` and `capturing`.

Add the four `CaptureError` lines — `restricted` ("Nimbus can't capture browser system pages."), `url-changed` ("You've moved on — this panel is still about the page you opened it on."), `injection-failed` ("Couldn't read this page."), `empty` ("There's nothing readable on this page to save.") — as a `Record<CaptureError, string>` next to the existing message tables, so the four reasons stay four distinct answers rather than one generic failure.

Wire `onRecapture` to the same `sendCapture()`. It is the identical flow: `POST /v1/clips` upserts on the canonicalised URL, so a re-capture updates the one item rather than creating a second.

Finally, extend `shownHeader()` so `captureState` wins when set — read its existing `fetchState` branch and add the new one beside it with the same precedence reasoning.

- [ ] **Step 4: Run the tests and the gates**

Run: `bunx vitest run test/unit/panel-in-page.test.ts test/unit/panel-view.test.ts && bun run typecheck && bun run lint`
Expected: PASS, exit 0, clean.

- [ ] **Step 5: Commit**

```bash
git add src/panel/panel-in-page.ts test/unit/panel-in-page.test.ts
git commit -m "feat(panel): capture, confirm, save, and re-resolve

Mirrors C3.1's sendFetch: one latch, a state that wins in shownHeader(),
a generation guard after every await, one paint per transition.

Every in-flight state renders. That matters most with the 1.3 preview
switched OFF, where there is no confirm step and the status lines are the
only sign that an injection, a POST and a resolve are happening.

Update this copy runs the identical flow: ingest upserts on the
canonicalised url, so a re-capture refreshes the one item.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Docs, changelog, and three stale roadmap claims

**Files:**
- Modify: `CHANGELOG.md`, `ROADMAP.md`, `docs/architecture.md`, `docs/development.md`

- [ ] **Step 1: Changelog**

Under `## [Unreleased]` → `### Added`, inserted directly beneath the heading (this file's convention):

```markdown
- **Save a copy when Nimbus can't reach a page itself.** On a site Nimbus has no
  connector for — an internal wiki, a vendor console — the panel now offers to
  save a copy of the page so your agents have something to work with. It appears
  only where nothing better is available: if Nimbus can fetch the page properly,
  it still offers that instead.
- **A saved copy says it is one.** A page you captured is labelled as your own
  copy rather than connector data, whether you saved it a minute ago or a month
  ago, and can be refreshed with **Update this copy**.
```

- [ ] **Step 2: Roadmap — the item, and three stale claims**

Mark **C3.2** shipped, and append a Status block recording that the offer is gated on the gateway having nothing left to try, that re-capture ships, and that the honesty is keyed on the item rather than the moment. Cite `docs/superpowers/specs/2026-08-16-capture-as-last-resort-design.md`.

Then correct the three places that still describe this item's blockers as open — **Nimbus#1005** and **Nimbus#1006** both closed on 2026-08-11:

1. C3.2's own `**Depends**` line — replace with a note that both closed and when.
2. Pillar 2's "Two open defects gate this pillar and should be cleared before it grows" paragraph — they are cleared; say so and keep the history.
3. The north-star naming section's "**Sequencing: Nimbus#1006 resolves first**" bullet — its premise ("while **Nimbus#1006** is live") no longer holds. **Do not decide the rename here.** Flag that the sequencing argument needs re-reading now that its blocker is gone, and leave the decision alone: it is not this slice's to make.

- [ ] **Step 3: Architecture**

Add a `####` subsection under the panel/recognition material describing: which header states offer capture and why a fetchable miss does not; that capture refuses on a pinned-URL mismatch because the DOM cannot be pinned; that the scheme guard lives in the worker because the caller is a content script; and that the captured-copy header keys off `service`/`type` rather than recency, with the upstream coupling named.

- [ ] **Step 4: Development checklist**

Append a `## Manual verification — Capture as the last resort (C3.2)` section matching the file's existing per-feature heading pattern, with **numbered** steps like its siblings: capture on a real unrecognised page; confirm the copy is labelled as yours; reopen the panel on it later and confirm it is *still* labelled as yours; run **Update this copy** and confirm the gateway reports `updated` and one item exists, not two; navigate an SPA mid-capture and confirm the `url-changed` refusal; and switch the 1.3 preview off and confirm the status lines still appear.

- [ ] **Step 5: Run every gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all green, zero test failures. `check-build` runs **after** `build`.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md ROADMAP.md docs/
git commit -m "docs: record capture as the last resort, and unstick pillar 2

C3.2's stated blockers, Nimbus#1005 and #1006, both closed on
2026-08-11. The roadmap still called them open in three places: this
item's Depends line, pillar 2's gate paragraph, and the north-star
sequencing bullet that holds a rename behind #1006 being live. The
first two are corrected; the third is flagged rather than decided,
because the rename is not this slice's call.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Decision 1 → Task 1 (predicate) + Task 5 (render). Decision 2 → Task 2 (`expectedUrl`, refuse before injecting) + Task 4 (pinned URL passed through) + Task 6 (`url-changed` line). Decision 3 → Task 3 (`preview: ClipPreview | null`) + Task 4 (pref read in the worker) + Task 6 (in-flight lines, tested with the preview off). Decision 4 → Task 1 (`isCapturedCopy`, constants + coupling comment) + Task 5 (the arm, no surface line). Decision 5 (lanes need no change) → deliberately no task; Task 7's architecture note records why. Decision 6 → Task 6 (`capturing` latch, `onRecapture`) + Task 5 (the control). The `capture-tab.ts` security requirement → Task 2 Steps 1/3 with a no-injection assertion. Roadmap corrections → Task 7 Step 2.

**Type consistency.** `CaptureError` is defined in Task 1 and consumed in Tasks 2, 3 and 6. `CaptureOutcome` / `captureTab` defined in Task 2, consumed in Task 4. `CaptureRequest` / `CaptureResponse` defined in Task 3, consumed in Tasks 4 and 6. `offersCapture` / `isCapturedCopy` defined in Task 1, consumed in Task 5. `CLIP_SERVICE` / `CLIP_TYPE` defined once in `types.ts` (Task 1) and read only by `capture-offer.ts`.

**Soft spots, resolved rather than flagged.** All three unknowns in the first draft were looked up and pinned: `renderHeader`'s real signature is `(doc, state, onChoose?, onFetch?)` so the new callbacks are parameters 5 and 6; `tabUrl` **already exists** at `src/browser/tabs.ts:49` with the exact shape Task 4 needs, so Task 4 imports rather than adds; and Task 6 now names the real test harness (`mountPanelWithScript`, `flush`, `headerText`, `clickPreviewSend`) plus the one change it needs — that helper currently **throws** on any message kind but `resolve`/`fetch`/`related`, so it must be extended to allow `capture` and `clip` before any Task 6 test can run.

**One judgement call worth a reviewer's eye.** Task 5 appends the capture offer *after* each eligible state's own content, so `unrecognised` keeps its "add this site in Options" hint above the button. That is deliberate — a real connector beats a scrape, and a self-hosted Bitbucket should still be configured rather than captured — but it does mean that state now carries two calls to action.
