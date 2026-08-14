# Slice 2 — A Panel You Can Always Reach: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the related panel reachable without the keyboard, and make Options tell the truth about whether its shortcut is actually bound.

**Architecture:** Every way of opening the panel converges on one `openPanel(tabId)` helper, so the four triggers (hotkey, context menu, popup button, ambient cue) cannot drift. Context-menu registration and click routing move out of the service worker into a `menus.ts` that owns every entry. Options reads `chrome.commands.getAll()` through a browser seam and renders each command's real binding — because `suggested_key` is only a suggestion, and a browser that declines it says nothing.

**Tech Stack:** TypeScript (strict, no `any`), Vitest (node env; DOM tests opt into jsdom via a docblock), Biome, esbuild, MV3 (Chrome + Firefox), Bun as the runner.

**Spec:** [`docs/superpowers/specs/2026-08-14-setup-trust-and-lane-inputs-design.md`](../specs/2026-08-14-setup-trust-and-lane-inputs-design.md) — read the "Slice 2 — A panel you can always reach" section. **Two of its claims are wrong; the corrections are in Global Constraints below and are binding.**

## Global Constraints

Copied from the spec, `CLAUDE.md`, and verification against the code at `cd7c446`.

- **TypeScript strict, no `any`.** Cross-boundary data is `unknown`, narrowed by a guard.
- **No `console.*` anywhere in `src/`** — Biome enforces `noConsole` there.
- **Loopback only (I6).** This slice adds no network call at all. If you find yourself writing a `fetch`, stop.
- **The bearer token is never logged, rendered, or placed in a page DOM.**
- **`textContent`, never `innerHTML`**, for anything derived from outside this file.
- **Keep pure logic out of the `chrome.*` seam** (`src/browser/`) so it stays unit-testable.
- **Every trigger is a user gesture, so `activeTab` still covers it. Add no permission.** `contextMenus` is already in the manifest.
- Merge new imports into the **existing** grouped import per module — Biome flags duplicates.
- **No new dependencies.**
- **Green bar:** `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build` before any commit.

### Spec corrections — binding

**Correction 1: menu registration is NOT in `quick-clip.ts`.** The spec says it "lifts out of `quick-clip.ts`". It does not live there — `quick-clip.ts` is pure clip logic with no `chrome.*` calls at all. Registration is `registerContextMenus` in **`src/background/service-worker.ts:461`**, with `addInstalledListener` and `addMenuClickListener` beside it. That is what moves.

**Correction 2: `chrome.commands` already has a seam.** The spec asks for "a new `src/browser/commands.ts` seam over `chrome.commands.getAll()`", but `addCommandListener` (over `chrome.commands.onCommand`) already lives in `src/browser/runtime.ts`. Creating `commands.ts` for only `getAll` would split one browser API across two seam files. So: create `commands.ts` and **move `addCommandListener` into it**, leaving `runtime.ts` owning messaging and install events only.

---

## File Structure

**Create:**
- `src/browser/commands.ts` — the whole `chrome.commands.*` seam: `addCommandListener` (moved) + `getAllCommands`
- `src/background/menus.ts` — owns every context-menu entry, its registration, and its click routing
- `src/options/shortcuts-view.ts` — pure: command bindings → renderable rows + the per-browser hint
- `test/unit/menus.test.ts`, `test/unit/shortcuts-view.test.ts`

**Modify:**
- `src/browser/runtime.ts` — `addCommandListener` moves out; `isFirefoxRuntime` moves in
- `src/background/service-worker.ts` — registration and routing move out; `openPanel` becomes the one path
- `src/options/options.html` / `options.css` / `options.ts` — the shortcuts block in stage 2
- `CHANGELOG.md`, `docs/architecture.md`, `docs/development.md`, `ROADMAP.md`

**Existing tests to extend:** `test/unit/browser-seam.test.ts`, `test/unit/service-worker.test.ts`, `test/unit/options.test.ts`

---

## Task 1: The `chrome.commands` seam

