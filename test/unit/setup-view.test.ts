// test/unit/setup-view.test.ts
import { describe, expect, test } from "vitest";
import { healthLine, stagesFrom } from "../../src/options/setup-view.ts";
import type { ConnectionResponse } from "../../src/shared/messages.ts";

const unpaired: ConnectionResponse = { kind: "connection", paired: false };
const paired: ConnectionResponse = {
  kind: "connection",
  paired: true,
  label: "chrome",
  origin: "http://127.0.0.1:7474",
  pairedAt: 1_000,
  queueDepth: 0,
  reachable: true,
  stale: false,
};

describe("stagesFrom", () => {
  test("a fresh install shows one thing to do", () => {
    expect(stagesFrom(unpaired)).toEqual({
      connect: "active",
      connection: "locked",
      sites: "locked",
      trust: "active",
    });
  });

  test("trust is never locked — it must be readable before pairing", () => {
    expect(stagesFrom(unpaired).trust).toBe("active");
  });

  test("pairing unlocks the rest", () => {
    expect(stagesFrom(paired)).toEqual({
      connect: "done",
      connection: "active",
      sites: "active",
      trust: "active",
    });
  });

  test("a stale token flags stage 1 but does NOT re-lock 2 and 3", () => {
    const stages = stagesFrom({ ...paired, stale: true });
    expect(stages.connect).toBe("needs-attention");
    expect(stages.connection).toBe("active");
    expect(stages.sites).toBe("active");
  });

  test("an unreachable gateway flags stage 1 but does NOT re-lock 2 and 3", () => {
    const stages = stagesFrom({ ...paired, reachable: false });
    expect(stages.connect).toBe("needs-attention");
    expect(stages.connection).toBe("active");
    expect(stages.sites).toBe("active");
  });
});

describe("healthLine", () => {
  test("unpaired says so", () => {
    expect(healthLine(unpaired, 0)).toBe("Not paired.");
  });

  test("a stale token names the fix, not the symptom", () => {
    expect(healthLine({ ...paired, stale: true }, 0)).toContain("Needs re-pairing");
  });

  test("stale wins over unreachable — re-pairing is the actionable one", () => {
    expect(healthLine({ ...paired, stale: true, reachable: false }, 0)).toContain(
      "Needs re-pairing",
    );
  });

  test("unreachable asks about the gateway", () => {
    expect(healthLine({ ...paired, reachable: false }, 0)).toContain("Can't reach");
  });

  test("healthy names the origin", () => {
    expect(healthLine(paired, 0)).toContain("http://127.0.0.1:7474");
  });

  test("a pending queue is reported", () => {
    expect(healthLine({ ...paired, queueDepth: 2 }, 0)).toContain("2 waiting to sync");
  });

  test("never-clipped does not claim a clip time", () => {
    expect(healthLine(paired, 0)).not.toContain("Last clip");
  });

  test("a recorded clip time is shown", () => {
    expect(healthLine({ ...paired, lastClipAt: 1 }, 1)).toContain("Last clip");
  });
});
