// test/unit/passage.test.ts
import { describe, expect, test } from "vitest";
import { BRIEF_CAPS } from "../../src/shared/brief.ts";
import {
  addPassage,
  groupCapturedAt,
  groupKey,
  groupPassages,
  isPassage,
  joinPassages,
  PASSAGE_CAPS,
  PASSAGE_SEPARATOR,
  type Passage,
  removeGroup,
  removePassage,
  stitch,
} from "../../src/shared/passage.ts";

function p(url: string, text: string, at = 1, title = "T"): Passage {
  return { url, title, text, at };
}

describe("groupKey", () => {
  test("strips the fragment and nothing else", () => {
    expect(groupKey("http://h/a?b=1#frag")).toBe("http://h/a?b=1");
    expect(groupKey("http://h/a?b=1")).toBe("http://h/a?b=1");
  });

  // The gateway drops utm_*/click-ids and the trailing slash itself
  // (recognise.ts). Doing it here too would be a second, drifting
  // implementation of its canonicalisation — see the spec's grouping section.
  test("preserves utm parameters, click ids and the trailing slash", () => {
    expect(groupKey("http://h/a?utm_source=x")).toBe("http://h/a?utm_source=x");
    expect(groupKey("http://h/a/")).toBe("http://h/a/");
  });

  test("leaves a string it cannot parse alone rather than throwing", () => {
    expect(groupKey("not a url")).toBe("not a url");
  });
});

describe("groupPassages", () => {
  test("two fragments of one page are one group; two query strings are two", () => {
    const groups = groupPassages([
      p("http://h/a#one", "first"),
      p("http://h/a#two", "second"),
      p("http://h/a?utm_source=x", "third"),
    ]);
    expect(groups.map((g) => g.url)).toEqual(["http://h/a", "http://h/a?utm_source=x"]);
    expect(groups[0]?.passages.map((x) => x.text)).toEqual(["first", "second"]);
  });

  test("keys keep first-seen order and the group takes the first title", () => {
    const groups = groupPassages([
      p("http://h/b", "b1", 1, "B title"),
      p("http://h/a", "a1", 2, "A title"),
      p("http://h/b", "b2", 3, "B renamed"),
    ]);
    expect(groups.map((g) => g.url)).toEqual(["http://h/b", "http://h/a"]);
    expect(groups[0]?.title).toBe("B title");
  });
});

describe("PASSAGE_SEPARATOR", () => {
  // Pinned by value, not because a formatter would rewrite a string literal —
  // none does — but because these bytes are visible in three places at once: the
  // body the gateway receives, the text the preview shows, and the e2e's literal
  // assertion. Changing it is allowed; changing it by accident is not, and this
  // is the test that names the contract when someone does.
  test("is exactly a bracketed ellipsis on its own line", () => {
    expect(PASSAGE_SEPARATOR).toBe("\n\n[...]\n\n");
  });
});

describe("stitch", () => {
  test("joins in collection order with the separator between passages", () => {
    const group = groupPassages([p("http://h/a", "one"), p("http://h/a", "two")])[0];
    expect(group).toBeDefined();
    expect(stitch(group as never)).toBe(`one${PASSAGE_SEPARATOR}two`);
  });

  test("a single passage carries no leading or trailing separator", () => {
    const group = groupPassages([p("http://h/a", "only")])[0];
    expect(stitch(group as never)).toBe("only");
  });

  // The body that is SENT and the body the preview SHOWS are the same string, and
  // this is what keeps them that way: `buildBriefPreview` calls `joinPassages`
  // too, and `addPassage` measures its cap against it. Were `stitch` to acquire a
  // join rule of its own, decision 7's honesty claim and decision 8's cap
  // arithmetic would both be quietly wrong.
  test("is exactly joinPassages over the group's texts", () => {
    const group = groupPassages([
      p("http://h/a", "one"),
      p("http://h/a", "two"),
      p("http://h/a", "three"),
    ])[0];
    expect(group).toBeDefined();
    expect(stitch(group as never)).toBe(
      joinPassages((group as never as { passages: Passage[] }).passages.map((x) => x.text)),
    );
  });
});

describe("groupCapturedAt", () => {
  // A stitched body is only as fresh as its OLDEST text. Reporting the newest
  // would overstate the freshness of everything above it.
  test("returns the oldest, even when passages arrived out of order", () => {
    const group = groupPassages([p("http://h/a", "late", 900), p("http://h/a", "early", 100)])[0];
    expect(groupCapturedAt(group as never)).toBe(100);
  });
});

