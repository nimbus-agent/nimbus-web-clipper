import { afterEach, describe, expect, test } from "vitest";
import {
  addMenuClickListener,
  createMenu,
  removeAllMenus,
} from "../../src/browser/context-menus.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

let harness: ChromeHarness;
afterEach(() => {
  harness.restore();
});

describe("browser/context-menus seam", () => {
  test("createMenu forwards id, title, contexts to chrome.contextMenus.create", () => {
    harness = installChromeMock();
    createMenu({ id: "clip-page", title: "Clip page to Nimbus", contexts: ["page"] });
    expect(harness.contextMenusCreate).toHaveBeenCalledWith({
      id: "clip-page",
      title: "Clip page to Nimbus",
      contexts: ["page"],
    });
  });

  test("removeAllMenus calls chrome.contextMenus.removeAll", async () => {
    harness = installChromeMock();
    await removeAllMenus();
    expect(harness.contextMenusRemoveAll).toHaveBeenCalled();
  });

  test("addMenuClickListener forwards menuItemId + tab id", () => {
    harness = installChromeMock();
    let seen: { id: string; tab?: number } | undefined;
    addMenuClickListener((menuItemId, tabId) => {
      seen = { id: menuItemId, ...(tabId === undefined ? {} : { tab: tabId }) };
    });
    harness.emitMenuClick("clip-selection", 7);
    expect(seen).toEqual({ id: "clip-selection", tab: 7 });
  });

  test("addMenuClickListener forwards tabId as undefined when the click has no tab", () => {
    harness = installChromeMock();
    let seenTabId: number | undefined = 0;
    addMenuClickListener((_menuItemId, tabId) => {
      seenTabId = tabId;
    });
    harness.emitMenuClick("clip-page");
    expect(seenTabId).toBeUndefined();
  });
});
