# Design Review: Store Publish Automation

**Date:** 2026-07-18
**Spec Reviewed:** [2026-07-18-store-publish-automation-design.md](file:///C:/gitrep/nimbus-web-clipper/docs/superpowers/specs/2026-07-18-store-publish-automation-design.md)
**Status:** Review Comments & Suggestions

---

## 1. Step-Level `if` Guards and Environment Variables

> [!IMPORTANT]
> In GitHub Actions, a step-level `if` condition is evaluated *before* the step's own `env` block is loaded. 

- **Problem:** If `AMO_JWT_ISSUER` or `CWS_CLIENT_ID` are only mapped in the step's `env:` block, checking `if: env.AMO_JWT_ISSUER != ''` at the step level will always evaluate to `false` (or empty) and cause the step to be skipped, even when the secret is present.
- **Suggestion:** Declare the environment variables at the **job-level** `env` block in `publish.yml`, or check the secret directly in the `if` condition using:
  ```yaml
  if: ${{ secrets.AMO_JWT_ISSUER != '' }}
  ```
  While the spec notes that GitHub Actions cannot reference secrets directly, modern GitHub Actions runner syntax *does* support checking if a secret is empty directly in `if` conditions via the expression syntax. If we prefer to use the job-level environment variable mapping (for auditability), we should specify the mapping at the top of the `publish` job:
  ```yaml
  jobs:
    publish:
      env:
        CWS_CLIENT_ID: ${{ secrets.CWS_CLIENT_ID }}
        AMO_JWT_ISSUER: ${{ secrets.AMO_JWT_ISSUER }}
  ```

---

## 2. Harden-Runner Egress Rules

- **Improvement:** Since the repository uses step security auditing via `harden-runner`, the job's allowed outbound network connections must be updated to permit store API requests and dynamic CLI resolution.
- **Suggestion:** Ensure the following hosts are added to the `harden-runner` `allowed-endpoints` list:
  - `accounts.google.com` (OAuth refresh token exchange)
  - `www.googleapis.com` (Chrome Web Store API)
  - `addons.mozilla.org` (AMO signing API)
  - `registry.npmjs.org` (for package resolution via `bunx`)

---

## 3. Dependency Management vs. Runtime Resolution (`bunx`)

- **Open Question:** Using `bunx` dynamically resolves and downloads the CLI tools at runtime. Does this introduce risks of network flakiness during releases, or possible supply chain vulnerabilities if the package version resolution isn't locked down?
- **Suggestion:** Consider adding `chrome-webstore-upload-cli` and `web-ext` as `devDependencies` in `package.json`. 
  - This pins their versions deterministically in `bun.lockb`.
  - It speeds up execution by utilizing cached node modules from the preceding `bun install` step.
  - It keeps security auditing clean, as all downloads happen during the initial install rather than scattered throughout the pipeline.

---

## 4. Retries and Version Conflict Handling

- **Open Question:** What happens if the GitHub Action fails halfway through (e.g., CWS succeeds, but AMO fails due to API downtime), and a release operator clicks "Re-run failed jobs"?
- **Problem:** Re-running the job will cause the Chrome step to run again. The `chrome-webstore-upload-cli` might return a non-zero exit code because version `X.Y.Z` has already been uploaded, blocking the operator from retrying the failed AMO step.
- **Suggestion:** We should handle "version already exists" error responses gracefully in the publish steps. For example, catching the error output and checking if the error code/message corresponds to an existing version, then exiting with `0` so the workflow can proceed.
