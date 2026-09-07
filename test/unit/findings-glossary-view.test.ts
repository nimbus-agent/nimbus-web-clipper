/** @vitest-environment jsdom */
import { describe, expect, test } from "vitest";
import { renderGlossaryFindings } from "../../src/panel/findings/glossary-view.ts";
import type { GlossaryFindings } from "../../src/shared/findings.ts";

const NOW = 1_800_000_000_000;

function entry(over: Record<string, unknown> = {}) {
  return {
    term: "peek",
    definition: "A read that does not consume.",
    definitionSource: "snippet" as const,
    docFreq: 6,
    score: 0.82,
    serviceSpread: 2,
    firstSeenAt: NOW - 10_000,
    lastSeenAt: NOW - 5_000,
    topSources: [
      {
        itemId: "github:acme/web#1",
        title: "Auth rewrite",
        url: "https://example.test/pr/1",
        service: "github",
        modifiedAt: NOW - 5_000,
      },
    ],
    synonyms: [],
    nearMisses: [],
    ...over,
  };
}

function findings(over: Partial<GlossaryFindings> = {}): GlossaryFindings {
  return {
    kind: "glossary",
    mode: "term",
    entries: [entry()],
    matchedVia: "exact",
    suggestions: [],
    ...over,
  };
}

describe("renderGlossaryFindings", () => {
  test("renders the term, its definition, and a linked source", () => {
    const el = renderGlossaryFindings(document, findings(), NOW);
    expect(el.textContent).toContain("peek");
    expect(el.textContent).toContain("A read that does not consume.");
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://example.test/pr/1");
  });

  test("renders a source whose url is null as text with no anchor", () => {
    const e = entry({ topSources: [{ ...entry().topSources[0], url: null }] });
    const el = renderGlossaryFindings(document, findings({ entries: [e] }), NOW);
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Auth rewrite");
  });

  test("renders a javascript: source url as text with no anchor", () => {
    const e = entry({ topSources: [{ ...entry().topSources[0], url: "javascript:alert(1)" }] });
    const el = renderGlossaryFindings(document, findings({ entries: [e] }), NOW);
    expect(el.querySelector("a")).toBeNull();
  });

  test("says the term has no definition rather than rendering an empty line", () => {
    const el = renderGlossaryFindings(
      document,
      findings({ entries: [entry({ definition: null, definitionSource: null })] }),
      NOW,
    );
    expect(el.textContent?.toLowerCase()).toContain("no definition");
  });

  test("a miss renders its suggestions as did-you-mean and no entries", () => {
    const el = renderGlossaryFindings(
      document,
      findings({ mode: "miss", entries: [], matchedVia: null, suggestions: ["peak", "peck"] }),
      NOW,
    );
    expect(el.textContent?.toLowerCase()).toContain("did you mean");
    expect(el.textContent).toContain("peak");
    expect(el.textContent).toContain("peck");
  });

  test("a miss with no suggestions says the term is unknown", () => {
    const el = renderGlossaryFindings(
      document,
      findings({ mode: "miss", entries: [], matchedVia: null, suggestions: [] }),
      NOW,
    );
    expect(el.querySelector(".nimbus-findings__empty")).not.toBeNull();
  });

  test("renders the score, so the visible number matches the visible order", () => {
    // Upstream's own note: showing only docFreq while sorting on score made the
    // number contradict the order.
    const el = renderGlossaryFindings(document, findings({ mode: "list" }), NOW);
    expect(el.textContent).toContain("0.82");
  });

  test("renders synonyms and near misses when present", () => {
    const el = renderGlossaryFindings(
      document,
      findings({ entries: [entry({ synonyms: ["peeking"], nearMisses: ["peak"] })] }),
      NOW,
    );
    expect(el.textContent).toContain("peeking");
    expect(el.textContent).toContain("peak");
  });

  test("never parses a term or definition as markup", () => {
    const el = renderGlossaryFindings(
      document,
      findings({ entries: [entry({ term: "<img src=x onerror=1>", definition: "<b>x</b>" })] }),
      NOW,
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
  });

  test("renders an empty line when a list mode returns nothing", () => {
    const el = renderGlossaryFindings(document, findings({ mode: "list", entries: [] }), NOW);
    expect(el.querySelector(".nimbus-findings__empty")).not.toBeNull();
  });
});
