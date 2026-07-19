# Review: Quick-Clip Entry Points Implementation Plan

Review of the implementation plan in [2026-07-19-quick-clip-entry-points.md](file:///C:/gitrep/nimbus-web-clipper/docs/superpowers/plans/2026-07-19-quick-clip-entry-points.md).

---

## Open Questions & Improvements

### 1. Robust Detection of Chrome Web Store (Blocked Domains)
* **Concern:** The implementation of `isRestrictedUrl` in Task 5 check only protocol schemes:
  ```ts
  const RESTRICTED_SCHEMES = new Set([
    "chrome:",
    "chrome-extension:",
    "moz-extension:",
    "about:",
    "edge:",
    "view-source:",
  ]);
  ```
  However, browser extensions are also strictly blocked from injecting content scripts into the **Chrome Web Store** (`chrome.google.com/webstore` and `chromewebstore.google.com`).
* **Suggestion:** Expand `isRestrictedUrl` to check if the host matches these domains. For example:
  ```ts
  const blockedHosts = ["chrome.google.com", "chromewebstore.google.com"];
  // Check if url parsed matches these hostnames as well.
  ```

### 2. Layout & Style Overlaps (Toast Position)
* **Concern:** Placing the toast at `bottom: 16px; right: 16px;` is standard, but the bottom-right corner is frequently occupied by other interactive widgets (e.g. Intercom/Zendesk chat bubbles, scroll-to-top buttons, etc.).
* **Suggestion:** Consider changing the position to the top-right (`top: 16px; right: 16px;`) or adding a slight offset/custom style structure that places the toast out of the way of common chat bubble zones.

### 3. Avoiding Repeated `toast.js` Injection Overhead
* **Concern:** In Task 6, Step 1, `showToast` is implemented as:
  ```ts
  export async function showToast(tabId: number, state: ToastState): Promise<void> {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["toast.js"] });
    await chrome.scripting.executeScript({ ... });
  }
  ```
  This executes the entire `toast.js` file on every single clip event. While safe (it just re-registers the global function), it generates unnecessary script evaluation overhead.
* **Suggestion:** We could first query the tab to see if `__nimbusToast` exists, e.g., by executing a simple check script first. If it does, invoke it immediately and skip the `files: ["toast.js"]` step.
