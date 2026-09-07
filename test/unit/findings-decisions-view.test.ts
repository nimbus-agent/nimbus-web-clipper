/** @vitest-environment jsdom */
import { describe, expect, test } from "vitest";
import { renderDecisionsFindings } from "../../src/panel/findings/decisions-view.ts";
import type { DecisionsFindings } from "../../src/shared/findings.ts";

const NOW = 1_800_000_000_000;

function evidence(over: Record<string, unknown> = {}) {
  return {
    kind: "pr" as const,
    entityId: "e1",
    itemId: "github:acme/web#7",
    label: "Adopt SQLite WAL",
    url: "https://example.test/pr/7",
    occurredAt: NOW - 86_400_000,
    ...over,
  };
}

function entry(over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    statement: "Use WAL mode for the index database.",
    rationale: "Concurrent readers during a sync pass.",
    alternatives: ["Rollback journal"],
    confidence: 0.9,
    decidedAt: NOW - 86_400_000,
    hasAdr: true,
    extractionSource: "snippet" as const,
    evidence: [evidence()],
    ...over,
  };
}

function findings(over: Partial<DecisionsFindings> = {}): DecisionsFindings {
  return { kind: "decisions", entries: [entry()], truncatedSources: 0, ...over };
}

describe("renderDecisionsFindings", () => {
  test("renders the statement, rationale and alternatives", () => {
    const el = renderDecisionsFindings(document, findings(), NOW);
    expect(el.textContent).toContain("Use WAL mode for the index database.");
    expect(el.textContent).toContain("Concurrent readers during a sync pass.");
    expect(el.textContent).toContain("Rollback journal");
  });

  test("links evidence that has a url", () => {
    const el = renderDecisionsFindings(document, findings(), NOW);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://example.test/pr/7");
  });

  test("renders evidence with a null url as text with no anchor", () => {
    const e = entry({ evidence: [evidence({ url: null })] });
    const el = renderDecisionsFindings(document, findings({ entries: [e] }), NOW);
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Adopt SQLite WAL");
  });

  test("renders a javascript: evidence url as text with no anchor", () => {
    const e = entry({ evidence: [evidence({ url: "javascript:alert(1)" })] });
    const el = renderDecisionsFindings(document, findings({ entries: [e] }), NOW);
    expect(el.querySelector("a")).toBeNull();
  });

  test("marks a decision that has an ADR", () => {
    const el = renderDecisionsFindings(document, findings(), NOW);
    expect(el.textContent?.toUpperCase()).toContain("ADR");
  });

  test("omits the ADR marker when there is none", () => {
    const el = renderDecisionsFindings(
      document,
      findings({ entries: [entry({ hasAdr: false })] }),
      NOW,
    );
    expect(el.textContent?.toUpperCase()).not.toContain("ADR");
  });

  test("omits the rationale line entirely when it is null", () => {
    const el = renderDecisionsFindings(
      document,
      findings({ entries: [entry({ rationale: null, alternatives: [] })] }),
      NOW,
    );
    expect(el.textContent).toContain("Use WAL mode for the index database.");
    expect(el.querySelectorAll(".nimbus-findings__item-detail")).toHaveLength(0);
  });

  test("renders the truncated-source caveat only when there is one", () => {
    const withCaveat = renderDecisionsFindings(document, findings({ truncatedSources: 3 }), NOW);
    expect(withCaveat.textContent?.toLowerCase()).toContain("truncated");
    const without = renderDecisionsFindings(document, findings({ truncatedSources: 0 }), NOW);
    expect(without.textContent?.toLowerCase()).not.toContain("truncated");
  });

  test("renders an empty line when there are no decisions", () => {
    const el = renderDecisionsFindings(document, findings({ entries: [] }), NOW);
    expect(el.querySelector(".nimbus-findings__empty")).not.toBeNull();
  });

  test("never parses a statement as markup", () => {
    const el = renderDecisionsFindings(
      document,
      findings({ entries: [entry({ statement: "<img src=x onerror=1>" })] }),
      NOW,
    );
    expect(el.querySelector("img")).toBeNull();
  });
});
