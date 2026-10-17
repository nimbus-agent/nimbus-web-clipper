// test/unit/lane-input.test.ts
import { describe, expect, it } from "vitest";
import {
  type LaneContext,
  laneCanRun,
  laneContextFrom,
  laneRequestInput,
  lanesFor,
  laneTitle,
  showsRelated,
  type TermState,
  termStateFrom,
  visibleLanes,
} from "../../src/panel/lane-input.ts";
import type { HeaderState } from "../../src/panel/panel-view.ts";
import { MAX_TERM_LENGTH } from "../../src/shared/term.ts";
import type { FileResolution } from "../../src/shared/types.ts";

const NO_TERM: TermState = { kind: "none" };

function ctx(over: Partial<LaneContext> = {}): LaneContext {
  return {
    surfaceKind: "pr",
    pageSubject: true,
    pickedItemId: null,
    term: NO_TERM,
    offered: null,
    connectorHealthy: true,
    ...over,
  };
}

describe("termStateFrom", () => {
  it("treats a never-made selection as none", () => {
    expect(termStateFrom(null)).toEqual({ kind: "none" });
  });

  it("normalises a ragged selection", () => {
    expect(termStateFrom("  blast   radius\n")).toEqual({ kind: "ready", term: "blast radius" });
  });

  // A selection spanning two lines is two words, not one welded together.
  it("turns a line break into a space, never into nothing", () => {
    expect(termStateFrom("blast\nradius")).toEqual({ kind: "ready", term: "blast radius" });
  });

  it("refuses a passage rather than truncating it", () => {
    const passage = "a".repeat(MAX_TERM_LENGTH + 1);
    expect(termStateFrom(passage)).toEqual({ kind: "refused", reason: "too_long" });
  });

  it("accepts a term of exactly the maximum length", () => {
    const term = "b".repeat(MAX_TERM_LENGTH);
    expect(termStateFrom(term)).toEqual({ kind: "ready", term });
  });

  it("refuses a whitespace-only selection", () => {
    expect(termStateFrom("   \n  ")).toEqual({ kind: "refused", reason: "empty" });
  });
});

describe("lanesFor — page lanes", () => {
  it("offers the pull-request lanes on a resolved pull request", () => {
    expect(lanesFor(ctx())).toEqual(["impact", "expert", "why"]);
  });

  // null means we never learned what this gateway serves. It must render exactly as
  // it did before capability discovery existed — not blank.
  it("filters nothing when the offered list is unknown", () => {
    expect(lanesFor(ctx({ offered: null }))).toEqual(["impact", "expert", "why"]);
  });

  it("drops a lane the gateway does not serve", () => {
    expect(lanesFor(ctx({ offered: ["impact", "why"] }))).toEqual(["impact", "why"]);
  });

  it("offers the service lanes on a dashboard", () => {
    expect(lanesFor(ctx({ surfaceKind: "home" }))).toEqual(["catchup", "decisions", "ownership"]);
  });

  // The header names no single item — a miss, an error, or an ambiguous answer
  // nobody has picked from. There is nothing for a page lane to answer about.
  it("offers no page lane without a subject in the header", () => {
    expect(lanesFor(ctx({ pageSubject: false }))).toEqual([]);
  });

  it("offers no page lane on an unrecognised page", () => {
    expect(lanesFor(ctx({ surfaceKind: null }))).toEqual([]);
  });

  it("offers no page lane on a build", () => {
    expect(lanesFor(ctx({ surfaceKind: "build" }))).toEqual([]);
  });

  // An issue and an incident are indexed items with graph entities, so the three
  // item lanes answer about them. Render order is `AGENT_LANES` order.
  it("offers the three item lanes on an issue and an incident", () => {
    expect(lanesFor(ctx({ surfaceKind: "issue" }))).toEqual(["expert", "why", "ownership"]);
    expect(lanesFor(ctx({ surfaceKind: "incident" }))).toEqual(["expert", "why", "ownership"]);
  });
});

