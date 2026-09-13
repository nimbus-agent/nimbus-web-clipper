# C10.3 — The Binding Stops Guessing: Design Review & Recommendations

**Review Date:** 2026-09-13  
**Target Spec:** [`2026-09-13-the-binding-stops-guessing-design.md`](./2026-09-13-the-binding-stops-guessing-design.md)  
**Status:** Review Complete · Actionable Suggestions Provided

---

## 1. Executive Summary

The **C10.3 ("The binding stops guessing")** design document specifies the integration of the upstream gateway endpoint `GET /v1/services/resolve?repo=<urn>` (Nimbus#1491, gateway v7.19.0). This replaces heuristic slug guessing with authoritative reverse mapping from repository coordinates to Nimbus service IDs during service binding, while detecting stale bindings in the Options page.

### Key Strengths of the Design
1. **Architectural Security Boundary Maintained:** The bearer-authed `services/resolve` call is strictly confined to the background service worker inside the existing `unbound` branch of `handleDeployPreflight`. The bearer token never crosses into the content script/panel.
2. **Honest `null` & 404 Degradation Semantics:** The spec carefully distinguishes between "repo not configured" vs. "exact coordinate not matched" (§3.1, §5.2), explicitly forbidding false assertions of unconfigured DORA setups. 404s/network errors degrade silently to today's slug-guessing behavior without imposing artificial gateway version floors.
3. **Validation Invariant Intact:** Authoritative resolution only *proposes* service IDs; `handleServiceBind` continues to validate all candidate and user-supplied IDs against `/v1/preflight/deploy` (§6). "A binding is never saved unverified" is fully preserved.
4. **Resilient Offline-First Options Architecture:** `service-bindings-list` remains a synchronous local storage read, while `service-bindings-check` is an independent, non-blocking network verification fanning out through `Promise.allSettled` (§7).

---

## 2. Open Questions & Ambiguities

### Q1: Exact Wire Shape & Guard Semantics for `services/resolve`
* **Context (§2, §8):** Upstream returns:
  ```json
  { "service": "checkout", "ambiguous": false, "candidates": ["checkout"] }
  ```
* **The Gaps:**
  1. When `ambiguous: true` (e.g. `candidates: ["checkout", "payments"]`), what is `service` in the upstream JSON? Does upstream set `service: null` or does it populate `service` with the first candidate (`candidates[0]`)?
  2. When `service: null`, is `candidates` guaranteed to be `[]`?
  3. How should the client-side parser (`parseServiceResolution`) validate candidates that violate string length limits (`MAX_SERVICE_ID_LEN = 64`)?
* **Recommendation:** Explicitly document the TypeScript interface and parsing rules in `src/shared/deploy.ts`:
  ```ts
  export interface ServiceResolution {
    readonly service: string | null;
    readonly ambiguous: boolean;
    readonly candidates: readonly string[];
  }
  ```
  `parseServiceResolution` should enforce:
  - `service === null || (typeof service === "string" && service.length >= 1 && service.length <= MAX_SERVICE_ID_LEN)`
  - `typeof ambiguous === "boolean"`
  - `Array.isArray(candidates) && candidates.every(c => typeof c === "string" && c.length >= 1 && c.length <= MAX_SERVICE_ID_LEN)`

---

### Q2: `DeployDeps` Injections & 403 Token Scope Gap Handling
* **Context (§4, §8):** Currently, `DeployDeps` in `src/background/deploy-handlers.ts` only provides unauthenticated dependencies:
  ```ts
  export interface DeployDeps {
    readonly getOrigin: () => Promise<string | null>;
    readonly getBindings: () => Promise<ServiceBinding[]>;
    readonly putBinding: (entry: ServiceBinding) => Promise<void>;
    readonly dropBinding: (origin: string, product: Product, scope: string) => Promise<void>;
    readonly doFetch: typeof fetch;
  }
  ```
* **The Gap:** `fetchServiceResolution` requires a bearer token under the `resolve` scope. When the gateway returns a 403, the response contains a `ScopeGap` body (`{ required: "resolve", granted: [...] }`). To format the pasteable command `nimbus clip scopes <label> --set ...`, the pairing `label` from `Connection` is required.
* **Questions:**
  1. How should `DeployDeps` be updated to supply auth credentials?
  2. Should `DeployDeps` adopt `getConnection: () => Promise<Connection | null>` (matching `EgressDeps` in `egress-handlers.ts`) instead of `getOrigin`?
* **Recommendation:** Update `DeployDeps` to inject `getConnection: () => Promise<Connection | null>`:
  ```ts
  export interface DeployDeps {
    readonly getConnection: () => Promise<Connection | null>;
    readonly getBindings: () => Promise<ServiceBinding[]>;
    readonly putBinding: (entry: ServiceBinding) => Promise<void>;
    readonly dropBinding: (origin: string, product: Product, scope: string) => Promise<void>;
    readonly doFetch: typeof fetch;
  }
  ```
  When a 403 occurs during resolution, attach the connection label to produce a full `ScopeGap` via `withLabel(conn.label, res.scopeGap)`.

---

### Q3: `DeployPreflightResponse` Widened Envelope & View Decoupling
* **Context (§4, §5.1, §5.3):** The spec states that `DeployPreflightResponse`'s `unbound` arm is widened with resolution details so the panel can render one of five notes and optional candidate picker options.
* **The Gap:** If the worker returns pre-formatted prose/strings, it violates the architectural rule that background workers handle pure logic while view modules (`deploy-view.ts`) own English strings and DOM markup.
* **Recommendation:** Model the resolution outcome as a structured union on `DeployPreflightResponse` rather than passing unstructured strings:
  ```ts
  export type ServiceResolutionOutcome =
    | { readonly kind: "resolved"; readonly serviceId: string }
    | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
    | { readonly kind: "unclaimed" }
    | { readonly kind: "forbidden"; readonly scopeGap?: ScopeGap }
    | { readonly kind: "silent" }; // 404, unreachable, server_error, malformed

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
        readonly reason: "unbound";
        readonly guessServiceId: string;
        readonly resolution: ServiceResolutionOutcome;
      }
    | {
        readonly kind: "deploy-preflight";
        readonly ok: false;
        readonly reason: Exclude<DeployRefusal, "unbound">;
      };
  ```
  This allows `deploy-view.ts` to cleanly match on `resolution.kind` to render notes, candidate buttons, and pasteable scope commands.

---

### Q4: Options Checking Concurrency & Rate Limiting (§7)
* **Context (§7):** `service-bindings-check` resolves every stored binding via `Promise.allSettled`.
* **The Gap:** If a user has a large list of stored bindings (e.g., 30–50+ repositories across Jenkins/GitLab/GitHub), firing unthrottled concurrent requests to `GET /v1/services/resolve` could saturate loopback connections or trip gateway rate limits (429).
* **Questions:**
  1. Should `handleServiceBindingsCheck` batch or pool resolution requests (e.g. concurrency limit of 5)?
  2. How should 429 (`too_many_requests`) be handled during batch checking?
* **Recommendation:**
  1. Implement a lightweight batch chunker or pool helper (e.g. concurrency of 5–8) in `deploy-handlers.ts`.
  2. On 429, classify the affected rows as `unchecked` with a specific reason `rate_limited` rather than throwing or failing the entire check suite.

---

### Q5: UX Flow for Options "Check Stored Bindings"
* **Context (§7):** `service-bindings-check` is decoupled from `service-bindings-list`.
* **The Gap:** The spec does not describe how the user initiates the check in the Options UI or how progress is displayed.
* **Recommendation:**
  1. In `src/options/options.html` / `bindings-view.ts`, add a "Check with Nimbus" button above the bindings table.
  2. Disable the button when unpaired or while a check is currently in flight.
  3. When checking, display a subtle progress indicator or per-row spinner ("Checking…").
  4. In the table's "Status" column:
     - `agrees`: Green checkmark / `"Matches gateway"`
     - `disagrees`: Yellow warning / `"Gateway configured as: <newId>"` with an **"Update to <newId>"** button
     - `unclaimed`: Subtle gray text / `"Coordinate not named in config"`
     - `ambiguous`: Blue badge / `"<n> candidates"` with a dropdown to select and update
     - `unchecked`: Muted text / `"Could not check"` (hover tooltip: missing scope / unreachable)

---

## 3. Improvements & Implementation Proposals

### Improvement 1: `repoUrn` Implementation & URN Formatting (`src/shared/services.ts`)

To ensure type-safe provider mapping without uncovered dead code:

```ts
// In src/shared/services.ts

export const URN_PROVIDERS: Record<Product, string | null> = {
  github: "github",
  gitlab: "gitlab",
  bitbucket: "bitbucket",
  jenkins: "jenkins",
  circleci: "circleci",
  jira: null,
  confluence: null,
  linear: null,
  pagerduty: null,
};

/**
 * Builds the canonical repository URN for Nimbus service resolution.
 * Returns `null` for products that do not produce repo scopes or for invalid scope lengths.
 */
export function repoUrn(product: Product, scope: string): string | null {
  const provider = URN_PROVIDERS[product];
  if (provider === null) {
    return null;
  }
  const trimmed = scope.trim();
  if (trimmed === "" || trimmed.length > MAX_SCOPE_LEN) {
    return null;
  }
  return `${provider}:${trimmed}`;
}
```

---

### Improvement 2: Extension Message Definitions (`src/shared/messages.ts`)

Formalize the message contracts for `service-bindings-check`:

```ts
// In src/shared/messages.ts

export interface ServiceBindingsCheckRequest {
  readonly kind: "service-bindings-check";
}

export type BindingCheckStatus =
  | { readonly state: "agrees" }
  | { readonly state: "disagrees"; readonly proposedServiceId: string }
  | { readonly state: "unclaimed" }
  | { readonly state: "ambiguous"; readonly candidates: readonly string[] }
  | {
      readonly state: "unchecked";
      readonly reason: "forbidden" | "unavailable" | "server_error" | "unreachable" | "malformed";
      readonly scopeGap?: ScopeGap;
    };

export interface ServiceBindingCheckRow {
  readonly binding: ServiceBinding;
  readonly status: BindingCheckStatus;
}

export type ServiceBindingsCheckResponse =
  | {
      readonly kind: "service-bindings-check";
      readonly ok: true;
      readonly results: readonly ServiceBindingCheckRow[];
    }
  | {
      readonly kind: "service-bindings-check";
      readonly ok: false;
      readonly reason: "not_paired" | "unreachable" | "server_error";
    };

export function isServiceBindingsCheckRequest(v: unknown): v is ServiceBindingsCheckRequest {
  return isObject(v) && v["kind"] === "service-bindings-check";
}

export function isServiceBindingsCheckResponse(v: unknown): v is ServiceBindingsCheckResponse {
  if (!isObject(v) || v["kind"] !== "service-bindings-check") {
    return false;
  }
  if (v["ok"] === true) {
    return Array.isArray(v["results"]);
  }
  return v["ok"] === false && typeof v["reason"] === "string";
}
```

---

### Improvement 3: Candidate Picker UX & Accessibility (`src/panel/deploy/`)

When resolution yields `candidates.length > 1`:
1. Render a candidate button group styled as selectable chips below the text input:
   ```html
   <div class="nimbus-deploy__candidates" role="group" aria-label="Suggested services">
     <span class="nimbus-deploy__candidates-label">Suggestions:</span>
     <button type="button" class="nimbus-deploy__chip" data-service="checkout">checkout</button>
     <button type="button" class="nimbus-deploy__chip" data-service="billing">billing</button>
   </div>
   ```
2. Clicking a candidate chip automatically populates `input.value = selectedService` and highlights the active chip.
3. Keyboard accessibility: candidate chips must be keyboard focusable (`tabindex="0"`) and activatable with `Enter` / `Space`.

---

## 4. Slice-by-Slice Implementation & Verification Plan

### Slice 1 (S1): Authoritative Resolution Seeding
* **Components:**
  - `src/shared/gateway.ts`: Add `servicesResolve: "/v1/services/resolve"` with docstring detailing §2 properties.
  - `src/shared/services.ts`: Add `URN_PROVIDERS` and `repoUrn(product, scope)`. Update file header comment.
  - `src/shared/deploy.ts`: Add `ServiceResolution` interface and `parseServiceResolution` guard.
  - `src/background/deploy-client.ts`: Add `fetchServiceResolution(origin, token, urn, doFetch)`.
  - `src/background/deploy-handlers.ts`: Update `handleDeployPreflight` to resolve URN and return `ServiceResolutionOutcome`.
  - `src/shared/messages.ts`: Widen `DeployPreflightResponse`'s `unbound` arm and guards.
  - `src/panel/deploy/`:
    - `deploy-view.ts`: Add resolution note messages, candidate chips builder, and scope guidance rendering.
    - `deploy-section.ts`: Handle candidate selection events.
* **Unit Tests:**
  - `test/unit/services.test.ts`: Test `repoUrn` across all 9 products, empty strings, and max length bounds.
  - `test/unit/deploy-client.test.ts`: Test `fetchServiceResolution` for 200 (single/ambiguous/null), 403 (with ScopeGap), 404 (`unavailable`), 500 (`server_error`), malformed JSON, and timeouts.
  - `test/unit/deploy-handlers.test.ts`: Test `handleDeployPreflight` unbound resolution enrichment and fallbacks.
  - `test/unit/deploy-view.test.ts` & `deploy-section.test.ts`: Test rendering of the five resolution notes and candidate chip interactions.

### Slice 2 (S2): Options Stored Binding Verifier
* **Components:**
  - `src/background/deploy-handlers.ts`: Implement `handleServiceBindingsCheck` with `Promise.allSettled` and status classifier.
  - `src/shared/messages.ts`: Add `ServiceBindingsCheckRequest`/`Response` interfaces and guards.
  - `src/background/service-worker.ts`: Add message routing for `service-bindings-check`.
  - `src/options/`:
    - `bindings-view.ts`: Add "Status" table column, status badge renderers, and one-click correction button.
    - `options.ts`: Add "Check bindings" button handler, trigger `service-bindings-check`, and wire up one-click re-binding.
* **Unit Tests:**
  - `test/unit/deploy-handlers.test.ts`: Test `handleServiceBindingsCheck` classification (`agrees`, `disagrees`, `unclaimed`, `ambiguous`, `unchecked`).
  - `test/unit/bindings-view.test.ts`: Test rendering of table with check status badges and update actions.
  - `test/unit/options.test.ts`: Test check button lifecycle and one-click update submit path.

---

## 5. Mock Gateway & E2E Requirements

Extend `scripts/mock-gateway.ts` to support `GET /v1/services/resolve`:

```ts
// Proposed additions to scripts/mock-gateway.ts

if (url.pathname === "/v1/services/resolve") {
  const auth = req.headers["authorization"] ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (auth.includes("legacy-no-resolve-token")) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "insufficient_scope",
      required: "resolve",
      granted: ["clip", "briefs"]
    }));
    return;
  }

  const repo = url.searchParams.get("repo");
  if (repo === "github:acme/payments-service") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "payments", ambiguous: false, candidates: ["payments"] }));
    return;
  }
  if (repo === "github:acme/monorepo") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "checkout", ambiguous: true, candidates: ["checkout", "cart", "billing"] }));
    return;
  }
  if (repo === "github:acme/unconfigured") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: null, ambiguous: false, candidates: [] }));
    return;
  }
  if (repo === "github:acme/malformed-500") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "config_unreadable" }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "services_disabled" }));
  return;
}
```

---

## 6. Pre-Implementation Checklist

- [ ] Confirm exact JSON payload of `GET /v1/services/resolve` when `ambiguous: true`.
- [ ] Inject `getConnection` into `DeployDeps` in `deploy-handlers.ts` and `service-worker.ts`.
- [ ] Define `ServiceResolutionOutcome` discriminated union in `src/shared/messages.ts`.
- [ ] Implement `URN_PROVIDERS` and `repoUrn` in `src/shared/services.ts`.
- [ ] Add candidate picker buttons with ARIA attributes in `src/panel/deploy/deploy-view.ts`.
- [ ] Implement `service-bindings-check` in `deploy-handlers.ts` with bounded concurrency.
- [ ] Update `bindings-view.ts` with status indicators and one-click correction action.
- [ ] Add mock endpoint routes to `scripts/mock-gateway.ts`.
