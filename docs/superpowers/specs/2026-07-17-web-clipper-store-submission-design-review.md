# Design Review: Store Submission

**Date:** 2026-07-17
**Spec Reviewed:** [2026-07-17-web-clipper-store-submission-design.md](file:///C:/gitrep/nimbus-web-clipper/docs/superpowers/specs/2026-07-17-web-clipper-store-submission-design.md)
**Status:** Review Comments & Suggestions

---

## 1. Screenshot Capture Harness (`scripts/screenshots/capture.mjs`)

### Extension ID Resolution
> [!NOTE]
> Unpacked extensions loaded in Playwright/Chromium receive a dynamically generated extension ID unless a `key` field is specified in `manifest.json`.

- **Open Question:** How will the script reliably discover the extension ID?
- **Suggestion:** Playwright allows querying background pages or service worker targets. We can inspect the service worker target's URL:
  ```javascript
  const targets = await context.targets();
  const backgroundTarget = targets.find(t => t.type() === 'service_worker' || t.type() === 'background_page');
  const extensionId = backgroundTarget.url().split('/')[2];
  ```
  Alternatively, we could use a fixed developer `key` in `manifest.json` specifically during the screenshot build step, but dynamically parsing the target URL is cleaner as it doesn't leak developer keys into the repository.

### Popup Render Environment
- **Improvement:** Extension popups cannot be screenshotted in the native browser toolbar via Playwright. Instead, the script should navigate directly to the popup page:
  ```javascript
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  ```
- **Suggestion:** To make the screenshot look natural (instead of a full-screen page), we should constrain the Playwright viewport size to the extension popup's design dimensions (e.g., `800x600` or `450x600`) and capture only the page element, or place it centered within the `1280x800` canvas against a clean background/device mockup.

---

## 2. CI Upload Automation (`publish.yml`)

### AMO Source Code Packaging
> [!IMPORTANT]
> Firefox AMO requires the exact source code zip file matching the submitted build if any minification/bundling (like esbuild) is used.

- **Improvement:** In `publish.yml`, use `git archive` to package the source code automatically before uploading it to AMO. This ensures local untracked files, `node_modules`, and secret credentials are not accidentally included:
  ```bash
  git archive --format=zip --output=dist/source.zip HEAD
  ```
- **Open Question:** Does the AMO step upload this source zip along with the built addon file? (Using `web-ext sign` with `--source-dir` or `--source-code` parameter).

### Upload Failures & Partial Releases
- **Open Question:** What happens if the Chrome Web Store upload succeeds but the AMO upload fails due to temporary credential expiration or API downtime?
- **Suggestion:** Ensure the upload steps are decoupled, and each failure is reported clearly in the GitHub Actions dashboard. Since releases can be re-run on GitHub Actions, upload steps should check if a version already exists or handle "version already exists" gracefully to allow retries.

---

## 3. Parity Unit Tests

### Extracting Permission Justifications from `listing.md`
- **Improvement:** To write a robust unit test that parses `store/listing.md` for permission justifications without fragile regex parsing of freeform text:
- **Suggestion:** Define a structured markdown table or list with specific formatting in `listing.md` that is easy to parse. For example:
  ```markdown
  ### Permission Justifications
  - `activeTab`: Needed to extract page HTML and capture screenshots.
  - `storage`: Needed to persist the pairing credentials securely.
  ```
  The parser can then easily extract keys between backticks under that heading and verify they match the permission list declared in the manifest.

---

## 4. Privacy Policy & Web Assets

### Privacy Policy Updates
- **Suggestion:** Is there an automated verification that the hosted policy at `nimbus-agent.dev` is up-to-date with `store/privacy-policy.md`? We could add a simple check or publish command to deploy doc changes directly to the landing page repo/hosting provider, or at least document the manual deployment step in `docs/store-submission.md`.
