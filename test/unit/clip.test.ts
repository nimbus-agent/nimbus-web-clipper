import { describe, expect, test } from "vitest";
import { buildClipPayload, parseTags } from "../../src/shared/clip.ts";
import type { CaptureResult } from "../../src/shared/types.ts";

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
});