**Files:**
- Create: `src/browser/commands.ts`
- Modify: `src/browser/runtime.ts` (remove `addCommandListener`, add `isFirefoxRuntime`)
- Modify: `src/background/service-worker.ts` (import `addCommandListener` from its new home)
- Test: `test/unit/browser-seam.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `interface CommandBinding { readonly name: string; readonly description: string; readonly shortcut: string }`
  - `getAllCommands(): Promise<CommandBinding[]>`
  - `addCommandListener(fn: (command: string) => void): void` (moved verbatim)
  - `isFirefoxRuntime(): boolean` in `runtime.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/browser-seam.test.ts`:

```ts
describe("getAllCommands", () => {
  test("maps chrome.commands.getAll into plain bindings", async () => {
    installChromeStub();
    (globalThis as unknown as { chrome: Record<string, unknown> }).chrome["commands"] = {
      getAll: (cb: (c: unknown[]) => void) =>
        cb([
          { name: "show_related", description: "Show related items in Nimbus", shortcut: "Alt+Shift+R" },
          { name: "clip-page", description: "Clip the current page to Nimbus", shortcut: "" },
        ]),
    };
    expect(await getAllCommands()).toEqual([
      { name: "show_related", description: "Show related items in Nimbus", shortcut: "Alt+Shift+R" },
      { name: "clip-page", description: "Clip the current page to Nimbus", shortcut: "" },
    ]);
  });

  test("a command with no shortcut field reads as unbound, not undefined", async () => {
    installChromeStub();
    (globalThis as unknown as { chrome: Record<string, unknown> }).chrome["commands"] = {
      getAll: (cb: (c: unknown[]) => void) => cb([{ name: "show_related" }]),
    };
    expect(await getAllCommands()).toEqual([
      { name: "show_related", description: "", shortcut: "" },
    ]);
  });

  test("an absent chrome.commands API yields an empty list, not a throw", async () => {
    installChromeStub();
    expect(await getAllCommands()).toEqual([]);
  });
});

describe("isFirefoxRuntime", () => {
  test("true for a moz-extension runtime URL", () => {
    installChromeStub();
    (globalThis as unknown as { chrome: Record<string, unknown> }).chrome["runtime"] = {
      getURL: () => "moz-extension://abc/",
    };
    expect(isFirefoxRuntime()).toBe(true);
  });

  test("false for a chrome-extension runtime URL", () => {
    installChromeStub();
    (globalThis as unknown as { chrome: Record<string, unknown> }).chrome["runtime"] = {
      getURL: () => "chrome-extension://abc/",
    };
    expect(isFirefoxRuntime()).toBe(false);
  });

  test("false rather than throwing when getURL is unavailable", () => {
    installChromeStub();
    expect(isFirefoxRuntime()).toBe(false);
  });
});
```

Add to that file's imports:

```ts
import { getAllCommands } from "../../src/browser/commands.ts";
import { isFirefoxRuntime } from "../../src/browser/runtime.ts";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- browser-seam`
Expected: FAIL — `Cannot find module '../../src/browser/commands.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/browser/commands.ts`:

```ts
// The whole `chrome.commands` seam — the listener and the binding read together,
// so one browser API has one home. `addCommandListener` moved here from
// runtime.ts for that reason; runtime.ts keeps messaging and install events.

export interface CommandBinding {
  readonly name: string;
  readonly description: string;
  /** Empty string means UNBOUND. `suggested_key` is a suggestion the browser may decline. */
  readonly shortcut: string;
}

export function addCommandListener(fn: (command: string) => void): void {
  chrome.commands.onCommand.addListener(fn);
}

/**
 * Every declared command with the shortcut the browser ACTUALLY bound.
 *
 * Callback-style rather than the promise form: Chrome 91+ returns a promise but
 * Firefox MV3 does not, and this is one of the few reads both targets make.
 *
 * Missing fields normalise to `""` rather than `undefined` so a caller cannot
 * accidentally render "undefined" as a shortcut, and an absent `chrome.commands`
 * yields `[]` rather than throwing — Options must still render if the API is
 * unavailable, because a page that fails to render tells the user nothing at all.
 */
export async function getAllCommands(): Promise<CommandBinding[]> {
  const api = (chrome as { commands?: { getAll?: unknown } }).commands;
  if (api === undefined || typeof api.getAll !== "function") {
    return [];
  }
  const raw = await new Promise<unknown[]>((resolve) => {
    (api.getAll as (cb: (c: unknown[]) => void) => void)((commands) => resolve(commands ?? []));
  });
  return raw.map((c) => {
    const o = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    return {
      name: typeof o["name"] === "string" ? o["name"] : "",
      description: typeof o["description"] === "string" ? o["description"] : "",
      shortcut: typeof o["shortcut"] === "string" ? o["shortcut"] : "",
    };
  });
}
```

