# Design Review: "Why does this change exist", asked from a pull request page (C2.4)

Below are comments, questions, and suggested improvements for the `2026-08-19-why-from-a-pull-request-design.md` specification.

## Open Questions & Clarifications

1. **URL Normalization and Tab Sub-Pages**
   * **Scenario:** A user is viewing a PR on a sub-tab, such as `https://github.com/owner/repo/pull/123/files`, `https://github.com/owner/repo/pull/123/commits`, or with query parameters like `?w=1` or `?notification_referrer_id=...`.
   * **Question:** Does the background handler/clipper pass the exact browser URL, or does it normalize/truncate it first? If the index canonical URL is exactly `https://github.com/owner/repo/pull/123`, a lookup of the tab URL via `resolveItemByUrl` might fail if it does not handle URL normalization. We should specify where URL normalization occurs (clipper-side, gateway-side, or within `resolveItemByUrl` itself).

2. **Unindexed PR User Experience**
   * **Question:** When a PR is not yet indexed, what does the user see in the Clipper panel? If `resolvePrSubject` returns `not_indexed`, does the brief render a clear call-to-action (CTA) to run Targeted Sync (C3.1)? A user-friendly message explaining that the PR needs indexing first is much better than a generic failure or a blank panel.

3. **Handling Multiple Matches / Ambiguity**
   * **Question:** The resolver design mentions an `ambiguous` miss arm when `resolveItemByUrl` declines to guess between multiple trimmed candidates. In what scenarios could a PR URL lookup be ambiguous, and how should the UI or CLI represent this to the user?

## Suggested Improvements

1. **Explicit CLI Output Formatting for PRs**
   * **Suggestion:** When running `nimbus why <url>` in the CLI, the output format should be tailored to the PR change context rather than file-line context. It should clearly display the PR Title, Number, and Repository at the top, and omit file-level section headers like authorship/blame.

2. **GitLab/Bitbucket URL Test Coverage**
   * **Suggestion:** Since the new resolver explicitly targets fixing GitLab and Bitbucket match defects, the unit/integration tests in `pr-subject.test.ts` should include varied host/URL layouts for GitLab (e.g., self-hosted instances, subgroup paths, and URL formats like `/merge_requests/N`) and Bitbucket (Server `/projects/PROJ/repos/repo/pull-requests/N` vs Cloud `/owner/repo/pull-requests/N`).
