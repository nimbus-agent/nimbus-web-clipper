// test/unit/rate-limit-pause.test.ts
import { afterEach, describe, expect, test } from "vitest";
import { clearPause, getPauseUntil, setPauseUntil } from "../../src/background/rate-limit-pause.ts";
import { installChromeStub } from "./chrome-stub.ts";

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

describe("rate-limit pause store", () => {
  test("absent key → 0", async () => {
    installChromeStub();
    expect(await getPauseUntil()).toBe(0);
  });

  test("set then get round-trips", async () => {
    installChromeStub();
    await setPauseUntil(1_700_000_000_000);
    expect(await getPauseUntil()).toBe(1_700_000_000_000);
  });

  // The stored value is external data crossing a trust boundary like any other.
  test("a malformed stored value reads as 0 rather than NaN", async () => {
    installChromeStub({ storage: { clipRateLimitPauseUntil: "soon" } });
    expect(await getPauseUntil()).toBe(0);
  });

  test("clearPause resets an active pause and reports that it did", async () => {
    installChromeStub();
    await setPauseUntil(1_700_000_000_000);
    expect(await clearPause()).toBe(true);
    expect(await getPauseUntil()).toBe(0);
  });

  // clearPause runs after EVERY successful clip; it must not write when idle. The
  // false return is also the signal the caller uses to leave the alarm alone.
  test("clearPause writes nothing and reports false when no pause is stored", async () => {
    const { storage } = installChromeStub();
    expect(await clearPause()).toBe(false);
    expect(storage.has("clipRateLimitPauseUntil")).toBe(false);
  });

  // A backwards system-clock correction (NTP jump, VM resume, dual-boot) can leave a
  // stored deadline arbitrarily far in the future; the gateway's own maximum
  // Retry-After is 120s, so nothing legitimate can exceed that from now.
  test("a negative stored value reads as 0", async () => {
    installChromeStub({ storage: { clipRateLimitPauseUntil: -1 } });
    expect(await getPauseUntil()).toBe(0);
  });

  test("a far-future stored value is clamped to at most 120s from now", async () => {
    const farFuture = Date.now() + 10 * 365 * 24 * 3600 * 1000;
    installChromeStub({ storage: { clipRateLimitPauseUntil: farFuture } });
    const before = Date.now();
    const result = await getPauseUntil();
    const after = Date.now();
    // The clamp samples Date.now() INSIDE getPauseUntil, so its ceiling is that
    // inner now + 120s — which sits between `before` and `after`. The only sound
    // upper bound is therefore after + 120s; a before-based bound is flaky (it
    // fails whenever a millisecond ticks over during the call).
    expect(result).toBeLessThanOrEqual(after + 120_000);
    expect(result).toBeGreaterThan(before);
  });
});