In `src/browser/runtime.ts`, **delete** `addCommandListener` and add:

```ts
/**
 * Is this the Firefox build?
 *
 * Derived from the extension's own URL scheme (`moz-extension:` vs
 * `chrome-extension:`), NOT from the user agent — the UA is spoofable and says
 * nothing about which package is running. Needed because the two browsers put
 * their keyboard-shortcut settings in different places and neither can be
 * reached by a link (see shortcuts-view.ts).
 */
export function isFirefoxRuntime(): boolean {
  try {
    return chrome.runtime.getURL("").startsWith("moz-extension:");
  } catch {
    return false;
  }
}
```

In `src/background/service-worker.ts`, move `addCommandListener` out of the `../browser/runtime.ts` import group and into a new import from `../browser/commands.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- browser-seam` then `bun run test`
Expected: PASS, whole suite green

- [ ] **Step 5: Commit**

```bash
git add src/browser/commands.ts src/browser/runtime.ts src/background/service-worker.ts test/unit/browser-seam.test.ts
git commit -m "feat(browser): one seam for chrome.commands, and a Firefox check"
```

---

## Task 2: The shortcuts view (pure)

**Files:**
- Create: `src/options/shortcuts-view.ts`
- Test: `test/unit/shortcuts-view.test.ts`

**Interfaces:**
- Consumes: `CommandBinding` from `src/browser/commands.ts` (Task 1)
- Produces:
  - `interface ShortcutRow { readonly label: string; readonly shortcut: string; readonly bound: boolean }`
  - `shortcutRows(commands: readonly CommandBinding[]): ShortcutRow[]`
  - `shortcutsHint(isFirefox: boolean): string`
  - `renderShortcuts(doc: Document, rows: readonly ShortcutRow[]): DocumentFragment`

- [ ] **Step 1: Write the failing test**

Create `test/unit/shortcuts-view.test.ts`:

```ts
// @vitest-environment jsdom
// test/unit/shortcuts-view.test.ts
import { describe, expect, test } from "vitest";
import type { CommandBinding } from "../../src/browser/commands.ts";
import {
  renderShortcuts,
  type ShortcutRow,
  shortcutRows,
  shortcutsHint,
} from "../../src/options/shortcuts-view.ts";

const bound: CommandBinding = {
  name: "show_related",
  description: "Show related items in Nimbus",
  shortcut: "Alt+Shift+R",
};
const unbound: CommandBinding = {
  name: "clip-page",
  description: "Clip the current page to Nimbus",
  shortcut: "",
};

describe("shortcutRows", () => {
  test("a bound command reports its real shortcut", () => {
    expect(shortcutRows([bound])).toEqual([
      { label: "Show related items in Nimbus", shortcut: "Alt+Shift+R", bound: true },
    ]);
  });

  test("an empty shortcut is UNBOUND and says so in words, not as a blank", () => {
    const [row] = shortcutRows([unbound]);
    expect(row?.bound).toBe(false);
    expect(row?.shortcut).toBe("Not set");
  });

  test("a command with no description falls back to its name, never an empty label", () => {
    const [row] = shortcutRows([{ name: "show_related", description: "", shortcut: "" }]);
    expect(row?.label).toBe("show_related");
  });

  test("no commands yields no rows", () => {
    expect(shortcutRows([])).toEqual([]);
  });
});

describe("shortcutsHint", () => {
  test("Chrome is told its own settings path", () => {
    expect(shortcutsHint(false)).toContain("chrome://extensions/shortcuts");
  });

  test("Firefox is told its own, which is a different place", () => {
    const hint = shortcutsHint(true);
    expect(hint).toContain("about:addons");
    expect(hint).not.toContain("chrome://extensions/shortcuts");
  });

  test("both hints say to paste it, because neither can be linked", () => {
    expect(shortcutsHint(false).toLowerCase()).toContain("paste");
    expect(shortcutsHint(true).toLowerCase()).toContain("paste");
  });
});

describe("renderShortcuts", () => {
  const rows: ShortcutRow[] = [
    { label: "Show related items in Nimbus", shortcut: "Alt+Shift+R", bound: true },
    { label: "Clip the current page to Nimbus", shortcut: "Not set", bound: false },
  ];

  test("renders one row per command", () => {
    const frag = renderShortcuts(document, rows);
    expect(frag.querySelectorAll(".shortcut").length).toBe(2);
  });

  test("an unbound row is marked so a reader can spot it without comparing text", () => {
    const frag = renderShortcuts(document, rows);
    const marked = frag.querySelectorAll('.shortcut[data-bound="false"]');
    expect(marked.length).toBe(1);
    expect(marked[0]?.textContent).toContain("Clip the current page to Nimbus");
  });

  test("renders labels as text, never as markup", () => {
    const frag = renderShortcuts(document, [
      { label: "<img src=x onerror=alert(1)>", shortcut: "Not set", bound: false },
    ]);
    expect(frag.querySelector("img")).toBeNull();
    expect(frag.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- shortcuts-view`
