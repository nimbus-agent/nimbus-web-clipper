// src/background/capture-tab.ts
// Inject capture.js into one tab and read the result back, with the two refusals
// that must happen BEFORE injection.
//
// `isRestrictedUrl` (the scheme guard) is the one thing actually SHARED with
// the hotkey path — `quick-clip.ts` imports it and re-checks it itself before
// calling its own `runCapture`. Everything else here — the injection call,
// the post-capture `url-changed` re-check, and the empty-body refusal — is
// this panel-capture path's own; `quick-clip.ts` still calls `deps.runCapture`
// directly and handles its own failures, it does not call `captureTab`.
//
// The empty-body rule genuinely differs between the two, and deliberately so:
// this function refuses `capture.body === ""` for EVERY mode, while
// `quick-clip.ts` refuses it only for `mode === "selection"` — an empty
// ARTICLE capture there is not specially refused and is clipped as-is. This
// path's stricter rule is the right one and is not being loosened to match:
// refusing an empty article capture, rather than saving a hollow item, is
// what this last-resort flow exists to get right.
import type { CaptureError, CaptureResult } from "../shared/types.ts";

const RESTRICTED_SCHEMES = new Set([
  "chrome:",
  "chrome-extension:",
  "moz-extension:",
  "about:",
  "edge:",
  "view-source:",
]);

/** True for pages a content script can't be injected into (also un-capturable). */
export function isRestrictedUrl(url: string): boolean {
  try {
    return RESTRICTED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return true;
  }
}

export interface CaptureTabDeps {
  readonly tabUrl: (tabId: number) => Promise<string | null>;
  readonly runCapture: (tabId: number, mode: "article" | "selection") => Promise<CaptureResult>;
}

export type CaptureOutcome =
  | { readonly ok: true; readonly capture: CaptureResult }
  | { readonly ok: false; readonly reason: CaptureError };

/**
 * `expectedUrl` is the panel's PINNED url. When given, the tab must still be on
 * it or this refuses with `url-changed`.
 *
 * The DOM cannot be pinned: on an SPA the pinned url is a string the panel
 * remembers while the live DOM is wherever the user navigated. Capturing that DOM
 * under the pinned url would file the new page's content against the old page's
 * address — a corrupt index entry, and worse than refusing. The hotkey path omits
 * `expectedUrl` because it has no pinned page to be wrong about.
 *
 * Both refusals happen BEFORE `runCapture`, deliberately: the scheme guard is a
 * security boundary (the caller may be a content script sending an arbitrary url),
 * and injecting first would defeat it.
 */
export async function captureTab(
  deps: CaptureTabDeps,
  tabId: number,
  mode: "article" | "selection",
  expectedUrl?: string,
): Promise<CaptureOutcome> {
  const live = await deps.tabUrl(tabId).catch(() => null);
  // Fail closed on an unknown url: "we could not read the tab" is not evidence
  // the tab is safe to inject into.
  if (live === null || isRestrictedUrl(live)) {
    return { ok: false, reason: "restricted" };
  }
  if (expectedUrl !== undefined && live !== expectedUrl) {
    return { ok: false, reason: "url-changed" };
  }
  let capture: CaptureResult;
  try {
    capture = await deps.runCapture(tabId, mode);
  } catch {
    return { ok: false, reason: "injection-failed" };
  }
  // Checked AGAIN, after the capture. The pre-check above closes the window
  // before injection; this one closes the window *during* it. `runCapture`
  // injects and awaits a round-trip into the page, and an SPA can change route
  // inside that window — so the pre-check alone would still let the new page's
  // DOM be filed under the old address, which is the corrupt entry this whole
  // rule exists to prevent.
  //
  // `capture.url` is authoritative for this: capture-in-page.ts:18 reads
  // `location.href` INSIDE the page at capture time, so it describes what was
  // actually captured rather than what we asked for.
  if (expectedUrl !== undefined && capture.url !== expectedUrl) {
    return { ok: false, reason: "url-changed" };
  }
  if (capture.body === "") {
    return { ok: false, reason: "empty" };
  }
  return { ok: true, capture };
}
