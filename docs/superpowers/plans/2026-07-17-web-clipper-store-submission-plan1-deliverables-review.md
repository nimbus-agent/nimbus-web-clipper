# Design Review: Store Submission — Plan 1: Deliverables + Screenshot Harness

**Date:** 2026-07-17
**Plan Reviewed:** [2026-07-17-web-clipper-store-submission-plan1-deliverables.md](file:///C:/gitrep/nimbus-web-clipper/docs/superpowers/plans/2026-07-17-web-clipper-store-submission-plan1-deliverables.md)
**Status:** Review Comments & Suggestions

---

## 1. Playwright Service Worker Race Condition & Extension ID Resolution

### Service Worker Activation in Headless Mode
> [!WARNING]
> In MV3, Chrome extension service workers loaded headlessly may not start immediately or register in `context.serviceWorkers()` until a page is navigated or interaction occurs.

- **Potential Issue:** `context.serviceWorkers()` might be empty or the `waitForEvent("serviceworker")` might hang/timeout under certain headless environments.
- **Suggestion:** A robust fallback to wake up the service worker is to navigate to a dummy page or check the extension targets. You can also retrieve the extension ID by inspecting the background page target list directly:
  ```ts
  // Wait for the background service worker target to be registered
  const workerTarget = await context.waitForEvent("targetcreated", {
    predicate: (target) => target.type() === "service_worker",
  });
  const swUrl = workerTarget.url();
  const extId = new URL(swUrl).host;
  ```

---

## 2. Popup Screenshot Layout & Styling

### Body Width Constraints
- **Potential Issue:** If `popup.html` or its stylesheet does not define a fixed width (e.g. `width: 360px`) on the `body` or container element, styling the `html` tag with `display: flex` will cause the `body` to stretch or span the entire `1280px` viewport width, resulting in an unnaturally stretched screenshot.
- **Suggestion:** Explicitly set or override the container width in the page injection inside `capture.ts`:
  ```ts
  await popup.addStyleTag({
    content:
      "html{margin:0;min-height:800px;display:flex;align-items:center;justify-content:center;background:#eef1f7}" +
      "body{width:360px;box-shadow:0 12px 40px rgba(0,0,0,.18);border-radius:12px;overflow:hidden}",
  });
  ```
  *(Verify the actual design width of the popup and use that exact value).*

---

## 3. Host Permissions and Schema Parity

### Manifest Schema Checks
- **Open Question:** In `test/unit/store-listing.test.ts`, the check uses:
  ```ts
  const expected = new Set<string>([...manifest.permissions, "host_permissions"]);
  ```
  Is `host_permissions` literally defined under `permissions` or is it `host_permissions` array in the manifest?
  If `manifest.host_permissions` exists as a separate top-level key in the manifest output (which is standard for MV3), the test needs to map and verify both arrays:
  ```ts
  const expected = new Set<string>([
    ...manifest.permissions,
    ...(manifest.host_permissions ? ["host_permissions"] : [])
  ]);
  ```
  *(Make sure to verify how `composeManifest` formats `host_permissions` to prevent false negatives in unit tests).*

---

## 4. Playwright Setup in Clean Environments

### Playwright Browser Binary Cache
- **Improvement:** In CI or a developer's clean setup, running `bun run screenshots` might fail if browser binaries aren't installed.
- **Suggestion:** Although this plan targets Plan 1 (local capture), consider adding a helper check or script command in `package.json` that installs the Playwright Chromium binary automatically, or verify it runs successfully during local execution.
