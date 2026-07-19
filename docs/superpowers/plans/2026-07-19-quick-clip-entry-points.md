# Quick-Clip Entry Points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clip the active tab without opening the popup — via a right-click context menu and rebindable keyboard shortcuts — for both "clip page" and "clip selection", confirmed by an injected in-page toast (toolbar-badge fallback on restricted pages).

**Architecture:** The background service worker owns two new triggers (`contextMenus.onClicked`, `commands.onCommand`). Each calls a pure `quickClip(deps, mode)` that captures the active tab (reusing `runCapture`), runs the existing `handleClip` (POST + offline queue), and shows feedback. Feedback is a shadow-DOM toast injected like the related panel, with a badge flash where injection can't run.

**Tech Stack:** TypeScript (strict), esbuild IIFE bundles, Vitest + the `chrome-mock` harness, MV3 (`chrome.*`).

## Global Constraints

- **Locked HTTP contract** — quick clips use `POST /v1/clips` via the existing `handleClip`; no contract or gateway change.
- **Loopback-only** — no new `host_permissions`; only `contextMenus` is added to `permissions`.
- **TypeScript strict, no `any`** — use `unknown` + narrowing at boundaries. **No `console.*` in `src/`.** Biome clean (`bun run lint`).
- **XSS-safe injection** — the toast is `textContent` only (no `innerHTML`, no anchors), in a shadow root with inlined `<style>`, exactly like `panel-in-page.ts`.
- **Never log the token / pairing code.** Not touched here, but the toast shows only clip status + the page's own title.
- **Default keys:** `clip-page` = `Alt+Shift+C`, `clip-selection` = `Alt+Shift+S` (existing `show_related` = `Alt+Shift+R`, unchanged). Rebindable by the user.
- **Commands:** `bun run typecheck`, `bun run lint`, `bun run test` (single file: `bun run test -- <name>`), `bun run build`, `bun run check-build`.
- **Test conventions:** `.ts` in `test/unit/`; DOM tests add `// @vitest-environment jsdom` as the first line; the shared harness is `test/unit/helpers/chrome-mock.ts` (`installChromeMock()` → handles + `emit*`).

## Design decision (deviation from spec, deliberate)

The spec suggested extracting the popup's capture front-half into a shared
`captureForClip` helper used by both the popup and `quickClip`. **This plan does
not** — `quickClip` inlines `activeTab` + `runCapture` (two lines). Rationale:
avoid modifying the shipped, well-tested `popup.ts` for a 2-line DRY win; the
duplication is trivial and keeps the popup at zero regression risk. `quickClip`
still reuses the pure `buildClipPayload` (inside `handleClip`) and the whole
clip+enqueue back-half, so behavior is identical.

## File Structure

- **Create:** `src/browser/context-menus.ts`, `src/capture/toast-view.ts`,
  `src/capture/toast-in-page.ts`, `src/background/quick-clip.ts`,
  `src/background/feedback.ts`; matching `test/unit/*.test.ts`.
- **Modify:** `src/manifest/manifest.ts`, `src/shared/types.ts`,
  `src/browser/runtime.ts`, `src/browser/scripting.ts`, `src/browser/action.ts`,
  `src/background/service-worker.ts`, `test/unit/helpers/chrome-mock.ts`,
  `store/listing.md`, `esbuild.mjs`, `scripts/check-build.mjs`,
  `test/unit/manifest.test.ts`, `test/unit/service-worker.test.ts`,
  `CHANGELOG.md`, `docs/development.md`.

---

### Task 1: Manifest — `contextMenus` permission + two commands

**Files:**
- Modify: `src/manifest/manifest.ts`
- Modify: `store/listing.md`
- Test: `test/unit/manifest.test.ts`, `test/unit/store-listing.test.ts` (kept green)

**Interfaces:**
- Produces: `permissions` includes `"contextMenus"`; `commands["clip-page"]` and `commands["clip-selection"]` with default keys. Later tasks route these commands.

- [ ] **Step 1: Failing test** — add to `test/unit/manifest.test.ts` inside the `describe("composeManifest", …)` block:

```ts
  test("declares the contextMenus permission (for right-click clipping)", () => {
    for (const target of BROWSER_TARGETS) {
      expect(composeManifest(target, "1.2.3").permissions).toContain("contextMenus");
    }
  });

  test("declares clip-page and clip-selection commands with default keys", () => {
    const m = composeManifest("chrome", "1.2.3");
    expect(m.commands["clip-page"]?.suggested_key.default).toBe("Alt+Shift+C");
    expect(m.commands["clip-selection"]?.suggested_key.default).toBe("Alt+Shift+S");
  });
```

- [ ] **Step 2: Run → fail**

Run: `bun run test -- manifest`
Expected: FAIL — `contextMenus` not in permissions; `clip-page` undefined. (Also a typecheck error on `commands["clip-page"]` until Step 3.)

- [ ] **Step 3: Implement** — in `src/manifest/manifest.ts`:

Replace the `ManifestCommands` interface:

