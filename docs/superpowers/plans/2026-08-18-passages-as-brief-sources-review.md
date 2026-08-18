# Review & Suggestions: Passages as Brief Sources Implementation Plan

This document reviews [2026-08-18-passages-as-brief-sources.md](file:///C:/gitrep/nimbus-web-clipper/.claude/worktrees/passages-as-brief-sources/docs/superpowers/plans/2026-08-18-passages-as-brief-sources.md) and details open questions, bug risks, and suggestions for the implementation steps.

---

## 1. Critical Bug Risks

### Bug Risk 1: Duplicate Passage Rows for Multiple Tabs of the Same Page (Task 7, Step 3)
* **Context:** The rendering logic in Task 7, Step 3 walks through `model.named` tabs and checks if a passage group exists for that tab's URL:
  ```ts
  for (const tab of model.named) {
    const group = byKey.get(groupKey(tab.url));
    if (group === undefined || whole.has(group.url)) {
      list.appendChild(tabRow(tab, model.selected));
      continue;
    }
    consumed.add(group.url);
    list.appendChild(passageRow(group, model.selected, tab));
  }
  ```
* **Issue:** If the user has two open tabs of the same page with different fragments (e.g. `http://h/a#one` and `http://h/a#two`), both tabs will resolve to the same group key (`http://h/a`).
  - In the first iteration, `consumed.add("http://h/a")` is called and the passage row is appended.
  - In the second iteration, the loop does *not* check `consumed.has(group.url)`. It will render the exact same passage row a second time, resulting in duplicate DOM elements for the same passage group and breaking the "one row per URL" invariant.
* **Fix/Suggestion:** Update the conditional check in the loop to account for already consumed groups:
  ```ts
  if (group === undefined || whole.has(group.url) || consumed.has(group.url)) {
    list.appendChild(tabRow(tab, model.selected));
    continue;
  }
  ```

---

## 2. Open Questions & Refinements

### Q1: Module-level State in Mock Gateway (Task 8, Step 1)
* **Context:** The plan uses module-level variables (`briefExpected` and `briefReceived`) in `mock-gateway.ts` to track counts across requests:
  ```ts
  let briefExpected = 0;
  let briefReceived = 0;
  ```
* **Question:** Is there a risk of race conditions or state pollution between different e2e runs?
* **Recommendation:** Rather than module-level variables, store these counters within the `Scenario` context (or on the `scenario` object directly). Since `Scenario` is fresh per test run/launch, this guarantees isolation and prevents flaky test failures.

---

## 3. Improvements & Enhancements

### Suggestion 1: Guarding `tabId` in Service Worker Menu Click (Task 3, Step 7)
* **Context:** `collectPassage` requires a `tabId: number`. The click listener payload in `service-worker.ts` has `tabId: number | undefined`.
* **Suggestion:** Make sure the early return guard is explicitly written out in the plan snippet to remind the developer/agent:
  ```ts
  case "add-passage":
    if (tabId === undefined) {
      return;
    }
    collectPassage(passageCollectDeps, tabId).catch(() => undefined);
    return;
  ```

### Suggestion 2: Adding a lint check for `PASSAGE_SEPARATOR`
* **Context:** The plan specifies `PASSAGE_SEPARATOR` is exactly `"\n\n[...]\n\n"`.
* **Suggestion:** Add a test case in `passage.test.ts` checking that `PASSAGE_SEPARATOR` matches this exact pattern, preventing accidental drift during code formatting (e.g., Biome or Prettier trying to collapse whitespace in string literals).
