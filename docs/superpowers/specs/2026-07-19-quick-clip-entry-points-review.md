# Review: Quick-Clip Entry Points Design

Review of the design specification in [2026-07-19-quick-clip-entry-points-design.md](file:///C:/gitrep/nimbus-web-clipper/docs/superpowers/specs/2026-07-19-quick-clip-entry-points-design.md).

---

## Open Questions

### 1. Script Injection Optimization (Repeated Injections)
* **Question:** The spec says: *"SW shows it with the same two-step `executeScript` pattern: inject `toast.js`, then `executeScript(func: ...)`"*.
* **Concern:** If the user triggers quick clips repeatedly, injecting `toast.js` every single time adds overhead.
* **Suggestion:** We should check if `globalThis.__nimbusToast` is already defined in the page context before calling `executeScript({ files: ["toast.js"] })`. If it exists, we can skip the file injection step and immediately call the function.

### 2. Toast Queueing and Concurrency
* **Question:** What happens if a user triggers quick-clip multiple times rapidly (e.g., clipping 3 different sections of a page using the shortcut)?
* **Concern:** If a toast is currently auto-dismissing (duration ~2.5s) and another is triggered:
  - Does the new toast overwrite the existing one?
  - Does it stack vertically?
  - Does it queue and wait for the first to dismiss?
* **Suggestion:** The simplest approach is for the new toast to replace the text content of the existing toast and reset the 2.5s timer, rather than spawning multiple shadow root hosts or stacking them.

### 3. Toast Accessibility (a11y)
* **Question:** Since the toast is injected dynamically into the page, how do screen reader users know that the clip succeeded or failed?
* **Suggestion:** The toast container inside the Shadow Root should include appropriate ARIA roles and properties, such as `role="status"` and `aria-live="polite"`, so that the browser announces the feedback state automatically.

### 4. Style Isolation & Performance
* **Question:** Since the toast will render in a Shadow Root to avoid page CSS interference, how are its styles defined?
* **Suggestion:** Inject a `<style>` tag containing minimal, scoped CSS directly inside the shadow root. Keep the CSS compact to minimize the injection footprint.

---

## Technical Improvements

### 1. Robust Detection of Restricted Pages
* **Issue:** Detecting when to trigger the badge fallback.
* **Details:** Relying solely on `try/catch` around `executeScript` works, but it can trigger verbose console errors in the browser's extension panel.
* **Suggestion:** We can pre-check the tab's URL scheme. If the URL starts with `chrome://`, `chrome-extension://`, `about:`, `file:///` (unless access is granted), or matches known restricted domains like the Chrome Web Store, we can immediately route to the badge fallback without attempting (and failing) script injection.

### 2. Context Menu Cleanup on Extension Uninstallation/Disable
* **Details:** While the context menu is registered idempotently, we should ensure that cleanups occur correctly if the extension is disabled or updated.
* **Suggestion:** In MV3, calling `chrome.contextMenus.removeAll()` inside the `chrome.runtime.onInstalled` handler before re-creating them is standard practice. The spec mentions this, but we should make sure our mock harness also tests this cleanup step.
