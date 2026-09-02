# Design Review: Lanes for Every Recognised Page (C6 · C7)

**Date:** 2026-08-31  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Under Review  
**Target Spec:** [`2026-08-31-lanes-for-every-recognised-page-design.md`](./2026-08-31-lanes-for-every-recognised-page-design.md)  
**Upstream Gateway Spec:** [`Nimbus` / `2026-08-31-agents-for-items-and-files-design.md`](../../../Nimbus/.claude/worktrees/agent-item-file-arms/docs/superpowers/specs/2026-08-31-agents-for-items-and-files-design.md)  
**SDK Spec:** [`nimbus-sdk` / `2026-08-31-connections-and-currency-briefs-design.md`](../../../nimbus-sdk/.claude/worktrees/connections-currency-briefs/docs/superpowers/specs/2026-08-31-connections-and-currency-briefs-design.md)

---

## 1. Summary of Review

The design delivers a major milestone for the browser extension by expanding agent lanes across all recognized products and introducing the source file surface (`file`), which transforms the clipper into an in-browser code intelligence companion.

Key design highlights:
1. **Structural Exhaustiveness (F1):** Generalizing the lane table from `lane -> rule` to `lane × surface -> param shape` eliminates hidden runtime bugs in `agentParams` at compile time.
2. **Version Floor over Blind Rejection (F4):** Using a clean version floor check prevents wasteful network calls and egress ledger spam.
3. **Transparent File Miss Banners (F5):** Distinctly explaining why lanes are unavailable (*repo not cloned* vs *file not indexed*) rather than rendering confusing empty lanes.
4. **Direct Bridge Navigation without Local Path Guesses (F3):** Passing the forge coordinate directly to the gateway respects boundary separation.

Below are open questions, architectural recommendations, and edge cases to consider during development.

---

## 2. Open Questions & Design Clarifications

### Q2.1: Forge File URL Parsing with Branch Slashes
* **Context:** §5.1 lists file URL patterns for GitHub, GitLab, and Bitbucket (`/blob/<ref>/<path>` or `/src/<ref>/<path>`).
* **Issue:** In git forges, branch names frequently contain forward slashes (e.g. `feat/auth-v2`, `bugfix/issue-123`, `release/2.14.0`).
  - For `github.com/acme/web/blob/feat/auth-v2/src/index.ts`, a naive split on `/blob/` takes `feat` as the ref and `auth-v2/src/index.ts` as the path (incorrect).
* **Question:** How does the recogniser determine where `<ref>` ends and `<path>` begins without querying the forge API?
* **Recommendation:**
  - If the client sends the forge coordinate without `<ref>` (as stated in §5.1: *"the ref is deliberately not sent"*), how is `<path>` extracted when the branch has slashes?
  - Consider having the client recogniser extract the full post-`blob/` subpath (or use standard heuristics such as known file extensions, or sending the trailing path components), or confirm if the recogniser tests in §7 cover branch names containing slashes.

### Q2.2: Gateway Version Floor vs Local Development Builds
* **Context:** §4.4 and §9 note that the version floor will gate item lanes until the upstream release is tagged.
* **Risk:** Developers working on feature branches or local builds of Nimbus often have gateway versions like `0.0.0-dev`, `git-<hash>`, or prerelease semver tags. A strict semver comparison (`semver.gte(version, "2.13.0")`) could disable the new lanes during local development and automated CI e2e tests.
* **Recommendation:** Allow `0.0.0-dev` or prerelease versions to satisfy the version floor check, or add an internal developer toggle in the extension options to bypass the version gate during development.

### Q2.3: File Page Miss Handling: Page-Level Preflight vs Concurrent 5-Lane Failures
* **Context:** §5.3 enables 5 lanes on a file page (`impact`, `expert`, `ownership`, `ghost`, `conflicts`).
* **Risk:** If a reader visits a file in a repo they have never cloned, all 5 lanes could trigger concurrent RPC requests to the gateway, each receiving the same `no such remote is tracked` miss. This creates 5 redundant queries and 5 egress ledger entries.
* **Recommendation:** Consider a lightweight page-level file resolution or shared query cache: when the first lane returns a `no such remote is tracked` miss, silence or cancel the sibling lane requests on that tab and immediately render the repository miss banner (§5.4).

### Q2.4: Layout Hierarchy: Related vs Connections Lane
* **Context:** Both `POST /v1/clips/related` (lexical/vector similarity) and the new `connections` lane (graph edge relations) will be active on issue and doc pages.
* **Question:** How will the panel visually differentiate the two to prevent user confusion?
* **Recommendation:** Group `connections` under a distinct section (e.g. **"Graph Connections"** or **"Linked Work"**) that prominently displays the edge relationship badge (e.g., `[resolves]`, `[mentions]`, `[depends on]`) immediately preceding the linked item title, while keeping Related in its traditional position at the bottom of the panel.

---

## 3. Technical Improvements & Code Health

### I3.1: Mitigating `panel-in-page.ts` Monolith Growth
* **Observation:** §9 notes that `panel-in-page.ts` is already 2,001 lines. Adding the `file` surface, 5 lanes, 2 new briefs, and miss banners risks pushing it past 2,500 lines.
* **Suggestion:** Before or alongside Slice 4, extract lane view rendering into dedicated helper modules:
  - `src/panel/lanes/file-lanes.ts` (handling file-specific renderers for `ghost`, `conflicts`, and file misses)
  - `src/panel/lanes/connections-lane.ts` and `currency-lane.ts`
  - `src/panel/components/miss-banner.ts`
  This prevents `panel-in-page.ts` from becoming an unmaintainable bottleneck.

### I3.2: Type-Safe Matrix Implementation for `lane × surface`
* **Suggestion:** Implement the `lane × surface -> param shape` matrix using a mapped type with exhaustiveness enforcement:
  ```ts
  export type LaneSurfaceMatrix = {
    readonly [L in AgentLane]: {
      readonly [S in SurfaceKind]?: (resolved: ResolveContext) => AgentParams;
    };
  };
  ```
  This guarantees that adding a lane to a surface without declaring its param builder causes a compile-time type error without requiring runtime fallback branches.

### I3.3: GitLab Nested Groups and Subgroups
* **Edge Case:** GitLab projects can be deeply nested under multiple namespaces (e.g. `gitlab.com/group/subgroup/deep-team/project/-/blob/main/src/app.ts`).
* **Suggestion:** Ensure the GitLab file recogniser regex accounts for variable-depth group hierarchies before the `/-/blob/` delimiter, extracting `group/subgroup/deep-team/project` as the repository coordinate.

---

## 4. Testing Strategy Recommendations

1. **Forge URL Branch Fixtures:** Add unit test fixtures for forge file URLs containing slashes in branch names (`/blob/feature/user-auth/src/file.ts`), tag names (`/blob/v1.0.0-rc.1/src/file.ts`), and commit hashes (`/blob/a1b2c3d4/src/file.ts`).
2. **5-Lane Local Only Assertion:** Pin with unit tests that `ghost` and `conflicts` dispatched from `file` surfaces never include `namespaces` in their request payload.
3. **Renderer Fallthrough on 3-Arm `WhyBrief`:** Ensure unit DOM tests include a `WhyBrief` where `itemSubject` is present and `subject` / `changeSubject` are `null`.
