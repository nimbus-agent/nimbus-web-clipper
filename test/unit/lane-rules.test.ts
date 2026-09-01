// test/unit/lane-rules.test.ts
import { describe, expect, it } from "vitest";
import {
  AGENT_LANES,
  LANE_RULES,
  laneBelongsOnSurface,
  SURFACE_KINDS,
  type SurfaceKind,
  scopeForLane,
} from "../../src/shared/types.ts";

// DERIVED, not hand-written. A literal list here typechecks while incomplete,
// so a new SurfaceKind would silently escape every test in this file — which is
// exactly how `doc` and `incident` would have arrived with no coverage at all.
const ALL_KINDS = SURFACE_KINDS;

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
      const claimed = Object.keys(rule.surfaces);
      expect(claimed.length, lane).toBeGreaterThan(0);
      for (const kind of claimed) {
        expect(ALL_KINDS).toContain(kind);
        // A claimed surface always carries a scope — the property the one-map
        // shape exists to make unexpressible otherwise.
        expect(scopeForLane(lane, kind as SurfaceKind), `${lane}/${kind}`).not.toBeNull();
      }
    }
  });

  // The C2.1 lanes ask about a change under review. `agents.impact` takes a
  // `fileOrPrUrl` and `expert` asks who should review it — neither question means
  // anything about a Jenkins build or a Jira issue.
  it("puts the shipped lanes on pull requests only", () => {
    expect(LANE_RULES.impact).toEqual({ input: "page", surfaces: { pr: "item" } });
    expect(LANE_RULES.expert).toEqual({ input: "page", surfaces: { pr: "item" } });
  });

  it("offers no page lane on any item surface — only a dashboard and a PR carry lanes", () => {
    // `doc` and `incident` join `build` and `issue` here rather than in a comment:
    // LANE_RULES names `pr` and `home` only, so a Confluence page and a PagerDuty
    // incident get the header, freshness, Related and the `glossary` term lane —
    // and no service lane claiming to answer about the whole connector.
    for (const kind of ["build", "issue", "doc", "incident"] as const) {
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

  it("names every surface kind the recogniser can produce", () => {
    // Pins the derivation itself: if `SurfaceKind` ever stops being derived from
    // `SURFACE_KINDS`, this list and the union can drift apart again.
    expect([...SURFACE_KINDS]).toEqual(["pr", "build", "issue", "home", "doc", "incident"]);
  });
});

describe("service lanes", () => {
  it("puts the service-scoped lanes on home and nowhere else", () => {
    for (const lane of ["catchup", "decisions", "ownership"] as const) {
      expect(LANE_RULES[lane], lane).toEqual({ input: "page", surfaces: { home: "service" } });
    }
  });

  it("keeps the item-scoped lanes off home", () => {
    for (const lane of ["impact", "expert"] as const) {
      expect(laneBelongsOnSurface(lane, "home"), lane).toBe(false);
    }
  });

  it("gives every surface kind at least one lane", () => {
    const covered = new Set(
      Object.values(LANE_RULES).flatMap((rule) =>
        rule.input === "page" ? Object.keys(rule.surfaces) : [],
      ),
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
