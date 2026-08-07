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
};
const jenkins: SurfaceRow = {
  origin: "https://corp.example/jenkins",
  product: "jenkins",
  granted: true,
};

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
      { origin: "https://x/<img src=x onerror=alert(1)>", product: "jira", granted: false },
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
