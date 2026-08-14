// test/unit/menus.test.ts
import { describe, expect, test } from "vitest";
import {
  MENU_CLIP_PAGE,
  MENU_CLIP_SELECTION,
  MENU_ITEMS,
  MENU_SHOW_RELATED,
  menuAction,
  registerMenus,
} from "../../src/background/menus.ts";

describe("MENU_ITEMS", () => {
  test("declares exactly the three entries, ids matching the constants", () => {
    expect(MENU_ITEMS.map((i) => i.id)).toEqual([
      MENU_CLIP_PAGE,
      MENU_CLIP_SELECTION,
      MENU_SHOW_RELATED,
    ]);
  });

  test("clip-selection appears on a selection; show-related on the page", () => {
    const byId = new Map(MENU_ITEMS.map((i) => [i.id, i]));
    expect(byId.get(MENU_CLIP_SELECTION)?.contexts).toEqual(["selection"]);
    expect(byId.get(MENU_SHOW_RELATED)?.contexts).toEqual(["page"]);
  });

  test("every entry has a non-empty title and at least one context", () => {
    for (const item of MENU_ITEMS) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.contexts.length).toBeGreaterThan(0);
    }
  });
});

describe("menuAction", () => {
  test("maps each id to its action", () => {
    expect(menuAction(MENU_CLIP_PAGE)).toBe("clip-article");
    expect(menuAction(MENU_CLIP_SELECTION)).toBe("clip-selection");
    expect(menuAction(MENU_SHOW_RELATED)).toBe("show-related");
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
    ]);
  });

  test("one failing entry does not cost the others — especially the last one", async () => {
    const created: string[] = [];
    await registerMenus({
      removeAll: async () => undefined,
      create: (item) => {
        // The FIRST entry throws. Without per-item isolation this would abort the
        // loop and `show-related` — the entry this slice adds, and the last in
        // the table — would never be registered at all.
        if (item.id === MENU_CLIP_PAGE) {
          throw new Error("duplicate id");
        }
        created.push(item.id);
      },
    });
    expect(created).toEqual([MENU_CLIP_SELECTION, MENU_SHOW_RELATED]);
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
