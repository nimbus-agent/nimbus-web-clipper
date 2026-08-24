// @vitest-environment jsdom
// test/unit/ledger-summary-view.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  type LedgerSummaryModel,
  renderLedgerSummary,
} from "../../src/options/ledger-summary-view.ts";

let root: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("div");
  document.body.append(root);
});

function model(over: Partial<LedgerSummaryModel> = {}): LedgerSummaryModel {
  return {
    state: "loaded",
    actionsShown: 14,
    oursCount: 9,
    rowsTruncated: false,
    ...over,
  } as LedgerSummaryModel;
}

describe("renderLedgerSummary", () => {
  it("states the window total and our share when the window is complete", () => {
    renderLedgerSummary(root, model());
    const text = root.textContent ?? "";
    expect(text).toContain("14");
    expect(text).toContain("9");
  });

  it("states both counts as floors when the window is truncated", () => {
    // Both are counted from the page, so a longer window holds more of each.
    // Stating either as exact would under-report.
    renderLedgerSummary(root, model({ actionsShown: 1000, oursCount: 900, rowsTruncated: true }));
    const text = root.textContent ?? "";
    expect(text).toContain("At least 1000");
    expect(text).toContain("at least 900");
  });

  it("counts ACTIONS, not ledger rows — markers are bookkeeping, not egress", () => {
    // The gateway's rowsTotal counts every row in the window, boot and outcome
    // markers included. Reporting that as "outbound actions" over-counted.
    renderLedgerSummary(root, model({ actionsShown: 4, oursCount: 1 }));
    expect(root.textContent).toContain("4 outbound actions recorded");
  });

  it("says nothing about verification — that lives on the page", () => {
    renderLedgerSummary(root, model());
    expect(root.textContent).not.toContain("verified");
  });

  it("stays factual rather than alarming on an unsupported gateway", () => {
    renderLedgerSummary(root, model({ state: "error", reason: "unsupported" }));
    expect(root.textContent).toContain("does not offer");
  });

  it("prompts for the scope with the built command", () => {
    renderLedgerSummary(
      root,
      model({
        state: "error",
        reason: "insufficient_scope",
        scopeGap: { label: "my-browser", required: "egress", granted: ["clip"] },
      }),
    );
    expect(root.textContent).toContain("nimbus clip scopes my-browser --set clip,egress");
  });

  it("falls back to generic guidance when the command cannot be safely built", () => {
    renderLedgerSummary(
      root,
      model({
        state: "error",
        reason: "insufficient_scope",
        scopeGap: { label: "bad label; rm -rf /", required: "egress", granted: [] },
      }),
    );
    const text = root.textContent ?? "";
    expect(text).not.toContain("rm -rf");
    expect(text).toContain("nimbus clip status");
  });

  it("has a message for every other failure reason", () => {
    for (const reason of [
      "unreachable",
      "unauthorized",
      "rate_limited",
      "server_error",
      "not_paired",
    ] as const) {
      root.replaceChildren();
      renderLedgerSummary(root, model({ state: "error", reason }));
      expect((root.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("never parses text as markup", () => {
    renderLedgerSummary(
      root,
      model({
        state: "error",
        reason: "insufficient_scope",
        scopeGap: { label: "<img src=x>", required: "egress", granted: [] },
      }),
    );
    expect(root.querySelector("img")).toBeNull();
  });
});
