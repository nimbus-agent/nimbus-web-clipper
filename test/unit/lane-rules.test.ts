// test/unit/lane-rules.test.ts
import { describe, expect, it } from "vitest";
import {
  AGENT_LANES,
  LANE_RULES,
  laneBelongsOnSurface,
  type SurfaceKind,
} from "../../src/shared/types.ts";

const ALL_KINDS: readonly SurfaceKind[] = ["pr", "build", "issue", "home"];

describe("LANE_RULES", () => {
  it("covers every lane", () => {
    expect(Object.keys(LANE_RULES).sort()).toEqual([...AGENT_LANES].sort());
  });

  // A page lane with no surfaces could never render — it would be dead config
  // that typechecks. A lane naming a kind the recogniser cannot produce is the
  // same defect pointing the other way.
  it("gives every page lane at least one real surface kind", () => {
    for (const lane of AGENT_LANES) {
      const rule = LANE_RULES[lane];
      if (rule.input !== "page") {
        continue;
      }
      expect(rule.surfaces.length, lane).toBeGreaterThan(0);
      for (const kind of rule.surfaces) {
        expect(ALL_KINDS).toContain(kind);
      }
    }
  });

  // The C2.1 lanes ask about a change under review. `agents.impact` takes a
  // `fileOrPrUrl` and `expert` asks who should review it — neither question means
  // anything about a Jenkins build or a Jira issue.
  it("puts the shipped lanes on pull requests only", () => {
    expect(LANE_RULES.impact).toEqual({ input: "page", surfaces: ["pr"] });
    expect(LANE_RULES.expert).toEqual({ input: "page", surfaces: ["pr"] });
  });

  it("offers no page lane on a build or an issue", () => {
    for (const kind of ["build", "issue"] as const) {
      expect(AGENT_LANES.filter((lane) => laneBelongsOnSurface(lane, kind))).toEqual([]);
    }
  });

  it("offers why on a pull request and nowhere else", () => {
    for (const kind of ALL_KINDS) {
      expect(laneBelongsOnSurface("why", kind)).toBe(kind === "pr");
    }
  });

  it("gates why exactly as the other two review lanes are gated", () => {
    // Not a tautology: it pins that a future edit widening `why`'s surfaces has to
    // widen impact's and expert's too, or explain why the three diverged.
    expect(LANE_RULES.why).toEqual(LANE_RULES.impact);
    expect(LANE_RULES.why).toEqual(LANE_RULES.expert);
  });
});

describe("service lanes", () => {
  it("puts the service-scoped lanes on home and nowhere else", () => {
    for (const lane of ["catchup", "decisions", "ownership"] as const) {
      expect(LANE_RULES[lane], lane).toEqual({ input: "page", surfaces: ["home"] });
    }
  });

  it("keeps the item-scoped lanes off home", () => {
    for (const lane of ["impact", "expert"] as const) {
      expect(laneBelongsOnSurface(lane, "home"), lane).toBe(false);
    }
  });

  it("gives every surface kind at least one lane", () => {
    const covered = new Set(
      Object.values(LANE_RULES).flatMap((rule) => (rule.input === "page" ? rule.surfaces : [])),
    );
    // `build` and `issue` deliberately have no agent lane yet — assert the two
    // that DO, so this test fails loudly if a future edit empties them.
    expect(covered.has("pr")).toBe(true);
    expect(covered.has("home")).toBe(true);
  });
});

describe("the glossary rule", () => {
  it("takes a term and declares no surface", () => {
    expect(LANE_RULES.glossary).toEqual({ input: "term" });
  });

  // The decision this table exists to record: glossary is not pinned to the
  // surfaces that happen to exist today, because its input is not the page.
  // `laneBelongsOnSurface` must answer false everywhere for it — a caller that
  // renders lanes by surface alone must not pick it up by accident, on any page.
  it("never answers the surface question", () => {
    for (const kind of ALL_KINDS) {
      expect(laneBelongsOnSurface("glossary", kind), kind).toBe(false);
    }
  });

  it("leads the render order — it is the lane the user summoned by name", () => {
    expect(AGENT_LANES[0]).toBe("glossary");
  });

  it("is the only term lane", () => {
    const termLanes = AGENT_LANES.filter((lane) => LANE_RULES[lane].input === "term");
    expect(termLanes).toEqual(["glossary"]);
  });
});
