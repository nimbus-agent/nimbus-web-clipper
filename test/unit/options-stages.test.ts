// @vitest-environment jsdom
// test/unit/options-stages.test.ts
import { describe, expect, test } from "vitest";
import { applyStages, stagesFrom } from "../../src/options/setup-view.ts";
import type { ConnectionResponse } from "../../src/shared/messages.ts";

function pageWithStages(): Document {
  const doc = document.implementation.createHTMLDocument("t");
  for (const id of ["stage-connect", "stage-connection", "stage-sites", "stage-trust"]) {
    const section = doc.createElement("section");
    section.id = id;
    doc.body.appendChild(section);
  }
  return doc;
}

const unpaired: ConnectionResponse = { kind: "connection", paired: false };

describe("applyStages", () => {
  test("stamps each stage's state onto data-state", () => {
    const doc = pageWithStages();
    applyStages(doc, stagesFrom(unpaired));
    expect(doc.getElementById("stage-connect")?.dataset["state"]).toBe("active");
    expect(doc.getElementById("stage-connection")?.dataset["state"]).toBe("locked");
    expect(doc.getElementById("stage-sites")?.dataset["state"]).toBe("locked");
    expect(doc.getElementById("stage-trust")?.dataset["state"]).toBe("active");
  });

  test("a missing section is skipped, not thrown on", () => {
    const doc = document.implementation.createHTMLDocument("t");
    expect(() => applyStages(doc, stagesFrom(unpaired))).not.toThrow();
  });
});