Expected: FAIL — `Cannot find module '../../src/options/shortcuts-view.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/options/shortcuts-view.ts`:

```ts
// Pure presentation for the keyboard-shortcut readout in Options stage 2.
// No chrome.*, no DOM reads — it takes bindings and returns rows, plus one
// string of per-browser guidance.
import type { CommandBinding } from "../browser/commands.ts";

export interface ShortcutRow {
  readonly label: string;
  /** The bound key combo, or the words "Not set" — never an empty cell. */
  readonly shortcut: string;
  readonly bound: boolean;
}

/**
 * WHY THIS EXISTS AT ALL: `suggested_key` in the manifest is a *suggestion*. When
 * something else already claims the combo, the browser leaves the command
 * unbound, reports nothing, and the keystroke goes to the page. A user in that
 * state concludes the feature is broken. This is the only surface that can tell
 * them otherwise — Alt+Shift+R failing to bind in Chrome is exactly how the
 * defect behind this slice was found.
 */
export function shortcutRows(commands: readonly CommandBinding[]): ShortcutRow[] {
  return commands.map((c) => ({
    // Never an empty label: a row with no text is indistinguishable from a
    // rendering bug, and the name is at least identifying.
    label: c.description === "" ? c.name : c.description,
    shortcut: c.shortcut === "" ? "Not set" : c.shortcut,
    bound: c.shortcut !== "",
  }));
}

/**
 * Where to go to fix an unbound shortcut, per browser.
 *
 * It is guidance plus a copyable path, NOT a link, and that is forced on us:
 * Chrome refuses to let an extension page navigate to `chrome://extensions/shortcuts`,
 * and Firefox's equivalent lives somewhere else entirely. A link that silently
 * does nothing would be a second invisible failure stacked on the one this
 * slice exists to fix.
 */
export function shortcutsHint(isFirefox: boolean): string {
  return isFirefox
    ? "To change these, paste about:addons into the address bar, then use the gear menu → Manage Extension Shortcuts."
    : "To change these, paste chrome://extensions/shortcuts into the address bar. Browsers don't allow a page to link there.";
}

export function renderShortcuts(doc: Document, rows: readonly ShortcutRow[]): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const row of rows) {
    const el = doc.createElement("div");
    el.className = "shortcut";
    // A data attribute, not only different text: the CSS marks the unbound row so
    // it is findable at a glance rather than by reading every line.
    el.dataset["bound"] = String(row.bound);
    const label = doc.createElement("span");
    label.className = "shortcut__label";
    // textContent, never innerHTML — the description comes from the manifest, but
    // this function must stay safe for any caller.
    label.textContent = row.label;
    const key = doc.createElement("span");
    key.className = "shortcut__key";
    key.textContent = row.shortcut;
    el.append(label, key);
    frag.append(el);
  }
  return frag;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- shortcuts-view`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/options/shortcuts-view.ts test/unit/shortcuts-view.test.ts
git commit -m "feat(options): render what the browser actually bound"
```

---

## Task 3: Show the shortcuts in Options

**Files:**
- Modify: `src/options/options.html` (stage 2)
- Modify: `src/options/options.css`
- Modify: `src/options/options.ts`
- Test: `test/unit/options.test.ts`

