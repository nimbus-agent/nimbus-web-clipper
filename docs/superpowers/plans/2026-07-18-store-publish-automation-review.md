# Design Review: Store Publish Automation — Implementation Plan

**Date:** 2026-07-18
**Plan Reviewed:** [2026-07-18-store-publish-automation.md](file:///C:/gitrep/nimbus-web-clipper/docs/superpowers/plans/2026-07-18-store-publish-automation.md)
**Status:** Review Comments & Suggestions

---

## 1. Artifact Download Path Behavior in `actions/download-artifact@v4`

> [!WARNING]
> By default, `actions/download-artifact@v4` extracts the downloaded files into a subdirectory named after the artifact (i.e. `./extension-build/`) rather than the workspace root.

- **Potential Issue:** In the proposed `store-chrome` and `store-firefox` jobs, the workflow downloads the artifact without specifying a path:
  ```yaml
  - name: Download build artifacts
    uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
    with:
      name: extension-build
  ```
  This will place the files at `./extension-build/dist-zip/...` and `./extension-build/dist/...`. Subsequent commands like `bunx chrome-webstore-upload --source "dist-zip/..."` and `bunx web-ext sign --source-dir dist/firefox` will fail with "file not found" errors because the files are nested under the `./extension-build/` subdirectory.
- **Suggestion:** Set the download `path` explicitly to the workspace root (`.`) in both jobs:
  ```yaml
  - name: Download build artifacts
    uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
    with:
      name: extension-build
      path: .
  ```

---

## 2. Speeding up Downstream Jobs via Bun Caching

- **Improvement:** The downstream jobs (`store-chrome` and `store-firefox`) run checkout and a full `bun install` sequentially. Since these dependencies are only needed to run the CLI tools (`web-ext` and `chrome-webstore-upload`), package resolution over the network can add unnecessary build time to every release run.
- **Suggestion:** Enable dependency caching in `setup-bun` to reuse downloaded packages across jobs:
  ```yaml
  - name: Setup Bun
    uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
    with:
      bun-version: latest
      cache: bun
  ```

---

## 3. Web-Ext Sign Directory Pollution

- **Open Question:** By default, `web-ext sign` creates a `./web-ext-artifacts/` folder containing the signed extension bundle (.zip or .xpi). Should we configure a clean output directory or clean up after signing to avoid polluting the workspace if any later steps are added?
- **Suggestion:** Although not strictly required since the job terminates immediately after signing, specifying `--artifacts-dir dist-zip/` or clean artifacts location keeps workspace outputs structured if the workflow is expanded in the future.
