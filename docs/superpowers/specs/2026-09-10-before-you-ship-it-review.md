# C10 — Before You Ship It: Design Review & Recommendations

**Review Date:** 2026-09-10  
**Target Spec:** [`2026-09-10-before-you-ship-it-design.md`](./2026-09-10-before-you-ship-it-design.md)  
**Status:** Review Complete · Actionable Suggestions Provided

---

## 1. Executive Summary

The **C10 ("Before you ship it")** design document provides a solid, well-reasoned architectural plan for integrating deploy readiness verdicts (`GET /v1/preflight/deploy`) and DORA metrics (`GET /v1/metrics/dora`) into the Nimbus Web Clipper.

### Key Strengths of the Design
1. **Loopback & Security Discipline:** Leverages existing unauthenticated read-only routes on `dispatchReadOnlyDataGet` without expanding host permissions, altering token scopes, or requiring re-pairing.
2. **Invariant Preservation:** Firmly rejects squeezing deploy preflight into `AGENT_LANES` or adding a direct-lane bypass. This protects the C6 roster gate and avoids confusing `deploy.preflight` with the withheld `agents.preflight`.
3. **Honest Metrics Visualization:** Explicitly rejects misleading trend-line interpolation over overlapping historical windows (`since` with no `until`), choosing side-by-side nested window comparisons and gap-first messaging.
4. **Structural Decoupling:** Isolates deploy readiness in its own controller/view (`src/panel/deploy/`) without expanding the already oversized `createPanel` in `panel-in-page.ts`.

---

## 2. Open Questions & Ambiguities

### Q1: Structured Repo Extraction Across Surfaces
* **Context (§3.1, §3.3):** `ServiceBinding` is keyed by `${product}:${repo}`, and inline binding proposes pre-filling the input with the last segment of the repo slug (e.g., `acme/payments-api` &rarr; `payments-api`).
* **The Gap:** In the current recogniser registry (`src/shared/recognise/`):
  * On `pr`: GitHub produces `ref: "owner/repo #123"`, GitLab produces `ref: "group/project !123"`, Bitbucket Server produces `ref: "KEY/slug #123"`, Bitbucket Cloud produces `ref: "workspace/repo #123"`.
  * On `build`: CircleCI produces `ref: "org/repo #123"`, while Jenkins produces `ref: "job/subjob #123"` (which is a job hierarchy, not necessarily a forge repo coordinate).
  * `Recognition` only carries a structured `forgeFile: { repo, refAndPath }` on `kind === "file"`.
* **Questions:**
  1. How should the panel or background worker extract the clean `repo` coordinate from `Recognition` on PR and build pages?
  2. How should Jenkins builds map to repo coordinates if the Jenkins job name does not match the Git provider repository coordinate in the gateway DORA config (`repos = ["github:owner/repo"]`)?
* **Recommendation:** Update `Recognition` (or provide a pure helper `repoOfRecognition(rec: Recognition): string | null`) so `repo` is cleanly extracted during recognition rather than relying on string-splitting `ref` across different product formatting rules.

---

### Q2: Surface Matrix Mismatch: `home` vs. `file` (§4.2)
* **Context (§4.2):** The spec states:
  > *"Surfaces: `pr`, `build`, `home`. Not `issue`, `doc`, `incident` or `file`: a deploy verdict is about a service at a ref, and those four surfaces supply neither."*
* **The Inconsistency:**
  1. **`file` actually possesses both a repo and a ref:** A source file URL (e.g. `github.com/owner/repo/blob/main/src/index.ts`) carries `{ repo: "owner/repo", refAndPath: "main/src/index.ts" }` in `forgeFile`, which resolves directly to a git ref.
  2. **`home` possesses neither a repo nor a ref:** `home` represents the root dashboard (e.g. `github.com/` or `app.circleci.com/pipelines`) where `Recognition.ref` is `""`.
* **Questions:**
  1. If `home` has no repo, how is the `${product}:${repo}` binding looked up when opening the panel on `home`? Does `home` render a service picker over all bound services, or was `home` intended for repo landing pages?
  2. If `file` is excluded, is it because deploy readiness is semantically unhelpful while reading individual source files (a UX decision), rather than a technical lack of repo/ref?
* **Recommendation:**
  * Clarify `home` behavior: If `home` offers deploy readiness, define how the service is selected (e.g., dropdown of bound services for that product).
  * Clarify `file` rationale: State that `file` is excluded because file-viewing is not a pre-deploy review gesture, correcting the premise that `file` lacks repo/ref coordinates.

---