**Interfaces:**
- Consumes: `getAllCommands` (Task 1), `isFirefoxRuntime` (Task 1), `renderShortcuts` / `shortcutRows` / `shortcutsHint` (Task 2)
- Produces: element ids `shortcut-list`, `shortcut-hint`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/options.test.ts`. The first two are raw-HTML assertions (the file already reads `options.html` from disk); the third is a jsdom test using the file's existing `boot()` / `flush()` helpers:

```ts
describe("options.html shortcuts block", () => {
  test("stage 2 carries the shortcut list and hint slots", () => {
    expect(html).toContain('id="shortcut-list"');
    expect(html).toContain('id="shortcut-hint"');
  });

  test("the shortcut block lives inside stage 2, not its own stage", () => {
    const stage2 = html.slice(html.indexOf('id="stage-connection"'), html.indexOf('id="stage-sites"'));
    expect(stage2).toContain('id="shortcut-list"');
  });
});

describe("shortcuts render into Options", () => {
  test("a bound and an unbound command both render, with the unbound one marked", async () => {
    await boot();
    harness.commandsGetAll = [
      { name: "show_related", description: "Show related items in Nimbus", shortcut: "Alt+Shift+R" },
      { name: "clip-page", description: "Clip the current page to Nimbus", shortcut: "" },
    ];
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush();

    const rows = el("shortcut-list").querySelectorAll(".shortcut");
    expect(rows.length).toBe(2);
    expect(el("shortcut-list").querySelectorAll('[data-bound="false"]').length).toBe(1);
  });

  test("the hint names a settings path the user can paste", async () => {
    await boot();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush();
    expect(el("shortcut-hint").textContent?.toLowerCase()).toContain("paste");
  });
});
```

> **Harness note — this one DOES need adding.** The mock's `chrome.commands`
> (`test/unit/helpers/chrome-mock.ts:178`) currently exposes only `onCommand`;
> there is no `getAll`. Add a mutable `commandsGetAll` array to the harness
> (defaulting to `[]`) and a `getAll: (cb) => cb(commandsGetAll)` beside
> `onCommand`, then expose `commandsGetAll` on the `ChromeHarness` interface
> alongside `storage`. Extend the existing mock; do not fork a second one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- options`
Expected: FAIL — the ids are absent and `harness.commandsGetAll` is not a property

- [ ] **Step 3: Write the implementation**

In `src/options/options.html`, inside the `#stage-connection` section, after the unpair buttons:

```html
        <h3 class="stage__sub">Keyboard shortcuts</h3>
        <div id="shortcut-list"></div>
        <p id="shortcut-hint" class="options__status"></p>
```

In `src/options/options.css`:

```css
.stage__sub { font-size: 0.95rem; margin: 1.2em 0 0.4em; }
.shortcut { display: flex; justify-content: space-between; gap: 1em; padding: 0.25em 0; }
.shortcut__key { font-family: ui-monospace, monospace; opacity: 0.8; }
/* The unbound row is the whole point of this block — mark it, don't just word it. */
.shortcut[data-bound="false"] .shortcut__key { color: #b23; font-style: italic; }
```

In `src/options/options.ts`, add the refresh and call it on load:

```ts
async function refreshShortcuts(): Promise<void> {
  const list = document.getElementById("shortcut-list");
  const hint = document.getElementById("shortcut-hint");
  if (list === null || hint === null) {
    return;
  }
  // Read directly from the browser seam, not through the service worker: Options
  // is an extension page with its own access to chrome.commands, so a message
  // round-trip would add a failure mode without adding information.
  list.replaceChildren(renderShortcuts(document, shortcutRows(await getAllCommands())));
  hint.textContent = shortcutsHint(isFirefoxRuntime());
}
```

Register it in the `DOMContentLoaded` handler beside the existing refreshes:

```ts
  void refreshShortcuts();
```

Add the imports:

```ts
import { getAllCommands } from "../browser/commands.ts";
import { isFirefoxRuntime } from "../browser/runtime.ts";
import { renderShortcuts, shortcutRows, shortcutsHint } from "./shortcuts-view.ts";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test`
Expected: PASS, whole suite green

- [ ] **Step 5: Commit**

```bash
git add src/options/options.html src/options/options.css src/options/options.ts test/unit/options.test.ts test/unit/helpers/chrome-mock.ts
git commit -m "feat(options): say whether the panel shortcut actually bound"
```

---

## Task 4: One panel path, several triggers

