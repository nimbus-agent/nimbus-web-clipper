# Review & Suggestions: Panel Page Context Implementation Plan

This document contains open questions, suggestions, and potential improvements for the proposed implementation plan in [2026-08-11-panel-page-context.md](file:///C:/gitrep/nimbus-web-clipper/docs/superpowers/plans/2026-08-11-panel-page-context.md).

## 1. Retry/Recovery Bug on Network/Worker Failure
* **The issue:** In Task 7, Step 4, `lastCheckedUrl` is updated *before* the async `sendMessage` call:
  ```ts
  const url = window.location.href;
  if (url === lastCheckedUrl) {
    return;
  }
  lastCheckedUrl = url; // <-- Updated here
  let res: unknown;
  try {
    res = await sendMessage({ kind: "recognise", pageUrl: url });
  } catch {
    // The worker is unreachable. Leaving the notice as it is beats guessing;
    return; // <-- Returns here
  }
  ```
  If the background worker is temporarily unreachable/busy when the navigation occurs, `sendMessage` will throw. Because `lastCheckedUrl` was already updated to the new `url`, subsequent interval ticks (which see `url === lastCheckedUrl`) will return early and **never retry** the check for this page.
* **Suggestion:** We should only commit the `lastCheckedUrl` update after a successful response, or reset it in the `catch` block:
  ```ts
  catch {
    lastCheckedUrl = ""; // Or revert to previous lastCheckedUrl so the next tick retries
    return;
  }
  ```

## 2. In-flight Poll/Timeout Cleanups on Generation Changes
* **Question:** When a re-read occurs and the generation counter is incremented, what happens to ongoing poll timeouts/intervals in `pollLane`?
* **Suggestion:** Ensure that the generation check in `pollLane` not only prevents painting but also stops rescheduling the next poll. If it doesn't, we might have orphaned polling loops running in the background for the old item. We should double-check that `clearLanePoll(lane)` is called during `reread()` (which Task 7 Step 5 does), but verify if there are any race conditions where a poll might schedule itself *after* the clear because of an in-flight promise resolving.

## 3. Consistency of `pinnedRef` and `unrecognised` Header States
* **Question:** When the panel is pinned to an unrecognised page, `pinnedRecognition` is a failed recognition (e.g. `{ ok: false, reason: "unrecognised-path" }`).
  * In `checkNavigation`, we have:
    ```ts
    const away = pinnedRecognition !== null && !sameItem(pinnedRecognition, res.recognition);
    ```
  * In this state, if the user navigates to a recognised PR, `sameItem` returns `false` (since one is `ok: false` and the other is `ok: true`). `away` becomes `true`, and the banner shows, which is correct.
  * If the user clicks **Re-read page**, the state pins to the new PR, and `pinnedRecognition` gets populated with the PR's recognition.
  * If they navigate to another unrecognised page, `away` becomes `true`, and the banner shows, which is also correct.
  * **Clarification:** This matches expectations, but we must verify that the banner rendering code safely handles `pinnedRef: null` (generic copy) when `pinnedRecognition.ok === false` (as specified in Task 6, Step 1).
