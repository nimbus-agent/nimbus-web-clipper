// test/unit/menus.test.ts
import { describe, expect, test } from "vitest";
import {
  MENU_ADD_PASSAGE,
  MENU_CLIP_PAGE,
  MENU_CLIP_SELECTION,
  MENU_DEFINE,
  MENU_ITEMS,
  MENU_RELATED_TO_SELECTION,
  MENU_SHOW_RELATED,
  menuAction,
  registerMenus,
} from "../../src/background/menus.ts";

describe("MENU_ITEMS", () => {
  test("declares exactly the six entries, ids matching the constants", () => {
    expect(MENU_ITEMS.map((i) => i.id)).toEqual([
      MENU_CLIP_PAGE,
      MENU_CLIP_SELECTION,
      MENU_SHOW_RELATED,
      MENU_DEFINE,
      MENU_RELATED_TO_SELECTION,
      MENU_ADD_PASSAGE,
    ]);
  });

  test("clip-selection appears on a selection; show-related on page, link, image and selection", () => {
    const byId = new Map(MENU_ITEMS.map((i) => [i.id, i]));
    expect(byId.get(MENU_CLIP_SELECTION)?.contexts).toEqual(["selection"]);
    // Wider than just "page": Chrome only shows a plain page-context item when
    // nothing else is under the cursor, and this entry needs to be reachable
    // on a right-click that lands on a link, image, or selected text too.
    expect(byId.get(MENU_SHOW_RELATED)?.contexts).toEqual(["page", "link", "image", "selection"]);
  });

  // Each entry is meaningless without selected text, and the browser only
  // offers a selection item when there is some — so here the narrow list is the
  // correct one, not a way for the entry to disappear.
  test("the selection-only entries appear on a selection and nowhere else", () => {
    const byId = new Map(MENU_ITEMS.map((i) => [i.id, i]));
    expect(byId.get(MENU_DEFINE)?.contexts).toEqual(["selection"]);
    expect(byId.get(MENU_RELATED_TO_SELECTION)?.contexts).toEqual(["selection"]);
    expect(byId.get(MENU_ADD_PASSAGE)?.contexts).toEqual(["selection"]);
  });

  test("every entry has a non-empty title and at least one context", () => {
    for (const item of MENU_ITEMS) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.contexts.length).toBeGreaterThan(0);
    }
  });

  test("every id maps to an action, and no action is unrouted", () => {
    // The `never` arm in the worker's switch catches a new MenuAction with no
    // route at compile time; this catches a new MENU_ITEMS row with no action.
    for (const item of MENU_ITEMS) {
      expect(menuAction(item.id)).not.toBeNull();
    }
  });
});

describe("menuAction", () => {
  test("maps each id to its action", () => {
    expect(menuAction(MENU_CLIP_PAGE)).toBe("clip-article");
    expect(menuAction(MENU_CLIP_SELECTION)).toBe("clip-selection");
    expect(menuAction(MENU_SHOW_RELATED)).toBe("show-related");
    expect(menuAction(MENU_DEFINE)).toBe("define-selection");
    expect(menuAction(MENU_RELATED_TO_SELECTION)).toBe("related-to-selection");
    expect(menuAction(MENU_ADD_PASSAGE)).toBe("add-passage");
  });

  test("an unknown id is null — NOT a default clip", () => {
    expect(menuAction("something-else")).toBeNull();
    expect(menuAction("")).toBeNull();
  });
});

describe("registerMenus", () => {
  test("clears before creating, so a reload cannot duplicate an id", async () => {
    const calls: string[] = [];
    await registerMenus({
      removeAll: async () => {
        calls.push("removeAll");
      },
      create: (item) => {
        calls.push(`create:${item.id}`);
      },
    });
    expect(calls).toEqual([
      "removeAll",
      `create:${MENU_CLIP_PAGE}`,
      `create:${MENU_CLIP_SELECTION}`,
      `create:${MENU_SHOW_RELATED}`,
      `create:${MENU_DEFINE}`,
      `create:${MENU_RELATED_TO_SELECTION}`,
      `create:${MENU_ADD_PASSAGE}`,
    ]);
  });

  test("one failing entry does not cost the others — especially the last one", async () => {
    const created: string[] = [];
    await registerMenus({
      removeAll: async () => undefined,
      create: (item) => {
        // The FIRST entry throws. Without per-item isolation this would abort the
        // loop and every entry after it — including the selection entries at the
        // end of the table — would never be registered at all.
        if (item.id === MENU_CLIP_PAGE) {
          throw new Error("duplicate id");
        }
        created.push(item.id);
      },
    });
    expect(created).toEqual([
      MENU_CLIP_SELECTION,
      MENU_SHOW_RELATED,
      MENU_DEFINE,
      MENU_RELATED_TO_SELECTION,
      MENU_ADD_PASSAGE,
    ]);
  });

  test("registerMenus itself does not reject when an entry fails", async () => {
    await expect(
      registerMenus({
        removeAll: async () => undefined,
        create: () => {
          throw new Error("nope");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