```ts
interface CommandDef {
  readonly suggested_key: { readonly default: string };
  readonly description: string;
}

interface ManifestCommands {
  readonly show_related: CommandDef;
  readonly "clip-page": CommandDef;
  readonly "clip-selection": CommandDef;
}
```

Add `contextMenus` to `permissions` in `composeManifest`:

```ts
    permissions: ["activeTab", "scripting", "storage", "alarms", "contextMenus"],
```

Replace the `commands` object in `composeManifest`:

```ts
    commands: {
      show_related: {
        suggested_key: { default: "Alt+Shift+R" },
        description: "Show related items in Nimbus",
      },
      "clip-page": {
        suggested_key: { default: "Alt+Shift+C" },
        description: "Clip the current page to Nimbus",
      },
      "clip-selection": {
        suggested_key: { default: "Alt+Shift+S" },
        description: "Clip the current selection to Nimbus",
      },
    },
```

- [ ] **Step 4: Add the listing justification** — in `store/listing.md`, under `## Permission justifications`, add a bullet (keeps the manifest↔listing parity test equal):

```markdown
- `contextMenus`: Add right-click "Clip page / Clip selection to Nimbus" menu entries so a page can be clipped without opening the popup.
```

- [ ] **Step 5: Run → pass**

Run: `bun run test -- manifest && bun run test -- store-listing && bun run typecheck`
Expected: PASS (manifest tests green; the parity test in `store-listing` still balances with the new permission + justification).

- [ ] **Step 6: Commit**

```bash
git add src/manifest/manifest.ts store/listing.md test/unit/manifest.test.ts
git commit -m "feat(manifest): contextMenus permission + clip-page/clip-selection commands"
```

---

### Task 2: `browser/context-menus.ts` seam + `runtime.addInstalledListener` + harness

**Files:**
- Create: `src/browser/context-menus.ts`
- Modify: `src/browser/runtime.ts`
- Modify: `test/unit/helpers/chrome-mock.ts` (additive — `contextMenus`, `onInstalled`)
- Test: `test/unit/context-menus.test.ts`

**Interfaces:**
- Produces: `createMenu(item)`, `removeAllMenus()`, `addMenuClickListener(fn)`; `addInstalledListener(fn)`. Harness gains `contextMenusCreate`, `contextMenusRemoveAll`, `emitMenuClick(menuItemId, tabId?)`, `emitInstalled()`.

- [ ] **Step 1: Extend the harness** — in `test/unit/helpers/chrome-mock.ts`:

Add to `ChromeHarness` (after `alarmListeners`):

```ts
  readonly contextMenusCreate: ReturnType<typeof vi.fn>;
  readonly contextMenusRemoveAll: ReturnType<typeof vi.fn>;
  /** Fire a context-menu click. */
  emitMenuClick(menuItemId: string, tabId?: number): void;
  /** Fire runtime.onInstalled. */
  emitInstalled(): void;
```

In `installChromeMock`, add the backing state + fns (near the other `vi.fn`s):

```ts
  const menuClickListeners: Array<(info: { menuItemId: string }, tab?: { id?: number }) => void> = [];
  const installedListeners: Array<() => void> = [];
  const contextMenusCreate = vi.fn();
  const contextMenusRemoveAll = vi.fn(async (): Promise<void> => undefined);
```

Add to `fakeChrome`:

```ts
    contextMenus: {
      create: contextMenusCreate,
      removeAll: contextMenusRemoveAll,
      onClicked: {
        addListener: (cb: (info: { menuItemId: string }, tab?: { id?: number }) => void): void => {
          menuClickListeners.push(cb);
        },
      },
    },
```

Extend the existing `runtime` object with `onInstalled`:

```ts
      onInstalled: {
        addListener: (cb: () => void): void => {
          installedListeners.push(cb);
        },
      },
```

Add the emit helpers (near `emitAlarm`) and include them + the two fns in the returned object:

```ts
  function emitMenuClick(menuItemId: string, tabId?: number): void {
    for (const cb of menuClickListeners) {
      cb({ menuItemId }, tabId === undefined ? undefined : { id: tabId });
    }
  }
  function emitInstalled(): void {
    for (const cb of installedListeners) {
      cb();
    }
  }
```

- [ ] **Step 2: Write the failing seam test** — `test/unit/context-menus.test.ts`:

```ts
import { afterEach, describe, expect, test } from "vitest";
import {
  addMenuClickListener,
  createMenu,
  removeAllMenus,
} from "../../src/browser/context-menus.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

let harness: ChromeHarness;
afterEach(() => {
  harness.restore();
});

describe("browser/context-menus seam", () => {
  test("createMenu forwards id, title, contexts to chrome.contextMenus.create", () => {
    harness = installChromeMock();
    createMenu({ id: "clip-page", title: "Clip page to Nimbus", contexts: ["page"] });
    expect(harness.contextMenusCreate).toHaveBeenCalledWith({
      id: "clip-page",
      title: "Clip page to Nimbus",
      contexts: ["page"],
    });
  });

  test("removeAllMenus calls chrome.contextMenus.removeAll", async () => {
    harness = installChromeMock();
    await removeAllMenus();
    expect(harness.contextMenusRemoveAll).toHaveBeenCalled();
  });

  test("addMenuClickListener forwards menuItemId + tab id", () => {
    harness = installChromeMock();
    let seen: { id: string; tab?: number } | undefined;
    addMenuClickListener((menuItemId, tabId) => {
      seen = { id: menuItemId, ...(tabId === undefined ? {} : { tab: tabId }) };
    });
    harness.emitMenuClick("clip-selection", 7);
    expect(seen).toEqual({ id: "clip-selection", tab: 7 });
  });
});
```

