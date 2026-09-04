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

  test("never offers capture on a file page", () => {
    // Not incidental: `offersCapture` ends in `default: return false`, so this arm is
    // excluded by construction — and that exclusion is invisible at the call site.
    // Clipping a forge's rendered blob page gives Nimbus neither a checkout nor an
    // indexed repository, so the offer would be false.
    expect(offersCapture({ kind: "file", surface: "GitHub file" })).toBe(false);
    expect(offersCapture({ kind: "file", surface: "GitHub file", banner: "Nimbus has no…" })).toBe(
      false,
    );
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
    expect(
      offersCapture({
        kind: "resolved",
        surface: SURFACE,
        item: {
          id: "1",
          service: "github",
          type: "pr",
          title: "A PR",
          url: "https://github.com/a/b/pull/1",
          modifiedAt: 1_700_000_000_000,
        },
        matchKind: "exact",
        nowMs: 1_700_000_000_000,
      }),
    ).toBe(false);
    expect(
      offersCapture({
        kind: "service",
        surface: SURFACE,
        product: "github",
        connector: { state: "healthy" },
        nowMs: 1_700_000_000_000,
      }),
    ).toBe(false);
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