**Files:**
- Create: `src/background/menus.ts`
- Modify: `src/background/service-worker.ts:457-480` (registration + click routing move out) and `:722-740` (the command listener)
- Test: `test/unit/menus.test.ts`, `test/unit/service-worker.test.ts`

**Interfaces:**
- Consumes: `createMenu`, `removeAllMenus` from `src/browser/context-menus.ts`; `singleFlight` from `src/background/single-flight.ts`
- Produces:
  - `MENU_ITEMS: readonly MenuItem[]` — the three entries
  - `MENU_CLIP_PAGE = "clip-page"`, `MENU_CLIP_SELECTION = "clip-selection"`, `MENU_SHOW_RELATED = "show-related"`
  - `menuAction(menuItemId: string): "clip-article" | "clip-selection" | "show-related" | null`
  - `registerMenus(deps: { removeAll, create }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/menus.test.ts`:

```ts
// test/unit/menus.test.ts
import { describe, expect, test } from "vitest";
import {
  MENU_CLIP_PAGE,
  MENU_CLIP_SELECTION,
  MENU_ITEMS,
  MENU_SHOW_RELATED,
  menuAction,
  registerMenus,
} from "../../src/background/menus.ts";

describe("MENU_ITEMS", () => {
  test("declares exactly the three entries, ids matching the constants", () => {
    expect(MENU_ITEMS.map((i) => i.id)).toEqual([
      MENU_CLIP_PAGE,
      MENU_CLIP_SELECTION,
      MENU_SHOW_RELATED,
    ]);
  });

  test("clip-selection appears on a selection; show-related on the page", () => {
    const byId = new Map(MENU_ITEMS.map((i) => [i.id, i]));
    expect(byId.get(MENU_CLIP_SELECTION)?.contexts).toEqual(["selection"]);
    expect(byId.get(MENU_SHOW_RELATED)?.contexts).toEqual(["page"]);
  });

  test("every entry has a non-empty title and at least one context", () => {
    for (const item of MENU_ITEMS) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.contexts.length).toBeGreaterThan(0);
    }
  });
});

describe("menuAction", () => {
  test("maps each id to its action", () => {
    expect(menuAction(MENU_CLIP_PAGE)).toBe("clip-article");
    expect(menuAction(MENU_CLIP_SELECTION)).toBe("clip-selection");
    expect(menuAction(MENU_SHOW_RELATED)).toBe("show-related");
  });

  test("an unknown id is null — NOT a default clip", () => {
    expect(menuAction("something-else")).toBeNull();
    expect(menuAction("")).toBeNull();
  });
});

describe("registerMenus", () => {
  test("clears before creating, so a reload cannot duplicate an id", async () => {
    const calls: string[] = [];
    await registerMenus({
      removeAll: async () => {
        calls.push("removeAll");
      },
      create: (item) => {
        calls.push(`create:${item.id}`);
      },
    });
    expect(calls).toEqual([
      "removeAll",
      `create:${MENU_CLIP_PAGE}`,
      `create:${MENU_CLIP_SELECTION}`,
      `create:${MENU_SHOW_RELATED}`,
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- menus`
Expected: FAIL — `Cannot find module '../../src/background/menus.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/background/menus.ts`:

