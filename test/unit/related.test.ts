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

describe("buildRelatedQuery with itemId", () => {
  test("an itemId is sent, and title is STILL sent beside it", () => {
    const q = buildRelatedQuery({ title: "Page title", itemId: "gh:1" });
    expect(q.itemId).toBe("gh:1");
    // Load-bearing: a gateway that does not know itemId falls back to title. If
    // title were dropped, that gateway would receive an empty query and the lane
    // would go permanently blank.
    expect(q.title).toBe("Page title");
  });

  test("canonicalUrl is withheld once an itemId is present", () => {
    const q = buildRelatedQuery({
      title: "T",
      canonicalUrl: "https://github.com/acme/web/pull/482",
      itemId: "gh:1",
    });
    expect("canonicalUrl" in q).toBe(false);
  });

  test("without an itemId, canonicalUrl is sent exactly as before", () => {
    const q = buildRelatedQuery({ title: "T", canonicalUrl: "https://ex.com/p" });
    expect(q.canonicalUrl).toBe("https://ex.com/p");
    expect("itemId" in q).toBe(false);
  });

  test("a blank itemId is treated as absent", () => {
    const q = buildRelatedQuery({ title: "T", canonicalUrl: "https://ex.com/p", itemId: "  " });
    expect("itemId" in q).toBe(false);
    expect(q.canonicalUrl).toBe("https://ex.com/p");
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
