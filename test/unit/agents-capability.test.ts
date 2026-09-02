// test/unit/agents-capability.test.ts
import { describe, expect, it } from "vitest";
import {
  type AgentRoster,
  fetchAgentRoster,
  ITEM_ARM_FLOOR,
  meetsFloor,
  offeredLanes,
} from "../../src/background/agents-capability.ts";
import { AGENT_LANES } from "../../src/shared/types.ts";

function stubFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const deps = (doFetch: typeof fetch) => ({
  origin: "http://127.0.0.1:7474",
  token: "t",
  doFetch,
});

describe("fetchAgentRoster", () => {
  it("returns the published names on 200", async () => {
    const roster = await fetchAgentRoster(deps(stubFetch(200, { agents: ["why", "impact"] })));
    expect(roster).toEqual({ names: ["why", "impact"], version: null });
  });

  it("treats a 404 as a gateway older than the route, and says nothing about it", async () => {
    expect(await fetchAgentRoster(deps(stubFetch(404, { error: "not_found" })))).toEqual({
      unavailable: true,
    });
  });

  it("treats an auth failure as unlearned, not as an empty roster", async () => {
    // The lanes themselves report a token problem far more precisely than a
    // roster read can; here it means only that we did not learn the set.
    for (const status of [401, 403, 500]) {
      expect(await fetchAgentRoster(deps(stubFetch(status, {})))).toEqual({ unavailable: true });
    }
  });

  it("treats a malformed body as unavailable, NEVER as an empty roster", async () => {
    // An empty roster would withhold every lane. Not knowing must leave the
    // panel exactly as it renders today.
    for (const body of [{ agents: "nope" }, {}, { agents: [1, 2] }, null]) {
      expect(await fetchAgentRoster(deps(stubFetch(200, body)))).toEqual({ unavailable: true });
    }
  });

  it("treats an unreachable gateway as unavailable", async () => {
    const throwing = (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    expect(await fetchAgentRoster(deps(throwing))).toEqual({ unavailable: true });
  });
});

describe("meetsFloor", () => {
  it("accepts a released gateway at or above the floor", () => {
    expect(meetsFloor("2.19.0", "2.19.0")).toBe(true);
    expect(meetsFloor("2.20.1", "2.19.0")).toBe(true);
    expect(meetsFloor("3.0.0", "2.19.0")).toBe(true);
  });

  it("rejects an older release", () => {
    expect(meetsFloor("2.18.0", "2.19.0")).toBe(false);
    expect(meetsFloor("2.18.9", "2.19.0")).toBe(false);
    expect(meetsFloor("1.99.99", "2.19.0")).toBe(false);
  });

  it("accepts a development build", () => {
    // Otherwise the lanes are off for exactly the people building them, and in
    // the e2e job that exists to prove they work.
    expect(meetsFloor("0.0.0", "2.19.0")).toBe(true);
    expect(meetsFloor("0.0.0-dev", "2.19.0")).toBe(true);
  });

  it("accepts a prerelease of the floor", () => {
    expect(meetsFloor("2.19.0-rc.1", "2.19.0")).toBe(true);
  });

  it("ignores build metadata, which semver excludes from precedence", () => {
    expect(meetsFloor("2.19.0+build.1234", "2.19.0")).toBe(true);
    expect(meetsFloor("2.19.0-beta.2+build.1234", "2.19.0")).toBe(true);
    // And a naive parse would read `0+build.1` as a patch number rather than 0.
    expect(meetsFloor("2.18.0+build.99", "2.19.0")).toBe(false);
  });

  it("fails closed on anything it cannot parse", () => {
    for (const v of [null, "garbage", "2.19", "2.19.x", "", "v2.19.0"]) {
      expect(meetsFloor(v, "2.19.0"), String(v)).toBe(false);
    }
  });

  it("names a floor that is a real semver", () => {
    expect(meetsFloor(ITEM_ARM_FLOOR, ITEM_ARM_FLOOR)).toBe(true);
  });
});

describe("fetchAgentRoster — the token never leaves loopback", () => {
  it("refuses a non-loopback origin without issuing the request", async () => {
    // The request carries the bearer token, so the interesting assertion is not the
    // return value but that `doFetch` is never reached at all.
    let called = 0;
    const spy = (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    for (const origin of [
      "https://evil.example",
      "http://127.0.0.1.attacker.com",
      "https://127.0.0.1:7474",
      "http://[::1]:7474".replace("[::1]", "example.com"),
    ]) {
      expect(await fetchAgentRoster({ origin, token: "t", doFetch: spy })).toEqual({
        unavailable: true,
      });
    }
    expect(called).toBe(0);
  });

  it("still allows the real loopback origins", async () => {
    for (const origin of ["http://127.0.0.1:7474", "http://localhost:7474"]) {
      const roster = await fetchAgentRoster({
        origin,
        token: "t",
        doFetch: stubFetch(200, { agents: ["why"] }),
      });
      expect(roster, origin).toEqual({ names: ["why"], version: null });
    }
  });
});

it("carries the version the gateway published", async () => {
  const roster = await fetchAgentRoster({
    origin: "http://127.0.0.1:7474",
    token: "t",
    doFetch: stubFetch(200, { agents: ["why"], version: "7.6.0" }),
  });
  expect(roster).toEqual({ names: ["why"], version: "7.6.0" });
});

// A gateway that serves the route but predates the field. NOT `unavailable`:
// we learned the names, and withholding every lane because we did not learn a
// version would be a much bigger claim than the one fact we are missing.
it("reads a roster with no version as names plus a null version", async () => {
  const roster = await fetchAgentRoster({
    origin: "http://127.0.0.1:7474",
    token: "t",
    doFetch: stubFetch(200, { agents: ["why"] }),
  });
  expect(roster).toEqual({ names: ["why"], version: null });
});

// A non-string version is a wire answer we do not understand. Fail closed on the
// FIELD (null), not on the whole roster — same reasoning as the missing-field case.
it("treats a non-string version as absent", async () => {
  const roster = await fetchAgentRoster({
    origin: "http://127.0.0.1:7474",
    token: "t",
    doFetch: stubFetch(200, { agents: ["why"], version: 7.6 }),
  });
  expect(roster).toEqual({ names: ["why"], version: null });
});

describe("offeredLanes", () => {
  const roster = (names: string[], version: string | null): AgentRoster => ({ names, version });

  // Not knowing must leave the panel exactly as it renders today. Same degradation
  // the connector-health gate makes when GET /v1/connectors is absent.
  it("returns null when the roster could not be read", () => {
    expect(offeredLanes({ unavailable: true }, "pr")).toBeNull();
  });

  it("withholds a lane the gateway does not publish", () => {
    const offered = offeredLanes(roster(["why", "impact"], "7.6.0"), "pr");
    expect(offered).toContain("why");
    expect(offered).not.toContain("expert");
  });

  // The pr lanes send prUrl / fileOrPrUrl / topicOrFile — arms every gateway has
  // served for releases. They must not be gated on a floor they never needed.
  it("does not floor-gate a pr lane", () => {
    expect(offeredLanes(roster(["why", "impact", "expert"], null), "pr")).toEqual([
      "impact",
      "expert",
      "why",
    ]);
  });

  it("withholds an item-arm lane when the gateway reports no version", () => {
    expect(offeredLanes(roster(["why", "expert", "ownership"], null), "issue")).toEqual([]);
  });

  it("withholds an item-arm lane below the floor", () => {
    expect(offeredLanes(roster(["why", "expert", "ownership"], "7.4.0"), "incident")).toEqual([]);
  });

  it("offers the item-arm lanes at the floor and above", () => {
    expect(offeredLanes(roster(["why", "expert", "ownership"], "7.6.0"), "issue")).toEqual([
      "expert",
      "why",
      "ownership",
    ]);
  });

  // A development build satisfies any floor — the people building these lanes are
  // the ones who most need them on, and the e2e job that proves them runs against
  // exactly such a build.
  it("offers the item-arm lanes to a development build", () => {
    expect(offeredLanes(roster(["why"], "0.0.0-dev"), "issue")).toEqual(["why"]);
  });

  // Order is AGENT_LANES order, which is render order. Note what this does NOT
  // do: `offeredLanes` never applies `LANE_RULES`, so a full roster on a `pr`
  // page returns every published lane, `catchup` and `ownership` included.
  // Whether a lane belongs on this surface is `lanesFor`'s question, and asking
  // it in two places is how the two answers start to disagree.
  it("preserves render order and applies no surface rule", () => {
    expect(offeredLanes(roster([...AGENT_LANES], "7.6.0"), "pr")).toEqual([
      "glossary",
      "impact",
      "expert",
      "why",
      "catchup",
      "decisions",
      "ownership",
    ]);
  });
});
