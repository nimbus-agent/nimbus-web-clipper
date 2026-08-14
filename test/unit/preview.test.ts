// test/unit/preview.test.ts
import { describe, expect, test } from "vitest";
import type { ClipPayload } from "../../src/shared/clip.ts";
import { buildClipPreview, buildFetchPreview, EXCERPT_CHARS } from "../../src/shared/preview.ts";
import type { FetchTarget } from "../../src/shared/types.ts";

const payload: ClipPayload = {
  url: "https://ex.com/p?utm_source=x",
  canonicalUrl: "https://ex.com/p",
  title: "Designing local-first software",
  mode: "article",
  body: "Local-first software keeps your data on your own machine.",
  tags: ["research", "work"],
  capturedAt: 1_700_000_000_000,
};

describe("buildClipPreview", () => {
  test("names every field that actually leaves", () => {
    const labels = buildClipPreview(payload).fields.map((f) => f.label);
    expect(labels).toEqual(["Title", "URL", "Canonical URL", "Mode", "Tags"]);
  });

  test("shows the real values, not placeholders", () => {
    const byLabel = new Map(buildClipPreview(payload).fields.map((f) => [f.label, f.value]));
    expect(byLabel.get("Title")).toBe("Designing local-first software");
    expect(byLabel.get("URL")).toBe("https://ex.com/p?utm_source=x");
    expect(byLabel.get("Canonical URL")).toBe("https://ex.com/p");
    expect(byLabel.get("Mode")).toBe("article");
    expect(byLabel.get("Tags")).toBe("research, work");
  });

  test("a payload with no canonical URL omits that row rather than showing a blank", () => {
    const { canonicalUrl: _omitted, ...rest } = payload;
    const labels = buildClipPreview(rest as ClipPayload).fields.map((f) => f.label);
    expect(labels).not.toContain("Canonical URL");
  });

  test("no tags reads as words, never an empty cell", () => {
    const byLabel = new Map(
      buildClipPreview({ ...payload, tags: [] }).fields.map((f) => [f.label, f.value]),
    );
    expect(byLabel.get("Tags")).toBe("none");
  });

  test("a short body is shown whole and is not marked truncated", () => {
    const p = buildClipPreview(payload);
    expect(p.excerpt).toBe(payload.body);
    expect(p.truncated).toBe(false);
    expect(p.bodyLength).toBe(payload.body.length);
  });

  test("a long body is excerpted, and reports its TRUE length", () => {
    const body = "x".repeat(EXCERPT_CHARS + 500);
    const p = buildClipPreview({ ...payload, body });
    expect(p.excerpt.length).toBe(EXCERPT_CHARS);
    expect(p.truncated).toBe(true);
    // The whole point: the user is told what actually gets sent, which is the
    // FULL body — the excerpt is a display convenience, not the payload.
    expect(p.bodyLength).toBe(EXCERPT_CHARS + 500);
  });

  test("THE TOKEN NEVER APPEARS. A stray secret on the input object is not rendered.", () => {
    const contaminated = { ...payload, token: "secret-bearer-token" } as ClipPayload;
    const serialised = JSON.stringify(buildClipPreview(contaminated));
    expect(serialised).not.toContain("secret-bearer-token");
    expect(serialised.toLowerCase()).not.toContain("token");
  });
});

describe("buildFetchPreview", () => {
  const target: FetchTarget = {
    product: "github",
    surface: "pr",
    url: "https://github.com/acme/web/pull/482",
  };

  test("names what the gateway is being asked to go and get", () => {
    expect(buildFetchPreview(target).fields).toEqual([
      { label: "Service", value: "github" },
      { label: "Type", value: "pr" },
      { label: "Address", value: "https://github.com/acme/web/pull/482" },
    ]);
  });

  test("every surface kind produces a readable type, never a raw blank", () => {
    for (const surface of ["pr", "build", "issue", "home"] as const) {
      const value = buildFetchPreview({ ...target, surface }).fields[1]?.value;
      expect(value).toBeTruthy();
    }
  });
});
