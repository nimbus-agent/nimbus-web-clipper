import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_HEALTH_TTL_MS,
  readConnectorHealth,
} from "../../src/background/connector-health-store.ts";
import { installChromeMock } from "./helpers/chrome-mock.ts";

const ORIGIN = "http://127.0.0.1:7777";
const HEALTHY = new Map([["github", { state: "healthy" as const }]]);

describe("readConnectorHealth", () => {
  beforeEach(() => {
    installChromeMock();
  });

  it("makes one request for two reads inside the TTL", async () => {
    let calls = 0;
    const deps = {
      getConnectors: async () => {
        calls++;
        return HEALTHY;
      },
    };
    await readConnectorHealth(deps, ORIGIN, 1_000);
    await readConnectorHealth(deps, ORIGIN, 1_000 + CONNECTOR_HEALTH_TTL_MS - 1);
    expect(calls).toBe(1);
  });

  it("reads again once the TTL has passed", async () => {
    // The remedial sequence: a user told a connector is unconfigured leaves,
    // configures it, and comes back. Their next panel open must see the change.
    let calls = 0;
    const deps = {
      getConnectors: async () => {
        calls++;
        return HEALTHY;
      },
    };
    await readConnectorHealth(deps, ORIGIN, 1_000);
    await readConnectorHealth(deps, ORIGIN, 1_000 + CONNECTOR_HEALTH_TTL_MS + 1);
    expect(calls).toBe(2);
  });

  it("coalesces two concurrent reads into one request", async () => {
    let calls = 0;
    const deps = {
      getConnectors: async () => {
        calls++;
        return HEALTHY;
      },
    };
    await Promise.all([
      readConnectorHealth(deps, ORIGIN, 1_000),
      readConnectorHealth(deps, ORIGIN, 1_000),
    ]);
    expect(calls).toBe(1);
  });

  it("does not cache a failed read", async () => {
    // A failure means "could not tell", not "nothing is configured". Caching it
    // would keep a panel ungated for a minute after the gateway came back.
    let calls = 0;
    const deps = {
      getConnectors: async () => {
        calls++;
        return null;
      },
    };
    expect(await readConnectorHealth(deps, ORIGIN, 1_000)).toBeNull();
    expect(await readConnectorHealth(deps, ORIGIN, 1_100)).toBeNull();
    expect(calls).toBe(2);
  });

  it("re-reads when the gateway origin changes", async () => {
    // Re-pairing to a different gateway must not answer from the old one's cache.
    let calls = 0;
    const deps = {
      getConnectors: async () => {
        calls++;
        return HEALTHY;
      },
    };
    await readConnectorHealth(deps, ORIGIN, 1_000);
    await readConnectorHealth(deps, "http://127.0.0.1:9999", 1_100);
    expect(calls).toBe(2);
  });

  it("does not hand one origin's answer to a CONCURRENT read of another", async () => {
    // `singleFlight` is parameterless — one in-flight slot for the whole module.
    // Wrapping the read in it directly would make a concurrent read for a different
    // origin await, and receive, the FIRST origin's health. Reachable while a panel is
    // open during a re-pair to a different gateway. The slot is therefore keyed by
    // origin. The sequential test above cannot catch this; only this one can.
    const seen: string[] = [];
    const deps = {
      getConnectors: async (origin: string) => {
        seen.push(origin);
        return new Map([[origin === ORIGIN ? "github" : "jira", { state: "healthy" as const }]]);
      },
    };
    const [a, b] = await Promise.all([
      readConnectorHealth(deps, ORIGIN, 1_000),
      readConnectorHealth(deps, "http://127.0.0.1:9999", 1_000),
    ]);
    expect(seen).toHaveLength(2);
    expect(a?.has("github")).toBe(true);
    expect(b?.has("jira")).toBe(true);
  });

  it("survives a service-worker restart within the TTL", async () => {
    // The store persists to chrome.storage.local precisely because the worker is
    // evicted between one panel open and the next.
    let calls = 0;
    const deps = {
      getConnectors: async () => {
        calls++;
        return HEALTHY;
      },
    };
    await readConnectorHealth(deps, ORIGIN, 1_000);
    // A fresh module instance, as a restarted worker has: the in-memory in-flight
    // map is gone, chrome.storage.local is not. `vi.resetModules()` + re-import is
    // this repo's established way to do that — see `service-worker.test.ts`, which
    // uses it for every module-evaluation side effect.
    vi.resetModules();
    const fresh = await import("../../src/background/connector-health-store.ts");
    await fresh.readConnectorHealth(deps, ORIGIN, 1_100);
    expect(calls).toBe(1);
  });
});
