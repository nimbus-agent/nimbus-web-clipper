import { describe, expect, it } from "vitest";
import {
  BRIEF_CAPS,
  buildCreateBody,
  buildSourceBody,
  suggestQuestions,
  utf8Bytes,
} from "../../src/shared/brief.ts";
import type { Recognition } from "../../src/shared/types.ts";

function pr(ref: string): Recognition {
  return {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref,
    resolveUrl: `https://github.com/acme/web/pull/${ref}`,
  };
}
function issue(ref: string): Recognition {
  return {
    ok: true,
    product: "jira",
    kind: "issue",
    label: "Jira issue",
    ref,
    resolveUrl: `https://acme.atlassian.net/browse/${ref}`,
  };
}
const unknown: Recognition = { ok: false, reason: "unknown-host" };

describe("utf8Bytes", () => {
  it("counts bytes, not code units", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("😀")).toBe(4);
  });
});

describe("suggestQuestions", () => {
  it("offers change-shaped questions for two or more pull requests", () => {
    const qs = suggestQuestions([pr("1"), pr("2")]);
    expect(qs).toContain("What do these changes disagree about?");
    expect(qs).toContain("What breaks if all of these land?");
  });

  it("offers issue-shaped questions for two or more issues", () => {
    const qs = suggestQuestions([issue("A-1"), issue("A-2")]);
    expect(qs).toContain("What is the common thread?");
  });

  it("offers relational questions for a mixed recognised set", () => {
    const qs = suggestQuestions([pr("1"), issue("A-1")]);
    expect(qs).toContain("How do these relate?");
  });

  it("still offers questions when nothing is recognised", () => {
    const qs = suggestQuestions([unknown, unknown]);
    expect(qs).toContain("Where do these contradict each other?");
    expect(qs).toContain("What do these agree on?");
  });

  it("never returns an empty list", () => {
    expect(suggestQuestions([]).length).toBeGreaterThan(0);
  });

  it("returns no duplicates", () => {
    const qs = suggestQuestions([pr("1"), pr("2"), issue("A-1")]);
    expect(new Set(qs).size).toBe(qs.length);
  });
});

describe("buildSourceBody", () => {
  it("passes a small body through untruncated", () => {
    const out = buildSourceBody({
      url: "https://example.com/a",
      title: "A",
      body: "short",
      capturedAt: 1000,
    });
    expect(out.body).toBe("short");
    expect(out.truncated).toBe(false);
    expect(out.capturedAt).toBe(1000);
  });

  it("cuts an over-cap body and flags it", () => {
    const body = "y".repeat(BRIEF_CAPS.extractionCapBytes + 500);
    const out = buildSourceBody({ url: "u", title: "t", body, capturedAt: 1 });
    expect(out.truncated).toBe(true);
    expect(utf8Bytes(out.body)).toBeLessThanOrEqual(BRIEF_CAPS.extractionCapBytes);
  });

  it("cuts on BYTES, not characters, so multi-byte text cannot exceed the cap", () => {
    const body = "😀".repeat(BRIEF_CAPS.extractionCapBytes); // 4 bytes each
    const out = buildSourceBody({ url: "u", title: "t", body, capturedAt: 1 });
    expect(utf8Bytes(out.body)).toBeLessThanOrEqual(BRIEF_CAPS.extractionCapBytes);
  });

  it("never splits a multi-byte character in half", () => {
    const body = "😀".repeat(BRIEF_CAPS.extractionCapBytes);
    const out = buildSourceBody({ url: "u", title: "t", body, capturedAt: 1 });
    expect(out.body.includes("�")).toBe(false);
    expect([...out.body].every((c) => c === "😀")).toBe(true);
  });

  it("THE RUN BUDGET: 20 sources cut at the extraction cap fit inside MAX_RUN_BYTES", () => {
    // The reason the cut is 200 KB and not the gateway's 256 KB ceiling.
    // Cutting at MAX_SOURCE_BYTES would fit only 4194304/262144 = 16 sources.
    const url = "https://example.com/some/reasonably/long/path/to/a/pull/request/12345";
    const title = "A fairly long tab title of the sort a real pull request page has";
    const one = BRIEF_CAPS.extractionCapBytes + utf8Bytes(url) + utf8Bytes(title);
    expect(one * BRIEF_CAPS.maxSources).toBeLessThanOrEqual(BRIEF_CAPS.maxRunBytes);
  });
});

describe("buildCreateBody", () => {
  it("carries useIndex as given, both ways", () => {
    const sources = [{ url: "http://h/a", title: "A" }];
    expect(buildCreateBody("q", sources, false).useIndex).toBe(false);
    expect(buildCreateBody("q", sources, true).useIndex).toBe(true);
  });

  it("still declares every source and caps the question, whatever useIndex says", () => {
    const sources = [
      { url: "http://h/a", title: "A" },
      { url: "http://h/b", title: "B" },
    ];
    const body = buildCreateBody("x".repeat(5000), sources, true);
    expect(body.sources).toHaveLength(2);
    expect(body.brief.length).toBe(BRIEF_CAPS.maxQuestionChars);
  });

  it("cuts an over-long question to the gateway's character cap", () => {
    const body = buildCreateBody("q".repeat(BRIEF_CAPS.maxQuestionChars + 10), [], false);
    expect(body.brief.length).toBe(BRIEF_CAPS.maxQuestionChars);
  });

  it("never declares more sources than the gateway accepts", () => {
    const sources = Array.from({ length: BRIEF_CAPS.maxSources + 5 }, (_, i) => ({
      url: `https://example.com/${i}`,
      title: `T${i}`,
    }));
    expect(buildCreateBody("q", sources, false).sources).toHaveLength(BRIEF_CAPS.maxSources);
  });
});
