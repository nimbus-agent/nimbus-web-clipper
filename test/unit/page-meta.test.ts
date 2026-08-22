// @vitest-environment jsdom
// test/unit/page-meta.test.ts
import { beforeEach, describe, expect, test } from "vitest";
import { parsePublishedAt, readPageMeta } from "../../src/capture/page-meta.ts";

const PAGE = "https://example.com/blog/post";

/** Mirrors the two spellings real pages use: `name` for `author`, `property`
 *  for the OpenGraph and `article:*` tags. */
function addMeta(attr: "name" | "property", key: string, content: string): void {
  const meta = document.createElement("meta");
  meta.setAttribute(attr, key);
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("lang");
});

describe("readPageMeta", () => {
  test("reads all five fields when the page exposes them", () => {
    document.documentElement.setAttribute("lang", "en-GB");
    addMeta("name", "author", "Ada Lovelace");
    addMeta("property", "og:site_name", "Example Journal");
    addMeta("property", "article:published_time", "2024-03-11T09:30:00Z");
    addMeta("property", "og:image", "/img/hero.jpg");
    expect(readPageMeta(document, PAGE)).toEqual({
      author: "Ada Lovelace",
      siteName: "Example Journal",
      publishedAt: Date.parse("2024-03-11T09:30:00Z"),
      lang: "en-GB",
      leadImage: "https://example.com/img/hero.jpg",
    });
  });

  test("a page exposing nothing yields an empty object, not undefined", () => {
    expect(readPageMeta(document, PAGE)).toEqual({});
  });

  // OpenGraph says `property`; a large minority of real pages write `name`.
  // Accepting both costs one selector and is the difference between a byline
  // and no byline on those sites.
  test("accepts og tags spelled with name= as well as property=", () => {
    addMeta("name", "og:site_name", "Example Journal");
    expect(readPageMeta(document, PAGE).siteName).toBe("Example Journal");
  });

  // HTML matches attribute keywords ASCII-case-insensitively; CSS attribute
  // VALUES are case-sensitive without the `i` flag. canonical.ts learned this
  // the hard way — see CANONICAL_LINK_SELECTOR.
  test("matches tag names case-insensitively", () => {
    addMeta("property", "OG:Image", "https://cdn.example.net/a.jpg");
    expect(readPageMeta(document, PAGE).leadImage).toBe("https://cdn.example.net/a.jpg");
  });

  test("blank and whitespace-only content is omitted, not sent as an empty string", () => {
    addMeta("name", "author", "");
    addMeta("property", "og:site_name", "   ");
    expect(readPageMeta(document, PAGE)).toEqual({});
  });

  test("values are trimmed", () => {
    addMeta("name", "author", "  Ada Lovelace  ");
    expect(readPageMeta(document, PAGE).author).toBe("Ada Lovelace");
  });

  test("a data: lead image is dropped", () => {
    addMeta("property", "og:image", "data:image/png;base64,AAAA");
    expect(readPageMeta(document, PAGE).leadImage).toBeUndefined();
  });

  test("a CDN lead image on a foreign origin is kept", () => {
    addMeta("property", "og:image", "https://images.unsplash.com/p.jpg");
    expect(readPageMeta(document, PAGE).leadImage).toBe("https://images.unsplash.com/p.jpg");
  });

  test("an unparseable published time is omitted rather than sent as NaN", () => {
    addMeta("property", "article:published_time", "last Tuesday");
    expect(readPageMeta(document, PAGE).publishedAt).toBeUndefined();
  });

  test("a blank lang attribute is omitted", () => {
    document.documentElement.setAttribute("lang", "   ");
    expect(readPageMeta(document, PAGE).lang).toBeUndefined();
  });
});

describe("parsePublishedAt", () => {
  test("an ISO 8601 instant becomes epoch ms", () => {
    expect(parsePublishedAt("2024-03-11T09:30:00Z")).toBe(Date.parse("2024-03-11T09:30:00Z"));
  });

  test("a bare date is accepted", () => {
    expect(parsePublishedAt("2024-03-11")).toBe(Date.parse("2024-03-11"));
  });

  test("undefined, empty and unparseable all yield undefined", () => {
    expect(parsePublishedAt(undefined)).toBeUndefined();
    expect(parsePublishedAt("   ")).toBeUndefined();
    expect(parsePublishedAt("last Tuesday")).toBeUndefined();
    expect(parsePublishedAt("+275760-09-14T00:00:00Z")).toBeUndefined();
  });

  // Date.parse returns NaN for a bare Unix timestamp, so without the digit
  // branch these sites lose their date entirely.
  test("a bare Unix timestamp in seconds is read", () => {
    expect(parsePublishedAt("1710149400")).toBe(1_710_149_400_000);
  });

  test("a bare Unix timestamp already in milliseconds is read as-is", () => {
    expect(parsePublishedAt("1710149400000")).toBe(1_710_149_400_000);
  });

  // THE FENCE. `Date.parse("2024")` is valid ISO 8601 for 2024-01-01, so a
  // digit branch without a length floor would seize it and report 1970. This
  // test is why the regex is `\d{10,}` and not `\d+`.
  test("a bare year stays a year and does not become an epoch", () => {
    expect(parsePublishedAt("2024")).toBe(Date.parse("2024-01-01T00:00:00Z"));
  });

  test("a short digit string that is not a date at all is refused", () => {
    expect(parsePublishedAt("20240311")).toBeUndefined();
  });

  test("an epoch beyond Date's range is refused", () => {
    expect(parsePublishedAt("99999999999999999")).toBeUndefined();
  });
});
