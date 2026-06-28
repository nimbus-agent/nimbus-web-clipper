import { describe, expect, test } from "vitest";
import { formatPairedSince } from "../../src/options/connection-view.ts";

describe("formatPairedSince", () => {
  test("formats an epoch ms to an en-US/UTC date string", () => {
    // 2026-06-27T12:00:00Z
    expect(formatPairedSince(Date.UTC(2026, 5, 27, 12, 0, 0))).toBe("Jun 27, 2026");
  });
  test("uses UTC so it does not drift a day near midnight", () => {
    // 2026-01-01T00:30:00Z stays Jan 1 under UTC
    expect(formatPairedSince(Date.UTC(2026, 0, 1, 0, 30, 0))).toBe("Jan 1, 2026");
  });
});
