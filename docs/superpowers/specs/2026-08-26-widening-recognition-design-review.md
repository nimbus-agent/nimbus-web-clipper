# Design Review: Widening Recognition (eleven products and a gate that makes them honest)

This document contains open questions, suggestions, and improvements for the [Widening Recognition Design Spec (2026-08-26)](./2026-08-26-widening-recognition-design.md).

---

## 1. Registry & Host Matching Logic

### Overlapping Hosts and Custom/Self-Hosted Domains
* **Concern:** Jira and Confluence both share `*.atlassian.net` in SaaS, resolved via registry order and `pathPrefix` (Jira at root/browse/etc. and Confluence under `/wiki/`). However, for self-hosted instances (e.g. Confluence Server, Jira Server), a user might configure a custom domain like `internal-tools.mycorp.com` where both products are hosted under different path prefixes, or configure them on separate custom hostnames.
* **Open Questions:** 
  * If a user configures `internal-tools.mycorp.com` as a Jira custom origin, does the Confluence matching rule (which checks for `/wiki/` path prefix) still activate, or is matching strictly siloed by the user-selected product type?
  * How are custom origins mapped to `ProductRule` configurations? If a custom host matches the origin, does it run matches for *all* rules, or only the rule corresponding to the product the user associated with that custom origin?
* **Suggestions:**
  * Clarify how `recognise()` resolves custom origins when multiple products are self-hosted on the same custom domain.
  * Ensure the registry lookup flow first resolves the configured product for a custom origin, and then applies the matching logic specific to *that* product, rather than running all matching logic globally on the host.

---

## 2. Connector Health Gate & UX

### Caching and Re-validation Latency
* **Concern:** The health state of connectors is cached in `connector-health-store.ts` via `chrome.storage.local` with a "short TTL".
* **Open Questions:**
  * What is the exact duration of this TTL (e.g., 1 minute, 5 minutes)?
  * If a user is blocked by a `not_configured` or `unauthenticated` message, goes to the gateway to configure or fix the credential, and returns to the panel, will they have to wait for the TTL to expire before the panel updates?
* **Suggestions:**
  * **Force Refresh on Panel Open:** Trigger a background, non-blocking fetch to bypass the cache and update the store whenever the panel is opened, or when the user interacts with the panel.
  * **Stale-While-Revalidate:** Return the cached state immediately to render the UI fast, but kick off a silent fetch in the background to update the state. If the state changes from unconfigured/error to healthy, update the view reactively.

### Unreachable Gateway and Health API Failures
* **Concern:** The design states: *"A 404, an unreachable gateway, or a body that fails the guard all yield `unknown`, and `unknown` renders the lanes ungated — exactly today's behaviour."*
* **Open Questions:**
  * If the gateway is down or unreachable, rendering the lanes ungated means the client will still attempt to call the agent lanes endpoints (`POST /v1/agents/*`), which will also fail or timeout. 
* **Suggestions:**
  * While silent degradation to `unknown` is correct for backward compatibility with older gateways that lack the health route, we should distinguish between "gateway returned 404 (route not found)" vs "network error / gateway completely offline". If the gateway is entirely offline, the panel should show a connection error state rather than trying to load lanes.

---

## 3. Product-Specific Matchers

### Sentry Subdomain Wildcards
* **Concern:** Sentry URLs use `<org>.sentry.io/issues/<id>/` or `sentry.io/organizations/<org>/issues/<id>/`.
* **Suggestions:**
  * Sentry tenant subdomains must use a `suffix` HostRule (matching `*.sentry.io`).
  * Ensure that helper subdomains like `status.sentry.io` or `blog.sentry.io` are explicitly excluded or fail the path matcher to prevent false positives.

### Notion Path Normalization
* **Concern:** Notion URLs have irregular structures (e.g. workspace-prefixed slugs, inline subpages, database view IDs, query-parameter-based views). 
* **Suggestions:**
  * Notion ID matching should be validated extensively against database view URLs (`/workspace/db-hash?v=view-hash`) and public pages to ensure they don't resolve to a broken `doc` ref.
  * If Notion IDs are extracted as 32-character hex strings, verify that query parameter values (which are also often 32-character hashes) are not mistakenly captured as the primary document ID.

### Linear Subdomains
* **Concern:** Although Linear's primary SaaS path is `linear.app/<workspace>`, they also support workspace subdomains (e.g., `<workspace>.linear.app`).
* **Suggestions:**
  * Add a `suffix` host rule for `*.linear.app` to support workspace subdomains out of the box.

---

## 4. Maintenance & Validation

### Cross-Repository Contract Verification
* **Concern:** `PRODUCT_SERVICE_ID` is a loose convention between the client and gateway repos. Since we are moving from 5 to 11 products, the potential for drift or typos increases.
* **Suggestions:**
  * Introduce a lightweight test script (or extend the drift guard) that reads the gateway's `bundled-connector-registry.ts` if available in the same CI space, or verify `serviceId` mappings against a static contract schema or JSON fixture updated when new gateway connectors are published.