describe("lanesFor — the term lane", () => {
  const term: TermState = { kind: "ready", term: "idempotency key" };

  it("does not exist until a term does", () => {
    expect(lanesFor(ctx())).not.toContain("glossary");
  });

  it("leads the lanes once a term arrives", () => {
    expect(lanesFor(ctx({ term }))).toEqual(["glossary", "impact", "expert", "why"]);
  });

  // The decision this slice turns on: glossary's input is not the page, so no
  // property of the page can withhold it. The term you most need defined is on
  // the internal wiki that has no connector at all.
  it("appears on a page the recogniser rejects", () => {
    expect(lanesFor(ctx({ surfaceKind: null, pageSubject: false, term }))).toEqual(["glossary"]);
  });

  it("appears on a page with no resolved subject", () => {
    expect(lanesFor(ctx({ pageSubject: false, term }))).toEqual(["glossary"]);
  });

  // The refusal is the thing the user needs to see. Hiding the lane would make
  // the gesture they just made look like it did nothing at all.
  it("still appears when the term was refused", () => {
    expect(lanesFor(ctx({ term: { kind: "refused", reason: "too_long" } }))).toContain("glossary");
  });

  // The term gate and the offered gate are independent, and both must pass. A
  // glossary lane the gateway does not publish cannot be answered either.
  it("drops a term lane the gateway does not serve", () => {
    expect(
      lanesFor(ctx({ surfaceKind: null, pageSubject: false, term, offered: ["why"] })),
    ).toEqual([]);
  });

  it("keeps a term lane the gateway does serve", () => {
    expect(
      lanesFor(ctx({ surfaceKind: null, pageSubject: false, term, offered: ["glossary"] })),
    ).toEqual(["glossary"]);
  });
});

describe("laneRequestInput", () => {
  it("sends nothing extra for a page lane on an unambiguous page", () => {
    expect(laneRequestInput("impact", ctx())).toEqual({});
  });

  it("carries the picked candidate for a page lane", () => {
    expect(laneRequestInput("expert", ctx({ pickedItemId: "github:42" }))).toEqual({
      itemId: "github:42",
    });
  });

  // A term lane is about a term, never about the item the page happens to be.
  it("carries the term for a term lane, and never the picked id", () => {
    const c = ctx({ pickedItemId: "github:42", term: { kind: "ready", term: "canary" } });
    expect(laneRequestInput("glossary", c)).toEqual({ term: "canary" });
  });

  it("carries no term when the term was refused", () => {
    const c = ctx({ term: { kind: "refused", reason: "too_long" } });
    expect(laneRequestInput("glossary", c)).toEqual({});
  });
});

describe("laneCanRun", () => {
  it("lets a page lane run", () => {
    expect(laneCanRun("impact", ctx())).toBe(true);
  });

  it("lets a term lane run once the term is ready", () => {
    expect(laneCanRun("glossary", ctx({ term: { kind: "ready", term: "canary" } }))).toBe(true);
  });

  // The one case where a lane renders and must never send: without this, the
  // panel would post an `agent-run` the message guard is bound to reject, and
  // the user would see a transport error instead of the reason.
  it("stops a term lane whose term was refused", () => {
    expect(laneCanRun("glossary", ctx({ term: { kind: "refused", reason: "too_long" } }))).toBe(
      false,
    );
  });
});

