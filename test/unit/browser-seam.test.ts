import { afterEach, describe, expect, test } from "vitest";
import { setBadgeCount } from "../../src/browser/action.ts";
import { clearAlarm, ensureAlarm, rearmAlarm } from "../../src/browser/alarms.ts";
import { getAllCommands } from "../../src/browser/commands.ts";
import { isFirefoxRuntime } from "../../src/browser/runtime.ts";
import { injectPanel, runCapture, showCue } from "../../src/browser/scripting.ts";
import { storageGet, storageRemove, storageSet } from "../../src/browser/storage.ts";
import {
  activeTab,
  addNavigationListener,
  addTabClosedListener,
  type TabNavigation,
  tabUrl,
} from "../../src/browser/tabs.ts";
import { installChromeStub } from "./chrome-stub.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

let harness: ChromeHarness;
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

describe("showCue", () => {
  test("showCue injects cue.js then calls its global with the state", async () => {
    harness = installChromeMock();
    await showCue(7, { label: "GitHub PR", ref: "acme/web #482" });
    expect(harness.executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 7 },
      files: ["cue.js"],
    });
    const second = harness.executeScript.mock.calls[1]?.[0] as { args?: unknown[] };
    expect(second.args).toEqual([{ label: "GitHub PR", ref: "acme/web #482" }]);
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

describe("browser/tabs navigation seam", () => {
  test("a URL change on an active tab reaches the listener", () => {
    harness = installChromeMock();
    const seen: TabNavigation[] = [];
    addNavigationListener((nav) => seen.push(nav));
    harness.emitTabUpdated(7, { url: "https://github.com/acme/web/pull/482" }, { active: true });
    expect(seen).toEqual([{ tabId: 7, url: "https://github.com/acme/web/pull/482", active: true }]);
  });

  test("an update with no url is not a navigation and is dropped", () => {
    harness = installChromeMock();
    const seen: TabNavigation[] = [];
    addNavigationListener((nav) => seen.push(nav));
    // The browser omits changeInfo.url for hosts we hold no permission on — the
    // permission boundary is enforced here, by the browser, not by our own check.
    harness.emitTabUpdated(7, {}, { active: true });
    harness.emitTabUpdated(7, { url: undefined }, { active: true });
    expect(seen).toEqual([]);
  });

  test("an inactive tab is reported as inactive rather than dropped here", () => {
    harness = installChromeMock();
    const seen: TabNavigation[] = [];
    addNavigationListener((nav) => seen.push(nav));
    harness.emitTabUpdated(7, { url: "https://github.com/x" }, { active: false });
    expect(seen[0]?.active).toBe(false);
  });

  test("a missing active flag is treated as inactive, never assumed active", () => {
    harness = installChromeMock();
    const seen: TabNavigation[] = [];
    addNavigationListener((nav) => seen.push(nav));
    harness.emitTabUpdated(7, { url: "https://github.com/x" }, {});
    expect(seen[0]?.active).toBe(false);
  });

  test("tab closure reaches its listener", () => {
    harness = installChromeMock();
    const closed: number[] = [];
    addTabClosedListener((tabId) => closed.push(tabId));
    harness.emitTabRemoved(7);
    expect(closed).toEqual([7]);
  });

  test("tabUrl returns the tab's url", async () => {
    harness = installChromeMock();
    harness.tabsGet.mockResolvedValueOnce({ url: "https://github.com/acme/web/pull/517" });
    expect(await tabUrl(7)).toBe("https://github.com/acme/web/pull/517");
  });

  test("tabUrl is null for a tab that has gone away", async () => {
    harness = installChromeMock();
    harness.tabsGet.mockRejectedValueOnce(new Error("No tab with id: 7"));
    expect(await tabUrl(7)).toBeNull();
  });

  test("tabUrl is null when the url is not visible to us", async () => {
    harness = installChromeMock();
    harness.tabsGet.mockResolvedValueOnce({});
    expect(await tabUrl(7)).toBeNull();
  });
});

describe("getAllCommands", () => {
  test("maps chrome.commands.getAll into plain bindings", async () => {
    installChromeStub();
    (globalThis as unknown as { chrome: Record<string, unknown> }).chrome["commands"] = {
      getAll: (cb: (c: unknown[]) => void) =>
        cb([
          {
            name: "show_related",
            description: "Show related items in Nimbus",
            shortcut: "Alt+Shift+R",
          },
          { name: "clip-page", description: "Clip the current page to Nimbus", shortcut: "" },
        ]),
    };
    expect(await getAllCommands()).toEqual([
      {
        name: "show_related",
        description: "Show related items in Nimbus",
        shortcut: "Alt+Shift+R",
      },
      { name: "clip-page", description: "Clip the current page to Nimbus", shortcut: "" },
    ]);
  });

  test("a command with no shortcut field reads as unbound, not undefined", async () => {
    installChromeStub();
    (globalThis as unknown as { chrome: Record<string, unknown> }).chrome["commands"] = {
      getAll: (cb: (c: unknown[]) => void) => cb([{ name: "show_related" }]),
    };
    expect(await getAllCommands()).toEqual([
      { name: "show_related", description: "", shortcut: "" },
    ]);
  });

  test("an absent chrome.commands API yields an empty list, not a throw", async () => {
    installChromeStub();
    expect(await getAllCommands()).toEqual([]);
  });
});

describe("isFirefoxRuntime", () => {
  test("true for a moz-extension runtime URL", () => {
    installChromeStub();
    (globalThis as unknown as { chrome: Record<string, unknown> }).chrome["runtime"] = {
      getURL: () => "moz-extension://abc/",
    };
    expect(isFirefoxRuntime()).toBe(true);
  });

  test("false for a chrome-extension runtime URL", () => {
    installChromeStub();
    (globalThis as unknown as { chrome: Record<string, unknown> }).chrome["runtime"] = {
      getURL: () => "chrome-extension://abc/",
    };
    expect(isFirefoxRuntime()).toBe(false);
  });

  test("false rather than throwing when getURL is unavailable", () => {
    installChromeStub();
    expect(isFirefoxRuntime()).toBe(false);
  });
});
