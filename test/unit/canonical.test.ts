// test/unit/canonical.test.ts
import { describe, expect, test } from "vitest";
import { resolveCanonical } from "../../src/shared/canonical.ts";

const PAGE = "https://example.com/blog/post-5";

describe("resolveCanonical — nothing to judge", () => {
  test.each([undefined, "", "   "])("%o declares nothing", (declared) => {
    expect(resolveCanonical(declared, PAGE)).toEqual({ kind: "none" });
  });
});

describe("resolveCanonical — nothing to judge, precisely", () => {
  test('href="" is "nothing declared", not "the page itself"', () => {
    // Worth its own named test because the naive reading is wrong:
    // `new URL("", pageUrl)` resolves to the PAGE URL. Without the early
    // return, `<link rel="canonical" href="">` would be forwarded as an
    // explicit self-canonical rather than as an absent one.
    expect(resolveCanonical("", PAGE)).toEqual({ kind: "none" });
  });
});

describe("resolveCanonical — absolutising", () => {
  test("a relative href resolves against the page, instead of being sent raw", () => {
    // The whole point: the gateway hashes what we send. `/article/5` sent raw is
    // hashed literally, so two sites declaring the same path collide onto one item.
    expect(resolveCanonical("/article/5", PAGE)).toEqual({
      kind: "resolved",
      url: "https://example.com/article/5",
    });
  });

  test("a protocol-relative href picks up the page's scheme", () => {
    expect(resolveCanonical("//example.com/a", PAGE)).toEqual({
      kind: "resolved",
      url: "https://example.com/a",
    });
  });

  test("an absolute same-origin href is kept", () => {
    expect(resolveCanonical("https://example.com/canon", PAGE)).toEqual({
      kind: "resolved",
      url: "https://example.com/canon",
    });
  });
});

describe("resolveCanonical — same-site rules", () => {
  test("a different host is rejected", () => {
    expect(resolveCanonical("https://evil.test/steal", PAGE)).toEqual({
      kind: "rejected",
      reason: "cross-origin",
      declared: "https://evil.test/steal",
    });
  });

  test("an https page downgrading to http is rejected", () => {
    expect(resolveCanonical("http://example.com/blog/post-5", PAGE)).toEqual({
      kind: "rejected",
      reason: "cross-origin",
      declared: "http://example.com/blog/post-5",
    });
  });

  test("an http page upgrading to https is ACCEPTED", () => {
    // The asymmetry in rung 4. A strict origin comparison gets this wrong, and
    // rejecting it gives one page two identities depending on how you arrived.
    expect(resolveCanonical("https://example.com/a", "http://example.com/a")).toEqual({
      kind: "resolved",
      url: "https://example.com/a",
    });
  });

  test("a different port is rejected", () => {
    expect(resolveCanonical("https://example.com:8443/a", PAGE).kind).toBe("rejected");
  });

  test("an explicitly-written default port is the same site as none", () => {
    // The port rule leans on `URL` normalising :443 away, so both sides compare
    // as "". This test is what notices if that ever stops being true — without
    // it, a plausible-looking "fix" to the port comparison could start
    // rejecting every site that spells its default port out.
    expect(resolveCanonical("https://example.com:443/a", PAGE)).toEqual({
      kind: "resolved",
      url: "https://example.com/a",
    });
  });

  test("bare host and www host are the same site, in both directions", () => {
    expect(resolveCanonical("https://www.example.com/a", PAGE)).toEqual({
      kind: "resolved",
      url: "https://www.example.com/a",
    });
    expect(resolveCanonical("https://example.com/a", "https://www.example.com/a")).toEqual({
      kind: "resolved",
      url: "https://example.com/a",
    });
  });

  test("the www strip is not a general subdomain relaxation", () => {
    expect(resolveCanonical("https://www.example.com/a", "https://blog.example.com/a").kind).toBe(
      "rejected",
    );
  });

  test("www is stripped as a whole label only", () => {
    expect(resolveCanonical("https://wwwexample.com/a", PAGE).kind).toBe("rejected");
  });

  test("a pathological www.com does not decay to com", () => {
    expect(resolveCanonical("https://com/a", "https://www.com/a").kind).toBe("rejected");
  });
});

describe("resolveCanonical — schemes and junk", () => {
  test.each(["javascript:alert(1)", "data:text/html,x", "mailto:a@b.test"])(
    "%s is rejected as a non-web scheme",
    (declared) => {
      expect(resolveCanonical(declared, PAGE)).toEqual({
        kind: "rejected",
        reason: "bad-scheme",
        declared,
      });
    },
  );

  test("an unparseable href is rejected rather than forwarded", () => {
    expect(resolveCanonical("http://[not a url", PAGE)).toEqual({
      kind: "rejected",
      reason: "unparseable",
      declared: "http://[not a url",
    });
  });
});

describe("resolveCanonical — the root-collapse guard", () => {
  test("a site-wide canonical to the homepage is rejected on an article", () => {
    // Without this, every clip from the site upserts the SAME row and each
    // capture clobbers the last.
    expect(resolveCanonical("https://example.com/", PAGE)).toEqual({
      kind: "rejected",
      reason: "root-collapse",
      declared: "https://example.com/",
    });
  });

  test("a root canonical ON the root page is correct and kept", () => {
    expect(resolveCanonical("https://example.com/", "https://example.com/")).toEqual({
      kind: "resolved",
      url: "https://example.com/",
    });
  });
});

describe("resolveCanonical does NOT canonicalise", () => {
  // These two prove a negative. Canonicalisation is the gateway's job
  // (src/shared/recognise.ts:253) and its rules are load-bearing, because
  // externalIdFor hashes canonicalizeUrl's output. If either of these starts
  // failing, someone has taught this module to normalise — that is the bug.
  test("a fragment and tracking params survive untouched", () => {
    const declared = "https://example.com/p?utm_source=x&id=7#section";
    expect(resolveCanonical(declared, PAGE)).toEqual({ kind: "resolved", url: declared });
  });

  test("a trailing slash on a non-root path survives untouched", () => {
    const declared = "https://example.com/p/";
    expect(resolveCanonical(declared, PAGE)).toEqual({ kind: "resolved", url: declared });
  });
});
