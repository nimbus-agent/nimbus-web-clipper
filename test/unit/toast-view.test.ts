// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { renderToast, setToastText } from "../../src/capture/toast-view.ts";

describe("renderToast", () => {
  test("builds an EMPTY aria live region (the text is set after mounting)", () => {
    const el = renderToast(document, "success");
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.querySelector(".nimbus-toast__text")?.textContent).toBe("");
    expect(el.classList.contains("nimbus-toast--success")).toBe(true);
  });

  test("variant sets the class", () => {
    expect(renderToast(document, "offline").className).toContain("nimbus-toast--offline");
    expect(renderToast(document, "error").className).toContain("nimbus-toast--error");
  });
});

describe("setToastText", () => {
  test("fills in the message", () => {
    const el = renderToast(document, "success");
    setToastText(el, "Saved to Nimbus.");
    expect(el.querySelector(".nimbus-toast__text")?.textContent).toBe("Saved to Nimbus.");
  });

  test("text is inert — markup is not parsed as HTML (XSS backstop)", () => {
    const el = renderToast(document, "error");
    setToastText(el, "<img src=x onerror=alert(1)>");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".nimbus-toast__text")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });

  test("a shell without a text slot is left alone (no throw)", () => {
    const bare = document.createElement("div");
    expect(() => setToastText(bare, "x")).not.toThrow();
  });
});
