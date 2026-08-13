# Review & Suggestions: Ambient Surfacing Design

This document contains open questions, suggestions, and potential improvements for the proposed design in [2026-08-13-ambient-surfacing-design.md](file:///C:/gitrep/nimbus-web-clipper/docs/superpowers/specs/2026-08-13-ambient-surfacing-design.md).

## 1. Race Conditions in Asynchronous Resolve
* **Scenario:** The user lands on a recognized page, triggering the asynchronous `resolve` loopback call. While the API call is in flight, the user rapidly switches tabs, closes the tab, or navigates to a different URL.
* **Suggestion:** Before injecting the cue script (`cue.js`) when `resolve` returns with `found`, the background worker must verify:
  * The target tab still exists.
  * The target tab is still the active tab.
  * The target tab's current URL matches the URL that was sent for resolution.
  * The panel is not already open on that tab.
  Otherwise, the cue could flash briefly or mount on a page the user has already navigated to.

## 2. In-Memory Prefs Cache for `onUpdated`
* **Performance Concern:** `chrome.tabs.onUpdated` fires frequently. Although the browser gates `changeInfo.url` based on permissions and we apply a debounce, reading preferences from storage (`chrome.storage.local` or similar) to check if a host is "toggled on" on every URL change could introduce I/O latency.
* **Suggestion:** The `ambient-prefs` store should maintain an in-memory cache of the enabled host patterns in the service worker. The service worker can load this cache once during startup and update it whenever the preferences change.

## 3. UI Synchronization for Built-In Origins
* **Question:** How will the Options UI determine the "Grant/Revoke" status for built-in origins (e.g. `github.com`, `*.atlassian.net`)?
* **Suggestion:** The `surfaces-view.ts` page should query `chrome.permissions.contains({ origins: [pattern] })` dynamically for each row (both built-in and stored) to determine whether the "Grant" or "Revoke" button should be displayed, ensuring the UI state is always synchronized with the browser's actual permission state.

## 4. Visual Placement & DOM Collisions
* **Question:** Which page corner is the cue pinned to (e.g., bottom-right)? Many modern websites have persistent UI elements in the bottom-right corner (chat bots, cookie banners, feedback buttons, scroll-to-top buttons).
* **Suggestion:** 
  * Explicitly define the default corner position (e.g., bottom-right) but ensure the container's CSS uses `pointer-events: none` on the overlay wrapper and `pointer-events: auto` on the cue itself, so it doesn't block clicks to underlying page elements.
  * Consider allowing the cue to be dragged or at least closed easily if it overlaps important page controls.

## 5. Canceling Stale Requests on Debounce
* **Question:** If the 600ms debounce triggers while an existing `resolve` call for the same tab is still in flight, does it abort the previous fetch/message?
* **Suggestion:** If a tab's URL changes again within or shortly after the debounce window, any active resolution/fetch controller should be aborted to avoid wasting network bandwidth and processing stale responses.
