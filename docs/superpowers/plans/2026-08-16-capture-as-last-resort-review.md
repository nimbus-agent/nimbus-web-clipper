# Review: Capture as the Last Resort Implementation Plan (2026-08-16)

This document tracks reviews, suggestions, and open questions for the [2026-08-16-capture-as-last-resort.md](file:///C:/gitrep/nimbus-web-clipper/.claude/worktrees/capture-last-resort/docs/superpowers/plans/2026-08-16-capture-as-last-resort.md) implementation plan.

---

## 1. Discrepancies and Scope Alignment

### Contradiction on "Update this copy" (Task 5 & 6 vs. Spec)
* **The Issue:** The design spec states under *Decision 6*:
  > *"Re-capturing to refresh a stale copy is **not** in this slice. It is a real feature and a different one..."*
  
  And under *Not in this slice*:
  > *`Re-capture / refresh — decision 6.`*
  
  However, the implementation plan explicitly schedules it:
  * **Task 5** requires rendering an `"Update this copy"` button with the class `nimbus-related__recapture` and testing it.
  * **Task 6** requires wiring `onRecapture` to `sendCapture()`.
* **Recommendation:** While implementing the recapture feature in this slice makes sense because it reuses the same backend logic (`POST /v1/clips` upserts on the URL), the design spec and the implementation plan must be aligned. Either:
  1. Update the design spec to indicate that recapture is included because it leverages the same upsert pathway, or
  2. Remove the recapture buttons/callbacks from the implementation plan tasks if we strictly want to defer it.

---

## 2. Technical & Safety Enhancements

### Mid-Capture URL Drift Check (Task 2 & 4)
* **The Issue:** In `captureTab` (Task 2), the live URL is checked against `expectedUrl` *before* injecting the script and running capture. However, because `runCapture` is an asynchronous operation that communicates with the tab, the user could navigate to a new SPA route *while* capture is executing.
* **Suggestion:** To prevent a race condition where the DOM of the *new* page is captured but filed under the *old* URL, the background handler (or `captureTab`) should perform a post-capture validation:
  ```ts
  if (expectedUrl !== undefined && capture.url !== expectedUrl) {
    return { ok: false, reason: "url-changed" };
  }
  ```
  This ensures that if the page URL drifts during the asynchronous capture window, we fail closed with `url-changed`.

### Error Handling Consistency (Task 6)
* **Context:** Task 6 introduces the `CaptureError` string mappings:
  * `restricted` -> `"Nimbus can't capture browser system pages."`
  * `url-changed` -> `"You've moved on — this panel is still about the page you opened it on."`
  * `injection-failed` -> `"Couldn't read this page."`
  * `empty` -> `"There's nothing readable on this page to save."`
* **Suggestion:** Verify where these strings are injected. If they are rendered inside `panel-view.ts`, the mapping should probably live there (or in a shared presentation helper) rather than directly inside the controller state machine `panel-in-page.ts`. Keeping rendering strings in `panel-view.ts` preserves the clean separation of concerns between view and controller.
