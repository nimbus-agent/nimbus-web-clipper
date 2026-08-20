// test/unit/lane-input.test.ts
import { describe, expect, it } from "vitest";
import {
  type LaneContext,
  laneCanRun,
  laneRequestInput,
  lanesFor,
  type TermState,
  termStateFrom,
} from "../../src/panel/lane-input.ts";
import { MAX_TERM_LENGTH } from "../../src/shared/term.ts";

const NO_TERM: TermState = { kind: "none" };

function ctx(over: Partial<LaneContext> = {}): LaneContext {
  return {
    surfaceKind: "pr",
    pageSubject: true,
    pickedItemId: null,
    term: NO_TERM,
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

  it("offers no page lane on a build or an issue", () => {
    expect(lanesFor(ctx({ surfaceKind: "build" }))).toEqual([]);
    expect(lanesFor(ctx({ surfaceKind: "issue" }))).toEqual([]);
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
