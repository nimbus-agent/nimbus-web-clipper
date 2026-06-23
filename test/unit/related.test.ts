import { describe, expect, test } from "vitest";
import { buildRelatedQuery, isRelatedHit, RELATED_LIMIT } from "../../src/shared/related.ts";

describe("buildRelatedQuery", () => {
  test("includes only non-blank fields and the default limit", () => {
    expect(
      buildRelatedQuery({ title: "Hello", canonicalUrl: "https://ex.com/p", selection: "pick" }),
    ).toEqual({
      title: "Hello",
      canonicalUrl: "https://ex.com/p",
      selection: "pick",
      limit: RELATED_LIMIT,
    });
  });
  test("drops blank/whitespace fields (exactOptionalPropertyTypes — never undefined)", () => {
    const q = buildRelatedQuery({ title: "  ", canonicalUrl: "", selection: "  x " });
    expect(q).toEqual({ selection: "x", limit: RELATED_LIMIT });
    expect("title" in q).toBe(false);
    expect("canonicalUrl" in q).toBe(false);
  });
  test("empty context → just the limit", () => {
    expect(buildRelatedQuery({})).toEqual({ limit: RELATED_LIMIT });
  });
  test("honors an explicit limit override", () => {
    expect(buildRelatedQuery({ title: "T" }, 3)).toEqual({ title: "T", limit: 3 });
  });
});

describe("isRelatedHit", () => {
  const hit = { id: "1", title: "T", service: "gmail", snippet: "s", url: "https://ex.com" };
  test("accepts a well-formed hit (url string)", () => {
    expect(isRelatedHit(hit)).toBe(true);
  });
  test("accepts url === null", () => {
    expect(isRelatedHit({ ...hit, url: null })).toBe(true);
  });
  test("rejects a non-string/non-null url, missing fields, and non-objects", () => {
    expect(isRelatedHit({ ...hit, url: 123 })).toBe(false);
    expect(isRelatedHit({ id: "1", title: "T", service: "g", snippet: "s" })).toBe(false);
    expect(isRelatedHit(null)).toBe(false);
  });
});
