// test/unit/passage-store.test.ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import { addPassage, type Passage, removeGroup } from "../../src/shared/passage.ts";
import type { ToastState } from "../../src/shared/types.ts";
import { installChromeStub } from "./chrome-stub.ts";

async function load() {
  // Re-imported per test: the module holds a write-chain promise, and a chain
  // carried between tests would serialise unrelated cases together.
  // Reset modules to clear the module cache before each dynamic import.
  vi.resetModules();
  return await import("../../src/background/passage-store.ts");
}

function p(url: string, text: string, at = 1): Passage {
  return { url, title: "T", text, at };
}

describe("passage store", () => {
  beforeEach(() => {
    installChromeStub();
  });

  test("an empty store reads as an empty list", async () => {
    const { getPassages } = await load();
    expect(await getPassages()).toEqual([]);
  });

  test("a write is readable back", async () => {
    const { getPassages, updatePassages } = await load();
    const res = await updatePassages((all: readonly Passage[]) =>
      addPassage(all, p("http://h/a", "one")),
    );
    expect(res.ok).toBe(true);
    expect(await getPassages()).toEqual([p("http://h/a", "one")]);
  });

  test("a refusal from the mutator writes nothing and is returned verbatim", async () => {
    const { getPassages, updatePassages } = await load();
    await updatePassages((all: readonly Passage[]) => addPassage(all, p("http://h/a", "one")));
    const res = await updatePassages((all: readonly Passage[]) =>
      addPassage(all, p("http://h/a", "one", 2)),
    );
    expect(res).toEqual({ ok: false, reason: "duplicate" });
    expect(await getPassages()).toHaveLength(1);
  });

  test("a malformed stored entry is dropped, and the rest survive", async () => {
    installChromeStub({ storage: { passages: [p("http://h/a", "one"), { url: 5 }, "junk"] } });
    const { getPassages } = await load();
    expect(await getPassages()).toEqual([p("http://h/a", "one")]);
  });

  test("a non-array stored value reads as empty", async () => {
    installChromeStub({ storage: { passages: { nope: true } } });
    const { getPassages } = await load();
    expect(await getPassages()).toEqual([]);
  });

  // Refuse, never evict: a passage exists in exactly one place and was put
  // there by hand. The clip queue drops its oldest under pressure; this must
  // not.
  test("a failed write refuses and leaves the held collection intact", async () => {
    installChromeStub({ storage: { passages: [p("http://h/a", "one")] }, failFirstSet: true });
    const { getPassages, updatePassages } = await load();
    const res = await updatePassages((all: readonly Passage[]) =>
      addPassage(all, p("http://h/b", "two", 2)),
    );
    expect(res).toEqual({ ok: false, reason: "storage-full" });
    expect(await getPassages()).toEqual([p("http://h/a", "one")]);
  });

  // A READ failure must refuse too. Left outside the try it rejected instead;
  // `collectPassage` has no try of its own, so the context-menu caller's
  // `.catch(() => undefined)` swallowed it — the user right-clicked and nothing
  // happened at all: no toast, no badge.
  test("a failed read refuses rather than rejecting", async () => {
    installChromeStub({ storage: { passages: [p("http://h/a", "one")] }, failFirstGet: true });
    const { updatePassages } = await load();
    const res = await updatePassages((all: readonly Passage[]) =>
      addPassage(all, p("http://h/b", "two", 2)),
    );
    expect(res).toEqual({ ok: false, reason: "storage-full" });
  });

  // The lock chain is `chain = next.catch(() => undefined)` precisely so a
  // failing update cannot wedge it for later callers. `failFirstGet` only fails
  // once, so the second call here proves the chain kept moving.
  test("a failed update does not wedge the lock for the next caller", async () => {
    installChromeStub({ failFirstGet: true });
    const { getPassages, updatePassages } = await load();
    const failed = await updatePassages((all: readonly Passage[]) =>
      addPassage(all, p("http://h/a", "one")),
    );
    expect(failed).toEqual({ ok: false, reason: "storage-full" });
    const res = await updatePassages((all: readonly Passage[]) =>
      addPassage(all, p("http://h/b", "two", 2)),
    );
    expect(res.ok).toBe(true);
    expect(await getPassages()).toEqual([p("http://h/b", "two", 2)]);
  });

  test("a failed read reaches the user as a toast, not as silence", async () => {
    installChromeStub({ failFirstGet: true });
    const { updatePassages } = await load();
    const { collectPassage } = await import("../../src/background/passage-collect.ts");
    const toasts: ToastState[] = [];
    await collectPassage(
      {
        capture: async () => ({
          ok: true,
          capture: {
            url: "http://h/a",
            title: "A",
            mode: "selection",
            body: "words",
            readableFound: true,
          },
        }),
        update: updatePassages,
        showFeedback: async (_tabId: number, state: ToastState) => {
          toasts.push(state);
        },
        now: () => 1,
      },
      7,
    );
    expect(toasts).toEqual([{ variant: "error", text: "Couldn't store that passage." }]);
  });

  test("concurrent updates each run against freshly-read state", async () => {
    const { getPassages, updatePassages } = await load();
    await Promise.all([
      updatePassages((all: readonly Passage[]) => addPassage(all, p("http://h/a", "one", 1))),
      updatePassages((all: readonly Passage[]) => addPassage(all, p("http://h/b", "two", 2))),
      updatePassages((all: readonly Passage[]) => addPassage(all, p("http://h/c", "three", 3))),
    ]);
    expect((await getPassages()).map((x: Passage) => x.text)).toEqual(["one", "two", "three"]);
  });

  test("a remove is a mutator like any other", async () => {
    const { getPassages, updatePassages } = await load();
    await updatePassages((all: readonly Passage[]) => addPassage(all, p("http://h/a", "one")));
    await updatePassages((all: readonly Passage[]) => addPassage(all, p("http://h/b", "two", 2)));
    await updatePassages((all: readonly Passage[]) => ({
      ok: true,
      all: removeGroup(all, "http://h/a"),
    }));
    expect((await getPassages()).map((x: Passage) => x.text)).toEqual(["two"]);
  });
});
