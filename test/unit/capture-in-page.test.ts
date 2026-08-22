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
  addLink("canonical", href);
}

/** Same, but with the `rel` spelled explicitly — for the token-list and
 *  casing variants HTML allows and an exact-match selector would drop. */
function addLink(rel: string, href: string): void {
  const link = document.createElement("link");
  link.setAttribute("rel", rel);
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
  // Reset the page path back to the jsdom default root before every test — a
  // few canonical tests below push a non-root path to exercise root-collapse,
  // and without this every test that follows would silently inherit it.
  window.history.pushState({}, "", "/");
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

  test("a blank href does not shadow a valid declaration further down the head", () => {
    // The bug this guards: `[href]` is satisfied by href="", so taking
    // querySelector's first hit blindly threw away the real canonical below it
    // and the page was filed under the address bar instead.
    setArticleDocument();
    addLink("canonical", "");
    addCanonicalLink("http://localhost:3000/the-real-one");
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBe("http://localhost:3000/the-real-one");
  });

  test("a whitespace-only href is treated as blank, not as a relative URL", () => {
    setArticleDocument();
    addLink("canonical", "   ");
    addCanonicalLink("http://localhost:3000/the-real-one");
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBe("http://localhost:3000/the-real-one");
  });

  test('rel="alternate canonical" is a canonical declaration', () => {
    // `rel` is a space-separated token list; an exact-match selector ignores
    // a perfectly valid declaration that carries a second keyword.
    setArticleDocument();
    addLink("alternate canonical", "http://localhost:3000/tokenised");
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBe("http://localhost:3000/tokenised");
  });

  test("the rel keyword is matched case-insensitively, as HTML defines it", () => {
    // DOCUMENTS INTENT; does not guard the regression. jsdom matches `rel`
    // values case-insensitively on its own, so this passes with or without the
    // `i` flag in the selector. A real browser does NOT — CSS attribute values
    // are case-sensitive by default — so the guard that matters here is the
    // Chromium e2e, not this test. Kept because it states the contract.
    setArticleDocument();
    addLink("Canonical", "http://localhost:3000/upper");
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBe("http://localhost:3000/upper");
  });

  test("includes canonicalUrl when a <link rel=canonical> is present", () => {
    setArticleDocument();
    addCanonicalLink("http://localhost:3000/canonical-article");
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBe("http://localhost:3000/canonical-article");
  });

  test("a cross-origin canonical is rejected — canonicalUrl absent, canonicalRejected is cross-origin", () => {
    setArticleDocument();
    addCanonicalLink("https://elsewhere.example/stolen");
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBeUndefined();
    expect(result.canonicalRejected).toBe("cross-origin");
  });

  test("a relative canonical is absolutised against the page URL", () => {
    setArticleDocument();
    addCanonicalLink("/article/5");
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBe("http://localhost:3000/article/5");
    expect(result.canonicalRejected).toBeUndefined();
  });

  test("a root-collapse canonical is rejected when the page is not at the root", () => {
    window.history.pushState({}, "", "/article/5");
    setArticleDocument();
    addCanonicalLink("http://localhost:3000/");
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBeUndefined();
    expect(result.canonicalRejected).toBe("root-collapse");
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

  test("uses the Readability-extracted title for the article", () => {
    setArticleDocument();
    const result = getCapture()("article");

    // Readability picks the document's <title> for this fixture; pin the exact
    // extracted value rather than a bare non-empty check.
    expect(result.title).toBe("Document Title");
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
    addCanonicalLink("http://localhost:3000/sparse");
    const result = getCapture()("article");

    expect(result.canonicalUrl).toBe("http://localhost:3000/sparse");
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
    addCanonicalLink("http://localhost:3000/selection-canonical");
    const heading = document.querySelector("h1");
    if (heading === null) {
      throw new Error("test setup: expected an h1 in the document");
    }
    selectText(heading);

    const result = getCapture()("selection");

    expect(result.canonicalUrl).toBe("http://localhost:3000/selection-canonical");
  });
});

/** A `<meta>` carrying either spelling of the key — `name` for `author`,
 *  `property` for the OpenGraph and `article:*` tags. */
function addMeta(attr: "name" | "property", key: string, content: string): void {
  const meta = document.createElement("meta");
  meta.setAttribute(attr, key);
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
}

/** Readability reads JSON-LD internally, which is how the article path gets
 *  metadata a page never wrote into a `<meta>` tag. */
function addJsonLd(value: unknown): void {
  const script = document.createElement("script");
  script.setAttribute("type", "application/ld+json");
  script.textContent = JSON.stringify(value);
  document.head.appendChild(script);
}

describe("source metadata", () => {
  test("the article path prefers Readability's reading over the meta tag", () => {
    setArticleDocument();
    addMeta("name", "author", "Meta Tag Author");
    addJsonLd({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "How Nimbus Captures Pages",
      author: { "@type": "Person", name: "Ada Lovelace" },
    });

    expect(getCapture()("article").source?.author).toBe("Ada Lovelace");
  });

  test("the meta tag fills a gap Readability leaves", () => {
    setArticleDocument();
    addMeta("property", "og:site_name", "Example Journal");
    addMeta("property", "og:image", "/img/hero.jpg");

    const source = getCapture()("article").source;

    expect(source?.siteName).toBe("Example Journal");
    expect(source?.leadImage).toBe("http://localhost:3000/img/hero.jpg");
  });

  test("the selection path carries page metadata", () => {
    setArticleDocument();
    addMeta("name", "author", "Ada Lovelace");
    const heading = document.querySelector("h1");
    if (heading === null) {
      throw new Error("test setup: expected an h1 in the document");
    }
    selectText(heading);

    const result = getCapture()("selection");

    expect(result.mode).toBe("selection");
    expect(result.source?.author).toBe("Ada Lovelace");
  });

  test("the fallback path carries page metadata", () => {
    setSparseDocument();
    addMeta("name", "author", "Ada Lovelace");

    const result = getCapture()("article");

    expect(result.readableFound).toBe(false);
    expect(result.source?.author).toBe("Ada Lovelace");
  });

  // Pins the MEASURED behaviour of @mozilla/readability 0.6.0 rather than the
  // hoped-for one: on a page it cannot read, `parse()` returns null outright
  // and its JSON-LD reading goes with it. So the fallback path's metadata comes
  // from readPageMeta alone, and a reader who assumes JSON-LD is covered here
  // has this test to correct them. If an upgrade starts returning metadata for
  // unreadable pages, this failing is the signal to widen the claim — not a
  // regression.
  test("on a page Readability cannot read at all, JSON-LD is NOT picked up", () => {
    setSparseDocument();
    addJsonLd({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Sparse Page",
      author: { "@type": "Person", name: "Ada Lovelace" },
    });

    const result = getCapture()("article");

    expect(result.readableFound).toBe(false);
    expect(result.source?.author).toBeUndefined();
  });

  // Absent, not an empty object: `{}` on the wire is noise the gateway would
  // have to strip, and buildClipSource returns undefined for it anyway.
  test("a page exposing nothing carries no source at all", () => {
    setSparseDocument();
    document.documentElement.removeAttribute("lang");

    expect(getCapture()("article").source).toBeUndefined();
  });
});
