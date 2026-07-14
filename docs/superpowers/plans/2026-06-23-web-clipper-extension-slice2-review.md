# Plan Review: Web Clipper Extension Slice 2 (Related-items sidecar)

**Review Date:** 2026-06-23  
**Reviewer:** AI Coding Assistant (Antigravity)  
**Target Plan:** [2026-06-23-web-clipper-extension-slice2.md](./2026-06-23-web-clipper-extension-slice2.md)

---

## 1. Import Dependencies & Missing References

### `activeTab` Import in `popup.ts` (Task 8, Step 4)
* **Observation:** In Task 8, Step 4, `showRelated()` uses `await activeTab()`. However, the import statement shown only merges `injectPanel` and `runCapture` from `../browser/scripting.ts`:
  ```typescript
  import { injectPanel, runCapture } from "../browser/scripting.ts";
  ```
* **Correction:** Ensure that `activeTab` is imported from its correct location (which is typically `../browser/tabs.ts` or similar browser wrapper module) in `src/popup/popup.ts`. 

---

## 2. Event Listener & Keyboard Trap Edge Cases

### Keyboard Tab Navigation Trap (Accessibility)
* **Observation:** Task 7 mounts the sidecar directly into the DOM inside a Shadow DOM wrapper.
* **Suggestion:** Since the panel contains interactive elements like links and buttons (e.g., the close `✕` button and the list of related item links), a user using keyboard navigation (`Tab` / `Shift+Tab`) might tab out of the panel and into the background page's focusable elements while the overlay is active.
* **Recommendation:** Consider adding a basic focus trap inside the Shadow DOM keydown listener (Task 7, Step 1) or ensure the close button is focused upon opening to guide keyboard and screen reader users.

---

## 3. UI/UX Suggestions

### Hotkey Silent Failure Feedback
* **Observation:** When the hotkey is triggered on a restricted page, `chrome.scripting.executeScript` rejects, and the service worker catches the error and does nothing (`.catch(() => undefined)`).
* **Suggestion:** To prevent users from thinking the hotkey listener is broken, the service worker could play a system warning sound or update the extension's badge temporarily to indicate it cannot run on that page. (Note: `console.*` is prohibited in shipped `src/` code, so a developer-facing log is not an option here — keep any feedback to a non-console signal.)

---

## 4. Test Alignment

### Abort/Timeout Test Integration (Task 3)
* **Observation:** Task 3 introduces `postRelated` with `RELATED_TIMEOUT_MS = 8_000` (8s).
* **Suggestion:** It would be beneficial to add a unit test checking that the abort signal/timeout behavior works correctly if the response takes longer than 8 seconds, ensuring that `postRelated` returns `unreachable` rather than hanging indefinitely.