```ts
// Every context-menu entry, its registration, and the id→action mapping.
//
// Lifted out of service-worker.ts, which is the largest file in the repo and was
// carrying this alongside message routing, alarms and the ambient cue. The menu
// is now one thing in one place, and adding an entry is a table edit plus a
// `menuAction` arm rather than a change inside the router.
import type { MenuItem } from "../browser/context-menus.ts";

export const MENU_CLIP_PAGE = "clip-page";
export const MENU_CLIP_SELECTION = "clip-selection";
export const MENU_SHOW_RELATED = "show-related";

/**
 * Hyphenated ids, deliberately unlike the manifest's `show_related` COMMAND name.
 * They are different namespaces — a menu id and a command name — and making them
 * identical would invite a future reader to route one through the other.
 */
export const MENU_ITEMS: readonly MenuItem[] = Object.freeze([
  { id: MENU_CLIP_PAGE, title: "Clip page to Nimbus", contexts: ["page"] },
  { id: MENU_CLIP_SELECTION, title: "Clip selection to Nimbus", contexts: ["selection"] },
  // The entry this slice exists for: a way into the panel the browser cannot
  // silently withhold, unlike a hotkey the browser may decline to bind.
  { id: MENU_SHOW_RELATED, title: "Show related in Nimbus", contexts: ["page"] },
]);

export type MenuAction = "clip-article" | "clip-selection" | "show-related";

/**
 * The action an id means, or null when the id is not ours.
 *
 * Null rather than a default: the previous routing treated every non-selection id
 * as "clip the page", so any future entry would have silently clipped until
 * someone noticed. An unknown id must do nothing.
 */
export function menuAction(menuItemId: string): MenuAction | null {
  switch (menuItemId) {
    case MENU_CLIP_PAGE:
      return "clip-article";
    case MENU_CLIP_SELECTION:
      return "clip-selection";
    case MENU_SHOW_RELATED:
      return "show-related";
    default:
      return null;
  }
}

export interface RegisterMenusDeps {
  readonly removeAll: () => Promise<void>;
  readonly create: (item: MenuItem) => void;
}

/**
 * Re-register from scratch. `removeAll` first because chrome.contextMenus.create
 * throws on a duplicate id, and a reload or upgrade would otherwise leave one
 * behind. The caller single-flights this — on a fresh install the startup
 * sequence and onInstalled both fire, and interleaved removeAll/create pairs can
 * hit a duplicate id.
 */
export async function registerMenus(deps: RegisterMenusDeps): Promise<void> {
  await deps.removeAll();
  for (const item of MENU_ITEMS) {
    deps.create(item);
  }
}
```

In `src/background/service-worker.ts`, replace the `registerContextMenus` block and the menu click listener with:

```ts
const registerContextMenus = singleFlight(
  async (): Promise<void> => await registerMenus({ removeAll: removeAllMenus, create: createMenu }),
);

addMenuClickListener((menuItemId, tabId) => {
  const action = menuAction(menuItemId);
  if (action === null) {
    return;
  }
  if (action === "show-related") {
    // The RIGHT-CLICKED tab, falling back to the active one. A right-click in a
    // non-focused window targets a different tab than tabs.query({active}), and
    // the activeTab grant belongs to the clicked tab — the same reasoning the
    // clip path already documents.
    openPanel(tabId);
    return;
  }
  quickClip(quickClipDeps, action === "clip-selection" ? "selection" : "article", tabId).catch(
    () => undefined,
  );
});
```

Add the shared opener above the listeners, and route the command through it:

```ts
/**
 * The ONE way the panel gets opened. Four triggers converge here — the hotkey,
 * the context menu, the popup button (via its own injectPanel call) and the
 * ambient cue — so the panel cannot behave differently depending on how it was
 * summoned, which is what C1.5 exists to prevent.
 *
 * A restricted page rejects injection; fail closed and silently, because there
 * is no surface to report on when the panel is the surface.
 */
function openPanel(tabId?: number): void {
  if (tabId !== undefined) {
    injectPanel(tabId).catch(() => undefined);
    return;
  }
  activeTab()
    .then((tab) => injectPanel(tab.id))
    .catch(() => undefined);
}
```

Then in the command listener, replace the `show_related` arm's body with `openPanel();` and change `openPanelForCue`'s body to call `openPanel(tabId)` so the cue shares it too.

Add the imports:

```ts
import { menuAction, registerMenus } from "./menus.ts";
```

- [ ] **Step 4: Add the service-worker routing tests**

Append to `test/unit/service-worker.test.ts`, using the file's existing harness:

```ts
describe("show-related context menu", () => {
  test("clicking it injects the panel into the RIGHT-CLICKED tab", async () => {
    await load();
    harness.executeScript.mockClear();
    harness.emitMenuClick("show-related", 42);
    await settle();
    expect(harness.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 42 }, files: ["panel.js"] }),
    );
  });

  test("an unknown menu id does nothing at all — it does not fall through to a clip", async () => {
    await load();
    harness.executeScript.mockClear();
    harness.emitMenuClick("not-ours", 42);
    await settle();
    expect(harness.executeScript).not.toHaveBeenCalled();
  });

  test("the menu registers all three entries", async () => {
    await load();
    const ids = harness.contextMenusCreate.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(["clip-page", "clip-selection", "show-related"]);
  });
});
```

> **Harness note.** `harness.emitMenuClick(menuItemId, tabId?)` and
> `harness.contextMenusCreate` already exist in `test/unit/helpers/chrome-mock.ts` —
> use them as-is. Nothing needs adding to the mock for this task.

