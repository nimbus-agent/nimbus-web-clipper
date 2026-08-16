# Review: Capture as the Last Resort Design (2026-08-16)

This document tracks reviews, suggestions, and open questions for the [2026-08-16-capture-as-last-resort-design.md](file:///C:/gitrep/nimbus-web-clipper/.claude/worktrees/capture-last-resort/docs/superpowers/specs/2026-08-16-capture-as-last-resort-design.md).

---

## 1. High-Risk / Architectural Questions

### SPA DOM Scrape mismatch with Pinned URL (Decision 2)
* **Context:** The design states: *"The captured page is the PINNED page, not the tab's current URL. ... Capture must use the same pinned URL, or a background SPA navigation would let the panel offer to save one page and actually save another..."*
* **The Issue:** In a Single Page Application (SPA), if the user navigates to a new page in the background, the current DOM changes to represent the **new** page, but the tab's URL (or the panel's internal state) might still refer to the **pinned** (old) URL. If the scraper runs on the active tab DOM, it will capture the HTML of the new page but associate it with the pinned (old) URL. When ingested, this creates a corrupt/mismatched index entry (old URL points to new content).
* **Questions:**
  1. Does the panel detect when the current tab URL has deviated from the pinned URL (e.g. via the page-context slice)?
  2. If a mismatch is detected, should the "Capture" offer be disabled, or should it prompt the user to re-resolve/unpin first?
  3. Scrappy fallback: Should we verify that the current tab URL matches the pinned URL at the exact moment of capture, throwing a `CaptureError` (e.g., `"url-changed"`) if they do not match?

### Shared Constants vs. Hardcoupling (Decision 4)
* **Context:** The design plans to hardcode `CLIP_SERVICE` (`"nimbus"`) and `CLIP_TYPE` (`"web_clip"`) client-side to detect captured copies, noting that if the gateway renames either, the header silently degrades.
* **Suggestion:** Since the workspace contains both `packages/gateway` and `packages/extension` (implied by the paths), can we export these constants from a shared schema/constants package or configuration file? Even a basic shared type declaration would prevent silent degradation on gateway-side refactoring.

---

## 2. UX & Interaction Improvements

### Visual Feedback when Preview is Disabled (Decision 3)
* **Context:** If the user has disabled the preview option, the capture flow should ideally be "one gesture".
* **Suggestion:** When the preview is off, clicking "Capture" should immediately show an in-progress indicator (e.g., changing the button to a loading spinner or showing a "Capturing page..." status line). Without this, the network lag during worker communication and gateway ingestion could make the panel appear frozen or non-responsive.

### Re-capture / Update Path (Decision 6)
* **Context:** The design excludes re-capturing to refresh a stale copy to limit scope.
* **Suggestion:** If a user opens the panel on a page that was already captured previously, they will see the "Captured copy" header stating something like *"Updated 3 weeks ago"*. 
  * If the page content has changed, how does the user update it? 
  * If no "Re-capture" button exists, they would have to open the Nimbus dashboard, find the clip, delete it, and reload the panel to see the "Capture" offer again.
  * **Proposal:** Consider adding a secondary, low-prominence link/button (e.g. *"Update copy"* or *"Recapture"*) directly in the captured header arm. If this is deferred, we should explicitly document it as a fast-follow story for the next milestone.

---

## 3. Implementation Details & Validation

### Restricted URL Checks in `capture-tab.ts`
* **Context:** The design notes that `isRestrictedUrl` is unnecessary for the panel's capture offer since it is already injected.
* **Suggestion:** In `src/background/capture-tab.ts`, which is shared between the hotkey and the panel paths, we should still enforce the `isRestrictedUrl` check internally. This ensures defense-in-depth and prevents potential extension API errors if the worker is queried with an invalid or restricted URL scheme via message passing.
