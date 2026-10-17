// test/unit/panel-host.test.ts
import { describe, expect, test } from "vitest";
import { samePage } from "../../src/shared/panel-host.ts";

describe("samePage", () => {
  test("ignores the fragment on both sides", () => {
    expect(samePage("https://ex.com/a/b", "https://ex.com/a/b#heading")).toBe(true);
    expect(samePage("https://ex.com/a/b#x", "https://ex.com/a/b#diff-123")).toBe(true);
    expect(samePage("https://ex.com/a/b#x", "https://ex.com/a/b")).toBe(true);
  });

  test("a different path, query or origin is a different page", () => {
    expect(samePage("https://ex.com/a/b", "https://ex.com/a/c")).toBe(false);
    expect(samePage("https://ex.com/a?x=1", "https://ex.com/a?x=2")).toBe(false);
    expect(samePage("https://ex.com/a", "https://ex.org/a")).toBe(false);
  });

  test("an unparseable URL falls back to string equality", () => {
    expect(samePage("not a url", "not a url")).toBe(true);
    expect(samePage("not a url", "not a url#x")).toBe(false);
    expect(samePage("not a url", "https://ex.com/")).toBe(false);
  });
});
