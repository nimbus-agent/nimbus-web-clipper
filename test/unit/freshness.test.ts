import { describe, expect, it } from "vitest";
import { formatAge } from "../../src/shared/freshness.ts";

describe("formatAge", () => {
  const now = 1_700_000_000_000;
  const s = 1000;
  const m = 60 * s;
  const h = 60 * m;
  const d = 24 * h;

  it("formats each bucket", () => {
    expect(formatAge(now, now)).toBe("just now");
    expect(formatAge(now - 30 * s, now)).toBe("just now");
    expect(formatAge(now - 1 * m, now)).toBe("1 min ago");
    expect(formatAge(now - 45 * m, now)).toBe("45 min ago");
    expect(formatAge(now - 1 * h, now)).toBe("1 hour ago");
    expect(formatAge(now - 5 * h, now)).toBe("5 hours ago");
    expect(formatAge(now - 1 * d, now)).toBe("1 day ago");
    expect(formatAge(now - 30 * d, now)).toBe("30 days ago");
  });

  it("does not claim the future when a clock skews", () => {
    expect(formatAge(now + 60 * m, now)).toBe("just now");
  });
});
