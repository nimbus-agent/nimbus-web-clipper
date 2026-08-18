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
