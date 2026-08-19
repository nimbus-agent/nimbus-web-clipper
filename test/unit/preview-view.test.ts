// @vitest-environment jsdom
// test/unit/preview-view.test.ts
import { describe, expect, test } from "vitest";
import type { BriefPreview, ClipPreview, FetchPreview } from "../../src/shared/preview.ts";
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
    expect(rows).toHaveLength(2);
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

describe("renderPreview — brief", () => {
  const brief: BriefPreview = {
    fields: [
      { label: "Question", value: "What do these changes disagree about?" },
      { label: "Sources", value: "2 pages" },
    ],
    sources: [
      { label: "Fix the thing", value: "https://github.com/acme/web/pull/1" },
      { label: "Also fix the thing", value: "https://github.com/acme/web/pull/2" },
    ],
    bodies: [],
    synthesisNotice: "Local or remote, depending on configuration.",
  };

  test("renders EVERY source, not just the count", () => {
    // A brief carries no `excerpt`, so before this shape was recognised it fell
    // through the fetch branch and every source row was silently dropped.
    const frag = renderPreview(document, brief);
    expect(frag.textContent).toContain("https://github.com/acme/web/pull/1");
    expect(frag.textContent).toContain("https://github.com/acme/web/pull/2");
    expect(frag.querySelectorAll(".preview__sources .preview__row")).toHaveLength(2);
  });

  test("renders the synthesis notice", () => {
    const frag = renderPreview(document, brief);
    expect(frag.textContent).toContain("Local or remote, depending on configuration.");
  });

  test("renders no body section — a brief preview shows no excerpt", () => {
    const frag = renderPreview(document, brief);
    expect(frag.querySelector(".preview__body")).toBeNull();
  });

  test("a source title containing markup is text, not markup", () => {
    const frag = renderPreview(document, {
      ...brief,
      sources: [{ label: "<img src=x onerror=alert(1)>", value: "https://ex.com/a" }],
    });
    expect(frag.querySelector("img")).toBeNull();
    expect(frag.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("renderPreview with passage bodies", () => {
  test("renders each passage body under a disclosure, labelled by its source", () => {
    const frag = renderPreview(document, {
      fields: [{ label: "Question", value: "q" }],
      sources: [{ label: "E", value: "http://h/e — 2 passages" }],
      bodies: [{ label: "E", value: "first\n\n[...]\n\nsecond" }],
      synthesisNotice: "notice",
    });
    const host = document.createElement("div");
    host.append(frag);
    const details = host.querySelectorAll("details.preview__passages");
    expect(details).toHaveLength(1);
    expect(details[0]?.querySelector("summary")?.textContent).toBe("E");
    // textContent, never innerHTML: passage text is page content.
    expect(details[0]?.querySelector(".preview__body")?.textContent).toBe(
      "first\n\n[...]\n\nsecond",
    );
  });

  test("a brief with no passage bodies renders no disclosure at all", () => {
    const frag = renderPreview(document, {
      fields: [],
      sources: [{ label: "W", value: "http://h/w" }],
      bodies: [],
      synthesisNotice: "notice",
    });
    const host = document.createElement("div");
    host.append(frag);
    expect(host.querySelector("details")).toBeNull();
  });
});
