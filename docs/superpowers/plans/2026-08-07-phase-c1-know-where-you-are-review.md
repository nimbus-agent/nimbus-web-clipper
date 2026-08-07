# Phase C1 — Know Where You Are — Plan Review Notes

## 1. State Scoping & Panel Remounts (Tasks 8 & 9)
* **Observation:** The plan implements `header` and `relatedBody` as module-level globals:
  ```ts
  let header: HeaderState = { kind: "loading" };
  let relatedBody: (doc: Document) => HTMLElement = (doc) => renderError(doc, "Loading…");
  ```
  While the plan correctly adds a state reset at the top of `mount()`, using module-level globals can still cause race conditions if the panel is quickly unmounted and remounted (e.g. due to rapid user shortcut summons), or if the same content script context survives across single-page application (SPA) client-side navigations.
* **Suggestion/Improvement:** Scope the state to the active mount instance. Instead of module-level globals, bundle the state into a controller class or closure instance created inside `mount()`, which holds its own `header`, `relatedBody`, and `paint` bindings. This isolates parallel network responses to the correct invocation of the panel UI.

## 2. Unhandled Promise Rejections in Parallel Loads (Task 9)
* **Observation:** The parallel async calls are fired with `void loadHeader(body)` and `void loadRelated(body)`. If any unexpected error occurs inside these functions (e.g. DOM manipulation throws or a type guard fails in a way that escapes `try/catch`), the promise rejects silently.
* **Suggestion/Improvement:** Wrap the calls or add a default catch handler to log or safely display a fallback error state:
  ```ts
  loadHeader(body).catch((err) => {
    // Safely handle unexpected failures in the UI state
  });
  ```

## 3. Chrome vs. Firefox Permission Verification (Task 4 & 5)
* **Observation:** The plan notes that `optional_host_permissions` supports Chrome and Firefox MV3. However, Firefox's permission dialog behaviour and return values can sometimes differ slightly under specific configurations (e.g. private windows or strict origin policies).
* **Suggestion/Improvement:** Ensure manual verification checklists explicitly note testing the permission grant/revoke flow in both Chrome and Firefox to verify consistent handling of the returned `Promise<boolean>` from `chrome.permissions.request`.

## 4. URL Prefix Matching in Recogniser (Task 2)
* **Observation:** In Task 2, `splitOrigin(entry.origin)` returns `{ base, prefix }`. The recognizer matches configured origins by checking if the URL pathname starts with the prefix.
* **Suggestion/Improvement:** Double check edge cases around case sensitivity in path prefixes for self-hosted instances (e.g., `/Jenkins` vs `/jenkins`). While hostnames are normalized to lowercase by the URL parser, path prefixes are case-sensitive on many web servers, so matching should be robust to this or document case-normalisation assumptions.
