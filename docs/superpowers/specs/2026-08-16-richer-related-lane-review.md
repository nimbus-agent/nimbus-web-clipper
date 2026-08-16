# Review: Richer Related Lane Design Specification

This document collects open questions, suggestions, and potential improvements for the proposed design specification in [2026-08-16-richer-related-lane-design.md](file:///C:/gitrep/nimbus-web-clipper/.claude/worktrees/richer-related-lane/docs/superpowers/specs/2026-08-16-richer-related-lane-design.md).

---

## 1. Gateway & SQL Queries

### FTS Column Index Fragility (Decision 1)
* **Concern:** The fix uses a hardcoded column index: `snippet(item_fts, 1, '', '', '…', 24)`. If the FTS table structure changes in a future migration (e.g., columns are reordered or a new column is inserted), using a hardcoded index `1` will silently break or display incorrect data.
* **Suggestion:** Verify if the SQLite query can reference the column by name or alias dynamically, or add a compile-time/test-time assertion/validation in the gateway tests to ensure that index `1` always maps to the body column.

### Query Exclusions under Selection-driven Search (Decision 2 & 4)
* **Question:** When a selection is active, the query text is driven by the selection rather than the item's title. In this scenario, is `itemId` still passed to `runClipRelated` to handle the self-exclusion of the current page?
* **Suggestion:** Clarify in the spec that `itemId` self-exclusion must run regardless of the query source (whether the query text comes from `selection`, `itemId`, or `title`).

### Verification of `modified_at` Time Units (Decision 3)
* **Question:** Is the `modified_at` field returned by the gateway represented in epoch seconds or epoch milliseconds? SQLite databases frequently store Unix timestamps in seconds, whereas Javascript expects milliseconds.
* **Suggestion:** Explicitly document the expected unit in the gateway wire contract (e.g. "Epoch seconds" or "Epoch ms") so that the client-side renaming and conversion logic knows exactly whether it needs to multiply by 1000.

---

## 2. Client & UI presentation

### Service Group Ordering Strategy (Decision 4)
* **Question:** How will the client order the service groups (e.g. GitHub, Slack, Notion)? 
* **Suggestion:** Define the sorting order of groups explicitly in the spec (e.g., by the maximum relevance score of any item in that group, by the size of the group, or alphabetically). Sorting by the highest-scoring item in each service group is generally best to keep the most relevant services at the top.

### Truncation vs. Grouping (Decision 4)
* **Question:** If the gateway query is limited (via `RelatedInput.limit`), it's possible that a single service with many hits fills up the limit, completely starving other services and preventing them from showing up as groups.
* **Suggestion:** Recommend that the client requests a slightly larger limit from the gateway (e.g., 30-50 hits) and then groups and truncates them on the client side to say, the top 3 items per service. This ensures variety in the service groups shown to the user.

### Type to Icon/Chip Mapping (Decision 3)
* **Question:** How does the client map the new `type` field to specific visual chips or icons?
* **Suggestion:** Provide a brief mapping or fallback policy in the spec (e.g., mapping `"pull_request"` to a PR icon, `"issue"` to an issue icon, and defaulting to a generic document chip if the type is unrecognized).

---

## 3. Testing & Compatibility

### Edge Case: Unresolved Selection
* **Question:** What happens if `selection` is active, but the page itself does not resolve to a known `itemId`?
* **Suggestion:** Ensure the tests verify that when a selection query is run on an unresolved page, self-exclusion is skipped gracefully, but selection search still functions using the selection text.
