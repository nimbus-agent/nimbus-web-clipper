# Review and Suggestions: Research Briefs Implementation Plan

This document contains feedback, suggestions, and open questions on the implementation steps outlined in [2026-08-17-research-briefs.md](file:///C:/gitrep/nimbus-web-clipper/.claude/worktrees/research-briefs-lane/docs/superpowers/plans/2026-08-17-research-briefs.md).

---

## 1. Test Gate Warning: Pruning of Suggestions Files
* **The Concern**: The plan notes that `test/unit/doc-references.test.ts` asserts the `docs/superpowers/plans/` directory is empty.
* **Impact**: Adding this suggestions file (`2026-08-17-research-briefs-suggestions.md`) to the plans folder will also cause `bun run test` to fail on that assertion.
* **Actionable Step**: Make sure that in **Task 14** (Documentation, roadmap and changelog), the developer or agent deletes both the plan file *and* this suggestions file from the workspace so that the final PR build passes the pruning check.

## 2. Alarm Lifecycle Management (Optimizing Resource Usage)
* **The Concern**: In Task 11, the `nimbus-brief-poll` alarm is introduced as an eviction net/fallback for the service worker.
* **Suggestion**:
  * Ensure the alarm is created dynamically when a brief run transitions to the `running` state, and cleared (`chrome.alarms.clear`) as soon as the run reaches a terminal state (`done` or `failed`).
  * If the alarm is registered statically on extension startup or left running indefinitely, it will repeatedly wake up the service worker every minute even when no brief is active.

## 3. Save-Time Expiration UX
* **The Concern**: Since briefs are ephemeral and runs are cleaned up after 30 minutes (or evicted from the gateway if concurrent runs limit is reached), saving a brief via `POST /v1/briefs/{id}/save` can return a 404 or 410.
* **Suggestion**: Explicitly ensure Task 10 (the brief page UI) handles this failure pathway gracefully by updating the UI status from `done` to a state that shows "Save failed: brief run has expired" rather than showing a generic server error or keeping the button in a loading spinner indefinitely.

## 4. Error Diagnostics for empty `listCandidateTabs()`
* **The Concern**: If `chrome.tabs.query` fails, the plan suggests catching the exception and returning `{ named: [], hiddenCount: 0 }`.
* **Suggestion**: While catching exceptions is good for reliability, silent failures can make debugging hard. It is recommended to log the exception internally (e.g. to a diagnostic/trace service or using a safe debug logger) so that if host permission/extension state bugs crop up, there is trace evidence of the failed query.
