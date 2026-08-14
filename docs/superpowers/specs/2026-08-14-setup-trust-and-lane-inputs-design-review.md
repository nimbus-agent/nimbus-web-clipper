# Review & Suggestions: Setup, Trust, and Lane Inputs Design

This document contains open questions, suggestions, and potential improvements for the proposed design in [2026-08-14-setup-trust-and-lane-inputs-design.md](./2026-08-14-setup-trust-and-lane-inputs-design.md).

## 1. Handling Stale/Revoked States in the Staged Options Flow
* **Concern:** The design defines four stages, with Stages 2 (Connection) and 3 (Your sites) locked until Stage 1 (Connect) completes. If a paired connection subsequently becomes stale (e.g., returns 401 and sets `stale: true`), does the Options flow lock the user out of Stages 2 and 3 again?
* **Suggestion:** If the token is stale or the gateway is unreachable, we should avoid locking the user out of viewing their already-recognized sites or trust settings. Instead of a hard lock, the stage status should support a `"stale"` or `"error"` state that displays warning banners while keeping the lists readable/editable (so they can unpair or inspect their settings).

## 2. Selection Length and Input Sanitation for Glossary Terms
* **Concern:** Glossary lanes take a user-selected string (`term`). If a user accidentally selects a huge block of text (e.g., thousands of characters) and triggers "Define in Nimbus", sending this raw string to the gateway could cause HTTP header size issues, gateway-side validation errors, or unnecessary agent execution.
* **Suggestion:**
  * Define a sensible character limit (e.g., 100–200 characters) in the content script or messages guard in [`messages.ts`](file:///C:/gitrep/nimbus-web-clipper/src/shared/messages.ts).
  * Truncate and clean the string (e.g., collapsing whitespace, stripping non-printable characters) before triggering the run or checking the cache.

## 3. Localhost and Loopback Probe Timeout Sensitivity
* **Concern:** The `probeHealth` method uses a short (~800 ms) timeout. While this prevents blocking the UI, Windows machines occasionally experience delays resolving `localhost` relative to `127.0.0.1` due to IPv4/IPv6 dual-stack resolution priority.
* **Suggestion:** Ensure the candidate probe executes `http://127.0.0.1:7474` and `http://localhost:7474` concurrently (or prioritizes `127.0.0.1`), so a slow `localhost` resolution doesn't cause the probe to fail and fall back to manual input unnecessarily.

## 4. Run Cache Budget Eviction Pressure
* **Concern:** Glossary lookup terms share the same `MAX_STORED_RUNS = 16` budget as item and service runs. A quick succession of glossary lookups on a page could completely evict existing, highly valuable service or item briefs.
* **Suggestion:** Partition the cache or introduce a separate sub-budget for glossary term runs (e.g., limit term runs to 8 entries) to ensure item and service briefs aren't easily evicted by glossary lookups.

## 5. Avoiding Redundant Lookups for Scope-Less Connections
* **Concern:** In Slice 5, connections established before the gateway grew token scopes will lack the `resolve` scope, leading to silent degradation. However, checking on every popup open is wasteful if the client already knows the token lacks the scope.
* **Suggestion:** Cache the scope-check outcome (or inspect the decoded token scopes if JWT/self-describing) on pairing or initial load, and disable the popup resolve lookup completely if the required scope is missing. This prevents redundant, failed requests.
