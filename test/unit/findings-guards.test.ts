import { describe, expect, test } from "vitest";
import type { SynthesisProvenance, WhyFindings } from "../../src/shared/findings.ts";

describe("findings types pin the fields we read", () => {
  // The mirrored types (§4.2) can drift from upstream with nothing enforcing it.
  // This is the "discoverability, not enforcement" position registry.ts takes
  // about the Product -> connector id coupling: a rename upstream surfaces here
  // as a failure rather than as a wrong render.
  test("WhyFindings carries the five fields the renderer reads", () => {
    const value: WhyFindings = {
      kind: "why",
      findings: [
        {
          lane: "authorship",
          title: "t",
          detail: "d",
          url: null,
          occurredAt: null,
          entityId: null,
        },
      ],
      subject: null,
      changeSubject: null,
      itemSubject: null,
    };
    expect(Object.keys(value).sort()).toEqual([
      "changeSubject",
      "findings",
      "itemSubject",
      "kind",
      "subject",
    ]);
  });

  test("SynthesisProvenance's used arm carries model and remote", () => {
    const used: SynthesisProvenance = {
      attempted: true,
      used: true,
      model: "llama3",
      remote: false,
    };
    expect(used.attempted && used.used ? used.remote : true).toBe(false);
  });
});
