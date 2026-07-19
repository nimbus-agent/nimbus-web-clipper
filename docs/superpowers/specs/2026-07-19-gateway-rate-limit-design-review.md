# Gateway Rate Limiting (429) Design Review

Review of the proposed design in [2026-07-19-gateway-rate-limit-design.md](file:///C:/gitrep/nimbus-web-clipper/docs/superpowers/specs/2026-07-19-gateway-rate-limit-design.md).

## Suggestions & Open Questions

### 1. Chrome MV3 Alarm Constraints (Critical)
- **Constraint:** In Chrome Extension MV3, `chrome.alarms` has a strict minimum delay and period of **1 minute** (`1.0`). If a delay or period of less than 1.0 minutes is requested (e.g., `remainingMs / 60000` when `remainingMs` is 45 seconds), Chrome clamps it to 1 minute.
- **Suggestion:**
  - If `remainingMs < 60000`, we should set the alarm delay to `1` minute anyway, but we should also set a local `setTimeout` inside the service worker if it is currently active. If the service worker gets terminated before the timeout fires, the 1-minute alarm serves as a fallback.
  - Alternatively, we should explicitly document that due to MV3 limitations, sub-minute precision for alarms is not possible, and the actual pause might resolve up to 1 minute later.

### 2. Standard HTTP `Retry-After` Header Formats
- **Observation:** The spec says we parse integer seconds for `Retry-After`. While the gateway current implementation might only send delta-seconds, standard HTTP proxies, CDNs (e.g., Cloudflare, CloudFront), or future gateway changes might return an HTTP-date format (e.g., `Wed, 21 Oct 2015 07:28:00 GMT`).
- **Suggestion:** Enhance the parsing logic to detect if the string is non-numeric, try parsing it as a Date, and compute the delta relative to `Date.now()`. If it fails, default to the 60s fallback.

### 3. Concurrency & Race Conditions during Manual Retries
- **Question:** If the queue is paused due to a rate limit, and the user hits "Retry All" (which passes `manual: true` to bypass the pause), does it clear the pause or just bypass it for that round?
- **Suggestion:** If a manual retry succeeds (e.g. gets a `200`), should we clear the pause until store (`setPauseUntil(0)`)? Since a successful request indicates the rate limiting window has cleared or slots are available, we shouldn't wait out the remainder of the pause for subsequent automatic runs.

### 4. Storage Write Overhead
- **Observation:** Setting the pause writes to `chrome.storage.local`. Since writing to storage is asynchronous and has minor overhead, we should make sure we don't redundantly write `setPauseUntil` on every subsequent 429 if the pause window hasn't changed or if a pause is already active for a longer time.
- **Suggestion:** Only update the storage value if the new `pausedUntil` is greater than the currently stored one (or significantly different).

### 5. Multi-Tab / Multiple Windows Sync
- **Observation:** Since `pausedUntil` is stored in `chrome.storage.local`, different parts of the extension (popup, options page, service worker) will automatically share the same state.
- **Suggestion:** Ensure the popup and other views listen to storage changes (`chrome.storage.onChanged`) or reload the state dynamically when they are opened, so that the status is updated immediately if a background flush gets rate-limited.
