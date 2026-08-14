# Review & Suggestions: Setup That Works Implementation Plan (Slice 1)

This document contains open questions, suggestions, and potential improvements for the proposed implementation plan in [2026-08-14-slice-1-setup-that-works.md](./2026-08-14-slice-1-setup-that-works.md).

## 1. Exception Safety and Graceful Degradation in `probeHealth`
* **The issue:** In Task 2, Step 3, the `readJson(res)` call is placed outside the `try-catch` block:
  ```ts
  try {
    res = await getJsonAt(doFetch, endpointUrl(origin, "health"), {}, HEALTH_TIMEOUT_MS);
  } catch {
    return false;
  }
  if (!res.ok) {
    return false;
  }
  const data = await readJson(res); // <-- Outside try-catch
  return isObject(data) && data["status"] === "ok";
  ```
  If the gateway (or something else listening on port 7474) returns non-JSON data or if the connection closes while reading the response body, `readJson` will throw an exception. This will bypass the fallback check in `handleDiscover`, terminating the sequential probing loop immediately and failing the entire request, rather than falling back to the next candidate (e.g. `localhost`).
* **Suggestion:** Move `readJson(res)` inside the `try` block, or extend the `try-catch` to cover the entire body of the function:
  ```ts
  try {
    const res = await getJsonAt(doFetch, endpointUrl(origin, "health"), {}, HEALTH_TIMEOUT_MS);
    if (!res.ok) {
      return false;
    }
    const data = await readJson(res);
    return isObject(data) && data["status"] === "ok";
  } catch {
    return false;
  }
  ```

## 2. Unhandled Promise Rejection in Fire-and-Forget `markStale`
* **The issue:** In Task 6, Step 3, `markStale` is called as a fire-and-forget promise in the message listener:
  ```ts
  const respond = (res: unknown): void => {
    if (carriesUnauthorized(res)) {
      void markStale(); // <-- Fire-and-forget
    }
    rawRespond(res);
  };
  ```
  While fire-and-forget is appropriate here to avoid delaying the user-facing response, any unhandled promise rejection inside `markStale` (e.g., if `chrome.storage.local.set` throws a runtime error or connection-store's `writes` chain rejects) might trigger a global unhandled rejection error in the service worker context.
* **Suggestion:** Explicitly catch errors on the promise:
  ```ts
  void markStale().catch(() => undefined);
  ```

## 3. Storage Mutation Concurrency Safety
* **The issue:** In Task 3, Step 3, the `mutate` wrapper serializes writes on a single promise chain:
  ```ts
  let writes: Promise<void> = Promise.resolve();
  function mutate(transform: (c: Connection) => Connection): Promise<void> {
    writes = writes
      .catch(() => undefined)
      .then(async () => {
        const current = await getConnection();
        if (current === null) {
          return;
        }
        await storageSet(CONNECTION_KEY, transform(current));
      });
    return writes;
  }
  ```
  * Note that since `writes` is a module-level variable, if the service worker goes idle and restarts, the local promise chain is lost. That is normal for extensions, but we should make sure that this serialize-in-memory strategy is purely to handle overlapping asynchronous messages within a single active session (e.g. quick back-to-back storage edits).
  * Also, ensure that the type signature of `transform` receives a deep copy or we don't accidentally mutate the referenced connection object in place if other background parts are holding onto a reference of `Connection`. Fortunately, `transform(current)` creates a new shallow copy (`{ ...c, stale: true }`), which is safe.
