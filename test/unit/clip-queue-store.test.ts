// test/unit/clip-queue-store.test.ts
import { afterEach, describe, expect, test } from "vitest";
import { getQueue, updateQueue } from "../../src/background/clip-queue-store.ts";
import { enqueue, type QueuedClip } from "../../src/shared/queue.ts";
import { installChromeStub } from "./chrome-stub.ts";

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

function entry(url: string): QueuedClip {
  return {
    payload: { url, title: url, mode: "article", body: "b", tags: [], capturedAt: 1 },
    queuedAt: 1,
    attempts: 0,
  };
}

describe("getQueue", () => {
  test("returns [] when unset or malformed; keeps only well-formed entries", async () => {
    installChromeStub();
    expect(await getQueue()).toEqual([]);
    installChromeStub({ storage: { clipQueue: [entry("a"), { bad: true }] } });
    expect((await getQueue()).map((e) => e.payload.url)).toEqual(["a"]);
  });
});

describe("updateQueue", () => {
  test("applies the mutator and persists", async () => {
    installChromeStub({ storage: { clipQueue: [] } });
    const out = await updateQueue((q) => enqueue(q, entry("a")));
    expect(out.map((e) => e.payload.url)).toEqual(["a"]);
    expect((await getQueue()).map((e) => e.payload.url)).toEqual(["a"]);
  });

  test("serializes concurrent read-modify-writes (no lost update)", async () => {
    // Both calls are invoked synchronously, so without the lock both reads would see
    // [] at the first await and each write a single entry — the result would be ["a"]
    // or ["b"], never ["a","b"]. This assertion therefore fails the moment the
    // promise-chain lock is removed (a real regression guard, not just a happy path).
    installChromeStub({ storage: { clipQueue: [] } });
    const p1 = updateQueue((q) => enqueue(q, entry("a")));
    const p2 = updateQueue((q) => enqueue(q, entry("b")));
    await Promise.all([p1, p2]);
    expect((await getQueue()).map((e) => e.payload.url)).toEqual(["a", "b"]);
  });

  test("quota fail-safe: on a write rejection while growing, evicts oldest and retries", async () => {
    installChromeStub({ failFirstSet: true, storage: { clipQueue: [entry("a"), entry("b")] } });
    const out = await updateQueue((q) => enqueue(q, entry("c")));
    expect(out.map((e) => e.payload.url)).toEqual(["b", "c"]);
    expect((await getQueue()).map((e) => e.payload.url)).toEqual(["b", "c"]);
  });
});
