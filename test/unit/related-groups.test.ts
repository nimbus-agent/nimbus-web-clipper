import { describe, expect, test } from "vitest";
import { groupHits, humaniseType } from "../../src/panel/related-groups.ts";
import type { RelatedHit } from "../../src/shared/types.ts";

function hit(id: string, service: string): RelatedHit {
  return { id, title: id, service, snippet: "", url: null };
}

describe("groupHits", () => {
  test("no hits → no groups", () => {
    expect(groupHits([])).toEqual([]);
  });

  test("one service → one group, order preserved", () => {
    const hits = [hit("a", "github"), hit("b", "github")];
    expect(groupHits(hits)).toEqual([{ service: "github", hits }]);
  });

  test("groups follow the rank position of their FIRST hit, not size", () => {
    // jira appears once and early; github appears twice but later. Rank wins.
    const hits = [hit("j1", "jira"), hit("g1", "github"), hit("g2", "github")];
    expect(groupHits(hits).map((g) => g.service)).toEqual(["jira", "github"]);
  });

  test("interleaved services collapse without reordering within a group", () => {
    const hits = [hit("g1", "github"), hit("j1", "jira"), hit("g2", "github")];
    const groups = groupHits(hits);
    expect(groups.map((g) => g.service)).toEqual(["github", "jira"]);
    expect(groups[0]?.hits.map((h) => h.id)).toEqual(["g1", "g2"]);
  });
});

describe("humaniseType", () => {
  test("overrides win where the mechanical rule reads wrong", () => {
    expect(humaniseType("pr")).toBe("Pull request");
    expect(humaniseType("ci_run")).toBe("CI run");
    expect(humaniseType("api_endpoint")).toBe("API endpoint");
  });

  test("an unknown type is humanised, never flattened to a generic word", () => {
    expect(humaniseType("code_symbol")).toBe("Code symbol");
    expect(humaniseType("obsidian_note")).toBe("Obsidian note");
    expect(humaniseType("issue")).toBe("Issue");
  });

  test("absent or blank → no chip", () => {
    expect(humaniseType(undefined)).toBeNull();
    expect(humaniseType("")).toBeNull();
    expect(humaniseType("   ")).toBeNull();
  });
});
