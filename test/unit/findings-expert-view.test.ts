/** @vitest-environment jsdom */
import { describe, expect, test } from "vitest";
import { renderExpertFindings } from "../../src/panel/findings/expert-view.ts";
import type { ExpertFindings } from "../../src/shared/findings.ts";

const NOW = 1_800_000_000_000;

function evidence(over: Record<string, unknown> = {}) {
  return {
    itemId: "github:acme/web#7",
    type: "pr_authored" as const,
    serviceId: "github",
    title: "Adopt SQLite WAL",
    modifiedAt: NOW - 86_400_000,
    weight: 0.6,
    ...over,
  };
}

function rankedEntry(over: Record<string, unknown> = {}) {
  return {
    personId: "person:1",
    displayName: "Ada Lovelace",
    evidence: [evidence()],
    score: 0.91,
    confidence: "high" as const,
    ...over,
  };
}

function findings(over: Partial<ExpertFindings> = {}): ExpertFindings {
  return { kind: "expert", ranked: [rankedEntry()], ...over };
}

describe("renderExpertFindings", () => {
  test("renders one group per ranked person, with displayName as the subject", () => {
    const el = renderExpertFindings(document, findings(), NOW);
    const groups = el.querySelectorAll(".nimbus-findings__group");
    expect(groups).toHaveLength(1);
    expect(el.textContent).toContain("Ada Lovelace");
  });

  test("renders confidence as a badge", () => {
    const el = renderExpertFindings(document, findings(), NOW);
    const badge = el.querySelector(".nimbus-findings__badge");
    expect(badge?.textContent).toBe("high");
  });

  test("renders score as a badge alongside confidence - the ranking's own reasoning", () => {
    const el = renderExpertFindings(
      document,
      findings({ ranked: [rankedEntry({ score: 0.91 })] }),
      NOW,
    );
    const badges = [...el.querySelectorAll(".nimbus-findings__subject .nimbus-findings__badge")];
    const texts = badges.map((b) => b.textContent);
    expect(texts).toContain("score 0.91");
  });

  test("renders an evidence title as a span, never an anchor", () => {
    const el = renderExpertFindings(document, findings(), NOW);
    expect(el.querySelector("a")).toBeNull();
    const item = el.querySelector(".nimbus-findings__item");
    expect(item?.querySelector("span")?.textContent).toContain("Adopt SQLite WAL");
  });

  test("renders evidence type as a badge and the age of modifiedAt", () => {
    const el = renderExpertFindings(document, findings(), NOW);
    const item = el.querySelector(".nimbus-findings__item");
    expect(item?.textContent).toContain("pr_authored");
    expect(item?.querySelector(".nimbus-findings__item-when")?.textContent).toContain("day");
  });

  test("renders multiple groups, one per ranked person", () => {
    const el = renderExpertFindings(
      document,
      findings({
        ranked: [
          rankedEntry({ personId: "person:1", displayName: "Ada Lovelace" }),
          rankedEntry({ personId: "person:2", displayName: "Grace Hopper" }),
        ],
      }),
      NOW,
    );
    expect(el.querySelectorAll(".nimbus-findings__group")).toHaveLength(2);
  });

  test("renders the empty-state line when ranked is empty, never a blank box", () => {
    const el = renderExpertFindings(document, findings({ ranked: [] }), NOW);
    const empty = el.querySelector(".nimbus-findings__empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe("No one in the index has worked on this.");
  });

  // Task 4: the link wrap. `findingLink` is the only way a URL becomes an
  // `<a>` — these four pin the map lookup, the no-map fallback, a missing id,
  // and that `safeHttpUrl` is genuinely in the path rather than assumed.
  test("with a map, an evidence title is a link carrying the mapped href", () => {
    const el = renderExpertFindings(document, findings(), NOW, {
      "github:acme/web#7": "https://github.com/acme/web/pull/7",
    });
    const link = el.querySelector<HTMLAnchorElement>(".nimbus-findings__item a");
    expect(link).not.toBeNull();
    expect(link?.href).toBe("https://github.com/acme/web/pull/7");
    expect(link?.textContent).toBe("Adopt SQLite WAL");
  });

  test("with no map, the same fixture renders a span and no anchor", () => {
    const el = renderExpertFindings(document, findings(), NOW);
    expect(el.querySelector("a")).toBeNull();
    const item = el.querySelector(".nimbus-findings__item");
    expect(item?.querySelector("span")?.textContent).toBe("Adopt SQLite WAL");
  });

  test("an evidence id missing from the map renders a span, not a link", () => {
    const el = renderExpertFindings(document, findings(), NOW, {
      "some:other-item": "https://example.test/other",
    });
    expect(el.querySelector("a")).toBeNull();
    const item = el.querySelector(".nimbus-findings__item");
    expect(item?.querySelector("span")?.textContent).toBe("Adopt SQLite WAL");
  });

  test("a mapped value that is not a safe http URL renders a span — safeHttpUrl is genuinely in the path", () => {
    const el = renderExpertFindings(document, findings(), NOW, {
      "github:acme/web#7": "javascript:alert(1)",
    });
    expect(el.querySelector("a")).toBeNull();
    const item = el.querySelector(".nimbus-findings__item");
    expect(item?.querySelector("span")?.textContent).toBe("Adopt SQLite WAL");
  });

  test("never parses a displayName or evidence title as markup", () => {
    const el = renderExpertFindings(
      document,
      findings({
        ranked: [
          rankedEntry({
            displayName: "<img src=x onerror=1>",
            evidence: [evidence({ title: "<img src=y onerror=2>" })],
          }),
        ],
      }),
      NOW,
    );
    expect(el.querySelector("img")).toBeNull();
  });
});
