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

  // `agents.impact` takes a `fileOrPrUrl` and asks what a change under review
  // breaks — a question that means nothing about a Jenkins build or a Jira issue.
  // `expert` has left this group: its item arm answers about any indexed item, so
  // it is no longer a pull-request-only lane. `impact` itself is no longer
  // PR-only either: the forge arm gave it a second, `file`-scoped surface — the
  // `fileOrPrUrl` question means exactly as much about a source file as it does
  // about a change under review.
  it("puts impact on a pull request and a file", () => {
    expect(LANE_RULES.impact).toEqual({
      input: "page",
      surfaces: { pr: "item", file: "file" },
    });
  });

  it("offers no page lane on a build or a doc — the two surfaces with nothing to ask", () => {
    // `build` and `doc` are the surfaces `LANE_RULES` names nowhere. A build is not
    // an indexed item at all; a Confluence page indexes as type "page", which has no
    // graph entity (upstream F8), so every one of these lanes would answer nothing
    // permanently on it. Both get the header, freshness, Related and the `glossary`
    // term lane — and no service lane claiming to answer about the whole connector.
    // `issue` and `incident` used to be in this list and are not any more: both are
    // indexed items with graph entities, so both carry the three item lanes.
    for (const kind of ["build", "doc"] as const) {
      expect(AGENT_LANES.filter((lane) => laneBelongsOnSurface(lane, kind))).toEqual([]);
    }
  });

  it("offers why on a pull request, an issue and an incident", () => {
    for (const kind of ALL_KINDS) {
      expect(laneBelongsOnSurface("why", kind), kind).toBe(
        kind === "pr" || kind === "issue" || kind === "incident",
      );
    }
  });

  it("gates why on expert's item surfaces, and no longer as impact is", () => {
    // Not a tautology: it pins that a future edit widening `why`'s item surfaces has
    // to widen `expert`'s too, or explain why the two diverged. `why` has no `file`
    // arm — `agents.why` has no forge-coordinate input at all — so it can no longer
    // equal `expert` outright now that `expert` also answers on a file; comparing the
    // two on `issue`/`incident`/`pr` alone is the part of the claim that still holds.
    // `impact` remains the divergence this widening explains: its non-PR arm answers
    // about a FILE, not an item, so there is no item surface for it to widen onto —
    // an issue URL under `fileOrPrUrl` would be the wrong question, which is the bug
    // `LANE_RULES` exists to prevent.
    for (const kind of ["pr", "issue", "incident"] as const) {
      expect(scopeForLane("why", kind), kind).toBe(scopeForLane("expert", kind));
    }
    expect(scopeForLane("why", "file")).toBeNull();
    expect(scopeForLane("expert", "file")).toBe("file");
    expect(LANE_RULES.why).not.toEqual(LANE_RULES.impact);
  });

  it("puts the three item lanes on an issue and an incident", () => {
    for (const lane of ["why", "expert", "ownership"] as const) {
      expect(scopeForLane(lane, "issue"), lane).toBe("item");
      expect(scopeForLane(lane, "incident"), lane).toBe("item");
    }
  });

  // Upstream F8: a Confluence page indexes as type "page", which is in neither
  // ITEM_LINKED_ENTITY_TYPES nor GRAPH_SYNC_BY_TYPE, so it has no graph entity at
  // all. Every one of these lanes answers from graph edges, so on a doc page they
  // would return an empty answer permanently — for a structural reason no user
  // could act on. Not an omission; the design.
  it("puts no lane on a doc page", () => {
    for (const lane of AGENT_LANES) {
      expect(laneBelongsOnSurface(lane, "doc"), lane).toBe(false);
    }
  });

  // impact is NOT widened: its non-PR arm answers about a file, not an item.
  it("leaves impact on a pull request alone", () => {
    expect(scopeForLane("impact", "issue")).toBeNull();
    expect(scopeForLane("impact", "incident")).toBeNull();
    expect(scopeForLane("impact", "pr")).toBe("item");
  });

  it("names every surface kind the recogniser can produce", () => {
    // Pins the derivation itself: if `SurfaceKind` ever stops being derived from
    // `SURFACE_KINDS`, this list and the union can drift apart again.
    expect([...SURFACE_KINDS]).toEqual(["pr", "build", "issue", "home", "doc", "incident", "file"]);
  });
});

describe("service lanes", () => {
  it("puts the service-scoped lanes on home and nowhere else", () => {
    // `ownership` is no longer one of them: it answers at two scopes now, and gets
    // its own assertion below.
    for (const lane of ["catchup", "decisions"] as const) {
      expect(LANE_RULES[lane], lane).toEqual({ input: "page", surfaces: { home: "service" } });
    }
  });

  // ownership now answers at two different scopes, which is the case that forced
  // the lane x surface table in the first place.
  it("keeps ownership service-scoped on a dashboard", () => {
    expect(scopeForLane("ownership", "home")).toBe("service");
  });

  it("gives ownership an item scope on an issue and an incident, and a file scope on a file", () => {
    expect(LANE_RULES.ownership).toEqual({
      input: "page",
      surfaces: { home: "service", issue: "item", incident: "item", file: "file" },
    });
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
    // `build` and `doc` deliberately have no agent lane — assert the ones that DO,
    // so this test fails loudly if a future edit empties them.
    expect(covered.has("pr")).toBe(true);
    expect(covered.has("home")).toBe(true);
    expect(covered.has("issue")).toBe(true);
    expect(covered.has("incident")).toBe(true);
  });
});

describe("the file surface", () => {
  it("offers exactly impact, expert and ownership", () => {
    const onFile = AGENT_LANES.filter((l) => scopeForLane(l, "file") !== null);
    expect(onFile).toEqual(["impact", "expert", "ownership"]);
  });

  it("does not offer ghost or conflicts, because neither can answer", () => {
    // Both build their entire result inside `input.namespaces.map(...)` upstream, and
    // the forge arm REFUSES namespaces ("that shape answers locally only"). So under
    // the one shape a browser can send, both return an empty array on every gateway,
    // forever. A lane that will answer nothing is worse than no lane — the same rule
    // that keeps these three off a Confluence page. See spec §4.7 before adding them.
    expect(AGENT_LANES).not.toContain("ghost");
    expect(AGENT_LANES).not.toContain("conflicts");
  });

  it("sends the forge coordinate on every file lane", () => {
    for (const lane of ["impact", "expert", "ownership"] as const) {
      expect(scopeForLane(lane, "file")).toBe("file");
    }
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