### Q3: Wire Envelope Details & Verdict Types for Deploy Preflight
* **Context (§4.4, §4.5, §6):** The spec mentions `verdict: "warn"` and `count: 0` with `gap: "unknown_service"`, and findings with `url: string | null`.
* **The Gap:** The exact TypeScript wire interfaces for `src/shared/deploy.ts` are omitted.
* **Questions:**
  1. What is the non-warning verdict value returned by the gateway when all checks pass? (`"pass"`, `"clear"`, or `"ok"`?)
  2. What is the full union of `PreflightGap` members? (The spec names `unknown_service` and `no_repos`. Are there others such as `no_ref`, `missing_target_ref`, `no_ci_connector`, `service_unconfigured`?)
  3. Are checks returned as a keyed dictionary or a list? E.g.:
     ```ts
     export interface DeployPreflightEnvelope {
       readonly verdict: "pass" | "warn";
       readonly checks: {
         readonly active_p1_incidents: PreflightCheck<IncidentFinding>;
         readonly failing_ci_runs: PreflightCheck<CiFinding>;
         readonly merge_conflicts: PreflightCheck<PrFinding>;
       };
     }
     ```
* **Recommendation:** Document the complete wire type definitions and sample JSON responses in `src/shared/deploy.ts` and the spec.

---

### Q4: DORA Query Execution & Window Fallbacks (§5.1, §5.2)
* **Context (§5.1):** `GET /v1/metrics/dora` takes `service` and `since` (epoch ms), rendering 7d, 30d, and 90d side-by-side.
* **Questions:**
  1. Does `dora.ts` execute 3 concurrent GET queries (`Promise.allSettled` or `Promise.all`) for the three timestamps (`Date.now() - 7*86400000`, etc.)?
  2. How does the UI render if one window fails (e.g. timeout on 90d calculation) while 7d and 30d succeed?
  3. What is the full union of `DoraGap`? The spec lists `approximate_lead_time`, `no_deployment_data`, `mixed_source`, `no_repos`, `no_pagerduty_mapping`, `unknown_service`, plus `low_sample`. Are there others?
* **Recommendation:** Specify partial failure rendering (e.g. per-column error card vs full-page error) and detail concurrent query mechanics.

---

### Q5: Navigation Entry Points to the DORA Dashboard (§5)
* **Context (§5):** `src/dora/` creates a dedicated extension page (`dora.html`).
* **Questions:**
  1. How does a user reach `dora.html`?
  2. Is there a "View DORA metrics &rarr;" link directly inside the panel's Deploy Readiness section when a service is bound?
  3. Does `dora.html` accept a URL parameter (`dora.html?service=payments-api`) to open directly to the relevant service?
* **Recommendation:** Add a direct navigation link from `deploy-section.ts` / `deploy-view.ts` to `dora.html?service=${serviceId}` via `chrome.tabs.create`, and add a top-level link in the Options page.

---

## 3. Architecture & Implementation Improvements

### Improvement 1: Define Extension Messaging Envelope (`src/shared/messages.ts`)
Because content scripts (the panel), the Options page, and full-tab pages (`dora.html`) communicate with the background worker exclusively via `chrome.runtime.sendMessage`, explicit message types and type guards are required:

```ts
// Proposed addition to src/shared/messages.ts

export interface DeployPreflightRequest {
  readonly kind: "deploy-preflight";
  readonly product: Product;
  readonly repo: string;
  readonly targetRef?: string;
}

export type DeployPreflightResponse =
  | {
      readonly kind: "deploy-preflight";
      readonly ok: true;
      readonly serviceId: string;
      readonly preflight: DeployPreflightResult;
    }
  | {
      readonly kind: "deploy-preflight";
      readonly ok: false;
      readonly reason: "unbound" | "unreachable" | "server_error" | "invalid_request";
      readonly guessServiceId?: string;
    };

export interface ServiceBindingsRequest {
  readonly kind: "service-bindings-list";
}

export interface ServiceBindingsResponse {
  readonly kind: "service-bindings-list";
  readonly ok: true;
  readonly bindings: readonly ServiceBinding[];
}

export interface ServiceBindRequest {
  readonly kind: "service-bind";
  readonly binding: ServiceBinding;
}

export type ServiceBindResponse =
  | { readonly kind: "service-bind"; readonly ok: true }
  | { readonly kind: "service-bind"; readonly ok: false; readonly reason: "unknown_service" | "unreachable" | "server_error" };

export interface DoraMetricsRequest {
  readonly kind: "dora-metrics";
  readonly serviceId: string;
  readonly sinceMs: number;
}
```

---

