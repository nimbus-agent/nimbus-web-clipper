import { describe, expect, test } from "vitest";
import { buildClipPayload, buildClipSource, parseTags } from "../../src/shared/clip.ts";
import type { CaptureResult, ClipSource } from "../../src/shared/types.ts";

describe("parseTags", () => {
  test("splits on commas, trims, drops empties, dedupes case-sensitively", () => {
    expect(parseTags("AI, machine learning ,AI, ")).toEqual(["AI", "machine learning"]);
  });
  test("keeps multi-word tags and preserves inner spaces", () => {
    expect(parseTags("vector index")).toEqual(["vector index"]);
  });
  test("case-sensitive: AI and ai are distinct", () => {
    expect(parseTags("AI, ai")).toEqual(["AI", "ai"]);
  });
  test("empty input → []", () => {
    expect(parseTags("   ")).toEqual([]);
  });
});

describe("buildClipPayload", () => {
  const cap: CaptureResult = {
    url: "https://ex.com/p",
    title: "Hello",
    mode: "article",
    body: "the body",
    readableFound: true,
  };
  test("maps capture + tags + capturedAt into the gateway request shape", () => {
    expect(buildClipPayload(cap, ["research"], 1750000000000)).toEqual({
      url: "https://ex.com/p",
      title: "Hello",
      mode: "article",
      body: "the body",
      tags: ["research"],
      capturedAt: 1750000000000,
    });
  });
  test("includes canonicalUrl only when present (exactOptionalPropertyTypes)", () => {
    const out = buildClipPayload({ ...cap, canonicalUrl: "https://ex.com/p?x" }, [], 1);
    expect(out.canonicalUrl).toBe("https://ex.com/p?x");
    expect("canonicalUrl" in buildClipPayload(cap, [], 1)).toBe(false);
  });

  test("threads a sanitised source onto the payload", () => {
    expect(buildClipPayload({ ...cap, source: { author: "Ada" } }, [], 1).source).toEqual({
      author: "Ada",
    });
  });

  test("a capture with no source produces a payload with no source key", () => {
    expect("source" in buildClipPayload(cap, [], 1)).toBe(false);
  });

  test("the page's object never reaches the payload", () => {
    const source = { author: "Ada", junk: "x" } as unknown as ClipSource;
    const out = buildClipPayload({ ...cap, source }, [], 1);
    expect(out.source).not.toBe(source);
    expect(out.source).toEqual({ author: "Ada" });
  });
});

describe("buildClipSource", () => {
  test("keeps the five known fields", () => {
    expect(
      buildClipSource({
        author: "Ada Lovelace",
        publishedAt: 1_710_149_400_000,
        siteName: "Example Journal",
        lang: "en-GB",
        leadImage: "https://cdn.example.net/hero.jpg",
      }),
    ).toEqual({
      author: "Ada Lovelace",
      publishedAt: 1_710_149_400_000,
      siteName: "Example Journal",
      lang: "en-GB",
      leadImage: "https://cdn.example.net/hero.jpg",
    });
  });

  // The whole point of this function: an extra key cannot ride along. A page
  // that put 60 KB under `source.junk` would otherwise push the item toward
  // the gateway's 64 KB metadata ceiling and make its own clip un-ingestable.
  test("drops any key that is not one of the five", () => {
    const built = buildClipSource({ author: "Ada", junk: "x".repeat(60_000) });
    expect(built).toEqual({ author: "Ada" });
    expect(Object.keys(built ?? {})).toEqual(["author"]);
  });

  test("returns a NEW object, never the caller's", () => {
    const raw = { author: "Ada" };
    expect(buildClipSource(raw)).not.toBe(raw);
  });

  test("truncates prose at 200 and drops over-long structured values", () => {
    const built = buildClipSource({
      author: "a".repeat(500),
      siteName: "s".repeat(500),
      lang: "x".repeat(21),
      leadImage: `https://example.com/${"p".repeat(2100)}`,
    });
    expect(built?.author).toHaveLength(200);
    expect(built?.siteName).toHaveLength(200);
    expect(built?.lang).toBeUndefined();
    expect(built?.leadImage).toBeUndefined();
  });

  test("drops wrong-typed members instead of failing the whole clip", () => {
    expect(buildClipSource({ author: 42, siteName: "Example Journal" })).toEqual({
      siteName: "Example Journal",
    });
  });

  test("drops a non-integer or out-of-range publishedAt", () => {
    expect(buildClipSource({ publishedAt: 1.5 })).toBeUndefined();
    expect(buildClipSource({ publishedAt: Number.NaN })).toBeUndefined();
    expect(buildClipSource({ publishedAt: 8_640_000_000_000_001 })).toBeUndefined();
  });

  // page-meta.ts scheme-checks what IT reads, but this function's input is
  // whatever __nimbusCapture returned — and a page can overwrite that global.
  // A length check alone would forward a javascript: URL into the index, which
  // the gateway stores unvalidated by design.
  test("drops a lead image that is not an http(s) URL, however short", () => {
    expect(buildClipSource({ leadImage: "javascript:alert(1)" })).toBeUndefined();
    expect(buildClipSource({ leadImage: "data:image/png;base64,AAAA" })).toBeUndefined();
    expect(buildClipSource({ leadImage: "/img/hero.jpg" })).toBeUndefined();
  });

  test("keeps an absolute http(s) lead image on any origin", () => {
    expect(buildClipSource({ leadImage: "https://images.unsplash.com/p.jpg" })).toEqual({
      leadImage: "https://images.unsplash.com/p.jpg",
    });
  });

  test("undefined, a non-object and an empty result all yield undefined", () => {
    expect(buildClipSource(undefined)).toBeUndefined();
    expect(buildClipSource("nope")).toBeUndefined();
    expect(buildClipSource(null)).toBeUndefined();
    expect(buildClipSource([])).toBeUndefined();
    expect(buildClipSource({})).toBeUndefined();
  });
});
