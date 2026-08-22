import { describe, expect, it } from "vitest";
import { safeHttpUrl } from "../../src/shared/safe-url.ts";

describe("safeHttpUrl", () => {
  it("accepts http and https", () => {
    expect(safeHttpUrl("https://ex.com/a")).toBe("https://ex.com/a");
    expect(safeHttpUrl("http://127.0.0.1:7474/x")).toBe("http://127.0.0.1:7474/x");
  });

  it("rejects every executable scheme", () => {
    // The whole reason this function exists: any of these in an href runs on
    // click. Case and whitespace variants included because the URL parser
    // normalises them and a naive prefix check would not.
    for (const raw of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://ex.com/abc",
    ]) {
      expect(safeHttpUrl(raw)).toBeNull();
    }
  });

  it("rejects relative paths and malformed input", () => {
    expect(safeHttpUrl("/relative/path")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
  });
});

describe("safeHttpUrl with a base", () => {
  const PAGE = "https://example.com/blog/post";

  it("absolutises a root-relative href against the page", () => {
    expect(safeHttpUrl("/img/hero.jpg", PAGE)).toBe("https://example.com/img/hero.jpg");
  });

  it("absolutises a document-relative href against the page", () => {
    expect(safeHttpUrl("hero.jpg", PAGE)).toBe("https://example.com/blog/hero.jpg");
  });

  it("picks up the page scheme for a protocol-relative href", () => {
    expect(safeHttpUrl("//cdn.example.net/hero.jpg", PAGE)).toBe(
      "https://cdn.example.net/hero.jpg",
    );
  });

  // The rung-4 exemption, stated as a test so nobody "fixes" it later: a lead
  // image never enters externalIdFor and is never fetched by this client, so a
  // foreign origin is the common case, not an attack.
  it("keeps a CDN image on a foreign origin", () => {
    expect(safeHttpUrl("https://images.unsplash.com/photo-1.jpg", PAGE)).toBe(
      "https://images.unsplash.com/photo-1.jpg",
    );
  });

  it("still refuses a non-web scheme even with a base", () => {
    expect(safeHttpUrl("data:image/png;base64,AAAA", PAGE)).toBeNull();
    expect(safeHttpUrl("javascript:alert(1)", PAGE)).toBeNull();
  });

  it("leaves the no-base behaviour alone", () => {
    expect(safeHttpUrl("/img/hero.jpg")).toBeNull();
  });

  it("yields null rather than throwing when the base is unparseable", () => {
    expect(safeHttpUrl("/img/hero.jpg", "not a url")).toBeNull();
  });
});
