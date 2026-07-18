// @vitest-environment jsdom
// test/unit/capture-in-page.test.ts
import { beforeEach, describe, expect, test } from "vitest";
import "../../src/capture/capture-in-page.ts";
import type { CaptureResult } from "../../src/shared/types.ts";

type CaptureFn = (mode: string) => CaptureResult;

function getCapture(): CaptureFn {
  return (globalThis as unknown as { __nimbusCapture: CaptureFn }).__nimbusCapture;
}

// Long, multi-paragraph prose so Mozilla Readability's scoring heuristics
// recognize the container as the article and extract it.
const PARAGRAPH_A =
  "Nimbus is a local-first index that keeps every clipped page on the owner's own machine, " +
  "never syncing content to a remote server or third-party cloud. The web clipper is a thin " +
  "client: it only ever talks to a gateway bound to the loopback interface, and the bearer " +
  "token that authorizes each request is minted once during an explicit pairing ceremony.";
const PARAGRAPH_B =
  "Readability was chosen because it is a well-understood, widely deployed heuristic for " +
  "separating the substantive prose of an article from surrounding navigation, ads, and " +
  "boilerplate. Given a full document, it scores candidate containers by paragraph density " +
  "and link density, then reassembles the highest-scoring subtree into a clean article body.";
const PARAGRAPH_C =
  "When Readability cannot find enough qualifying text, the capture path falls back to a " +
  "short bookmark-style body built from the page's meta description, or from the URL itself " +
  "if no description is present. This keeps every capture usable even on pages that are " +
  "mostly interactive chrome, like dashboards, search results, or single-page applications.";
const PARAGRAPH_D =
  "Selection capture is a separate, simpler path: whatever text the user has highlighted on " +
  "the page is read directly from the window selection object and sent as-is, bypassing the " +
  "Readability parse entirely. This gives the user a precise, deliberate way to clip a single " +
  "quote or passage without pulling in the rest of the surrounding page.";

function setArticleDocument(): void {
  document.title = "Document Title";
  document.body.innerHTML = `
    <nav><a href="/one">One</a><a href="/two">Two</a></nav>
    <article>
      <h1>How Nimbus Captures Pages</h1>
      <p>${PARAGRAPH_A}</p>
      <p>${PARAGRAPH_B}</p>
      <p>${PARAGRAPH_C}</p>
      <p>${PARAGRAPH_D}</p>
    </article>
    <footer>Copyright</footer>
  `;
}

function setSparseDocument(): void {
  document.title = "Sparse Page";
  document.body.innerHTML = `<div id="app"><button>Load</button></div>`;
}

function addMetaDescription(content: string): void {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "description");
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
}

function addOgDescription(content: string): void {
  const meta = document.createElement("meta");
  meta.setAttribute("property", "og:description");
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
}

function addCanonicalLink(href: string): void {
  const link = document.createElement("link");
  link.setAttribute("rel", "canonical");
  link.setAttribute("href", href);
  document.head.appendChild(link);
}

function selectText(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.title = "";
  window.getSelection()?.removeAllRanges();
});

describe("__nimbusCapture registration", () => {
  test("importing the module exposes __nimbusCapture on globalThis", () => {
    expect(typeof getCapture()).toBe("function");
  });
});

describe("article mode", () => {
  test("extracts a readable article via Readability", () => {
    setArticleDocument();
    const result = getCapture()("article");

    expect(result.mode).toBe("article");
    expect(result.readableFound).toBe(true);
    expect(result.body.length).toBeGreaterThan(0);
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.body).toContain("local-first index");
    expect(result.url).toBe("http://localhost:3000/");
  });

  test("includes canonicalUrl when a <link rel=canonical> is present", () => {
    setArticleDocument();
    addCanonicalLink("https://example.com/canonical-article");
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBe("https://example.com/canonical-article");
  });

  test("omits canonicalUrl when no <link rel=canonical> is present", () => {
    setArticleDocument();
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBeUndefined();
    expect("canonicalUrl" in result).toBe(false);
  });

  test("an empty href canonical link is treated as absent", () => {
    setArticleDocument();
    addCanonicalLink("");
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBeUndefined();
  });

  test("does not fall back to the document title when Readability finds its own", () => {
    setArticleDocument();
    const result = getCapture()("article");

    // Readability should surface some non-empty title (its own heading extraction
    // or the <title> tag) rather than an empty string.
    expect(result.title).not.toBe("");
  });
});

