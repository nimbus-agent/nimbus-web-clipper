import { describe, expect, test } from "vitest";
import { singleFlight } from "../../src/background/single-flight.ts";

describe("singleFlight", () => {
  test("coalesces concurrent calls into a single in-flight run", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = singleFlight(async () => {
      calls += 1;
      await gate;
      return calls;
    });

    const a = run();
    const b = run(); // invoked while `a` is still in flight → same promise, no second call
    expect(calls).toBe(1);

    release();
    expect(await a).toBe(1);
    expect(await b).toBe(1);
  });

  test("runs again after the previous run settles", async () => {
    let calls = 0;
    const run = singleFlight(async () => {
      calls += 1;
      return calls;
    });
    expect(await run()).toBe(1);
    expect(await run()).toBe(2); // prior run settled → a fresh run starts
  });

  test("clears the in-flight slot even when the run rejects (not stuck on a rejection)", async () => {
    let calls = 0;
    const run = singleFlight(async () => {
      calls += 1;
      throw new Error("boom");
    });
    await expect(run()).rejects.toThrow("boom");
    await expect(run()).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });
});
