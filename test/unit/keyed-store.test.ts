// test/unit/keyed-store.test.ts
//
// The two primitives every persisted store in the worker is built on.
//
// `agent-run-store.test.ts` and `brief-run-store.test.ts` already prove that
// serialisation happens and that a failing guard drops an entry. What they do
// NOT reach is the re-arm after a REJECTED write, and the fact that each store
// gets a lock of its own — both were provably untested when this module was
// extracted (breaking either left the whole suite green), and both are the kind
// of failure that shows up as "the store went read-only" rather than as an
// error anyone can see.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createWriteChain, readGuarded } from "../../src/background/keyed-store.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

let harness: ChromeHarness;

beforeEach(() => {
  harness = installChromeMock();
});

afterEach(() => {
  harness.restore();
});

describe("createWriteChain", () => {
  test("a REJECTED write does not wedge the lock for every write after it", async () => {
    // Without the re-arm, the next call awaits a promise that is already
    // rejected, its work never runs, and the store is silently read-only for the
    // life of the worker. A single quota error would do it.
    const exclusively = createWriteChain();

    await expect(exclusively(async () => Promise.reject(new Error("quota")))).rejects.toThrow(
      "quota",
    );

    await expect(exclusively(async () => "written")).resolves.toBe("written");
  });

  test("the rejection reaches the caller rather than being swallowed", async () => {
    // The re-arm must not turn a failed write into a silent success: the caller
    // is the one that decides whether to retry or surface it.
    const exclusively = createWriteChain();
    await expect(exclusively(async () => Promise.reject(new Error("quota")))).rejects.toThrow(
      "quota",
    );
  });

  test("each store gets a lock of its own", async () => {
    // One shared chain would make a slow or wedged write to one store stall
    // every other store behind it — the poll loop's run store waiting on the
    // clip queue, for no reason at all.
    const first = createWriteChain();
    const second = createWriteChain();
    const order: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const held = first(async () => {
      await gate;
      order.push("first");
    });
    await second(async () => {
      order.push("second");
    });

    expect(order).toEqual(["second"]);
    release();
    await held;
    expect(order).toEqual(["second", "first"]);
  });
});

describe("readGuarded", () => {
  const isNumberEntry = (v: unknown): v is { n: number } =>
    typeof v === "object" && v !== null && typeof (v as { n?: unknown }).n === "number";

  test.each([
    ["a null written over the store", null],
    ["a bare string", "not an object"],
    ["a number", 7],
  ])("%s reads as an empty store rather than throwing", async (_name, stored) => {
    // chrome.storage is external input. A hand-edited or half-written value must
    // not take the whole store down with it — and `Object.entries(null)` THROWS,
    // so without the guard the null case takes the caller's read with it.
    harness.storage.set("k", stored);
    await expect(readGuarded("k", isNumberEntry)).resolves.toEqual({});
  });

  test("an absent key reads as an empty store", async () => {
    await expect(readGuarded("never-written", isNumberEntry)).resolves.toEqual({});
  });

  test("keeps the entries that pass and drops the ones that do not, by KEY", async () => {
    harness.storage.set("k", { good: { n: 1 }, bad: { n: "1" }, alsoGood: { n: 2 }, nope: null });
    await expect(readGuarded("k", isNumberEntry)).resolves.toEqual({
      good: { n: 1 },
      alsoGood: { n: 2 },
    });
  });
});
