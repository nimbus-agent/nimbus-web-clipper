import { afterEach, describe, expect, test } from "vitest";
import { setBadgeCount } from "../../src/browser/action.ts";
import { clearAlarm, ensureAlarm, rearmAlarm } from "../../src/browser/alarms.ts";
import { injectPanel, runCapture } from "../../src/browser/scripting.ts";
import { storageGet, storageRemove, storageSet } from "../../src/browser/storage.ts";
import { activeTab } from "../../src/browser/tabs.ts";
import { installChromeStub } from "./chrome-stub.ts";

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
    const capture = {
      url: "https://ex.com/p",
      title: "P",
      mode: "article",
      body: "b",
      readableFound: true,
    };
    installChromeStub({ executeResults: [{ result: capture }] });
    expect(await runCapture(7, "article")).toEqual(capture);
  });
  test("throws when the injected result is not a CaptureResult", async () => {
    installChromeStub({ executeResults: [{ result: undefined }] });
    await expect(runCapture(7, "article")).rejects.toThrow();
  });
});

describe("injectPanel", () => {
  test("injects panel.js into the target tab", async () => {
    const { executeCalls } = installChromeStub();
    await injectPanel(7);
    expect(executeCalls).toEqual([{ target: { tabId: 7 }, files: ["panel.js"] }]);
  });
});

describe("alarms seam", () => {
  test("ensureAlarm creates a periodic alarm; clearAlarm clears it", async () => {
    const { alarmCalls } = installChromeStub();
    await ensureAlarm("flush-clip-queue", 1);
    await clearAlarm("flush-clip-queue");
    expect(alarmCalls).toEqual([
      { create: "flush-clip-queue", info: { periodInMinutes: 1 } },
      { clear: "flush-clip-queue" },
    ]);
  });

  // Regression: chrome.alarms.create REPLACES a same-named alarm, restarting its
  // countdown. syncQueueState runs after every clip, so a re-create on each call
  // would push the flush alarm out forever and the queue would never drain.
  test("ensureAlarm does not re-create an alarm that already exists", async () => {
    const { alarmCalls } = installChromeStub();
    await ensureAlarm("flush-clip-queue", 1);
    await ensureAlarm("flush-clip-queue", 1);
    await ensureAlarm("flush-clip-queue", 1);
    expect(alarmCalls).toEqual([{ create: "flush-clip-queue", info: { periodInMinutes: 1 } }]);
  });

  test("ensureAlarm creates again after the alarm is cleared", async () => {
    const { alarmCalls } = installChromeStub();
    await ensureAlarm("flush-clip-queue", 1);
    await clearAlarm("flush-clip-queue");
    await ensureAlarm("flush-clip-queue", 1);
    expect(alarmCalls.filter((c) => "create" in (c as object))).toHaveLength(2);
  });

  test("rearmAlarm always replaces, with a delay and a period", () => {
    const { alarmCalls } = installChromeStub();
    rearmAlarm("flush-clip-queue", 0.75, 1);
    rearmAlarm("flush-clip-queue", 0.5, 1);
    expect(alarmCalls).toEqual([
      { create: "flush-clip-queue", info: { delayInMinutes: 0.75, periodInMinutes: 1 } },
      { create: "flush-clip-queue", info: { delayInMinutes: 0.5, periodInMinutes: 1 } },
    ]);
  });
});

describe("action badge seam", () => {
  test("setBadgeCount shows the number when > 0 and clears at 0", async () => {
    const { badgeTexts } = installChromeStub();
    await setBadgeCount(3);
    await setBadgeCount(0);
    expect(badgeTexts).toEqual(["3", ""]);
  });
});
