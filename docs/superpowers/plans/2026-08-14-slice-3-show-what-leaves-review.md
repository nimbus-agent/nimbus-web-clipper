# Slice 3 — Show What Leaves: Plan Review

This document contains a review, improvements, and suggestions for the Slice 3 implementation plan.

---

## Major Strengths & Design Wins

1. **Defense-in-Depth against Token Leakage**: Manually naming and constructing the preview fields (rather than iterating over keys of the `ClipPayload` or request objects) is an excellent security guard. It ensures that future additions to the payload structure cannot accidentally expose the bearer token or other secrets.
2. **Fail-Safe Preference Defaults**: Setting `preview-enabled` to default to `true` (and failing safe to `true` on invalid values) ensures that we prioritize user privacy and consent over convenience in ambiguous states.
3. **Correct Panel Latching (`fetchSent`)**: Gating the `fetchSent` latch inside the confirmed execution path rather than the preview-open path is critical. This prevents a user's cancel gesture from locking them out of fetching.

---

## Suggested Improvements & Edge Cases

### 1. Disable / Hide Main Actions During Popup Preview
* **Issue**: When `#preview` is shown (`section.hidden = false`), the rest of the popup content (e.g., the primary capture buttons like "Clip Page") might still be interactive or visible.
* **Suggestion**: When the preview is open, either:
  - Add a class or set `disabled = true` on the other action/mode buttons to prevent duplicate captures or state confusion.
  - Or, hide the main actions container entirely while `#preview` is visible.

### 2. Formatting of Tags in the Preview
* **Issue**: The plan uses `payload.tags.join(", ")` (yielding `"research, work"`). If there are many tags, or long tags, this might overflow or look cluttered.
* **Suggestion**: Consider wrapping tags in small inline badge styles in the popup UI if space permits, or ensuring the CSS handles word-wrapping for tags appropriately.

### 3. Clear Status Message Handling on Cancel
* **Issue**: When a user cancels the popup preview, `setStatus("Cancelled — nothing was sent.")` is called.
* **Suggestion**: Ensure that clicking a capture button again clears this cancel status message so that status reads correctly when the new preview opens.

---

## Open Questions

1. **Quick-Clip Clarity in Options/Trust Panel**: Since quick-clip (hotkeys and context-menu clips) intentionally bypasses the preview confirmation step, should we add a small note near the toggle in the Options UI (not just in the "What we send" paragraph) clarifying that the setting only applies to toolbar clips?
2. **Fetch Preview Layout in Panel**: Since the in-page panel has constrained horizontal space, how should the Send/Cancel controls for the targeted fetch preview be positioned? (e.g., stacked vertically or side-by-side?)
