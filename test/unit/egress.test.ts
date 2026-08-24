// test/unit/egress.test.ts
import { describe, expect, it } from "vitest";
import {
  actionClass,
  type EgressRow,
  isEgressRow,
  isOutcomeRow,
  parseEgressWindow,
  parseOutcome,
  partitionRows,
  splitOutcomes,
} from "../../src/shared/egress.ts";

function row(over: Partial<EgressRow> = {}): EgressRow {
  return {
    id: 1,
    timestamp: 1_700_000_000_000,
    sourceType: "sync",
    sourceId: null,
    destination: "github",
    method: "items.fetch",
    payloadSummary: '{"method":"items.fetch"}',
    hitlStatus: "not_required",
    resultStatus: "authorized",
    rowHash: "aa",
    prevHash: "bb",
    ...over,
  };
}

describe("isEgressRow", () => {
  it("accepts a well-formed row", () => {
    expect(isEgressRow(row())).toBe(true);
  });

  it("rejects a closed-union field carrying an unknown string", () => {
    // The union is CHECK-constrained on the wire. A guard that only asked
    // `typeof === "string"` would let an unmodelled status through, and every
    // consumer would then narrow on a value that cannot occur.
    expect(isEgressRow({ ...row(), resultStatus: "pending" })).toBe(false);
    expect(isEgressRow({ ...row(), hitlStatus: "maybe" })).toBe(false);
  });

  it("rejects a non-integer id and a non-finite timestamp", () => {
    expect(isEgressRow({ ...row(), id: 1.5 })).toBe(false);
    expect(isEgressRow({ ...row(), timestamp: Number.NaN })).toBe(false);
  });

  it("rejects a negative id — a rowid is never below zero", () => {
    expect(isEgressRow({ ...row(), id: -1 })).toBe(false);
  });

  it("accepts an explicitly null sourceId but rejects a missing one", () => {
    expect(isEgressRow({ ...row(), sourceId: null })).toBe(true);
    const { sourceId: _dropped, ...withoutSourceId } = row();
    expect(isEgressRow(withoutSourceId)).toBe(false);
  });
});

describe("isEgressRow — the rejection paths", () => {
  // These guards exist to stop a wire value the types say cannot occur from
  // reaching a consumer that narrowed on it. An untested rejection path is a
  // guard nobody has watched refuse anything.
  it("rejects a non-object", () => {
    expect(isEgressRow(null)).toBe(false);
    expect(isEgressRow("row")).toBe(false);
    expect(isEgressRow(42)).toBe(false);
  });

  it("rejects a sourceId that is neither a string nor null", () => {
    expect(isEgressRow({ ...row(), sourceId: 7 })).toBe(false);
  });

  it("rejects a non-string in any of the plain string fields", () => {
    for (const key of [
      "sourceType",
      "destination",
      "method",
      "payloadSummary",
      "rowHash",
      "prevHash",
    ]) {
      expect(isEgressRow({ ...row(), [key]: 1 })).toBe(false);
    }
  });
});

describe("parseEgressWindow", () => {
  it("reads rows and the window totals", () => {
    expect(
      parseEgressWindow({ rows: [row({ id: 2 })], rowsTotal: 40, rowsTruncated: true }),
    ).toEqual({ rows: [row({ id: 2 })], rowsTotal: 40, rowsTruncated: true });
  });

  it("refuses a body whose totals are missing", () => {
    // Without totals the view would have to count the page, which is the exact
    // under-reporting the design forbids.
    expect(parseEgressWindow({ rows: [row()] })).toBeNull();
  });

  it("refuses a non-object body and one whose rows are not an array", () => {
    expect(parseEgressWindow(null)).toBeNull();
    expect(parseEgressWindow({ rows: "none", rowsTotal: 0, rowsTruncated: false })).toBeNull();
  });

  it("refuses a non-boolean rowsTruncated", () => {
    // A truthy string here would read as "there is more", and the page would
    // offer an Older button that pages into nothing.
    expect(parseEgressWindow({ rows: [], rowsTotal: 0, rowsTruncated: "yes" })).toBeNull();
  });

  it("refuses a non-integer or negative rowsTotal", () => {
    expect(parseEgressWindow({ rows: [], rowsTotal: 1.5, rowsTruncated: false })).toBeNull();
    // A negative total makes `rows.length < rowsTotal` false on a genuinely
    // truncated window, which would hide the Older control.
    expect(parseEgressWindow({ rows: [], rowsTotal: -1, rowsTruncated: true })).toBeNull();
  });

  it("refuses a body with one malformed row rather than silently dropping it", () => {
    expect(
      parseEgressWindow({ rows: [row(), { id: "x" }], rowsTotal: 2, rowsTruncated: false }),
    ).toBeNull();
  });
});

