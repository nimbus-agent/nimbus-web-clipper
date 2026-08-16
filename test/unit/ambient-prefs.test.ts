import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getAmbientHosts,
  isAmbientUrl,
  setAmbientHost,
} from "../../src/background/ambient-prefs.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

let harness: ChromeHarness;
beforeEach(() => {
  harness = installChromeMock();
});
afterEach(() => {
  harness.restore();
});

describe("ambient prefs store", () => {
  test("no stored value reads as no enabled hosts", async () => {
    expect(await getAmbientHosts()).toEqual([]);
  });

  test("a non-array stored value reads as empty rather than throwing", async () => {
    harness.storage.set("ambient-hosts", { nope: true });
    expect(await getAmbientHosts()).toEqual([]);
  });

  test("non-string members are filtered out — stored data is external input", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*", 7, null]);
    expect(await getAmbientHosts()).toEqual(["https://github.com/*"]);
  });

  test("switching a host on stores it, and again is idempotent", async () => {
    await setAmbientHost("https://github.com/*", true);
    await setAmbientHost("https://github.com/*", true);
    expect(await getAmbientHosts()).toEqual(["https://github.com/*"]);
  });

  test("switching a host off removes only that host", async () => {
    await setAmbientHost("https://github.com/*", true);
    await setAmbientHost("https://gitlab.com/*", true);
    await setAmbientHost("https://github.com/*", false);
    expect(await getAmbientHosts()).toEqual(["https://gitlab.com/*"]);
  });

  test("switching off a host that was never on is a no-op", async () => {
    await setAmbientHost("https://github.com/*", false);
    expect(await getAmbientHosts()).toEqual([]);
  });
});

describe("isAmbientUrl", () => {
  test("true when any enabled pattern covers the url", () => {
    expect(
      isAmbientUrl("https://acme.atlassian.net/browse/ABC-1", [
        "https://github.com/*",
        "https://*.atlassian.net/*",
      ]),
    ).toBe(true);
  });

  test("false when no pattern covers it", () => {
    expect(isAmbientUrl("https://example.com/x", ["https://github.com/*"])).toBe(false);
  });

  test("false with no enabled patterns at all — off is the default", () => {
    expect(isAmbientUrl("https://github.com/acme/web/pull/1", [])).toBe(false);
  });
});
