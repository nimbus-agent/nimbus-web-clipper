# Review & Suggestions: Passages as Brief Sources Design

This document reviews [2026-08-18-passages-as-brief-sources-design.md](file:///C:/gitrep/nimbus-web-clipper/.claude/worktrees/passages-as-brief-sources/docs/superpowers/specs/2026-08-18-passages-as-brief-sources-design.md) and captures open questions, suggestions, and potential improvements.

---

## 1. Open Questions

### Q1: Clearing Passages when "Whole Page" is Toggled
* **Context:** Decision 5 introduces a toggle to "use the whole page instead" of passages if the URL is an open tab. Decision 9 states that the collection is cleared of groups accepted into a run that reached `/run`.
* **Question:** If the user toggles a row to "Whole Page" mode and completes the run, are the stored passages for that URL cleared or kept?
  * *Option A (Clear):* Clear them. The user "sent the page," so they likely consider the collection for that page complete/consumed.
  * *Option B (Keep):* Keep them. The passages themselves were not actually sent (the whole page was), so clearing them might feel like a data loss if they wanted to reuse those specific highlights later.
  * *Recommendation:* Clear them. Reusing highlights is explicitly called out as out of scope ("re-running the same sources with a tweaked question needs re-collecting"), and keeping them would result in surprising "ghost" highlights appearing in the next brief run if the tab is closed.

### Q2: Stitched Separator Standard
* **Context:** Decision 3 states: *"The separator is a visible marker, not a blank line."*
* **Question:** What is the exact string structure of this separator?
  * If it's markdown-like, using a standard horizontal rule with clear labels helps the downstream LLM understand boundaries:
    ```markdown
    
    --- [Excerpt boundary] ---
    
    ```
  * *Recommendation:* Define this as a constant in `src/shared/passage.ts` (e.g., `PASSAGE_SEPARATOR = "\n\n--- [Passage Separator] ---\n\n"`) so both client previews and gateway handlers reference the exact same boundary.

---

## 2. Improvements & Suggestions

### Suggestion 1: URL Normalization / Query Parameter Pruning
* **Context:** Decision 8 states: *"Grouping is by exact URL string. Two visits to the same page under different query strings are two groups..."*
* **Issue:** Users frequently visit pages with dynamic query parameters (e.g., `?utm_source=...`, `?ref=...`, or hash fragments like `#section-2`). If they highlight a passage on `example.com/page?ref=1` and another on `example.com/page`, these will be treated as separate sources, violating the "one page is one row/source" mental model.
* **Suggestion:** Implement a basic URL normalizer during grouping (e.g., stripping common tracking parameters or hashes) or at least stripping the `#` hash fragment, while retaining necessary parameters (like search queries on search result pages).

### Suggestion 2: Passage-Level Deletion in the Composer Preview
* **Context:** Decision 7 enables showing the actual captured passage text in the preview, collapsed under the count. Decision 9 mentions only "Manual per-row remove".
* **Issue:** If a user collects 3 passages from a page and decides one of them was a mistake, their only option is to delete the entire page from the composer, then go back to the tab and re-collect the other 2 passages.
* **Suggestion:** Since the preview already displays the individual passages, add a small delete/dismiss button `(x)` next to each passage in the preview drawer. This provides a low-friction way to prune unwanted snippets without losing the whole group.

### Suggestion 3: Safe Storage Overhead Check
* **Context:** Decision 8 specifies a limit of 200 KB per page's stitched body and 20 pages max in the collection.
* **Analysis:** `20 * 200 KB = 4.0 MB`. Chrome's standard extension storage limit for `chrome.storage.local` is **5 MB** unless the `"unlimitedStorage"` permission is requested.
* **Suggestion:** Although 4.0 MB fits within 5 MB, we also store other data in `storage.local` (e.g., clip queue, configuration, cached telemetry). To guarantee we never hit a browser quota exception, we should:
  1. Add the `"unlimitedStorage"` permission to `manifest.ts` to remove the 5MB cap entirely, OR
  2. Implement defensive try-catch blocks around the storage write in `passage-store.ts` to handle quota-exceeded errors gracefully.

---

## 3. Implementation Details / Checklist Additions

### `messages.ts` Guard Verification
* **Check:** Ensure the schema guard for `BriefStartRequest.picks` validates that:
  - For `kind: "tab"`, `id` is a valid integer.
  - For `kind: "passages"`, `url` is a valid string of acceptable length, preventing payload injection.

### Test Coverage Checklist
* Add a unit test to verify that toggling between "Whole Page" and "Passages" mode updates the `picks` structure sent to `BriefStartRequest` correctly.
* Add an integration test in `brief-handlers.ts` verifying that if a passage source is skipped due to gateway budget capacity restrictions, its status remains intact in `passage-store`.