describe("partitionRows", () => {
  it("splits by label into ours, others and unattributable", () => {
    const ours = row({ id: 1, sourceType: "http", sourceId: "my-browser" });
    const theirs = row({ id: 2, sourceType: "http", sourceId: "my-editor" });
    const anon = row({ id: 3, sourceId: null });

    expect(partitionRows([ours, theirs, anon], "my-browser")).toEqual({
      ours: [ours],
      others: [theirs],
      unattributable: [anon],
    });
  });

  it("never guesses: an unlabelled targeted fetch is unattributable, not ours", () => {
    const fetchRow = row({ sourceId: null, sourceType: "sync", method: "items.fetch" });
    expect(partitionRows([fetchRow], "my-browser").ours).toEqual([]);
    expect(partitionRows([fetchRow], "my-browser").unattributable).toEqual([fetchRow]);
  });

  it("treats an empty label as matching nothing", () => {
    // An unpaired or malformed connection must not sweep every anonymous row
    // into "yours".
    expect(partitionRows([row({ sourceId: null })], "").ours).toEqual([]);
  });
});

describe("actionClass", () => {
  it("names the four classes from sourceType and method", () => {
    expect(actionClass(row({ sourceType: "sync", method: "items.fetch" }))).toBe("targeted-fetch");
    expect(actionClass(row({ sourceType: "sync", method: "sync.run" }))).toBe("background-sync");
    expect(actionClass(row({ sourceType: "http", method: "agents.why" }))).toBe("agent-run");
    expect(actionClass(row({ sourceType: "model", method: "synthesis" }))).toBe("other");
  });
});

/** An outcome marker as the gateway writes it: `source_id` names the row it describes. */
function outcome(over: Partial<EgressRow> = {}): EgressRow {
  return row({
    id: 20,
    sourceType: "outcome",
    sourceId: "aa".repeat(32),
    method: "items.fetch.outcome",
    payloadSummary: JSON.stringify({ status: "indexed", itemId: "github:acme/web#482" }),
    ...over,
  });
}

describe("isOutcomeRow", () => {
  it("recognises the marker and nothing else", () => {
    expect(isOutcomeRow(outcome())).toBe(true);
    expect(isOutcomeRow(row({ sourceType: "sync" }))).toBe(false);
    expect(isOutcomeRow(row({ sourceType: "http" }))).toBe(false);
  });
});

describe("parseOutcome", () => {
  it("reads the status and the item id", () => {
    expect(parseOutcome(outcome())).toEqual({
      status: "indexed",
      itemId: "github:acme/web#482",
    });
  });

  it("reads a miss reason, with no item id", () => {
    const parsed = parseOutcome(
      outcome({ payloadSummary: JSON.stringify({ status: "not_found", reason: "absent" }) }),
    );
    expect(parsed).toEqual({ status: "not_found", reason: "absent" });
  });

  it("returns null for a truncated summary rather than throwing", () => {
    // `redactEgressSummary` caps at 256 bytes and appends "…[truncated]", which
    // is not valid JSON. The page shows "not recorded" rather than crashing.
    expect(parseOutcome(outcome({ payloadSummary: '{"status":"inde…[truncated]' }))).toBeNull();
  });

  it("returns null for a status the gateway never writes", () => {
    // Type narrow, runtime wide: the union is closed upstream, so an unknown
    // value is malformed data and must not reach a consumer that narrowed on it.
    expect(
      parseOutcome(outcome({ payloadSummary: JSON.stringify({ status: "maybe" }) })),
    ).toBeNull();
  });

  it("returns null for a row that is not an outcome at all", () => {
    expect(parseOutcome(row({ sourceType: "sync" }))).toBeNull();
  });
});

describe("splitOutcomes", () => {
  it("takes outcome rows out of the action list and keys them by the row they describe", () => {
    const action = row({ id: 1, rowHash: "aa".repeat(32) });
    const marker = outcome({ id: 2 });

    const { actions, outcomesByHash } = splitOutcomes([marker, action]);

    // An outcome is an annotation on an action, not an action — it has no time,
    // service or kind of its own worth showing.
    expect(actions).toEqual([action]);
    expect(outcomesByHash.get("aa".repeat(32))).toEqual({
      status: "indexed",
      itemId: "github:acme/web#482",
    });
  });

  it("drops an orphan outcome whose authorising row is on another page", () => {
    // The outcome carries a HIGHER id than the row it describes and the read is
    // newest-first, so the pair routinely straddles a page boundary. An orphan
    // is simply not rendered.
    const { actions, outcomesByHash } = splitOutcomes([outcome()]);
    expect(actions).toEqual([]);
    expect(outcomesByHash.size).toBe(1);
  });

  it("keeps an outcome whose summary will not parse out of the map", () => {
    const { outcomesByHash } = splitOutcomes([outcome({ payloadSummary: "not json at all" })]);
    expect(outcomesByHash.size).toBe(0);
  });
});
