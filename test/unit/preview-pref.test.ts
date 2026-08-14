// test/unit/preview-pref.test.ts
import { afterEach, describe, expect, test } from "vitest";
import { isPreviewEnabled, setPreviewEnabled } from "../../src/background/preview-pref.ts";
import { installChromeStub } from "./chrome-stub.ts";

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

describe("preview-pref", () => {
  test("DEFAULTS ON — an unset preference means the preview shows", async () => {
    installChromeStub();
    expect(await isPreviewEnabled()).toBe(true);
  });

  test("switching it off persists", async () => {
    installChromeStub();
    await setPreviewEnabled(false);
    expect(await isPreviewEnabled()).toBe(false);
  });

  test("switching it back on persists", async () => {
    installChromeStub({ storage: { "preview-enabled": false } });
    await setPreviewEnabled(true);
    expect(await isPreviewEnabled()).toBe(true);
  });

  test("a non-boolean stored value falls back to ON, not to off", async () => {
    // Corrupt storage must fail SAFE: showing a preview nobody asked for is a
    // minor annoyance; silently sending without one is the thing this slice exists
    // to prevent.
    installChromeStub({ storage: { "preview-enabled": "nope" } });
    expect(await isPreviewEnabled()).toBe(true);
  });
});
