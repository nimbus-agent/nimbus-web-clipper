# Gateway Rate Limiting (429) Implementation Plan Review

Review of the proposed implementation plan in [2026-07-19-gateway-rate-limit.md](file:///C:/gitrep/nimbus-web-clipper/docs/superpowers/plans/2026-07-19-gateway-rate-limit.md).

## Suggestions & Open Questions

### 1. Alarm Delay Floor and Chrome Clamping (Critical)
- **Constraint:** In Chrome MV3, `delayInMinutes` is clamped to a minimum of **1.0 minute** (60 seconds) for packed extensions. While unpacked/developer mode extensions might allow 0.5 minutes (30 seconds) or print a warning, in production, any value less than 1.0 is clamped to 1.0.
- **Impact:** If `remainingMs` is 30 seconds and we schedule the alarm with `delayInMinutes: 0.5`, Chrome will clamp it to `1.0`, resulting in a 60-second wait.
- **Suggestion:**
  - Standardize on `1.0` as the alarm floor for production robustness, OR:
  - Implement a **hybrid timer strategy** in the service worker:
    ```ts
    if (remainingMs > 0) {
      if (remainingMs < 60_000) {
        // Run a local setTimeout since the service worker will stay active for up to 30s anyway.
        setTimeout(() => syncQueueState(), remainingMs);
      }
      rearmAlarm(FLUSH_ALARM, Math.max(1.0, remainingMs / 60_000), 1);
      return;
    }
    ```
    This ensures that sub-minute rate-limit pauses (which are very common, e.g., 5s, 10s, 30s) are serviced immediately while the worker is warm, with the alarm remaining as the reliable fallback if the worker gets terminated.

### 2. Error Seeding in `test/unit/chrome-stub.ts`
- **Observation:** Adding `alarms.get` requires updating multiple mock configurations.
- **Suggestion:** Make sure `alarms.get` handles potential edge cases where an alarm does not have a `periodInMinutes` or is scheduled purely with a `delayInMinutes`. Ensure the returned stub matches the type signature of `chrome.alarms.Alarm` precisely (including fields like `scheduledTime`).

### 3. Queue Alarm Starvation during High Concurrency
- **Observation:** `syncQueueState` is async and reads the storage queue length. If multiple clips are processed concurrently, `syncQueueState` calls might race.
- **Suggestion:** Debounce or queue the alarm synchronization calls slightly if needed, or ensure that re-arming the alarm with a different `delayInMinutes` does not reset the alarm if the target fire time is roughly similar.

### 4. Handling `clearPause` inside the paced fetch wrapper
- **Observation:** In Task 8, `postClipPaced` calls `clearPause().catch(() => undefined)` on success.
- **Suggestion:** If the pause is cleared, we should also invoke `syncQueueState()` to ensure the alarm is updated immediately (e.g. downgraded from a long pause alarm back to the regular 1-minute alarm or cleared if the queue is now empty).
