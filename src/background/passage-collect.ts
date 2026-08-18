// src/background/passage-collect.ts
// The collect gesture, end to end: capture the live selection, hand it to the
// collection's rules, and report what happened in the page.
//
// Shaped like `quick-clip.ts` — pure orchestration over injected seams — for the
// same reason: the whole action is testable without a browser. It reuses
// `captureTab` rather than the menu click's `info.selectionText`, which the
// browser truncates without saying so; a silently cut excerpt filed under the
// user's own selection is exactly the defect `BriefSource.truncated` exists to
// prevent.

import {
  addPassage,
  groupKey,
  type Passage,
  type PassageRefusal,
  type PassageUpdate,
} from "../shared/passage.ts";
import type { ToastState } from "../shared/types.ts";
import type { CaptureOutcome } from "./capture-tab.ts";

const REFUSAL_TEXT: Record<PassageRefusal, string> = {
  duplicate: "Already collected.",
  "page-full": "That page's passages are full.",
  "collection-full": "Collection is full — send or clear a brief first.",
  "storage-full": "Couldn't store that passage.",
};

const CANT_READ: ToastState = { variant: "error", text: "Nothing selected." };
const CANT_INJECT: ToastState = {
  variant: "error",
  text: "Nimbus can't read a selection on this page.",
};

export interface PassageCollectDeps {
  readonly capture: (tabId: number) => Promise<CaptureOutcome>;
  readonly update: (m: (all: readonly Passage[]) => PassageUpdate) => Promise<PassageUpdate>;
  readonly showFeedback: (tabId: number, state: ToastState, restricted?: boolean) => Promise<void>;
  readonly now: () => number;
}

function heldForPage(all: readonly Passage[], url: string): number {
  const key = groupKey(url);
  return all.filter((passage) => groupKey(passage.url) === key).length;
}

/**
 * Collect the current selection in `tabId` into the brief collection.
 *
 * Never throws: a menu click has nowhere to report a rejection, so every path
 * ends in a toast (or the badge, when the page cannot host one).
 */
export async function collectPassage(deps: PassageCollectDeps, tabId: number): Promise<void> {
  const outcome = await deps.capture(tabId);
  if (!outcome.ok) {
    // `restricted` is the one reason the page cannot host a toast at all, so it
    // takes the badge fallback. This is not the collection owning the badge —
    // the queue owns that; this is the shipped un-injectable-page path.
    const state = outcome.reason === "empty" ? CANT_READ : CANT_INJECT;
    await deps.showFeedback(tabId, state, outcome.reason === "restricted").catch(() => undefined);
    return;
  }
  const passage: Passage = {
    url: outcome.capture.url,
    title: outcome.capture.title,
    text: outcome.capture.body,
    at: deps.now(),
  };
  const res = await deps.update((all) => addPassage(all, passage));
  const state: ToastState = res.ok
    ? {
        variant: "success",
        text: `Added — ${heldForPage(res.all, passage.url)} ${
          heldForPage(res.all, passage.url) === 1 ? "passage" : "passages"
        } from this page.`,
      }
    : { variant: "error", text: REFUSAL_TEXT[res.reason] };
  await deps.showFeedback(tabId, state).catch(() => undefined);
}
