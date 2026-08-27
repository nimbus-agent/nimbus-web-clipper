import { describe, expect, it } from "vitest";
import { parseConnectorHealth } from "../../src/shared/connector-health.ts";

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
