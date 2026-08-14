# Review & Suggestions: A Panel You Can Always Reach Implementation Plan (Slice 2)

This document contains open questions, suggestions, and potential improvements for the proposed implementation plan in [2026-08-14-slice-2-panel-entry-points.md](./2026-08-14-slice-2-panel-entry-points.md).

## 1. Defensive API Existence Check in `getAllCommands`
* **The issue:** In Task 1, Step 3, `getAllCommands` checks if `chrome.commands` is defined:
  ```ts
  const api = (chrome as { commands?: { getAll?: unknown } }).commands;
  ```
  If the global `chrome` object itself is not defined (e.g., in certain testing environments or non-extension browser pages where the options page scripts might be loaded or imported), referencing `chrome` directly will throw a `ReferenceError` ("chrome is not defined").
* **Suggestion:** Make the check defensive by inspecting `typeof chrome` first:
  ```ts
  if (typeof chrome === "undefined" || !chrome.commands || typeof chrome.commands.getAll !== "function") {
    return [];
  }
  ```

## 2. Unhandled Promise Rejection in `refreshShortcuts`
* **The issue:** In Task 3, Step 3, `refreshShortcuts` calls `getAllCommands()` with `await` but does not wrap it in a `try-catch`:
  ```ts
  async function refreshShortcuts(): Promise<void> {
    const list = document.getElementById("shortcut-list");
    const hint = document.getElementById("shortcut-hint");
    if (list === null || hint === null) {
      return;
    }
    list.replaceChildren(renderShortcuts(document, shortcutRows(await getAllCommands())));
    hint.textContent = shortcutsHint(isFirefoxRuntime());
  }
  ```
  If the async `getAllCommands` rejects (due to extension context invalidation or if mocked to reject in testing), `refreshShortcuts` will reject. Since it is invoked as a fire-and-forget promise in the `DOMContentLoaded` handler (`void refreshShortcuts()`), this rejection will result in a global unhandled promise rejection error.
* **Suggestion:** Wrap the async calls inside `refreshShortcuts` in a `try-catch` to ensure options initialization always degrades gracefully:
  ```ts
  async function refreshShortcuts(): Promise<void> {
    const list = document.getElementById("shortcut-list");
    const hint = document.getElementById("shortcut-hint");
    if (list === null || hint === null) {
      return;
    }
    try {
      const commands = await getAllCommands();
      list.replaceChildren(renderShortcuts(document, shortcutRows(commands)));
    } catch {
      list.replaceChildren(); // Safe empty state
    }
    hint.textContent = shortcutsHint(isFirefoxRuntime());
  }
  ```

## 3. Safe Extension Re-registration Error Isolation
* **The issue:** In Task 4, Step 3, `registerMenus` iterates over `MENU_ITEMS` and registers them sequentially:
  ```ts
  export async function registerMenus(deps: RegisterMenusDeps): Promise<void> {
    await deps.removeAll();
    for (const item of MENU_ITEMS) {
      deps.create(item);
    }
  }
  ```
  If any individual `deps.create(item)` call throws an error (e.g., if the browser rejects a context menu layout context configuration, or if `chrome.contextMenus.create` encounters an issue), the loop will immediately abort. This means subsequent context menu items will not be registered.
* **Suggestion:** Consider wrapping individual `create` calls in a `try-catch` (or logging the failures) so a single bad registration doesn't block the rest:
  ```ts
  export async function registerMenus(deps: RegisterMenusDeps): Promise<void> {
    await deps.removeAll();
    for (const item of MENU_ITEMS) {
      try {
        deps.create(item);
      } catch (err) {
        // Log error or handle gracefully
      }
    }
  }
  ```