- [ ] **Step 3: Run → fail**

Run: `bun run test -- context-menus`
Expected: FAIL — module `../../src/browser/context-menus.ts` not found.

- [ ] **Step 4: Implement the seam** — `src/browser/context-menus.ts`:

```ts
// Thin typed seam over chrome.contextMenus — the only place the API is touched,
// so the SW's menu logic stays unit-testable.
export interface MenuItem {
  readonly id: string;
  readonly title: string;
  readonly contexts: readonly chrome.contextMenus.ContextType[];
}

export function createMenu(item: MenuItem): void {
  chrome.contextMenus.create({ id: item.id, title: item.title, contexts: [...item.contexts] });
}

export async function removeAllMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
}

export function addMenuClickListener(
  fn: (menuItemId: string, tabId: number | undefined) => void,
): void {
  chrome.contextMenus.onClicked.addListener((info, tab) => fn(String(info.menuItemId), tab?.id));
}
```

Add to `src/browser/runtime.ts`:

```ts
export function addInstalledListener(fn: () => void): void {
  chrome.runtime.onInstalled.addListener(() => fn());
}
```

- [ ] **Step 5: Run → pass, and confirm the whole suite still green** (harness change is additive)

Run: `bun run test -- context-menus && bun run test && bun run typecheck && bun run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/browser/context-menus.ts src/browser/runtime.ts test/unit/helpers/chrome-mock.ts test/unit/context-menus.test.ts
git commit -m "feat(browser): context-menus seam + runtime.onInstalled + harness mocks"
```

---

### Task 3: `ToastState` type + pure `toast-view.ts`

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/capture/toast-view.ts`
- Test: `test/unit/toast-view.test.ts`

**Interfaces:**
- Produces: `type ToastVariant`, `interface ToastState`; `renderToast(doc, state) → HTMLElement`.

- [ ] **Step 1: Add the type** — append to `src/shared/types.ts`:

```ts
/** The three feedback states a quick-clip toast can show. */
export type ToastVariant = "success" | "offline" | "error";

export interface ToastState {
  readonly variant: ToastVariant;
  readonly text: string;
}
```

- [ ] **Step 2: Failing test** — `test/unit/toast-view.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { renderToast } from "../../src/capture/toast-view.ts";

describe("renderToast", () => {
  test("renders the text and an aria live-region status role", () => {
    const el = renderToast(document, { variant: "success", text: "Clipped to Nimbus." });
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.querySelector(".nimbus-toast__text")?.textContent).toBe("Clipped to Nimbus.");
    expect(el.classList.contains("nimbus-toast--success")).toBe(true);
  });

  test("variant sets the class", () => {
    expect(renderToast(document, { variant: "offline", text: "x" }).className).toContain(
      "nimbus-toast--offline",
    );
    expect(renderToast(document, { variant: "error", text: "x" }).className).toContain(
      "nimbus-toast--error",
    );
  });

  test("text is inert — markup is not parsed as HTML (XSS backstop)", () => {
    const el = renderToast(document, { variant: "error", text: "<img src=x onerror=alert(1)>" });
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".nimbus-toast__text")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });
});
```

- [ ] **Step 3: Run → fail**

Run: `bun run test -- toast-view`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** — `src/capture/toast-view.ts`:

```ts
import type { ToastState } from "../shared/types.ts";

const ICONS: Record<ToastState["variant"], string> = {
  success: "✓",
  offline: "⏳",
  error: "⚠",
};

/** Build the toast element with textContent only (no innerHTML/anchors). */
export function renderToast(doc: Document, state: ToastState): HTMLElement {
  const el = doc.createElement("div");
  el.className = `nimbus-toast nimbus-toast--${state.variant}`;
  // A polite live region so screen readers announce the result without stealing focus.
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");

  const icon = doc.createElement("span");
  icon.className = "nimbus-toast__icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = ICONS[state.variant];

  const text = doc.createElement("span");
  text.className = "nimbus-toast__text";
  text.textContent = state.text;

  el.append(icon, text);
  return el;
}
```

- [ ] **Step 5: Run → pass**

Run: `bun run test -- toast-view && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/capture/toast-view.ts test/unit/toast-view.test.ts
git commit -m "feat(capture): ToastState type + pure toast-view renderer"
```

---

### Task 4: `toast-in-page.ts` injected entry + build wiring

**Files:**
- Create: `src/capture/toast-in-page.ts`
- Modify: `esbuild.mjs`, `scripts/check-build.mjs`
- Test: `test/unit/toast-in-page.test.ts`

**Interfaces:**
- Consumes: `renderToast` (Task 3), `ToastState`.
- Produces: bundled `toast.js` exposing `globalThis.__nimbusToast(state)` — singleton shadow host, ~2.5s auto-dismiss, repeat-replaces-and-resets, idempotent on re-injection.

- [ ] **Step 1: Failing test** — `test/unit/toast-in-page.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToastState } from "../../src/shared/types.ts";

