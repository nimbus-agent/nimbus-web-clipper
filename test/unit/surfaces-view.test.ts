// @vitest-environment jsdom
// test/unit/surfaces-view.test.ts
import { describe, expect, test } from "vitest";
import {
  renderSurfaceList,
  type SurfaceRow,
  sharedHostNote,
} from "../../src/options/surfaces-view.ts";

const jira: SurfaceRow = {
  origin: "https://corp.example/jira",
  product: "jira",
  granted: false,
  builtIn: false,
  pattern: "https://corp.example/*",
  ambient: false,
};
const jenkins: SurfaceRow = {
  origin: "https://corp.example/jenkins",
  product: "jenkins",
  granted: true,
  builtIn: false,
  pattern: "https://corp.example/*",
  ambient: false,
};

const STORED: SurfaceRow = {
  origin: "https://corp.example/jira",
  product: "jira",
  granted: true,
  builtIn: false,
  pattern: "https://corp.example/*",
  ambient: false,
};

const BUILT_IN: SurfaceRow = {
  origin: "github.com",
  product: "github",
  granted: true,
  builtIn: true,
  pattern: "https://github.com/*",
  ambient: true,
};

function actions(el: HTMLElement): string[] {
  return [...el.querySelectorAll("[data-action]")].map(
    (node) => (node as HTMLElement).dataset["action"] ?? "",
  );
}

describe("renderSurfaceList", () => {
  test("empty state explains what the list is for", () => {
    expect(renderSurfaceList(document, []).textContent).toContain("No self-hosted surfaces");
  });
  test("one row per entry, showing origin and product", () => {
    const list = renderSurfaceList(document, [jira, jenkins]);
    expect(list.querySelectorAll(".surfaces__row")).toHaveLength(2);
    expect(list.textContent).toContain("https://corp.example/jira");
    expect(list.textContent).toContain("Jira");
  });
  test("an ungranted row offers Grant; a granted row offers Revoke", () => {
    const list = renderSurfaceList(document, [jira, jenkins]);
    const buttons = [...list.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toContain("Grant page access");
    expect(buttons).toContain("Revoke page access");
  });
  test("rows carry their origin so click delegation can identify them", () => {
    const list = renderSurfaceList(document, [jira]);
    const button = list.querySelector<HTMLButtonElement>("button[data-action='remove']");
    expect(button?.dataset["origin"]).toBe("https://corp.example/jira");
  });
  test("XSS backstop — an origin string is inert text", () => {
    const list = renderSurfaceList(document, [
      {
        origin: "https://x/<img src=x onerror=alert(1)>",
        product: "jira",
        granted: false,
        builtIn: false,
        pattern: "https://x/*",
        ambient: false,
      },
    ]);
    expect(list.querySelector("img")).toBeNull();
    expect(list.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("sharedHostNote", () => {
  test("warns when revoking a host would silence a sibling prefix", () => {
    expect(sharedHostNote([jira, jenkins], "https://corp.example/jira")).toContain(
      "https://corp.example/jenkins",
    );
  });
  test("no note when the host carries a single entry", () => {
    expect(sharedHostNote([jira], "https://corp.example/jira")).toBeNull();
  });
});

describe("built-in rows", () => {
  test("a built-in row offers grant/revoke and the toggle but never Remove", () => {
    const el = renderSurfaceList(document, [BUILT_IN]);
    expect(actions(el)).toEqual(["ambient", "revoke"]);
    expect(el.textContent).toContain("github.com");
  });

  test("a stored row keeps Remove", () => {
    const el = renderSurfaceList(document, [STORED]);
    expect(actions(el)).toEqual(["ambient", "revoke", "remove"]);
  });

  test("an ungranted row offers Grant instead of Revoke", () => {
    const el = renderSurfaceList(document, [{ ...BUILT_IN, granted: false }]);
    expect(actions(el)).toContain("grant");
    expect(actions(el)).not.toContain("revoke");
  });
});

describe("the ambient toggle", () => {
  test("reflects the stored state and carries the pattern, not the origin", () => {
    const el = renderSurfaceList(document, [BUILT_IN]);
    const toggle = el.querySelector('[data-action="ambient"]');
    expect(toggle).toBeInstanceOf(HTMLInputElement);
    const input = toggle as HTMLInputElement;
    expect(input.type).toBe("checkbox");
    expect(input.checked).toBe(true);
    expect(input.dataset["pattern"]).toBe("https://github.com/*");
  });

  test("is disabled without page access — the cue cannot see a host it may not read", () => {
    const el = renderSurfaceList(document, [{ ...BUILT_IN, granted: false, ambient: false }]);
    const input = el.querySelector('[data-action="ambient"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  test("is disabled when the row has no usable pattern", () => {
    const el = renderSurfaceList(document, [{ ...STORED, pattern: null }]);
    const input = el.querySelector('[data-action="ambient"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  test("never renders ticked-but-disabled — a tick means the cue is happening", () => {
    // Reachable when page access is revoked from the browser's own extension
    // settings, which never passes through our revoke handler.
    const el = renderSurfaceList(document, [{ ...BUILT_IN, granted: false, ambient: true }]);
    const input = el.querySelector('[data-action="ambient"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.checked).toBe(false);
  });

  test("origin text is written as text, never parsed as markup", () => {
    const el = renderSurfaceList(document, [
      { ...STORED, origin: "https://corp.example/<img src=x onerror=alert(1)>" },
    ]);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
