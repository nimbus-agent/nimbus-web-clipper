// src/shared/capture-offer.ts
// Where the panel offers to capture the page, and what makes a resolved item a
// captured copy. Pure — no DOM, no messaging — because both rules are consulted
// from two files and neither belongs inside a 900-line renderer.
import type { HeaderState } from "../panel/panel-view.ts";
import { CLIP_SERVICE, CLIP_TYPE } from "./types.ts";

/**
 * True when the gateway has nothing left to try, so a captured copy is better
 * than nothing.
 *
 * Capture is deliberately the WORSE answer: a connector models a pull request
 * properly and a DOM scrape produces a lower-fidelity copy of the same thing. So
 * a `not-indexed` page that is still `fetchable` returns false — C3.1's fetch
 * button is on that state and is the better answer. Capture becomes reachable
 * there only once a fetch has failed terminally, which moves the panel to
 * `fetch-blocked`, one of the arms below.
 *
 * A rate-limited fetch retry is likewise not an offer: it lives in
 * `fetch-retry`, which is not listed here, because waiting seconds beats
 * scraping.
 *
 * There is no `unresolvable` arm here, and there never should be: `HeaderState`
 * has none. `panel-in-page.ts` deliberately collapses that resolve outcome into
 * `not-indexed`, carrying `fetchable` through — an unresolvable answer reads to
 * the user as "not indexed" either way, so distinguishing it is a client-code
 * concern, not a user-facing one. Adding a case for it here would be dead code
 * the type system cannot catch.
 */
export function offersCapture(state: HeaderState): boolean {
  switch (state.kind) {
    case "unrecognised":
    case "fetch-blocked":
      return true;
    case "not-indexed":
      return !state.fetchable;
    default:
      return false;
  }
}

/**
 * True when this item is a copy the user captured, rather than data a connector
 * synced.
 *
 * Keyed on the ITEM, never on "we just captured it" — a page captured last week
 * resolves like anything else, and flagging only the fresh case would present it
 * as connector data seven days later. Same state, same words, no expiry.
 */
export function isCapturedCopy(item: { service: string; type: string }): boolean {
  return item.service === CLIP_SERVICE && item.type === CLIP_TYPE;
}