### Improvement 2: Concurrency & Storage in `service-binding-store.ts`
* In §3.1, the spec suggests modeling `service-binding-store.ts` on `origin-store.ts` without `keyed-store.ts`.
* However, unlike `origin-store.ts` (which is written solely from the Options page), service bindings can be saved inline from the panel content script **and** edited/deleted in the Options page simultaneously.
* **Suggestion:** Use `createWriteChain()` from `src/background/keyed-store.ts` to ensure that concurrent read-modify-write operations in the service worker cannot clobber each other.

---

### Improvement 3: `GATEWAY_PATHS` Route Format (`src/shared/gateway.ts`)
* In §6, `GATEWAY_PATHS` gains `preflightDeploy`, `metricsDora`, and `itemById`.
* Note that `itemById` is a parameterized endpoint (`/v1/items/{id}`). In accordance with the pattern established for `agents` and `agentRuns`:
  ```ts
  export const GATEWAY_PATHS = {
    // ...
    preflightDeploy: "/v1/preflight/deploy",
    metricsDora: "/v1/metrics/dora",
    items: "/v1/items", // Base path: callers append `/${encodeURIComponent(id)}`
  } as const;
  ```

---

### Improvement 4: Inline Binding UX State Machine
To provide clear UX feedback during inline binding in `src/panel/deploy/deploy-view.ts`:
1. **Unbound State:** Display detected repo coordinate, text input pre-filled with slug guess, "Bind Service" submit button, optional `defaultBranch` input.
2. **Validating State:** Disable input and button, display "Verifying service with Nimbus gateway...".
3. **Refusal State:** If the gateway returns all checks with `gap: "unknown_service"`, display:
   > *"Service '<serviceId>' is not defined in your Nimbus gateway configuration. Check your `[metrics.dora.<id>]` config."*
4. **Network Error State:** If gateway is unreachable, display:
   > *"Cannot connect to Nimbus gateway on loopback to verify service."*
5. **Success State:** Persist binding and immediately transition to the preflight evaluation view without requiring a manual page refresh.

---

## 4. Suggested Updates to Slices & Verification Plan

### Slice Refinements (§8)
* **Slice 1 (The Binding and Panel Section):**
  * `src/shared/services.ts` (types, guards, slug guess logic)
  * `src/shared/deploy.ts` (preflight types, gap constants, `PreflightGap` record map)
  * `src/background/service-binding-store.ts` (storage with write chain)
  * `src/background/deploy-client.ts` (preflight & item fetch)
  * `src/shared/messages.ts` (message envelopes & guards)
  * `src/panel/deploy/` (`deploy-section.ts`, `deploy-view.ts`)
  * `src/options/` (bindings management table & delete/edit actions)
  * `src/shared/gateway.ts` (endpoints)
* **Slice 2 (DORA Dashboard):**
  * `src/shared/dora.ts` (DORA metrics types, `DoraGap` record map)
  * `src/dora/` (`dora.ts`, `dora-view.ts`, `dora.html`, `dora.css`)
  * `esbuild.mjs`, `scripts/check-build.mjs`, `build-artifacts.test.ts` entries
  * Navigation link from Deploy Readiness panel & Options page to `dora.html`

### Mock Gateway Updates (§9)
To support unit, integration, and E2E tests, add mock endpoints to `scripts/mock-gateway.ts`:
1. `GET /v1/preflight/deploy?service=...&target_ref=...`:
   * Return 200 with clean pass verdict.
   * Return 200 with warnings (e.g. 1 failing CI run, 1 open conflict).
   * Return 200 with `gap: "unknown_service"` on all checks for invalid service IDs.
   * Return 200 with `gap: "no_repos"`.
2. `GET /v1/metrics/dora?service=...&since=...`:
   * Return 200 with sample metrics across all four DORA categories.
   * Return 200 with null values and specific gap reasons.
3. `GET /v1/items/:id`:
   * Return 200 with `{ id, metadata: { branch: "main" } }`.
   * Return 200 with `{ id, metadata: {} }`.
   * Return 404.

---

## 5. Summary Checklist Before Implementation

- [ ] Clarify how `repo` is extracted from `Recognition` on PR and build pages.
- [ ] Refine the surface applicability reasoning for `home` and `file` in §4.2.
- [ ] Define the exact TypeScript wire interfaces for deploy preflight and DORA responses in `src/shared/`.
- [ ] Add runtime extension messaging contracts in `src/shared/messages.ts`.
- [ ] Include write serialization (`createWriteChain`) in `service-binding-store.ts`.
- [ ] Specify DORA page entry points and query parameters (`dora.html?service=...`).
- [ ] Verify mock gateway routes in `scripts/mock-gateway.ts`.
