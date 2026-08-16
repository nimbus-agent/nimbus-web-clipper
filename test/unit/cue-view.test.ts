// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { renderCue } from "../../src/panel/cue-view.ts";

const STATE = { label: "GitHub PR", ref: "acme/web #482" };

describe("renderCue", () => {
  test("names the surface and the item", () => {
    const el = renderCue(document, STATE);
    expect(el.textContent).toContain("GitHub PR");
    expect(el.textContent).toContain("acme/web #482");
  });

  test("offers exactly one open target and one dismiss target", () => {
    const el = renderCue(document, STATE);
    expect(el.querySelectorAll('[data-action="open"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-action="dismiss"]')).toHaveLength(1);
  });

  test("both controls are real buttons, so keyboard users reach them", () => {
    const el = renderCue(document, STATE);
    for (const node of el.querySelectorAll("[data-action]")) {
      expect(node).toBeInstanceOf(HTMLButtonElement);
      expect((node as HTMLButtonElement).type).toBe("button");
    }
  });

  test("announces politely without stealing focus", () => {
    const el = renderCue(document, STATE);
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.hasAttribute("autofocus")).toBe(false);
  });

  test("the dismiss control has an accessible name, not just a glyph", () => {
    const el = renderCue(document, STATE);
    const dismiss = el.querySelector('[data-action="dismiss"]') as HTMLButtonElement;
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss");
  });

  test("page-derived text is written as text, never parsed as markup", () => {
    const el = renderCue(document, {
      label: "GitHub PR",
      ref: "<img src=x onerror=alert(1)>",
    });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
