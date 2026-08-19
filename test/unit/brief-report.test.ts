import { describe, expect, it } from "vitest";
import {
  type BriefReport,
  countIndexHits,
  isBriefReport,
  QUOTES_OMITTED_GAP,
  quotesWereOmitted,
  visibleGaps,
} from "../../src/shared/brief-report.ts";

function report(over: Partial<BriefReport> = {}): BriefReport {
  return {
    summary: "s",
    findings: [{ text: "f", citations: [{ kind: "source", title: "One" }] }],
    conflicts: [],
    gaps: [],
    synthesis: { model: "llama3", remote: false },
    ...over,
  };
}

describe("isBriefReport", () => {
  function reportWithCitation(citation: unknown): BriefReport {
    return report({ findings: [{ text: "f", citations: [citation as never] }] });
  }

  it("accepts a well-formed local report", () => {
    expect(isBriefReport(report())).toBe(true);
  });

  it("accepts a citation carrying itemType and itemId", () => {
    expect(
      isBriefReport({
        summary: "s",
        findings: [
          {
            text: "t",
            citations: [
              {
                kind: "clip",
                title: "PR 482",
                itemId: "nimbus:pull_request:acme/web/482",
                itemType: "pull_request",
              },
            ],
          },
        ],
        conflicts: [],
        gaps: [],
        synthesis: { model: "m", remote: false },
      }),
    ).toBe(true);
  });

  it("accepts an itemType this build has never heard of", () => {
    // Connectors are added to the gateway on their own schedule. An enum here
    // would guarantee a break on somebody else's release.
    const report = reportWithCitation({
      kind: "clip",
      title: "standup",
      itemType: "slack_message",
    });
    expect(isBriefReport(report)).toBe(true);
  });

  it("still rejects a non-string itemType", () => {
    expect(isBriefReport(reportWithCitation({ kind: "clip", title: "x", itemType: 7 }))).toBe(
      false,
    );
  });

  it("accepts a remote report carrying a disclosure", () => {
    expect(
      isBriefReport(
        report({
          gaps: ["Synthesised remotely."],
          synthesis: { model: "gpt", remote: true, disclosure: "Synthesised remotely." },
        }),
      ),
    ).toBe(true);
  });

  it("rejects a missing synthesis block", () => {
    const { synthesis: _drop, ...rest } = report();
    expect(isBriefReport(rest)).toBe(false);
  });

  it("rejects a non-boolean remote flag", () => {
    expect(isBriefReport(report({ synthesis: { model: "m", remote: "yes" } as never }))).toBe(
      false,
    );
  });

  it("rejects a citation whose kind is not source or clip", () => {
    expect(
      isBriefReport(
        report({ findings: [{ text: "f", citations: [{ kind: "web", title: "t" } as never] }] }),
      ),
    ).toBe(false);
  });

  it("rejects non-objects and null", () => {
    expect(isBriefReport(null)).toBe(false);
    expect(isBriefReport("report")).toBe(false);
    expect(isBriefReport(undefined)).toBe(false);
  });
});

describe("visibleGaps", () => {
  it("suppresses the disclosure duplicate BY EQUALITY", () => {
    const r = report({
      gaps: ["Only 2 of 3 sources were read.", "Synthesised on a remote model."],
      synthesis: { model: "gpt", remote: true, disclosure: "Synthesised on a remote model." },
    });
    expect(visibleGaps(r)).toEqual(["Only 2 of 3 sources were read."]);
  });

  it("keeps a gap that merely resembles the disclosure", () => {
    // Guards against anyone replacing the equality check with a pattern match.
    const r = report({
      gaps: ["Synthesised on a remote model (see docs)."],
      synthesis: { model: "gpt", remote: true, disclosure: "Synthesised on a remote model." },
    });
    expect(visibleGaps(r)).toHaveLength(1);
  });

  it("returns gaps unchanged when there is no disclosure", () => {
    const r = report({ gaps: ["a", "b"] });
    expect(visibleGaps(r)).toEqual(["a", "b"]);
  });
});

describe("quotesWereOmitted", () => {
  it("detects the save-time quote-stripping gap", () => {
    expect(quotesWereOmitted(report({ gaps: [QUOTES_OMITTED_GAP] }))).toBe(true);
  });

  it("is false for an ordinary report", () => {
    expect(quotesWereOmitted(report())).toBe(false);
  });
});

describe("countIndexHits", () => {
  it("is zero for a report with no indexed citation at all", () => {
    expect(countIndexHits(report())).toBe(0);
  });

  it("counts an indexed citation, and ignores the picked sources beside it", () => {
    const r = report({
      findings: [
        {
          text: "f",
          citations: [
            { kind: "source", title: "A tab" },
            { kind: "clip", title: "A clip", itemId: "i1" },
          ],
        },
      ],
    });
    expect(countIndexHits(r)).toBe(1);
  });

  it("counts DISTINCT items — one clip cited in three findings is one", () => {
    // The number this feeds is the egress log's "how much of your index did
    // this run reach". Counting citations instead would say 3, and could climb
    // past the bound of 8 the pre-send notice named — the one way it misleads.
    const cite = { kind: "clip" as const, title: "A clip", itemId: "i1" };
    const r = report({
      findings: [
        { text: "f1", citations: [cite] },
        { text: "f2", citations: [cite, { ...cite, quote: "a different quote" }] },
      ],
      conflicts: [{ text: "c", citations: [cite, { kind: "source", title: "A tab" }] }],
    });
    expect(countIndexHits(r)).toBe(1);
  });

  it("counts conflicts as well as findings — both name what the run drew on", () => {
    const r = report({
      findings: [{ text: "f", citations: [{ kind: "clip", title: "One", itemId: "i1" }] }],
      conflicts: [
        {
          text: "c",
          citations: [
            { kind: "clip", title: "Two", itemId: "i2" },
            { kind: "clip", title: "Three", itemId: "i3" },
          ],
        },
      ],
    });
    expect(countIndexHits(r)).toBe(3);
  });

  it("falls back to clipId, then to the citation's own text, rather than dropping a hit", () => {
    const r = report({
      findings: [
        {
          text: "f",
          citations: [
            { kind: "clip", title: "By clip id", clipId: "c1" },
            { kind: "clip", title: "By clip id again", clipId: "c1" },
            { kind: "clip", title: "No id at all", url: "https://h/x" },
            { kind: "clip", title: "No id at all", url: "https://h/x" },
            { kind: "clip", title: "No id at all", url: "https://h/y" },
          ],
        },
      ],
    });
    // c1 once, (title, x) once, (title, y) once — an id-less hit is still a hit,
    // and undercounting an egress record is the error this must not make.
    expect(countIndexHits(r)).toBe(3);
  });

  it("never collides an itemId with a clipId, or either with a title", () => {
    const r = report({
      findings: [
        {
          text: "f",
          citations: [
            { kind: "clip", title: "x", itemId: "same" },
            { kind: "clip", title: "x", clipId: "same" },
            { kind: "clip", title: "same" },
          ],
        },
      ],
    });
    expect(countIndexHits(r)).toBe(3);
  });
});
