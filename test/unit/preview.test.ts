// test/unit/preview.test.ts
import { describe, expect, it, test } from "vitest";
import type { ClipPayload } from "../../src/shared/clip.ts";
import { PASSAGE_SEPARATOR } from "../../src/shared/passage.ts";
import {
  buildBriefPreview,
  buildClipPreview,
  buildFetchPreview,
  EXCERPT_CHARS,
  SYNTHESIS_NOTICE,
} from "../../src/shared/preview.ts";
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
    expect(p.excerpt).toHaveLength(EXCERPT_CHARS);
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

describe("buildBriefPreview", () => {
  const input = {
    question: "What do these changes disagree about?",
    sources: [
      { url: "https://github.com/acme/web/pull/1", title: "Fix the thing" },
      { url: "https://github.com/acme/web/pull/2", title: "Also fix the thing" },
    ],
    useIndex: false,
  };

  test("names the question and the source count", () => {
    const p = buildBriefPreview(input);
    expect(p.fields).toEqual([
      { label: "Question", value: "What do these changes disagree about?" },
      { label: "Sources", value: "2 pages" },
    ]);
  });

  test("names EVERY source, so nothing leaves unnamed", () => {
    const p = buildBriefPreview(input);
    expect(p.sources).toHaveLength(2);
    expect(p.sources[0]).toEqual({
      label: "Fix the thing",
      value: "https://github.com/acme/web/pull/1",
    });
  });

  test("uses the singular for one source", () => {
    const only = input.sources[0];
    if (only === undefined) {
      throw new Error("fixture");
    }
    const p = buildBriefPreview({ question: "q", sources: [only], useIndex: false });
    expect(p.fields[1]).toEqual({ label: "Sources", value: "1 page" });
  });

  test("carries the synthesis notice and never claims the run stays local", () => {
    const p = buildBriefPreview(input);
    expect(p.synthesisNotice).toBe(SYNTHESIS_NOTICE);
    expect(p.synthesisNotice.toLowerCase()).not.toContain("stays on your machine");
    expect(p.synthesisNotice.toLowerCase()).toContain("local or a remote model");
  });
});

describe("buildBriefPreview with passage sources", () => {
  const question = "What do these disagree about?";

  test("the count names both kinds", () => {
    const preview = buildBriefPreview({
      question,
      sources: [
        { title: "Whole", url: "http://h/w" },
        { title: "Excerpts", url: "http://h/e", passages: ["one", "two"] },
      ],
      useIndex: false,
    });
    expect(preview.fields).toEqual([
      { label: "Question", value: question },
      { label: "Sources", value: "2 sources — 1 page, 1 set of passages" },
    ]);
  });

  test("all pages reads as pages alone, as it did before passages existed", () => {
    const preview = buildBriefPreview({
      question,
      sources: [
        { title: "A", url: "http://h/a" },
        { title: "B", url: "http://h/b" },
      ],
      useIndex: false,
    });
    expect(preview.fields[1]).toEqual({ label: "Sources", value: "2 pages" });
  });

  test("all passages reads as sets of passages alone", () => {
    const preview = buildBriefPreview({
      question,
      sources: [{ title: "A", url: "http://h/a", passages: ["one"] }],
      useIndex: false,
    });
    expect(preview.fields[1]).toEqual({ label: "Sources", value: "1 set of passages" });
  });

  test("a passages row says how many; a page row says the address alone", () => {
    const preview = buildBriefPreview({
      question,
      sources: [
        { title: "Whole", url: "http://h/w" },
        { title: "Excerpts", url: "http://h/e", passages: ["one", "two", "three"] },
      ],
      useIndex: false,
    });
    expect(preview.sources).toEqual([
      { label: "Whole", value: "http://h/w" },
      { label: "Excerpts", value: "http://h/e — 3 passages" },
    ]);
  });

  test("the text of each passage source is carried, in order", () => {
    const preview = buildBriefPreview({
      question,
      sources: [{ title: "E", url: "http://h/e", passages: ["first", "second"] }],
      useIndex: false,
    });
    expect(preview.bodies).toEqual([{ label: "E", value: `first${PASSAGE_SEPARATOR}second` }]);
  });

  test("a page source carries no body — its text does not exist yet", () => {
    const preview = buildBriefPreview({
      question,
      sources: [{ title: "W", url: "http://h/w" }],
      useIndex: false,
    });
    expect(preview.bodies).toEqual([]);
  });

  test("the synthesis notice is unchanged", () => {
    const preview = buildBriefPreview({
      question,
      sources: [{ title: "W", url: "http://h/w" }],
      useIndex: false,
    });
    expect(preview.synthesisNotice).toBe(SYNTHESIS_NOTICE);
  });
});

