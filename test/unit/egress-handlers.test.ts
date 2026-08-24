// test/unit/egress-handlers.test.ts
import { describe, expect, it } from "vitest";
import {
  type EgressDeps,
  handleEgressProve,
  handleEgressVerify,
  handleEgressWindow,
} from "../../src/background/egress-handlers.ts";
import type { EgressRow } from "../../src/shared/egress.ts";

const CONNECTION = {
  origin: "http://127.0.0.1:7474",
  token: "tok",
  label: "my-browser",
  pairedAt: 1,
};

function row(over: Partial<EgressRow> = {}): EgressRow {
  return {
    id: 1,
    timestamp: 1_700_000_000_000,
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

function deps(over: Partial<EgressDeps> = {}): EgressDeps {
  return {
    getConnection: async () => CONNECTION,
    listEgress: async () => ({
      ok: true,
      value: { rows: [row()], rowsTotal: 1, rowsTruncated: false },
    }),
    verifyEgress: async () => ({
      ok: true,
      value: { intact: true, brokenAt: null, verifiedRows: 1, reason: null },
    }),
    proveEgressWindow: async () => ({
      ok: true,
      value: { digest: "d", sigB64: "s", pubkeyB64: "p", rowsTotal: 1, rowsTruncated: false },
    }),
    ...over,
  };
}

describe("handleEgressWindow", () => {
  it("partitions with the CONNECTION's own label, not one the page supplied", async () => {
    const res = await handleEgressWindow(deps(), { kind: "egress-window" });
    expect(res).toEqual({
      kind: "egress-window",
      ok: true,
      partition: { ours: [row()], others: [], unattributable: [] },
      ourLabel: "my-browser",
      rowsTotal: 1,
      rowsTruncated: false,
    });
  });

  it("refuses when not paired", async () => {
    const res = await handleEgressWindow(deps({ getConnection: async () => null }), {
      kind: "egress-window",
    });
    expect(res).toEqual({ kind: "egress-window", ok: false, reason: "not_paired" });
  });

  it("widens the gateway's raw gap with the device label", async () => {
    // The view needs `label` to build a pasteable `nimbus clip scopes` command,
    // and only the handler knows it — the gateway's 403 does not carry it.
    const res = await handleEgressWindow(
      deps({
        listEgress: async () => ({
          ok: false,
          reason: "insufficient_scope",
          scopeGap: { required: "egress", granted: ["clip"] },
        }),
      }),
      { kind: "egress-window" },
    );
    expect(res).toEqual({
      kind: "egress-window",
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { label: "my-browser", required: "egress", granted: ["clip"] },
    });
  });

  it("passes the cursor through to the read", async () => {
    let seen: unknown = null;
    await handleEgressWindow(
      deps({
        listEgress: async (_o, _t, opts) => {
          seen = opts;
          return { ok: true, value: { rows: [], rowsTotal: 0, rowsTruncated: false } };
        },
      }),
      { kind: "egress-window", before: 55 },
    );
    expect(seen).toEqual({ before: 55 });
  });

  it("has no writer on its dependency surface", async () => {
    // Nothing in this client may persist a ledger row: a local copy is exactly
    // the private log the design forbids, because it could quietly disagree with
    // `nimbus prove`. Pinned so adding one means deleting an assertion.
    expect(Object.keys(deps()).sort()).toEqual([
      "getConnection",
      "listEgress",
      "proveEgressWindow",
      "verifyEgress",
    ]);
  });
});

describe("handleEgressVerify", () => {
  it("returns the verdict", async () => {
    const res = await handleEgressVerify(deps(), { kind: "egress-verify" });
    expect(res).toEqual({
      kind: "egress-verify",
      ok: true,
      verdict: { intact: true, brokenAt: null, verifiedRows: 1, reason: null },
    });
  });

  it("reports a broken chain as a success carrying a false verdict", async () => {
    // A broken chain is an ANSWER, not a transport failure: the page must be able
    // to tell "could not check" from "checked, and it is broken".
    const res = await handleEgressVerify(
      deps({
        verifyEgress: async () => ({
          ok: true,
          value: { intact: false, brokenAt: 7, verifiedRows: 6, reason: "hash mismatch" },
        }),
      }),
      { kind: "egress-verify" },
    );
    expect(res).toEqual({
      kind: "egress-verify",
      ok: true,
      verdict: { intact: false, brokenAt: 7, verifiedRows: 6, reason: "hash mismatch" },
    });
  });
});

describe("handleEgressProve", () => {
  it("returns the signed artifact", async () => {
    const res = await handleEgressProve(deps(), { kind: "egress-prove" });
    expect(res).toEqual({
      kind: "egress-prove",
      ok: true,
      proof: { digest: "d", sigB64: "s", pubkeyB64: "p", rowsTotal: 1, rowsTruncated: false },
    });
  });

  it("maps an unsupported route so the page can hide the export", async () => {
    const res = await handleEgressProve(
      deps({ proveEgressWindow: async () => ({ ok: false, reason: "unsupported" }) }),
      { kind: "egress-prove" },
    );
    expect(res).toEqual({ kind: "egress-prove", ok: false, reason: "unsupported" });
  });
});
