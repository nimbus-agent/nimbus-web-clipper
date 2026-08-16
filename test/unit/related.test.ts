import { describe, expect, test } from "vitest";
import {
  buildRelatedQuery,
  isRelatedHit,
  parseRelatedHit,
  RELATED_LIMIT,
} from "../../src/shared/related.ts";

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

describe("parseRelatedHit", () => {
  const base = { id: "gh:1", title: "T", service: "github", snippet: "s", url: null };

  test("accepts the old five-field shape and leaves the new fields absent", () => {
    const hit = parseRelatedHit(base);
    expect(hit).not.toBeNull();
    expect("type" in (hit ?? {})).toBe(false);
    expect("modifiedAt" in (hit ?? {})).toBe(false);
  });

  test("renames modified_at to modifiedAt and keeps type", () => {
    expect(parseRelatedHit({ ...base, type: "pr", modified_at: 1_700_000_000_000 })).toEqual({
      ...base,
      type: "pr",
      modifiedAt: 1_700_000_000_000,
    });
  });

  test("a non-numeric modified_at is dropped, not carried through", () => {
    const hit = parseRelatedHit({ ...base, modified_at: "yesterday" });
    expect(hit).not.toBeNull();
    expect("modifiedAt" in (hit ?? {})).toBe(false);
  });

  test("a non-string type is dropped", () => {
    const hit = parseRelatedHit({ ...base, type: 7 });
    expect(hit).not.toBeNull();
    expect("type" in (hit ?? {})).toBe(false);
  });

  test("a null snippet is rejected outright — the gateway must coalesce", () => {
    expect(parseRelatedHit({ ...base, snippet: null })).toBeNull();
  });

  test("a missing required field is rejected", () => {
    expect(parseRelatedHit({ id: "x", title: "T", service: "github" })).toBeNull();
  });
});
