// test/unit/passage-collect.test.ts
import { describe, expect, test, vi } from "vitest";
import { collectPassage, type PassageCollectDeps } from "../../src/background/passage-collect.ts";
import { addPassage, type Passage, type PassageUpdate } from "../../src/shared/passage.ts";
import type { CaptureResult, ToastState } from "../../src/shared/types.ts";

const CAPTURE: CaptureResult = {
  url: "http://h/a#frag",
  title: "A page",
  mode: "selection",
  body: "the selected words",
  readableFound: true,
};

function deps(over: Partial<PassageCollectDeps> = {}): {
  deps: PassageCollectDeps;
  held: Passage[];
  toasts: ToastState[];
} {
  const held: Passage[] = [];
  const toasts: ToastState[] = [];
  const base: PassageCollectDeps = {
    capture: async () => ({ ok: true, capture: CAPTURE }),
    update: async (mutator) => {
      const res: PassageUpdate = mutator(held);
      if (res.ok) {
        held.length = 0;
        held.push(...res.all);
      }
      return res;
    },
    showFeedback: async (_tabId, state) => {
      toasts.push(state);
    },
    now: () => 1000,
    ...over,
  };
  return { deps: base, held, toasts };
}

describe("collectPassage", () => {
  test("stores the captured selection under the page's own url and title", async () => {
    const { deps: d, held } = deps();
    await collectPassage(d, 7);
    expect(held).toEqual([
      { url: "http://h/a#frag", title: "A page", text: "the selected words", at: 1000 },
    ]);
  });

  test("confirms with a toast naming how many passages the page now holds", async () => {
    const { deps: d, toasts } = deps();
    await collectPassage(d, 7);
    await collectPassage(
      { ...d, capture: async () => ({ ok: true, capture: { ...CAPTURE, body: "more words" } }) },
      7,
    );
    expect(toasts[0]).toEqual({ variant: "success", text: "Added — 1 passage from this page." });
    expect(toasts[1]).toEqual({ variant: "success", text: "Added — 2 passages from this page." });
  });

  test("an empty capture says nothing was selected and stores nothing", async () => {
    const {
      deps: d,
      held,
      toasts,
    } = deps({
      capture: async () => ({ ok: false, reason: "empty" }),
    });
    await collectPassage(d, 7);
    expect(held).toEqual([]);
    expect(toasts).toEqual([{ variant: "error", text: "Nothing selected." }]);
  });

  test("a restricted page reports through the badge fallback", async () => {
    const restrictedFlags: (boolean | undefined)[] = [];
    const { deps: d } = deps({
      capture: async () => ({ ok: false, reason: "restricted" }),
      showFeedback: async (_tabId, _state, restricted) => {
        restrictedFlags.push(restricted);
      },
    });
    await collectPassage(d, 7);
    expect(restrictedFlags).toEqual([true]);
  });

  test("an injection failure gets the same toast as restricted, but not the badge fallback", async () => {
    // The distinction between the two branches IS the point: both reach
    // CANT_INJECT's text, but only "restricted" is un-injectable — an
    // "injection-failed" page can still host a toast, so `restricted` must be
    // falsy here even though the wording is identical to the restricted case.
    const restrictedFlags: (boolean | undefined)[] = [];
    const { deps: d, toasts } = deps({
      capture: async () => ({ ok: false, reason: "injection-failed" }),
      showFeedback: async (_tabId, state, restricted) => {
        toasts.push(state);
        restrictedFlags.push(restricted);
      },
    });
    await collectPassage(d, 7);
    expect(toasts).toEqual([
      { variant: "error", text: "Nimbus can't read a selection on this page." },
    ]);
    expect(restrictedFlags).toEqual([false]);
  });

  test("each refusal reason gets its own words", async () => {
    for (const [reason, text] of [
      ["duplicate", "Already collected."],
      ["page-full", "That page's passages are full."],
      ["collection-full", "Collection is full — send or clear a brief first."],
      ["storage-full", "Couldn't store that passage."],
    ] as const) {
      const { deps: d, toasts } = deps({ update: async () => ({ ok: false, reason }) });
      await collectPassage(d, 7);
      expect(toasts).toEqual([{ variant: "error", text }]);
    }
  });

  test("a duplicate is refused by the rules, not by the action", async () => {
    // The action must not pre-filter: `addPassage` owns every cap, and a second
    // implementation here could disagree with it.
    const { deps: d, held, toasts } = deps();
    await collectPassage(d, 7);
    await collectPassage(d, 7);
    expect(held).toHaveLength(1);
    expect(toasts[1]).toEqual({ variant: "error", text: "Already collected." });
  });

  test("a failing toast never rejects the collect", async () => {
    const { deps: d, held } = deps({
      showFeedback: () => Promise.reject(new Error("no receiver")),
    });
    await expect(collectPassage(d, 7)).resolves.toBeUndefined();
    expect(held).toHaveLength(1);
  });

  test("the mutator it passes is addPassage's result, unmodified", async () => {
    const update = vi.fn(async (m: (all: readonly Passage[]) => PassageUpdate) => m([]));
    const { deps: d } = deps({ update });
    await collectPassage(d, 7);
    const mutator = update.mock.calls[0]?.[0];
    expect(mutator).toBeDefined();
    expect(mutator?.([])).toEqual(
      addPassage([], {
        url: "http://h/a#frag",
        title: "A page",
        text: "the selected words",
        at: 1000,
      }),
    );
  });
});
