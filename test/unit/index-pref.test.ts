import { afterEach, describe, expect, it } from "vitest";
import { isIndexSearchEnabled, setIndexSearchEnabled } from "../../src/background/index-pref.ts";
import { installChromeStub } from "./chrome-stub.ts";

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

describe("index search preference", () => {
  it("defaults to OFF when nothing is stored", async () => {
    // A widening of what a run consults must never be the unasked-for default.
    installChromeStub();
    expect(await isIndexSearchEnabled()).toBe(false);
  });

  it("round-trips a deliberate choice", async () => {
    installChromeStub();
    await setIndexSearchEnabled(true);
    expect(await isIndexSearchEnabled()).toBe(true);
    await setIndexSearchEnabled(false);
    expect(await isIndexSearchEnabled()).toBe(false);
  });

  it("falls back to OFF on a value that is not a boolean", async () => {
    // The OPPOSITE fail-safe direction from preview-pref: an unreadable value
    // must never silently turn on a wider search.
    installChromeStub({ storage: { "index-search-enabled": "yes" } });
    expect(await isIndexSearchEnabled()).toBe(false);
  });
});
