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
      outcomes: {},
      rowsTotal: 1,
      rowsTruncated: false,
    });
  });

  it("takes outcome markers out of the rows and keys them by the row they describe", async () => {
    // A marker annotates an action rather than being one. Partitioning it by
    // caller would list it as a row in its own right and ask "who caused this
    // annotation", which is not a question.
    const action = row({ id: 1, rowHash: "ff" });
    const marker = row({
      id: 2,
      sourceType: "outcome",
      sourceId: "ff",
      method: "items.fetch.outcome",
      payloadSummary: JSON.stringify({ status: "indexed", itemId: "github:acme/web#482" }),
    });
    const res = await handleEgressWindow(
      deps({
        listEgress: async () => ({
          ok: true,
          value: { rows: [marker, action], rowsTotal: 2, rowsTruncated: false },
        }),
      }),
      { kind: "egress-window" },
    );

    expect(res).toMatchObject({
      ok: true,
      partition: { ours: [action], others: [], unattributable: [] },
      outcomes: { ff: { status: "indexed", itemId: "github:acme/web#482" } },
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

describe("every route refuses before it reads", () => {
  // `getConnection` returning null is the not-paired case, and it must be
  // answered WITHOUT a gateway read: an unpaired browser has no token to send,
  // and a call made anyway would be an unauthenticated request the user never
  // asked for. Two tests rather than one table because the handlers take
  // different request types, and a table would need a cast to bridge them.
  it("verify refuses when not paired, without calling the gateway", async () => {
    let reads = 0;
    const res = await handleEgressVerify(
      deps({
        getConnection: async () => null,
        verifyEgress: async () => {
          reads += 1;
          return {
            ok: true,
            value: { intact: true, brokenAt: null, verifiedRows: 0, reason: null },
          };
        },
      }),
      { kind: "egress-verify" },
    );
    expect(res).toEqual({ kind: "egress-verify", ok: false, reason: "not_paired" });
    expect(reads).toBe(0);
  });

  it("prove refuses when not paired, without calling the gateway", async () => {
    let reads = 0;
    const res = await handleEgressProve(
      deps({
        getConnection: async () => null,
        proveEgressWindow: async () => {
          reads += 1;
          return {
            ok: true,
            value: { digest: "d", sigB64: "s", pubkeyB64: "p", rowsTotal: 0, rowsTruncated: false },
          };
        },
      }),
      { kind: "egress-prove" },
    );
    expect(res).toEqual({ kind: "egress-prove", ok: false, reason: "not_paired" });
    expect(reads).toBe(0);
  });
});

describe("scope gaps reach every route's caller", () => {
  // Only the handler knows the device label, so a route that forgets to widen
  // the gateway's raw gap leaves the view unable to print a pasteable
  // `nimbus clip scopes` command — the one thing that fixes a 403.
  const RAW = { required: "egress", granted: ["clip"] };
  const WIDENED = { label: "my-browser", required: "egress", granted: ["clip"] };

  it("verify widens the gap with the device label", async () => {
    const res = await handleEgressVerify(
      deps({
        verifyEgress: async () => ({ ok: false, reason: "insufficient_scope", scopeGap: RAW }),
      }),
      { kind: "egress-verify" },
    );
    expect(res).toEqual({
      kind: "egress-verify",
      ok: false,
      reason: "insufficient_scope",
      scopeGap: WIDENED,
    });
  });

  it("prove widens the gap with the device label", async () => {
    const res = await handleEgressProve(
      deps({
        proveEgressWindow: async () => ({ ok: false, reason: "insufficient_scope", scopeGap: RAW }),
      }),
      { kind: "egress-prove" },
    );
    expect(res).toEqual({
      kind: "egress-prove",
      ok: false,
      reason: "insufficient_scope",
      scopeGap: WIDENED,
    });
  });

  it("an error with no gap carries NO scopeGap key at all", async () => {
    // Not `scopeGap: undefined`: the views branch on `=== undefined`, and an
    // explicit key would also make `toEqual` treat the two shapes as equal, so
    // a regression here would not be caught by the assertions above.
    const res = await handleEgressWindow(
      deps({ listEgress: async () => ({ ok: false, reason: "unreachable" }) }),
      { kind: "egress-window" },
    );
    expect(res).toEqual({ kind: "egress-window", ok: false, reason: "unreachable" });
    expect(Object.keys(res)).not.toContain("scopeGap");
  });

  it("verify's error with no gap carries no scopeGap key either", async () => {
    const res = await handleEgressVerify(
      deps({ verifyEgress: async () => ({ ok: false, reason: "unreachable" }) }),
      { kind: "egress-verify" },
    );
    expect(Object.keys(res)).not.toContain("scopeGap");
  });
});

describe("handleEgressProve window bounds", () => {
  it("passes since/until through, and omits each one that was not asked for", async () => {
    // Built by spread from two optional fields: an absent bound must not become
    // an explicit `undefined`, which the gateway would serialise into the query.
    let seen: unknown = null;
    const capture = deps({
      proveEgressWindow: async (_o, _t, opts) => {
        seen = opts;
        return {
          ok: true,
          value: { digest: "d", sigB64: "s", pubkeyB64: "p", rowsTotal: 1, rowsTruncated: false },
        };
      },
    });

    await handleEgressProve(capture, { kind: "egress-prove", since: 10, until: 20 });
    expect(seen).toEqual({ since: 10, until: 20 });

    await handleEgressProve(capture, { kind: "egress-prove", since: 10 });
    expect(Object.keys(seen as object)).toEqual(["since"]);

    await handleEgressProve(capture, { kind: "egress-prove", until: 20 });
    expect(Object.keys(seen as object)).toEqual(["until"]);

    await handleEgressProve(capture, { kind: "egress-prove" });
    expect(seen).toEqual({});
  });
});
