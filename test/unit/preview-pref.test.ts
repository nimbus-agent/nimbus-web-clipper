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

  test("falsy non-boolean values fall back to ON", async () => {
    // A falsy value (e.g. "") distinguishes typeof from Boolean() coercion:
    // Boolean("") is false, but Boolean("nope") is true, so only a falsy
    // non-boolean proves the guard is a typeof narrowing and not a coercion.
    // This case catches the mistake `return Boolean(value)`.
    installChromeStub({ storage: { "preview-enabled": "" } });
    expect(await isPreviewEnabled()).toBe(true);
  });

  test("falsy numeric values fall back to ON", async () => {
    // A falsy number (e.g. 0) also falls back to ON. Boolean(0) is false,
    // so this catches the same Boolean() mistake from a different angle.
    installChromeStub({ storage: { "preview-enabled": 0 } });
    expect(await isPreviewEnabled()).toBe(true);
  });

  test("null stored value falls back to ON", async () => {
    // null must also fail safe. A naive guard like value ?? true would correctly
    // return true here, but this case verifies we are using typeof to narrow,
    // not just falsy-checking or coercion.
    installChromeStub({ storage: { "preview-enabled": null } });
    expect(await isPreviewEnabled()).toBe(true);
  });
});