describe("addPassage", () => {
  test("appends to the end of the collection", () => {
    const res = addPassage([p("http://h/a", "one")], p("http://h/a", "two", 2));
    expect(res.ok).toBe(true);
    expect(res.ok && res.all.map((x) => x.text)).toEqual(["one", "two"]);
  });

  test("refuses an exact duplicate of a passage already held for that page", () => {
    const res = addPassage([p("http://h/a", "same")], p("http://h/a#other", "same", 2));
    expect(res).toEqual({ ok: false, reason: "duplicate" });
  });

  test("the same text on a different page is not a duplicate", () => {
    const res = addPassage([p("http://h/a", "same")], p("http://h/b", "same", 2));
    expect(res.ok).toBe(true);
  });

  test("refuses when the page's stitched body would exceed the extraction cap", () => {
    const big = "x".repeat(BRIEF_CAPS.extractionCapBytes - 10);
    const res = addPassage([p("http://h/a", big)], p("http://h/a", "yyyyyyyyyyyyyyyy", 2));
    expect(res).toEqual({ ok: false, reason: "page-full" });
  });

  test("accepts a page's passages right up to the cap", () => {
    const body = "x".repeat(BRIEF_CAPS.extractionCapBytes - PASSAGE_SEPARATOR.length - 1);
    const res = addPassage([p("http://h/a", body)], p("http://h/a", "y", 2));
    expect(res.ok).toBe(true);
  });

  test("counts UTF-8 bytes, not code units", () => {
    // A 4-byte astral character must count as four. A length-based cap would
    // admit four times the ceiling.
    const astral = "\u{1F600}".repeat(BRIEF_CAPS.extractionCapBytes / 4);
    const res = addPassage([p("http://h/a", astral)], p("http://h/a", "y", 2));
    expect(res).toEqual({ ok: false, reason: "page-full" });
  });

  test("refuses a new page once the collection holds the cap", () => {
    const full = Array.from({ length: PASSAGE_CAPS.maxPages }, (_, i) =>
      p(`http://h/${i}`, "t", i),
    );
    expect(addPassage(full, p("http://h/new", "t", 99))).toEqual({
      ok: false,
      reason: "collection-full",
    });
  });

  test("a page already held still accepts passages when the collection is full", () => {
    const full = Array.from({ length: PASSAGE_CAPS.maxPages }, (_, i) =>
      p(`http://h/${i}`, "t", i),
    );
    expect(addPassage(full, p("http://h/0", "another", 99)).ok).toBe(true);
  });

  // `at` is the ONLY per-passage identity `removePassage`/`forgetPassages` match
  // on. Two collects on one page inside one millisecond would collide, and a
  // removal could then drop the wrong passage — including one that never left.
  test("a colliding `at` is bumped past the group's newest, and both survive", () => {
    const res = addPassage([p("http://h/a", "one", 5)], p("http://h/a", "two", 5));
    expect(res.ok && res.all.map((x) => [x.text, x.at])).toEqual([
      ["one", 5],
      ["two", 6],
    ]);
  });

  test("the bump clears the group's newest, not merely the passage it collided with", () => {
    const held = [p("http://h/a", "one", 5), p("http://h/a", "two", 9)];
    const res = addPassage(held, p("http://h/a", "three", 5));
    expect(res.ok && res.all[2]?.at).toBe(10);
  });

  test("a bumped passage is removable by its own `at`, and only it", () => {
    const res = addPassage([p("http://h/a", "one", 5)], p("http://h/a", "two", 5));
    const all = res.ok ? res.all : [];
    expect(removePassage(all, "http://h/a", 6).map((x) => x.text)).toEqual(["one"]);
    expect(removePassage(all, "http://h/a", 5).map((x) => x.text)).toEqual(["two"]);
  });

  test("the bump is per page — the same instant on another page is left alone", () => {
    const res = addPassage([p("http://h/a", "one", 5)], p("http://h/b", "two", 5));
    expect(res.ok && res.all.map((x) => x.at)).toEqual([5, 5]);
  });

  test("a bump cannot overstate freshness: the group's oldest is unchanged", () => {
    const res = addPassage([p("http://h/a", "one", 5)], p("http://h/a", "two", 5));
    const group = groupPassages(res.ok ? res.all : [])[0];
    expect(groupCapturedAt(group as never)).toBe(5);
  });

  test("a refusal never mutates the input", () => {
    const before = [p("http://h/a", "same")];
    addPassage(before, p("http://h/a", "same", 2));
    expect(before).toEqual([p("http://h/a", "same")]);
  });
});

describe("removePassage / removeGroup", () => {
  test("removePassage drops one and leaves its siblings in order", () => {
    const all = [p("http://h/a", "one", 1), p("http://h/a", "two", 2), p("http://h/a", "three", 3)];
    expect(removePassage(all, "http://h/a", 2).map((x) => x.text)).toEqual(["one", "three"]);
  });

  test("removing the last passage of a group leaves no empty group behind", () => {
    const all = [p("http://h/a", "only", 1), p("http://h/b", "other", 2)];
    const left = removePassage(all, "http://h/a", 1);
    expect(groupPassages(left).map((g) => g.url)).toEqual(["http://h/b"]);
  });

  test("removeGroup drops only its own page, fragment-insensitively", () => {
    const all = [p("http://h/a#x", "one", 1), p("http://h/b", "two", 2)];
    expect(removeGroup(all, "http://h/a").map((x) => x.text)).toEqual(["two"]);
  });
});

describe("isPassage", () => {
  test("accepts a well-formed stored passage", () => {
    expect(isPassage({ url: "http://h/a", title: "T", text: "x", at: 1 })).toBe(true);
  });

  test.each([
    ["null", null],
    ["a string", "x"],
    ["a missing url", { title: "T", text: "x", at: 1 }],
    ["a numeric title", { url: "u", title: 2, text: "x", at: 1 }],
    ["a missing text", { url: "u", title: "T", at: 1 }],
    ["a string at", { url: "u", title: "T", text: "x", at: "1" }],
    // A stored NaN reaches `capturedAt` through `groupCapturedAt`, and
    // `JSON.stringify(NaN)` is `null` — the gateway would be told the text has
    // no capture time. A fractional `at` fails differently and more quietly:
    // `isPassageDropRequest` accepts only an integer, so it could never be
    // removed from the composer.
    ["a NaN at", { url: "u", title: "T", text: "x", at: Number.NaN }],
    ["an infinite at", { url: "u", title: "T", text: "x", at: Number.POSITIVE_INFINITY }],
    ["a fractional at", { url: "u", title: "T", text: "x", at: 1.5 }],
  ])("rejects %s", (_label, value) => {
    expect(isPassage(value)).toBe(false);
  });
});
