import { describe, expect, it } from "vitest";
import {
  type BriefReport,
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
