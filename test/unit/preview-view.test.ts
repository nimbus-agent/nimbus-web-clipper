// @vitest-environment jsdom
// test/unit/preview-view.test.ts
import { describe, expect, test } from "vitest";
import type { ClipPreview, FetchPreview } from "../../src/shared/preview.ts";
import { renderPreview } from "../../src/shared/preview-view.ts";

const clip: ClipPreview = {
  fields: [
    { label: "Title", value: "Designing local-first software" },
    { label: "URL", value: "https://ex.com/p" },
  ],
  excerpt: "Local-first software keeps your data on your own machine.",
  bodyLength: 57,
  truncated: false,
};

const fetchPreview: FetchPreview = {
  fields: [
    { label: "Service", value: "github" },
    { label: "Type", value: "pr" },
  ],
};

describe("renderPreview", () => {
  test("renders one row per field, label and value both present", () => {
    const frag = renderPreview(document, clip);
    const rows = frag.querySelectorAll(".preview__row");
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain("Title");
    expect(rows[0]?.textContent).toContain("Designing local-first software");
  });

  test("a clip preview shows the body excerpt", () => {
    expect(renderPreview(document, clip).textContent).toContain("keeps your data");
  });

  test("a fetch preview has no body section at all — there is no body to send", () => {
    const frag = renderPreview(document, fetchPreview);
    expect(frag.querySelector(".preview__body")).toBeNull();
  });

  test("a truncated body says so, and reports the FULL length", () => {
    const frag = renderPreview(document, {
      ...clip,
      excerpt: "x".repeat(300),
      bodyLength: 5000,
      truncated: true,
    });
    const text = frag.textContent ?? "";
    expect(text).toContain("5000");
    expect(text.toLowerCase()).toContain("showing the first");
  });

  test("values are rendered as TEXT, never as markup", () => {
    const frag = renderPreview(document, {
      ...clip,
      fields: [{ label: "Title", value: "<img src=x onerror=alert(1)>" }],
    });
    expect(frag.querySelector("img")).toBeNull();
    expect(frag.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("an excerpt containing markup is also text", () => {
    const frag = renderPreview(document, { ...clip, excerpt: "<script>alert(1)</script>" });
    expect(frag.querySelector("script")).toBeNull();
    expect(frag.textContent).toContain("<script>alert(1)</script>");
  });
});
