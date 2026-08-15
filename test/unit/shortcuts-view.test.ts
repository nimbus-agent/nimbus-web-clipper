// @vitest-environment jsdom
// test/unit/shortcuts-view.test.ts
import { describe, expect, test } from "vitest";
import type { CommandBinding } from "../../src/browser/commands.ts";
import {
  renderShortcuts,
  type ShortcutRow,
  shortcutRows,
  shortcutsHint,
} from "../../src/options/shortcuts-view.ts";

const bound: CommandBinding = {
  name: "show_related",
  description: "Show related items in Nimbus",
  shortcut: "Alt+Shift+R",
};
const unbound: CommandBinding = {
  name: "clip-page",
  description: "Clip the current page to Nimbus",
  shortcut: "",
};

describe("shortcutRows", () => {
  test("a bound command reports its real shortcut", () => {
    expect(shortcutRows([bound])).toEqual([
      { label: "Show related items in Nimbus", shortcut: "Alt+Shift+R", bound: true },
    ]);
  });

  test("an empty shortcut is UNBOUND and says so in words, not as a blank", () => {
    const [row] = shortcutRows([unbound]);
    expect(row?.bound).toBe(false);
    expect(row?.shortcut).toBe("Not set");
  });

  test("a command with no description falls back to its name, never an empty label", () => {
    const [row] = shortcutRows([{ name: "show_related", description: "", shortcut: "" }]);
    expect(row?.label).toBe("show_related");
  });

  test("no commands yields no rows", () => {
    expect(shortcutRows([])).toEqual([]);
  });
});

describe("shortcutsHint", () => {
  test("Chrome is told its own settings path", () => {
    expect(shortcutsHint(false)).toContain("chrome://extensions/shortcuts");
  });

  test("Firefox is told its own, which is a different place", () => {
    const hint = shortcutsHint(true);
    expect(hint).toContain("about:addons");
    expect(hint).not.toContain("chrome://extensions/shortcuts");
  });

  test("both hints say to paste it, because neither can be linked", () => {
    expect(shortcutsHint(false).toLowerCase()).toContain("paste");
    expect(shortcutsHint(true).toLowerCase()).toContain("paste");
  });
});

describe("renderShortcuts", () => {
  const rows: ShortcutRow[] = [
    { label: "Show related items in Nimbus", shortcut: "Alt+Shift+R", bound: true },
    { label: "Clip the current page to Nimbus", shortcut: "Not set", bound: false },
  ];

  test("renders one row per command", () => {
    const frag = renderShortcuts(document, rows);
    expect(frag.querySelectorAll(".shortcut")).toHaveLength(2);
  });

  test("an unbound row is marked so a reader can spot it without comparing text", () => {
    const frag = renderShortcuts(document, rows);
    const marked = frag.querySelectorAll('.shortcut[data-bound="false"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain("Clip the current page to Nimbus");
  });

  test("renders labels as text, never as markup", () => {
    const frag = renderShortcuts(document, [
      { label: "<img src=x onerror=alert(1)>", shortcut: "Not set", bound: false },
    ]);
    expect(frag.querySelector("img")).toBeNull();
    expect(frag.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