describe("fallback (no readable article)", () => {
  test("falls back to the meta description when Readability finds nothing", () => {
    setSparseDocument();
    addMetaDescription("A short blurb about a sparse page.");
    const result = getCapture()("article");

    expect(result.mode).toBe("article");
    expect(result.readableFound).toBe(false);
    expect(result.body).toBe("A short blurb about a sparse page.");
    expect(result.title).toBe("Sparse Page");
  });

  test("falls back to the URL when there is no meta description either", () => {
    setSparseDocument();
    const result = getCapture()("article");

    expect(result.readableFound).toBe(false);
    expect(result.body).toBe("http://localhost:3000/");
  });

  test("an og:description-only meta tag is not honored — falls back to the URL", () => {
    setSparseDocument();
    addOgDescription("Open Graph description, not the standard meta description.");
    const result = getCapture()("article");

    expect(result.readableFound).toBe(false);
    expect(result.body).toBe("http://localhost:3000/");
  });

  test("a blank meta description is treated as absent", () => {
    setSparseDocument();
    addMetaDescription("   ");
    const result = getCapture()("article");

    expect(result.readableFound).toBe(false);
    expect(result.body).toBe("http://localhost:3000/");
  });

  test("canonicalUrl is still surfaced on a fallback capture", () => {
    setSparseDocument();
    addCanonicalLink("https://example.com/sparse");
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBe("https://example.com/sparse");
    expect(result.readableFound).toBe(false);
  });
});

describe("selection mode", () => {
  test("captures the highlighted text and marks readableFound true", () => {
    setArticleDocument();
    const heading = document.querySelector("h1");
    if (heading === null) {
      throw new Error("test setup: expected an h1 in the document");
    }
    selectText(heading);

    const result = getCapture()("selection");

    expect(result.mode).toBe("selection");
    expect(result.body).toBe("How Nimbus Captures Pages");
    expect(result.readableFound).toBe(true);
  });

  test("trims surrounding whitespace from the selected text", () => {
    document.body.innerHTML = `<p id="p">   padded text   </p>`;
    const p = document.getElementById("p");
    if (p === null) {
      throw new Error("test setup: expected #p in the document");
    }
    selectText(p);

    const result = getCapture()("selection");

    expect(result.body).toBe("padded text");
  });

  test("an empty selection yields an empty body and readableFound false", () => {
    setArticleDocument();
    window.getSelection()?.removeAllRanges();

    const result = getCapture()("selection");

    expect(result.mode).toBe("selection");
    expect(result.body).toBe("");
    expect(result.readableFound).toBe(false);
  });

  test("selection mode does not run Readability — body is exactly the selection", () => {
    setArticleDocument();
    const heading = document.querySelector("h1");
    if (heading === null) {
      throw new Error("test setup: expected an h1 in the document");
    }
    selectText(heading);

    const result = getCapture()("selection");

    expect(result.body).not.toContain("local-first index");
  });

  test("includes canonicalUrl in selection mode as well", () => {
    setArticleDocument();
    addCanonicalLink("https://example.com/selection-canonical");
    const heading = document.querySelector("h1");
    if (heading === null) {
      throw new Error("test setup: expected an h1 in the document");
    }
    selectText(heading);

    const result = getCapture()("selection");

    expect(result.canonicalUrl).toBe("https://example.com/selection-canonical");
  });
});