const HOST_ID = "nimbus-toast-host";

function toast(): (s: ToastState) => void {
  return (globalThis as unknown as { __nimbusToast: (s: ToastState) => void }).__nimbusToast;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.innerHTML = "<head></head><body></body>";
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("toast-in-page (__nimbusToast)", () => {
  test("mounts one shadow host, renders the text, and auto-dismisses", async () => {
    await import("../../src/capture/toast-in-page.ts");
    toast()({ variant: "success", text: "Clipped to Nimbus." });

    const host = document.getElementById(HOST_ID);
    expect(host).not.toBeNull();
    expect(host?.shadowRoot?.querySelector(".nimbus-toast__text")?.textContent).toBe(
      "Clipped to Nimbus.",
    );

    vi.advanceTimersByTime(2500);
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  test("a repeat call replaces content + resets the timer (single host)", async () => {
    await import("../../src/capture/toast-in-page.ts");
    toast()({ variant: "success", text: "first" });
    vi.advanceTimersByTime(2000);
    toast()({ variant: "offline", text: "second" });

    const hosts = document.querySelectorAll(`#${HOST_ID}`);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.shadowRoot?.querySelector(".nimbus-toast__text")?.textContent).toBe("second");

    // timer was reset: 2000+1000 = 3000 elapsed since first, but only 1000 since reset → still up
    vi.advanceTimersByTime(1000);
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    vi.advanceTimersByTime(1500);
    expect(document.getElementById(HOST_ID)).toBeNull();
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `bun run test -- toast-in-page`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/capture/toast-in-page.ts`:

```ts
// Injected as dist/<target>/toast.js. Defines globalThis.__nimbusToast(state); the
// SW calls it after injecting this file (two-step, like capture.js). A single
// shadow-DOM host lives at HOST_ID: a repeat call replaces its content and resets
// the auto-dismiss timer. Re-injecting this file just re-assigns __nimbusToast — no
// duplicate hosts or listeners.
import type { ToastState } from "../shared/types.ts";
import { renderToast } from "./toast-view.ts";

const HOST_ID = "nimbus-toast-host";
const DISMISS_MS = 2500;

const STYLES = `
:host { all: initial; }
.nimbus-toast {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 320px;
  padding: 10px 14px;
  border-radius: 10px;
  font-family: system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.3;
  color: #ffffff;
  background: #275fd4;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
}
.nimbus-toast--offline { background: #6b5b16; }
.nimbus-toast--error { background: #a03434; }
.nimbus-toast__icon { font-size: 15px; }
.nimbus-toast__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

interface ToastHost extends HTMLElement {
  __nimbusTimer?: ReturnType<typeof setTimeout>;
}

function show(state: ToastState): void {
  let host = document.getElementById(HOST_ID) as ToastHost | null;
  let root: ShadowRoot;
  if (host === null) {
    host = document.createElement("div") as ToastHost;
    host.id = HOST_ID;
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    root.append(style);
    document.documentElement.append(host);
  } else {
    root = host.shadowRoot as ShadowRoot;
    root.querySelector(".nimbus-toast")?.remove();
    if (host.__nimbusTimer !== undefined) {
      clearTimeout(host.__nimbusTimer);
    }
  }
  root.append(renderToast(document, state));
  const current = host;
  current.__nimbusTimer = setTimeout(() => current.remove(), DISMISS_MS);
}

(globalThis as unknown as { __nimbusToast?: (s: ToastState) => void }).__nimbusToast = show;
```

- [ ] **Step 4: Wire the build** — in `esbuild.mjs`, add to `ENTRIES`:

```js
  { in: "src/capture/toast-in-page.ts", out: "toast" },
```

In `scripts/check-build.mjs`, add to `REQUIRED_FILES`:

```js
  "toast.js",
```

- [ ] **Step 5: Run → pass, and build**

Run: `bun run test -- toast-in-page && bun run typecheck`
Expected: PASS.
Run: `bun run build && bun run check-build`
Expected: build OK; `check-build: OK` (with `toast.js` now required and present in both targets).

- [ ] **Step 6: Commit**

```bash
git add src/capture/toast-in-page.ts esbuild.mjs scripts/check-build.mjs test/unit/toast-in-page.test.ts
git commit -m "feat(capture): injected toast (toast.js) + build/check-build wiring"
```

---

### Task 5: `quick-clip.ts` orchestration

**Files:**
- Create: `src/background/quick-clip.ts`
- Test: `test/unit/quick-clip.test.ts`

**Interfaces:**
- Consumes: `ClipRequest`/`ClipResponse` (`shared/messages.ts`), `CaptureResult`/`ToastState` (`shared/types.ts`).
- Produces: `isRestrictedUrl(url)`, `toToastState(res)`, `quickClip(deps, mode)`, `interface QuickClipDeps`.

- [ ] **Step 1: Failing test** — `test/unit/quick-clip.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import {
  isRestrictedUrl,
  type QuickClipDeps,
  quickClip,
  toToastState,
} from "../../src/background/quick-clip.ts";
import type { ClipResponse } from "../../src/shared/messages.ts";
import type { CaptureResult } from "../../src/shared/types.ts";

const CAPTURE: CaptureResult = {
  url: "https://ex.com/a",
  title: "An Article",
  mode: "article",
  body: "text",
  readableFound: true,
};

function deps(over: Partial<QuickClipDeps> = {}): {
  d: QuickClipDeps;
  clip: ReturnType<typeof vi.fn>;
  feedback: ReturnType<typeof vi.fn>;
} {
  const clip = vi.fn(async (): Promise<ClipResponse> => ({ kind: "clip", ok: true, status: "created", bookmarked: false }));
  const feedback = vi.fn(async (): Promise<void> => undefined);
  const d: QuickClipDeps = {
    activeTab: vi.fn(async () => ({ id: 1, url: "https://ex.com/a", title: "An Article" })),
    runCapture: vi.fn(async () => CAPTURE),
    clip,
    showFeedback: feedback,
    ...over,
  };
  return { d, clip, feedback };
}

describe("isRestrictedUrl", () => {
  test("flags non-injectable schemes", () => {
    expect(isRestrictedUrl("chrome://extensions")).toBe(true);
    expect(isRestrictedUrl("about:debugging")).toBe(true);
    expect(isRestrictedUrl("view-source:https://x")).toBe(true);
    expect(isRestrictedUrl("https://example.com/a")).toBe(false);
    expect(isRestrictedUrl("not a url")).toBe(true);
  });
});

describe("toToastState", () => {
  test("maps clip responses to toast states", () => {
    expect(toToastState({ kind: "clip", ok: true, status: "created", bookmarked: false }).text).toBe("Clipped to Nimbus.");
    expect(toToastState({ kind: "clip", ok: true, status: "updated", bookmarked: false }).text).toBe("Updated in Nimbus.");
    expect(toToastState({ kind: "clip", ok: true, status: "created", bookmarked: true }).text).toBe("Saved as a bookmark.");
    expect(toToastState({ kind: "clip", ok: false, reason: "unreachable", queued: true })).toEqual({ variant: "offline", text: "Offline — saved to retry queue." });
    expect(toToastState({ kind: "clip", ok: false, reason: "not_paired" })).toEqual({ variant: "error", text: "Pair a browser first (Options)." });
  });
});

describe("quickClip", () => {
  test("captures, clips, and shows the success toast", async () => {
    const { d, clip, feedback } = deps();
    await quickClip(d, "article");
    expect(clip).toHaveBeenCalledWith({ kind: "clip", capture: CAPTURE, tags: [] });
    expect(feedback).toHaveBeenCalledWith(1, { variant: "success", text: "Clipped to Nimbus." });
  });

  test("restricted page → error feedback, no capture", async () => {
    const runCapture = vi.fn();
    const { d, clip, feedback } = deps({
      activeTab: vi.fn(async () => ({ id: 2, url: "chrome://extensions", title: "" })),
      runCapture,
    });
    await quickClip(d, "article");
    expect(runCapture).not.toHaveBeenCalled();
    expect(clip).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenCalledWith(2, expect.objectContaining({ variant: "error" }), true);
  });

  test("empty selection → prompt, no clip", async () => {
    const { d, clip, feedback } = deps({
      runCapture: vi.fn(async () => ({ ...CAPTURE, mode: "selection", body: "" })),
    });
    await quickClip(d, "selection");
    expect(clip).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenCalledWith(1, { variant: "error", text: "Select some text first." });
  });

  test("runCapture throws → error feedback (badge)", async () => {
    const { d, clip, feedback } = deps({
      runCapture: vi.fn(async () => { throw new Error("no"); }),
    });
    await quickClip(d, "article");
    expect(clip).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenCalledWith(1, expect.objectContaining({ variant: "error" }), true);
  });

  test("offline clip → offline toast", async () => {
    const { d, feedback } = deps({
      clip: vi.fn(async () => ({ kind: "clip", ok: false, reason: "unreachable", queued: true })),
    });
    await quickClip(d, "article");
    expect(feedback).toHaveBeenCalledWith(1, { variant: "offline", text: "Offline — saved to retry queue." });
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `bun run test -- quick-clip`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/background/quick-clip.ts`:

```ts
import type { ClipRequest, ClipResponse } from "../shared/messages.ts";
import type { CaptureResult, ToastState } from "../shared/types.ts";

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

const ERROR_TEXT: Record<string, string> = {
  not_paired: "Pair a browser first (Options).",
  unauthorized: "Pairing expired — re-pair in Options.",
  invalid_request: "Couldn't clip this page.",
  server_error: "Nimbus had an error saving this.",
  unreachable: "Can't reach Nimbus — is the gateway running?",
};

/** Map a clip response to the toast to show. */
export function toToastState(res: ClipResponse): ToastState {
  if (res.ok) {
    if (res.bookmarked === true) {
      return { variant: "success", text: "Saved as a bookmark." };
    }
    return {
      variant: "success",
      text: res.status === "updated" ? "Updated in Nimbus." : "Clipped to Nimbus.",
    };
  }
  if (res.queued === true) {
    return { variant: "offline", text: "Offline — saved to retry queue." };
  }
  return { variant: "error", text: ERROR_TEXT[res.reason] ?? "Couldn't clip this page." };
}

export interface QuickClipDeps {
  readonly activeTab: () => Promise<{ id: number; url: string; title: string }>;
  readonly runCapture: (tabId: number, mode: "article" | "selection") => Promise<CaptureResult>;
  readonly clip: (req: ClipRequest) => Promise<ClipResponse>;
  /** Restricted = injection is known to be impossible → go straight to the badge. */
  readonly showFeedback: (tabId: number, state: ToastState, restricted?: boolean) => Promise<void>;
}

const CANT_CLIP: ToastState = { variant: "error", text: "Nimbus can't clip this page." };

export async function quickClip(deps: QuickClipDeps, mode: "article" | "selection"): Promise<void> {
  let tab: { id: number; url: string; title: string };
  try {
    tab = await deps.activeTab();
  } catch {
    return; // no active tab (e.g. no focused window) — nothing to clip
  }
  if (isRestrictedUrl(tab.url)) {
    await deps.showFeedback(tab.id, CANT_CLIP, true);
    return;
  }
  let capture: CaptureResult;
  try {
    capture = await deps.runCapture(tab.id, mode);
  } catch {
    await deps.showFeedback(tab.id, CANT_CLIP, true);
    return;
  }
  if (mode === "selection" && capture.body === "") {
    await deps.showFeedback(tab.id, { variant: "error", text: "Select some text first." });
    return;
  }
  const res = await deps.clip({ kind: "clip", capture, tags: [] });
  await deps.showFeedback(tab.id, toToastState(res));
}
```

- [ ] **Step 4: Run → pass**

Run: `bun run test -- quick-clip && bun run typecheck && bun run lint`
Expected: PASS. (If `ClipResponse`'s `reason` type is a union that makes `ERROR_TEXT[res.reason]` a type error, index with the value directly — the union members are all strings; `Record<string, string>` accepts them.)

- [ ] **Step 5: Commit**

```bash
git add src/background/quick-clip.ts test/unit/quick-clip.test.ts
git commit -m "feat(background): quickClip orchestration (capture → clip → feedback)"
```

---

### Task 6: Feedback module + service-worker wiring

**Files:**
- Modify: `src/browser/scripting.ts` (add `showToast`), `src/browser/action.ts` (add `setBadgeText`)
- Create: `src/background/feedback.ts`
- Modify: `src/background/service-worker.ts`
- Test: `test/unit/feedback.test.ts`, `test/unit/service-worker.test.ts` (extend)
- Modify: `CHANGELOG.md`, `docs/development.md`

**Interfaces:**
- Consumes: `quickClip`/`QuickClipDeps` (Task 5), the seams (Task 2), `ToastState`.
- Produces: `showToast(tabId, state)`, `setBadgeText(text)`, `showFeedback(deps, tabId, state, restricted?)`; the SW registers menus and routes menu clicks + the two commands to `quickClip`.

- [ ] **Step 1: Add the two seam functions**

`src/browser/scripting.ts` — append (import the type at the top: `import type { CaptureResult, ToastState } from "../shared/types.ts";` — extend the existing `CaptureResult` import):

```ts
/** Inject toast.js then call its global with the state (two-step, like runCapture). */
export async function showToast(tabId: number, state: ToastState): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["toast.js"] });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (s: ToastState) =>
      (globalThis as unknown as { __nimbusToast: (x: ToastState) => void }).__nimbusToast(s),
    args: [state],
  });
}
```

`src/browser/action.ts` — append:

```ts
export async function setBadgeText(text: string): Promise<void> {
  await chrome.action.setBadgeText({ text });
}
```

- [ ] **Step 2: Failing test for feedback** — `test/unit/feedback.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { type FeedbackDeps, showFeedback } from "../../src/background/feedback.ts";

function deps(over: Partial<FeedbackDeps> = {}): FeedbackDeps {
  return {
    showToast: vi.fn(async (): Promise<void> => undefined),
    setBadgeText: vi.fn(async (): Promise<void> => undefined),
    restoreBadge: vi.fn(async (): Promise<void> => undefined),
    ...over,
  };
}

describe("showFeedback", () => {
  test("shows the toast on a normal page", async () => {
    const d = deps();
    await showFeedback(d, 1, { variant: "success", text: "ok" });
    expect(d.showToast).toHaveBeenCalledWith(1, { variant: "success", text: "ok" });
    expect(d.setBadgeText).not.toHaveBeenCalled();
  });

  test("restricted → badge flash, no toast attempt", async () => {
    vi.useFakeTimers();
    const d = deps();
    await showFeedback(d, 1, { variant: "error", text: "x" }, true);
    expect(d.showToast).not.toHaveBeenCalled();
    expect(d.setBadgeText).toHaveBeenCalledWith("!");
    vi.advanceTimersByTime(1500);
    expect(d.restoreBadge).toHaveBeenCalled();
    vi.useRealTimers();
  });

  test("toast injection failure → badge fallback", async () => {
    vi.useFakeTimers();
    const d = deps({ showToast: vi.fn(async () => { throw new Error("blocked"); }) });
    await showFeedback(d, 1, { variant: "success", text: "x" });
    expect(d.setBadgeText).toHaveBeenCalledWith("✓");
    vi.advanceTimersByTime(1500);
    expect(d.restoreBadge).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 3: Run → fail**

Run: `bun run test -- feedback`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement feedback** — `src/background/feedback.ts`:

```ts
import type { ToastState } from "../shared/types.ts";

const BADGE_MS = 1500;
const BADGE: Record<ToastState["variant"], string> = { success: "✓", offline: "…", error: "!" };

export interface FeedbackDeps {
  readonly showToast: (tabId: number, state: ToastState) => Promise<void>;
  readonly setBadgeText: (text: string) => Promise<void>;
  /** Repaint the normal (queue-count) badge after the flash. */
  readonly restoreBadge: () => Promise<void>;
}

/**
 * Confirm a quick-clip. Normally an in-page toast; when the page can't host a
 * script (restricted, or injection throws), flash the toolbar badge instead and
 * restore the queue-count badge shortly after (best-effort — the SW is alive
 * right after the clip).
 */
export async function showFeedback(
  deps: FeedbackDeps,
  tabId: number,
  state: ToastState,
  restricted = false,
): Promise<void> {
  if (!restricted) {
    try {
      await deps.showToast(tabId, state);
      return;
    } catch {
      // fall through to the badge fallback
    }
  }
  await deps.setBadgeText(BADGE[state.variant]);
  setTimeout(() => {
    deps.restoreBadge().catch(() => undefined);
  }, BADGE_MS);
}
```

- [ ] **Step 5: Wire the service worker** — in `src/background/service-worker.ts`:

Extend the imports:

```ts
import { setBadgeBackground, setBadgeCount, setBadgeText } from "../browser/action.ts";
import { addCommandListener, addInstalledListener, addMessageListener } from "../browser/runtime.ts";
import { injectPanel, runCapture, showToast } from "../browser/scripting.ts";
import { createMenu, addMenuClickListener, removeAllMenus } from "../browser/context-menus.ts";
import { quickClip, type QuickClipDeps } from "./quick-clip.ts";
import { showFeedback } from "./feedback.ts";
```

After `syncQueueState` is defined, add the shared clip deps + quick-clip wiring:

```ts
const clipDeps = { getConnection, postClip, updateQueue, nowMs: () => Date.now() };

const quickClipDeps: QuickClipDeps = {
  activeTab,
  runCapture,
  clip: (req) => handleClip(clipDeps, req).then(async (res) => {
    await syncQueueState(); // the clip may have enqueued — keep the badge count fresh
    return res;
  }),
  showFeedback: (tabId, state, restricted) =>
    showFeedback({ showToast, setBadgeText, restoreBadge: syncQueueState }, tabId, state, restricted),
};

async function registerContextMenus(): Promise<void> {
  await removeAllMenus();
  createMenu({ id: "clip-page", title: "Clip page to Nimbus", contexts: ["page"] });
  createMenu({ id: "clip-selection", title: "Clip selection to Nimbus", contexts: ["selection"] });
}

addInstalledListener(() => {
  void registerContextMenus();
});

addMenuClickListener((menuItemId) => {
  void quickClip(quickClipDeps, menuItemId === "clip-selection" ? "selection" : "article");
});
```

Update the existing `clip` message handler to reuse `clipDeps` (replace the inline object):

```ts
  if (isClipRequest(message)) {
    handleClip(clipDeps, message)
      .then(async (res) => {
        await syncQueueState();
        respond(res);
      })
      .catch(() => {
        respond({ kind: "clip", ok: false, reason: "server_error" });
      });
    return true;
  }
```

Extend the command listener:

```ts
addCommandListener((command) => {
  if (command === "show_related") {
    activeTab()
      .then((tab) => injectPanel(tab.id))
      .catch(() => undefined);
    return;
  }
  if (command === "clip-page") {
    void quickClip(quickClipDeps, "article");
    return;
  }
  if (command === "clip-selection") {
    void quickClip(quickClipDeps, "selection");
  }
});
```

Register menus on startup too — add to `runStartupSequence` (after `setBadgeBackground`):

```ts
  await registerContextMenus().catch(() => undefined);
```

- [ ] **Step 6: Extend the SW test** — append to `test/unit/service-worker.test.ts` (mirror its existing `emitCommand`/import-under-harness style):

```ts
describe("service-worker — quick clip", () => {
  test("registers the two context menus on startup (removeAll before create)", async () => {
    harness = installChromeMock();
    await import("../../src/background/service-worker.ts"); // adjust to the file's existing import pattern
    await vi.waitFor(() => expect(harness.contextMenusCreate).toHaveBeenCalledTimes(2));
    expect(harness.contextMenusRemoveAll).toHaveBeenCalled();
    const ids = harness.contextMenusCreate.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(["clip-page", "clip-selection"]);
  });

  test("clip-page command captures the active tab and posts a clip", async () => {
    // paired connection + a valid capture result + a 201 gateway response
    harness = installChromeMock();
    harness.storage.set("connection", { origin: "http://127.0.0.1:8765", token: "t", label: "d", pairedAt: 1 });
    harness.tabsQuery.mockResolvedValue([{ id: 5, url: "https://ex.com/a", title: "A" }]);
    harness.executeScript
      .mockResolvedValueOnce([{ result: undefined }]) // capture.js file inject
      .mockResolvedValueOnce([{ result: { url: "https://ex.com/a", title: "A", mode: "article", body: "b", readableFound: true } }])
      .mockResolvedValue([{ result: undefined }]); // toast.js inject + call
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "1", status: "created" }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await import("../../src/background/service-worker.ts"); // adjust import as above

    harness.emitCommand("clip-page");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v1/clips");
    vi.unstubAllGlobals();
  });
});
```

> The SW test file already establishes the exact import/`vi.resetModules()` pattern for loading `service-worker.ts` under a fresh harness — follow that same pattern here rather than the placeholder comment. Reuse its existing `harness`/`beforeEach` setup.

- [ ] **Step 7: Changelog + manual checklist**

Add to `CHANGELOG.md` under `## [Unreleased]` → `### Added`:

```markdown
- **Quick-clip entry points.** Clip the current page or selection without opening
  the popup — via a right-click context menu ("Clip page / selection to Nimbus")
  or the `Alt+Shift+C` / `Alt+Shift+S` shortcuts (rebindable). The result is
  confirmed by an in-page toast (saved / offline-queued / error), with a toolbar-
  badge flash on pages a script can't be injected into. Adds the `contextMenus`
  permission; loopback-only and the locked clip contract are unchanged.
```

Add to `docs/development.md` a manual-verification section for the new surface (context menu + hotkeys): normal page (saved toast), gateway down (offline toast), `chrome://` page (badge flash), unpaired (pair prompt), and "clip selection" with nothing selected (prompt).

- [ ] **Step 8: Full gate**

Run: `bun run test && bun run typecheck && bun run lint && bun run build && bun run check-build`
Expected: all PASS (all tests green including the new suites; both targets build with `toast.js`).

- [ ] **Step 9: Commit**

```bash
git add src/browser/scripting.ts src/browser/action.ts src/background/feedback.ts src/background/service-worker.ts test/unit/feedback.test.ts test/unit/service-worker.test.ts CHANGELOG.md docs/development.md
git commit -m "feat(quick-clip): wire context menu + shortcuts into the service worker"
```

---

## Self-Review

**Spec coverage:**
- Context menu (page + selection) → Task 1 (manifest perm) + Task 2 (seam) + Task 6 (register + route).
- Keyboard commands (clip-page/clip-selection, default keys) → Task 1 + Task 6 routing.
- `quickClip` reuses capture + `handleClip` (identical behavior, offline queue) → Task 5 + Task 6 wiring.
- Selection re-runs in-page capture (not `selectionText`) → Task 5 uses `runCapture(mode)`.
- Toast: shadow-DOM, textContent-only, singleton + reset timer, idempotent re-inject, a11y role/aria-live, inline `<style>` → Task 3 (view) + Task 4 (host).
- Restricted-page scheme pre-check + `try/catch` backstop → Task 5 (`isRestrictedUrl`) + Task 6 (`showFeedback` badge fallback on inject throw).
- Badge fallback restores the queue count → Task 6 (`restoreBadge: syncQueueState`).
- Context-menu registration `removeAll()` before `create()`, on install + startup → Task 6.
- Manifest `contextMenus` + listing justification + parity → Task 1.
- `toast.js` build entry + check-build → Task 4.
- Tests (quickClip paths, toast-view a11y/XSS, toast singleton/timer, command + menu routing, manifest, seam) → Tasks 1–6.

**Placeholder scan:** No TBD/TODO; every step has complete code or an exact edit. The only prose-directed step is the SW-test import pattern (Task 6 Step 6), which points the implementer at the existing `service-worker.test.ts` convention rather than inventing a conflicting one — deliberate, since that file owns the pattern.

**Type/name consistency:** `ToastState`/`ToastVariant` (types.ts) used by `toast-view`, `toast-in-page`, `quick-clip`, `feedback`, `scripting.showToast`; `QuickClipDeps.showFeedback(tabId, state, restricted?)` matches `feedback.showFeedback` signature; `quickClipDeps.clip` returns `ClipResponse`; menu ids `clip-page`/`clip-selection` match the manifest command names and the routing switches. `handleClip(clipDeps, req)` matches the existing signature.

**Note for the implementer:** the real context menu + hotkeys can only be exercised by loading the built extension (Task 6's manual checklist); everything else — orchestration, mapping, toast rendering/lifecycle, seams, routing, manifest, build — is unit-verifiable and covered above.
