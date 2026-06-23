import { afterEach, describe, expect, test } from "vitest";
import { installChromeStub } from "./chrome-stub.ts";
import { storageGet, storageRemove, storageSet } from "../../src/browser/storage.ts";
import { activeTab } from "../../src/browser/tabs.ts";
import { runCapture } from "../../src/browser/scripting.ts";

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

describe("storage", () => {
  test("set then get round-trips; remove deletes", async () => {
    installChromeStub();
    await storageSet("k", { a: 1 });
    expect(await storageGet("k")).toEqual({ a: 1 });
    await storageRemove("k");
    expect(await storageGet("k")).toBeUndefined();
  });
});

describe("activeTab", () => {
  test("returns id/url/title from chrome.tabs.query", async () => {
    installChromeStub({ tab: { id: 7, url: "https://ex.com/p", title: "Page" } });
    expect(await activeTab()).toEqual({ id: 7, url: "https://ex.com/p", title: "Page" });
  });
});

describe("runCapture", () => {
  test("returns the CaptureResult the injected function yields", async () => {
    const capture = { url: "https://ex.com/p", title: "P", mode: "article", body: "b", readableFound: true };
    installChromeStub({ executeResults: [{ result: capture }] });
    expect(await runCapture(7, "article")).toEqual(capture);
  });
  test("throws when the injected result is not a CaptureResult", async () => {
    installChromeStub({ executeResults: [{ result: undefined }] });
    await expect(runCapture(7, "article")).rejects.toThrow();
  });
});
