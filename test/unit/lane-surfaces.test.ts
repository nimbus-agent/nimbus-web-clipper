// test/unit/lane-surfaces.test.ts
import { describe, expect, it } from "vitest";
import { AGENT_LANES, LANE_SURFACES, type SurfaceKind } from "../../src/shared/types.ts";

const ALL_KINDS: readonly SurfaceKind[] = ["pr", "build", "issue", "home"];

describe("LANE_SURFACES", () => {
  it("covers every lane", () => {
    expect(Object.keys(LANE_SURFACES).sort()).toEqual([...AGENT_LANES].sort());
  });

  // A lane with no surfaces could never render — it would be dead config that
  // typechecks. A lane naming a kind the recogniser cannot produce is the same
  // defect pointing the other way.
  it("gives every lane at least one real surface kind", () => {
    for (const lane of AGENT_LANES) {
      expect(LANE_SURFACES[lane].length).toBeGreaterThan(0);
      for (const kind of LANE_SURFACES[lane]) {
        expect(ALL_KINDS).toContain(kind);
      }
    }
  });

  // The C2.1 lanes ask about a change under review. `agents.impact` takes a
  // `fileOrPrUrl` and `expert` asks who should review it — neither question means
  // anything about a Jenkins build or a Jira issue.
  it("puts the shipped lanes on pull requests only", () => {
    expect(LANE_SURFACES.impact).toEqual(["pr"]);
    expect(LANE_SURFACES.expert).toEqual(["pr"]);
  });

  it("offers no lane on a build or an issue", () => {
    for (const kind of ["build", "issue"] as const) {
      expect(AGENT_LANES.filter((lane) => LANE_SURFACES[lane].includes(kind))).toEqual([]);
    }
  });
});

describe("service lanes", () => {
  it("puts the service-scoped lanes on home and nowhere else", () => {
    for (const lane of ["catchup", "decisions", "ownership"] as const) {
      expect(LANE_SURFACES[lane], lane).toEqual(["home"]);
    }
  });

  it("keeps the item-scoped lanes off home", () => {
    for (const lane of ["impact", "expert"] as const) {
      expect(LANE_SURFACES[lane].includes("home"), lane).toBe(false);
    }
  });

  it("gives every surface kind at least one lane", () => {
    const covered = new Set(Object.values(LANE_SURFACES).flat());
    // `build` and `issue` deliberately have no agent lane yet — assert the two
    // that DO, so this test fails loudly if a future edit empties them.
    expect(covered.has("pr")).toBe(true);
    expect(covered.has("home")).toBe(true);
  });
});
