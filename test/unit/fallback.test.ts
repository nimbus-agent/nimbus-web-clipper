import { describe, expect, test } from "vitest";
import { fallbackBody } from "../../src/capture/fallback.ts";

describe("fallbackBody", () => {
  test("uses the description when present", () => {
    expect(fallbackBody({ description: "A summary", url: "https://ex.com" })).toBe("A summary");
  });
  test("falls back to the url when description is absent", () => {
    expect(fallbackBody({ url: "https://ex.com" })).toBe("https://ex.com");
  });
  test("treats a blank/whitespace description as absent", () => {
    expect(fallbackBody({ description: "   ", url: "https://ex.com" })).toBe("https://ex.com");
  });
});
