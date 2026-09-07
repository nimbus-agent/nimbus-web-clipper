/** @vitest-environment jsdom */
import { describe, expect, test } from "vitest";
import {
  findingLink,
  renderEmptyLine,
  renderGaps,
  renderProvenance,
} from "../../src/panel/findings/shared-view.ts";

describe("findingLink", () => {
  test("builds an anchor for an http url, opening safely", () => {
    const el = findingLink(document, "Title", "https://example.test/a");
    expect(el.tagName).toBe("A");
    expect((el as HTMLAnchorElement).href).toBe("https://example.test/a");
    expect(el.getAttribute("target")).toBe("_blank");
    expect(el.getAttribute("rel")).toBe("noopener noreferrer");
    expect(el.textContent).toBe("Title");
  });

  test("renders text, not a link, for a javascript: url", () => {
    const el = findingLink(document, "Title", "javascript:alert(1)");
    expect(el.tagName).toBe("SPAN");
    expect(el.querySelector("a")).toBeNull();
    // The claim is still shown - safeHttpUrl's own rule.
    expect(el.textContent).toBe("Title");
  });

  test("renders text for a null url", () => {
    expect(findingLink(document, "Title", null).tagName).toBe("SPAN");
  });

  test("renders text, not a link, for a data: url", () => {
    const el = findingLink(document, "Title", "data:text/plain,hello");
    expect(el.tagName).toBe("SPAN");
    expect(el.querySelector("a")).toBeNull();
    // safeHttpUrl's contract: a rejected URL is shown as text, never hidden.
    expect(el.textContent).toBe("Title");
  });

  test("renders text, not a link, for a relative url (findingLink passes no base)", () => {
    const el = findingLink(document, "Title", "/relative/path");
    expect(el.tagName).toBe("SPAN");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toBe("Title");
  });

  test("renders text, not a link, for an unparseable url string", () => {
    const el = findingLink(document, "Title", "not a url at all");
    expect(el.tagName).toBe("SPAN");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toBe("Title");
  });
});

describe("renderGaps", () => {
  test("renders each gap's detail and its remediation", () => {
    const el = renderGaps(document, [
      { category: "empty_index", detail: "Nothing indexed yet.", remediation: "Run nimbus sync." },
    ]);
    expect(el?.textContent).toContain("Nothing indexed yet.");
    expect(el?.textContent).toContain("Run nimbus sync.");
  });

  test("returns null for an empty list so nothing is painted", () => {
    expect(renderGaps(document, [])).toBeNull();
  });

  test("never parses gap text as markup", () => {
    const el = renderGaps(document, [{ category: "empty_index", detail: "<img src=x onerror=1>" }]);
    expect(el?.querySelector("img")).toBeNull();
    expect(el?.textContent).toContain("<img src=x onerror=1>");
  });
});

describe("renderProvenance", () => {
  test("names the model and says it stayed local", () => {
    const el = renderProvenance(document, {
      attempted: true,
      used: true,
      model: "llama3",
      remote: false,
    });
    expect(el.textContent).toContain("llama3");
    expect(el.textContent?.toLowerCase()).toContain("local");
  });

  test("says a remote model wrote it", () => {
    const el = renderProvenance(document, {
      attempted: true,
      used: true,
      model: "gpt",
      remote: true,
    });
    expect(el.textContent?.toLowerCase()).toContain("remote");
  });

  test("says no model wrote it when synthesis was not attempted", () => {
    const el = renderProvenance(document, { attempted: false, reason: "disabled" });
    expect(el.textContent?.toLowerCase()).toContain("no model");
  });

  test("says no model wrote it when the rewrite was discarded", () => {
    const el = renderProvenance(document, {
      attempted: true,
      used: false,
      reason: "contract_violation",
    });
    expect(el.textContent?.toLowerCase()).toContain("no model");
  });
});

describe("renderEmptyLine", () => {
  test("renders the given text as text", () => {
    expect(renderEmptyLine(document, "Nothing here.").textContent).toBe("Nothing here.");
  });
});
