import { describe, expect, it } from "vitest";
import {
  CONNECTOR_STATES,
  gatePolicy,
  parseConnectorHealth,
} from "../../src/shared/connector-health.ts";

/** The wire shape, as `GET /v1/connectors` actually returns it: a `data` array of
 *  ConnectorHealthSnapshot, each with `connectorId` and `state`, plus optional
 *  fields. Dates cross JSON as ISO strings, never as Date objects. */
const BODY = {
  data: [
    {
      connectorId: "github",
      state: "healthy",
      backoffAttempt: 0,
      lastSuccessfulSync: "2026-08-27T04:00:00.000Z",
    },
    { connectorId: "jira", state: "not_configured", backoffAttempt: 0 },
    {
      connectorId: "jenkins",
      state: "rate_limited",
      backoffAttempt: 3,
      lastError: "429 from https://ci.example/?token=SECRET",
    },
  ],
  meta: { total: 3, limit: 3, offset: 0 },
};

describe("parseConnectorHealth", () => {
  it("reads each connector's state, keyed by connector id", () => {
    const map = parseConnectorHealth(BODY);
    expect(map?.get("github")?.state).toBe("healthy");
    expect(map?.get("jira")?.state).toBe("not_configured");
    expect(map?.get("jenkins")?.state).toBe("rate_limited");
  });

  it("parses lastSuccessfulSync from its ISO string, and omits it when absent", () => {
    const map = parseConnectorHealth(BODY);
    expect(map?.get("github")?.lastSuccessfulSyncMs).toBe(Date.parse("2026-08-27T04:00:00.000Z"));
    expect(map?.get("jira")?.lastSuccessfulSyncMs).toBeUndefined();
  });

  it("never carries lastError through — it is free-form upstream text bound for a page DOM", () => {
    const map = parseConnectorHealth(BODY);
    // Asserted on the whole entry, not on a named field: a future editor adding
    // `lastError` to ConnectorHealth would have to delete this line to do it.
    expect(JSON.stringify([...(map ?? [])])).not.toContain("SECRET");
    expect(JSON.stringify([...(map ?? [])])).not.toContain("lastError");
  });

  it("degrades an unrecognised state to unknown rather than throwing", () => {
    // Upstream may add an eighth state. A client that throws on it would take the
    // whole panel down; a client that trusts it would render a state it cannot explain.
    const map = parseConnectorHealth({
      data: [{ connectorId: "linear", state: "quarantined", backoffAttempt: 0 }],
    });
    expect(map?.get("linear")?.state).toBe("unknown");
  });

  it("returns null for a body that is not the expected shape", () => {
    expect(parseConnectorHealth(null)).toBeNull();
    expect(parseConnectorHealth({})).toBeNull();
    expect(parseConnectorHealth({ data: "nope" })).toBeNull();
  });

  it("skips a malformed row rather than failing the whole read", () => {
    // One bad row must not cost the user every other connector's status.
    const map = parseConnectorHealth({
      data: [{ state: "healthy" }, { connectorId: "github", state: "healthy" }],
    });
    expect(map?.size).toBe(1);
    expect(map?.get("github")?.state).toBe("healthy");
  });

  it("ignores a lastSuccessfulSync that is not a parseable date", () => {
    const map = parseConnectorHealth({
      data: [{ connectorId: "github", state: "healthy", lastSuccessfulSync: "soon" }],
    });
    expect(map?.get("github")?.lastSuccessfulSyncMs).toBeUndefined();
  });
});

describe("gatePolicy", () => {
  it("runs the lanes when the connector is healthy, and says nothing", () => {
    expect(gatePolicy("healthy")).toEqual({ lanes: true, note: null });
  });

  it("runs the lanes with a caveat when the answers are real but may be stale", () => {
    // degraded/rate_limited/paused all mean "syncing is impaired", not "cannot
    // answer" — the indexed items are still real, just possibly missing the newest.
    for (const state of ["degraded", "rate_limited", "paused"] as const) {
      const policy = gatePolicy(state);
      expect(policy.lanes).toBe(true);
      expect(policy.note).not.toBeNull();
    }
  });

  it("withholds the lanes when the connector cannot answer", () => {
    for (const state of ["not_configured", "unauthenticated", "error"] as const) {
      const policy = gatePolicy(state);
      expect(policy.lanes).toBe(false);
      expect(policy.note).not.toBeNull();
    }
  });

  it("gives not_configured and unauthenticated different notes", () => {
    // Upstream keeps these apart deliberately: one means no credential was ever
    // stored, the other that one was presented and rejected. Different problems,
    // different remedies — collapsing them is what made an upstream bug take an hour.
    expect(gatePolicy("not_configured").note).not.toBe(gatePolicy("unauthenticated").note);
  });

  it("does not assert what the user did or failed to do for not_configured", () => {
    // It is also the state of a connector configured a minute ago that has not yet
    // ticked, so the copy says what is KNOWN: Nimbus has never synced this service.
    const note = gatePolicy("not_configured").note ?? "";
    expect(note).toMatch(/never synced/i);
    expect(note).not.toMatch(/you have not|you did not|set (it |this )?up/i);
  });

  it("names no CLI command in any note", () => {
    // /v1/connectors supplies no remedy string, and parseScopeGap set the precedent:
    // absent a machine-readable detail, guidance stays generic rather than invented.
    //
    // Matched against COMMAND SHAPES, not against the word "Nimbus" — the notes name
    // the product legitimately ("Nimbus has never synced …"), so a bare /nimbus \w+/
    // would fail on correct copy. These are the CLI's actual verbs.
    for (const state of CONNECTOR_STATES) {
      expect(gatePolicy(state).note ?? "").not.toMatch(/nimbus (clip|connector|sync|auth|pair)\b/i);
      expect(gatePolicy(state).note ?? "").not.toContain("`");
    }
  });

  it("is silent and ungated when the state is unknown", () => {
    // An older gateway loses the gate, not the feature — and is not nagged about it.
    expect(gatePolicy("unknown")).toEqual({ lanes: true, note: null });
  });
});