- [ ] **Step 5: Run everything and commit**

```bash
bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build
git add src/background/menus.ts src/background/service-worker.ts test/unit/menus.test.ts test/unit/service-worker.test.ts test/unit/helpers/chrome-mock.ts
git commit -m "feat(background): a menu route into the panel, and one path for every trigger"
```

---

## Task 5: Docs, changelog, roadmap

**Files:**
- Modify: `CHANGELOG.md`, `docs/architecture.md`, `docs/development.md`, `ROADMAP.md`

**Interfaces:** none — documentation

- [ ] **Step 1: Add the changelog entry**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:

```markdown
- **The related panel no longer depends on a keyboard shortcut that may not
  exist.** Right-click any page → **Show related in Nimbus** opens the same
  panel the hotkey does. And Options now lists each Nimbus shortcut with the
  keys your browser *actually* bound — `Alt+Shift+R` is only a suggestion, and
  when another extension already claims it your browser silently leaves it
  unset. A shortcut that never bound now reads **Not set** instead of looking
  like a broken feature.
```

- [ ] **Step 2: Document the decisions**

Add to `docs/architecture.md`:
- `openPanel` as the single path all four triggers converge on, and why (the panel must not behave differently depending on how it was summoned).
- `menuAction` returning `null` for an unknown id rather than defaulting to a clip — the previous routing treated every non-selection id as "clip the page".
- Why the shortcut readout exists: `suggested_key` is a suggestion; an unbound command reports nothing, so this is the only surface that can tell the user.
- Why the hint is a copyable path and not a link, per target.

- [ ] **Step 3: Extend the manual checklist**

Add to `docs/development.md` a "Manual verification — Panel entry points (C1.5)" section:

1. Right-click a normal page → **Show related in Nimbus** appears; clicking it opens the panel.
2. Right-click a page in a **non-focused** window → the panel opens in *that* tab, not the focused one.
3. On `chrome://extensions` → the entry either does not appear or does nothing; no error surfaces.
4. Options stage 2 lists all three commands with their real bindings.
5. Deliberately rebind `Alt+Shift+R` to something else in the browser's shortcut settings → Options reflects the change on reload.
6. Unbind it entirely → Options shows **Not set**, and the context-menu route still opens the panel.
7. Repeat 1–6 in Firefox, confirming the hint names `about:addons` rather than the Chrome path.

- [ ] **Step 4: Update the roadmap**

Mark **C1.5** shipped with a `**Status**` line following the format C1.3 / C2.3 / 3.5 use. Record honestly that this delivers both halves the brief named — the click-driven entry point *and* the shortcut visibility.

- [ ] **Step 5: Commit**

```bash
bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build
git add CHANGELOG.md docs/architecture.md docs/development.md ROADMAP.md
git commit -m "docs: record slice 2 — a panel you can always reach"
```

---

## Self-Review Notes

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| A *Show related* context-menu entry | 4 |
| It routes into the **same** `injectPanel` path | 4 (`openPanel`, shared by all four triggers) |
| Menu registration owns every entry in one module | 4 (`menus.ts`) |
| Options reports whether `show_related` actually bound | 1, 2, 3 |
| A `chrome.commands` browser seam | 1 (corrected: `commands.ts` also takes `addCommandListener`) |
| Per-target guidance, copyable path not a link | 2 (`shortcutsHint`), 3 |
| No new permission — every trigger is a gesture | all (asserted in Global Constraints) |

**Corrections carried into this plan:** menu registration is in `service-worker.ts`, not `quick-clip.ts`; and `chrome.commands` already had a partial seam in `runtime.ts`, so `commands.ts` absorbs it rather than splitting one API in two.

**Deliberately not in this slice:** the popup's *Show related* button already exists and already calls `injectPanel` — it needs no change, and the roadmap's own 2026-08-11 correction records that the panel was never actually unreachable. The `openPanel` helper does not replace the popup's direct call, because the popup runs in its own context and cannot reach a service-worker-local function; the convergence that matters is among the service worker's own three triggers.

**Known follow-up:** `service-worker.ts` loses ~20 lines here but remains the largest file in the repo. If slice 4 (the lane inputs) grows it further, the ambient-cue machinery is the next coherent piece to lift out.
