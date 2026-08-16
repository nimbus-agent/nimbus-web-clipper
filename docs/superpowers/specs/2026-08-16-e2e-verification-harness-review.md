# Review & Suggestions: E2E Verification Harness — Phase 1

This document compiles review feedback, suggestions, and open questions regarding the proposed design for the Phase 1 E2E verification harness spec ([2026-08-16-e2e-verification-harness-design.md](file:///C:/gitrep/nimbus-web-clipper/.claude/worktrees/e2e-harness/docs/superpowers/specs/2026-08-16-e2e-verification-harness-design.md)).

---

## 1. Dynamic Port Allocation vs. Parallel Test Runs
* **Observation:** The design specifies: *"each test starts its own mock on its own port with its own scenario object."*
* **Potential Risk:** Static port mapping will lead to port collision conflicts in parallel environments (such as Playwright running with multiple workers or concurrent CI jobs).
* **Recommendation:** 
  - Ensure the mock server binds to port `0` (ephemeral port) to dynamically allocate an unused port.
  - The dynamic port must then be retrieved and passed to both the launcher and the extension context.

## 2. Extension Host / Target URL Configuration per Test
* **Observation:** Playwright loads the built extension inside a Chromium instance. Since the mock gateway port will be dynamic or vary per test, the extension needs to route requests to the correct local port.
* **Open Questions:**
  - How does the loaded extension know which mock gateway port to use?
  - Does the launcher rewrite an extension configuration file (like `config.json` or local storage) prior to launch?
  - Or does the test inject the target port via Playwright's `chrome.storage.local` API or service worker overrides before navigating to the test page?

## 3. Playwright Launcher Context & Cleanup
* **Observation:** Playwright's extension support requires loading extensions via a persistent context (`chromium.launchPersistentContext`).
* **Recommendations:**
  - Ensure the launcher dynamically creates a unique user data directory for each test run to avoid cross-test state leakage.
  - Add explicit lifecycle hooks (`afterEach`/`afterAll`) to clean up these temporary directories.

## 4. Automation of the "Honesty Rule" (Drift Protection)
* **Observation:** The design suggests adding per-step coverage markers in `docs/development.md`.
* **Recommendation:**
  - To prevent markdown and codebase drift over time, we should consider a simple linter script (or test) that checks if the steps marked as `[e2e:...]` in `docs/development.md` actually exist in the `test/e2e/` test files.
  - Introduce a standardized format for the markers (e.g., `<!-- e2e:related-lane-1 -->`) to make them easily machine-readable.

## 5. Playwright Browser Caching in CI
* **Observation:** Installing Playwright and its browser binaries from scratch on every CI run can be slow.
* **Suggestion:**
  - Configure `.github/workflows/ci.yml` to cache the Playwright browser binaries directory (typically `~/.cache/ms-playwright`) keyed on the version in `package.json` / `bun.lockb` to minimize job setup time.
