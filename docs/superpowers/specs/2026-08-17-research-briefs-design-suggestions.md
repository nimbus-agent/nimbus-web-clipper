# Review and Suggestions: Research briefs from your open tabs design

This document contains comments, open questions, and suggested improvements for the [2026-08-17-research-briefs-design.md](file:///C:/gitrep/nimbus-web-clipper/.claude/worktrees/research-briefs-lane/docs/superpowers/specs/2026-08-17-research-briefs-design.md) specification.

---

## 1. Global vs. Individual Cap Enforcement (`MAX_RUN_BYTES` vs. `MAX_SOURCE_BYTES`)
* **Context**: `MAX_SOURCE_BYTES` is 256 KB, and `MAX_RUN_BYTES` is 4 MB. `MAX_SOURCES_PER_RUN` is 20.
* **The Problem**: If a user runs a brief with 20 sources, and each source is near the 256 KB cap, the total raw size is $20 \times 256\text{ KB} = 5\text{ MB}$. This exceeds `MAX_RUN_BYTES` (4 MB).
* **Open Question**: How does the client enforce the 4 MB limit?
  * If the client uploads sources sequentially, does the gateway reject the `POST /run` call or the last few `POST /sources` calls with a `413`?
  * **Recommendation**: The client should pre-calculate the total budget. If the sum of the captured sources exceeds 4 MB, it should perform a global budget allocation (e.g., dynamically lowering the individual truncation limit to `4 MB / actual_source_count` or prioritizing content truncation based on tab order) before feeding, rather than feeding payloads that will inevitably cause `/run` or the final feeds to fail.

## 2. Host Permission UX Enhancement (Inline Grants)
* **Context**: Decision 2 states: *"3 open tabs are on sites you haven't granted page access to with a link to Options."*
* **The Problem**: Navigating away to the Options page to grant host permissions disrupts the flow of composing a brief.
* **Recommendation**: Leverage the Optional Permissions API via `chrome.permissions.request`.
  * Since picking a tab and clicking "Run Brief" or a dedicated "Grant Access" button constitutes a user gesture, the extension can request optional permissions for those specific origins inline.
  * This allows the user to grant access to the 3 ungranted hosts directly from the composer/confirming state without leaving the page.

## 3. Concurrency in the Feeding Phase
* **Context**: The design specifies sequential feeding: `POST /sources` is done one-by-one.
* **The Problem**: sequential network requests introduce latency (especially on high-RTT connections), and up to 20 serial HTTP calls can make the creation phase feel sluggish.
* **Open Question**: Can we parallelize feeding?
  * If `brief-src` rate limiting (60/min) is the primary constraint, a batch of 20 concurrent requests will not exceed it.
  * Running requests in parallel (e.g., via `Promise.all` with a concurrency limit of 3 or 4) would speed up the collection state significantly while still keeping rate-limit compliance.
  * **Recommendation**: Use a concurrent worker queue with a small pool size (e.g., 3-5 concurrent requests) to feed sources. This speeds up feed times while keeping the rate-limit safe.

## 4. Polling & Service Worker State Restoration
* **Context**: Polling uses `setTimeout` backoff on the client page, but uses `chrome.alarms` in the service worker to handle background resurrection.
* **Open Question**: How does the Service Worker communicate status updates back to the UI if the worker is resurrected mid-poll?
  * If the `brief.html` page is open, does it also poll? If both poll, do they duplicate requests?
  * **Recommendation**: Specify a clear ownership model.
    * If the page is active, it should own the polling and keep the service worker alive via message ports or regular pings.
    * If the page is closed/backgrounded, the service worker's `chrome.alarms` takes over.
    * Clarify whether `brief-run-store.ts` syncs polling status reactively to the page via `chrome.runtime.sendMessage` upon alarm triggers.

## 5. Free-Text Escape Hatch UX
* **Context**: Decision 3 states: *"Free text exists behind a disclosure as an escape hatch — the surface leads with what it already knows, and typing is the fallback rather than the entry."*
* **Open Question**: What is the nature of the "disclosure"?
  * If it is a warning or an extra click-through dialog, it might feel like friction for users who have a specific custom question in mind.
  * **Recommendation**: Frame it as a simple "Ask a custom question..." button/accordion that expands an input field, rather than a scary "disclosure" or warning.

## 6. Egress Disclosure Log and Option Panel Eviction
* **Context**: Log entries are capped at `MAX_RETAINED_TERMINAL_RUNS = 16`.
* **The Problem**: If a log entry is evicted but the user saved the item to the gateway (`savedItemId` is set), the link is lost in the log UI.
* **Open Question**: Should saved items be immune to log eviction?
  * If the user explicitly saved a brief, that run is arguably "important" and its egress record should probably not be evicted as quickly as unsaved runs.
  * **Recommendation**: Prioritize evicting logs of unsaved runs first, or keep saved run log entries pinned to the storage as long as the saved item exists.
