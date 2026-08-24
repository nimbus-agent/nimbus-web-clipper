// test/unit/egress.test.ts
import { describe, expect, it } from "vitest";
import {
  actionClass,
  type EgressRow,
  isEgressRow,
  parseEgressWindow,
  partitionRows,
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
