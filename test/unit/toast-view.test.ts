// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { renderToast } from "../../src/capture/toast-view.ts";

describe("renderToast", () => {
  test("renders the text and an aria live-region status role", () => {
    const el = renderToast(document, { variant: "success", text: "Clipped to Nimbus." });
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.querySelector(".nimbus-toast__text")?.textContent).toBe("Clipped to Nimbus.");
    expect(el.classList.contains("nimbus-toast--success")).toBe(true);
  });

  test("variant sets the class", () => {
    expect(renderToast(document, { variant: "offline", text: "x" }).className).toContain(
      "nimbus-toast--offline",
    );
    expect(renderToast(document, { variant: "error", text: "x" }).className).toContain(
      "nimbus-toast--error",
    );
  });

  test("text is inert — markup is not parsed as HTML (XSS backstop)", () => {
    const el = renderToast(document, { variant: "error", text: "<img src=x onerror=alert(1)>" });
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".nimbus-toast__text")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });
});
