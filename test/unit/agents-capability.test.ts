// test/unit/agents-capability.test.ts
import { describe, expect, it } from "vitest";
import {
  fetchAgentRoster,
  ITEM_ARM_FLOOR,
  meetsFloor,
} from "../../src/background/agents-capability.ts";

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
    expect(roster).toEqual({ names: ["why", "impact"] });
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
      expect(roster, origin).toEqual({ names: ["why"] });
    }
  });
});