describe("buildBriefPreview with the index option", () => {
  const SOURCE = { title: "Whole", url: "http://h/w" };

  it("says nothing about the index when the index is not searched", () => {
    const p = buildBriefPreview({ question: "q", sources: [SOURCE], useIndex: false });
    expect(p.indexNotice).toBeUndefined();
  });

  it("states the bound, the un-nameability, and that the QUESTION is what is searched", () => {
    const p = buildBriefPreview({ question: "q", sources: [SOURCE], useIndex: true });
    const notice = p.indexNotice ?? "";
    // The bound is named: "a count is not consent" cuts both ways — when the
    // members cannot be listed, the number that CAN be stated must be.
    expect(notice).toContain("8");
    // The un-nameability is stated, not glossed.
    expect(notice.toLowerCase()).toContain("cannot be listed");
    // The one thing that may leave even though the clips do not.
    expect(notice.toLowerCase()).toContain("question");
  });

  it("never claims the indexed items stay local, because the client cannot know", () => {
    const p = buildBriefPreview({ question: "q", sources: [SOURCE], useIndex: true });
    expect((p.indexNotice ?? "").toLowerCase()).not.toContain("stays on your machine");
  });

  // The gateway's brief search no longer filters to `itemType: "web_clip"`
  // (Nimbus#1253), so the notice names the whole index. Its predecessor asserted
  // the opposite — that the notice said "saved clips" and NOT "has indexed" —
  // which is what kept the wider claim out of two public store listings while
  // the widening was still an unmerged branch. Same rule, other side of it now.
  it("names the corpus the shipped gateway actually searches", () => {
    const p = buildBriefPreview({ question: "q", sources: [SOURCE], useIndex: true });
    const notice = (p.indexNotice ?? "").toLowerCase();
    expect(notice).toContain("has indexed");
    expect(notice).not.toContain("saved clips");
  });
});

describe("buildClipPreview — an ignored canonical URL", () => {
  const { canonicalUrl: _none, ...noCanonical } = payload;

  test("names the reason right after the URL it fell back to", () => {
    const fields = buildClipPreview(noCanonical as ClipPayload, "cross-origin").fields;
    expect(fields.map((f) => f.label)).toEqual(["Title", "URL", "Note", "Mode", "Tags"]);
    expect(fields[2]?.value).toContain("another site's address");
  });

  test.each([
    ["cross-origin", "another site's address"],
    ["root-collapse", "homepage"],
    ["unparseable", "wasn't a usable URL"],
    ["bad-scheme", "wasn't a web address"],
    ["credentials", "username and password"],
    ["downgrade", "insecure version of its own address"],
  ] as const)("%s gets its own sentence", (reason, fragment) => {
    const fields = buildClipPreview(noCanonical as ClipPayload, reason).fields;
    const note = fields.find((f) => f.label === "Note");
    expect(note?.value).toContain(fragment);
  });

  test("every reason has a distinct sentence, and every sentence points at the URL row", () => {
    // The table is a Record over the union, so a MISSING reason is a compile
    // error. What the type cannot catch is two reasons sharing one sentence —
    // which would quietly tell a reader the wrong thing — or a sentence that
    // stops pointing at the row it says to look at.
    const reasons = [
      "cross-origin",
      "root-collapse",
      "unparseable",
      "bad-scheme",
      "credentials",
      "downgrade",
    ] as const;
    const sentences = reasons.map((r) => {
      const note = buildClipPreview(noCanonical as ClipPayload, r).fields.find(
        (f) => f.label === "Note",
      );
      return note?.value ?? "";
    });
    expect(new Set(sentences).size).toBe(reasons.length);
    for (const sentence of sentences) {
      expect(sentence).toContain("the address above");
    }
  });

  test("no rejection means no Note row", () => {
    expect(buildClipPreview(payload).fields.map((f) => f.label)).toEqual([
      "Title",
      "URL",
      "Canonical URL",
      "Mode",
      "Tags",
    ]);
  });
});

describe("buildClipPreview — the source metadata rows", () => {
  const source = {
    author: "Ada Lovelace",
    publishedAt: Date.parse("2024-03-11T09:30:00Z"),
    siteName: "Example Journal",
    lang: "en-GB",
    leadImage: "https://cdn.example.net/hero.jpg",
  };

  test("every source field the payload carries gets a row", () => {
    const preview = buildClipPreview({ ...payload, source });
    expect(preview.fields.map((f) => f.label)).toEqual([
      "Title",
      "URL",
      "Canonical URL",
      "Mode",
      "Tags",
      "Author",
      "Published",
      "Site",
      "Language",
      "Lead image",
    ]);
  });

  test("shows the real values, with the date as a plain calendar day", () => {
    const byLabel = new Map(
      buildClipPreview({ ...payload, source }).fields.map((f) => [f.label, f.value]),
    );
    expect(byLabel.get("Author")).toBe("Ada Lovelace");
    expect(byLabel.get("Published")).toBe("2024-03-11");
    expect(byLabel.get("Site")).toBe("Example Journal");
    expect(byLabel.get("Language")).toBe("en-GB");
    expect(byLabel.get("Lead image")).toBe("https://cdn.example.net/hero.jpg");
  });

  test("a field the page did not expose gets no row", () => {
    const labels = buildClipPreview({ ...payload, source: { author: "Ada Lovelace" } }).fields.map(
      (f) => f.label,
    );
    expect(labels).toContain("Author");
    expect(labels).not.toContain("Published");
    expect(labels).not.toContain("Lead image");
  });

  test("a payload with no source renders exactly the rows it always did", () => {
    expect(buildClipPreview(payload).fields.map((f) => f.label)).toEqual([
      "Title",
      "URL",
      "Canonical URL",
      "Mode",
      "Tags",
    ]);
  });

  // Every CANONICAL_NOTICE sentence ends "used the address above", which is
  // only true while the Note row sits directly beneath URL. The source rows
  // append at the END for exactly that reason — this is the fence.
  test("source rows never come between URL and the canonical note", () => {
    const { canonicalUrl: _omitted, ...rest } = payload;
    const labels = buildClipPreview({ ...rest, source } as ClipPayload, "cross-origin").fields.map(
      (f) => f.label,
    );
    expect(labels.indexOf("Note")).toBe(labels.indexOf("URL") + 1);
  });
});
