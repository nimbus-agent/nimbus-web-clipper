import { describe, expect, test } from "vitest";
import { isCapturedCopy, offersCapture } from "../../src/shared/capture-offer.ts";

const SURFACE = "GitHub pull request";

describe("offersCapture", () => {
  test("unrecognised offers capture — the internal-wiki case", () => {
    expect(offersCapture({ kind: "unrecognised" })).toBe(true);
  });

  test("a fetchable miss does NOT offer capture — fetch is the better answer", () => {
    expect(
      offersCapture({
        kind: "not-indexed",
        surface: SURFACE,
        product: "github",
        fetchable: true,
      }),
    ).toBe(false);
  });

  test("an unfetchable miss offers capture", () => {
    expect(
      offersCapture({
        kind: "not-indexed",
        surface: SURFACE,
        product: "github",
        fetchable: false,
      }),
    ).toBe(true);
  });

  test("every terminal fetch-blocked reason offers capture", () => {
    for (const reason of ["unfetchable", "not-configured", "needs-fetch-scope"] as const) {
      expect(
        offersCapture({
          kind: "fetch-blocked",
          surface: SURFACE,
          product: "github",
          reason,
          scopeGap: null,
        }),
      ).toBe(true);
    }
  });

  test("needs-scope does NOT offer capture — re-pairing fixes it", () => {
    expect(offersCapture({ kind: "needs-scope", surface: SURFACE, scopeGap: null })).toBe(false);
  });

  test("fetch-retry does NOT offer capture — waiting fixes it", () => {
    expect(offersCapture({ kind: "fetch-retry", surface: SURFACE, reason: "rate-limited" })).toBe(
      false,
    );
  });

  test("loading, resolved, service and error never offer capture", () => {
    expect(offersCapture({ kind: "loading" })).toBe(false);
    expect(offersCapture({ kind: "error", surface: null, message: "x" })).toBe(false);
  });
});

describe("isCapturedCopy", () => {
  test("a gateway-ingested clip is a captured copy", () => {
    expect(isCapturedCopy({ service: "nimbus", type: "web_clip" })).toBe(true);
  });

  test("connector items are not", () => {
    expect(isCapturedCopy({ service: "github", type: "pr" })).toBe(false);
  });

  test("service alone is not enough", () => {
    expect(isCapturedCopy({ service: "nimbus", type: "note" })).toBe(false);
  });

  test("type alone is not enough", () => {
    expect(isCapturedCopy({ service: "obsidian", type: "web_clip" })).toBe(false);
  });
});
