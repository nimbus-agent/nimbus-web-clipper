# Review & Suggestions: Service Lanes Design (C2.3)

This document contains open questions, suggestions, and potential improvements for the proposed design in [2026-08-13-c2-3-service-lanes-design.md](file:///C:/gitrep/nimbus-web-clipper/docs/superpowers/specs/2026-08-13-c2-3-service-lanes-design.md).

## 1. Instance-Specific vs. Service-Wide Cache Keying
* **Scenario:** A user has multiple distinct self-hosted Jenkins instances (e.g., `jenkins.dev.local` and `jenkins.prod.local`). 
* **Concern:** Since `ref` is constant and empty for all dashboard recognitions of a given product type, two different hosts of the same product map to the same `RunSubject` (e.g., `{ kind: "service", service: "jenkins" }`). Consequently, navigating from the Dev dashboard to the Prod dashboard will replay the cached Dev answer (within the 10-minute TTL).
* **Suggestion:** Include the origin/host in the cache key or `RunSubject` for service lanes, or at least distinguish them per configured origin. Even though `service` is a flat string (`"jenkins"`), the query results from the gateway might differ if the gateway segments indexes by source or if the user expects contextually distinct answers. If they don't, and the gateway truly returns a single global set of results for `"jenkins"`, we should confirm this behavior is documented.

## 2. Lack of "Force Re-run" for Dashboard Lanes
* **Concern:** The design correctly suppresses the "Fetch" button (since dashboards are not fetchable index items) and the candidate chooser. However, if a user wants to refresh the dashboard's service lanes (e.g., to see if new decisions or catchups have occurred) before the 10-minute cache TTL expires, they have no manual refresh option.
* **Suggestion:** Introduce a "Refresh" or "Re-run" button specific to the lane or header when on a dashboard page. This would invalidate the cache entry for that service and trigger a fresh agent run.

## 3. Actionability of the `ownership` Gap Brief
* **Concern:** The design notes that `ownership` will often return a gap-only brief: *"There are no git-aware filesystem roots configured, so no ownership can be derived"*. This is the expected default state for browser-only users.
* **Suggestion:** Enhance the UI rendering of this specific gap brief to include a quick action, copyable command (e.g., `nimbus index add .`), or a link to the documentation explaining how to configure filesystem roots. This turns a dead-end message into an actionable onboarding step.

## 4. Maintenance of the `PRODUCT_SERVICE_ID` Mapping
* **Concern:** The design states that `PRODUCT_SERVICE_ID` is a static map to prevent silent breakage when upstream renames a connector. However, type errors will only occur if the client-side `Product` union changes. If upstream renames a connector string (e.g., `"jenkins"` to `"jenkins-ci"`), the compiler won't detect this.
* **Suggestion:** If the gateway exposes a metadata/capabilities endpoint (e.g., listing supported service/connector IDs), add a test or runtime check that validates the values in `PRODUCT_SERVICE_ID` against the gateway's advertised services.

## 5. Header Visuals on Dashboard Pages
* **Concern:** With no item link, no freshness line, and no fetch button, the panel header on dashboard pages might feel excessively empty or lack context.
* **Suggestion:** Display the recognized origin/host (e.g., `github.com` or `jenkins.corp.internal`) in the header state. This reassures the user which specific instance's dashboard context they are looking at, especially for self-hosted instances.
