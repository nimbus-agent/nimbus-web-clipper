// test/unit/discovery.test.ts
import { describe, expect, test } from "vitest";
import {
  DISCOVERY_CANDIDATES,
  type ProbeResult,
  pickReachable,
} from "../../src/shared/discovery.ts";
import { isLoopbackOrigin } from "../../src/shared/gateway.ts";

describe("discovery candidates", () => {
  test("probes exactly two origins — never a port range", () => {
    expect(DISCOVERY_CANDIDATES).toHaveLength(2);
  });

  test("127.0.0.1 is probed first", () => {
    expect(DISCOVERY_CANDIDATES[0]).toBe("http://127.0.0.1:7474");
    expect(DISCOVERY_CANDIDATES[1]).toBe("http://localhost:7474");
  });

  test("every candidate is a loopback origin (I6)", () => {
    for (const origin of DISCOVERY_CANDIDATES) {
      expect(isLoopbackOrigin(origin)).toBe(true);
    }
  });
});

describe("pickReachable", () => {
  test("returns the first reachable origin in candidate order", () => {
    const results: ProbeResult[] = [
      { origin: "http://127.0.0.1:7474", reachable: true },
      { origin: "http://localhost:7474", reachable: true },
    ];
    expect(pickReachable(results)).toBe("http://127.0.0.1:7474");
  });

  test("falls through to a later candidate when the first is unreachable", () => {
    const results: ProbeResult[] = [
      { origin: "http://127.0.0.1:7474", reachable: false },
      { origin: "http://localhost:7474", reachable: true },
    ];
    expect(pickReachable(results)).toBe("http://localhost:7474");
  });

  test("no reachable candidate → null, so the manual field stays the answer", () => {
    const results: ProbeResult[] = [
      { origin: "http://127.0.0.1:7474", reachable: false },
      { origin: "http://localhost:7474", reachable: false },
    ];
    expect(pickReachable(results)).toBeNull();
  });

  test("empty results → null", () => {
    expect(pickReachable([])).toBeNull();
  });
});