describe("laneContextFrom", () => {
  const ITEM = { id: "i1", service: "github", type: "pr", title: "T", url: null };
  const PR = {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref: "a/b #1",
    resolveUrl: "https://github.com/a/b/pull/1",
  } as const;
  const base = { recognition: PR, file: null, offered: null, term: NO_TERM } as const;
  const resolved: HeaderState = {
    kind: "resolved",
    surface: "s",
    item: { ...ITEM, modifiedAt: 1 },
    matchKind: "exact",
    nowMs: 1,
  };
  const service = (state: "healthy" | "not_configured"): HeaderState => ({
    kind: "service",
    surface: "s",
    product: "github",
    connector: { state },
    nowMs: 1,
  });
  const pageSubject = (shown: HeaderState, file: FileResolution | null = null): boolean =>
    laneContextFrom({ ...base, shown, file }).pageSubject;

  it("takes the surface kind from the recognition, null when it was rejected", () => {
    expect(laneContextFrom({ ...base, shown: resolved }).surfaceKind).toBe("pr");
    const rejected = { ok: false, reason: "unknown-host" } as const;
    expect(
      laneContextFrom({ ...base, shown: resolved, recognition: rejected }).surfaceKind,
    ).toBeNull();
    expect(laneContextFrom({ ...base, shown: resolved, recognition: null }).surfaceKind).toBeNull();
  });

  it("has a page subject for resolved, service and chosen headers only", () => {
    expect(pageSubject(resolved)).toBe(true);
    expect(pageSubject(service("healthy"))).toBe(true);
    expect(pageSubject({ kind: "chosen", surface: "s", candidate: ITEM })).toBe(true);
    expect(pageSubject({ kind: "captured", item: { ...ITEM, modifiedAt: 1 }, ageNowMs: 1 })).toBe(
      false,
    );
    expect(
      pageSubject({ kind: "ambiguous", surface: "s", candidates: [ITEM], truncated: false }),
    ).toBe(false);
  });

  it("gates a file header on the probe, not on the header", () => {
    const file: HeaderState = { kind: "file", surface: "s" };
    expect(pageSubject(file, { kind: "found", path: "a.ts" })).toBe(true);
    expect(pageSubject(file, { kind: "unsupported" })).toBe(false);
    expect(pageSubject(file)).toBe(false);
  });

  it("carries the picked item id from a chosen header only", () => {
    expect(
      laneContextFrom({ ...base, shown: { kind: "chosen", surface: "s", candidate: ITEM } })
        .pickedItemId,
    ).toBe("i1");
    expect(laneContextFrom({ ...base, shown: resolved }).pickedItemId).toBeNull();
  });

  it("fails open on connector health except for an unservable service header", () => {
    expect(laneContextFrom({ ...base, shown: resolved }).connectorHealthy).toBe(true);
    expect(laneContextFrom({ ...base, shown: service("healthy") }).connectorHealthy).toBe(true);
    expect(laneContextFrom({ ...base, shown: service("not_configured") }).connectorHealthy).toBe(
      false,
    );
  });
});

describe("laneTitle", () => {
  it("quotes the term for glossary", () => {
    expect(laneTitle("glossary", "pr", { kind: "ready", term: "idempotency" })).toBe(
      "“idempotency”",
    );
  });

  it("falls back to the plain title for glossary without a ready term", () => {
    expect(laneTitle("glossary", "pr", { kind: "refused", reason: "empty" })).toBe("Definition");
  });

  it("applies the surface override, and falls through where there is none", () => {
    expect(laneTitle("expert", "file", NO_TERM)).toBe("Who knows this file");
    expect(laneTitle("why", "incident", NO_TERM)).toBe("How did we get here");
    expect(laneTitle("why", "pr", NO_TERM)).toBe("Why does this change exist");
    expect(laneTitle("why", null, NO_TERM)).toBe("Why does this change exist");
  });
});

describe("visibleLanes and showsRelated", () => {
  it("returns nothing on an unhealthy home, even with a ready term", () => {
    const unhealthy = ctx({
      surfaceKind: "home",
      connectorHealthy: false,
      term: { kind: "ready", term: "x" },
    });
    expect(visibleLanes(unhealthy)).toEqual([]);
  });

  it("titles each lane and never includes related", () => {
    const lanes = visibleLanes(ctx({ term: { kind: "ready", term: "x" } }));
    expect(lanes.map((l) => l.lane)).toEqual(["glossary", "impact", "expert", "why"]);
    expect(lanes[0]).toEqual({ lane: "glossary", title: "“x”", canRun: true });
    expect(lanes.map((l) => String(l.lane))).not.toContain("related");
  });

  it("carries a refusal exactly on a lane that cannot run", () => {
    const lanes = visibleLanes(ctx({ term: { kind: "refused", reason: "too_long" } }));
    const glossary = lanes.find((l) => l.lane === "glossary");
    expect(glossary?.canRun).toBe(false);
    expect(glossary?.refusal).toBe("That's a passage, not a term — select a word or phrase.");
    expect(lanes.filter((l) => l.canRun).every((l) => l.refusal === undefined)).toBe(true);
  });

  it("shows related everywhere but home", () => {
    expect(showsRelated(ctx({ surfaceKind: "home" }))).toBe(false);
    expect(showsRelated(ctx({ surfaceKind: "pr" }))).toBe(true);
    expect(showsRelated(ctx({ surfaceKind: null }))).toBe(true);
  });
});
