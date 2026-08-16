// Shared test-only helpers for the e2e suites.
//
// `togglePanel` was duplicated verbatim across three suites and inlined in a
// fourth, and the "load /sample, then move the tab on via pushState onto a
// recognised path" recipe was repeated three times more. Both live here
// instead. `test/unit/e2e-coverage.test.ts` only scans `test/e2e/*.e2e.ts`
// files for a `COVERS` block, so this file — matched by neither the glob nor
// Playwright's `testMatch` — cannot trip the non-empty-`COVERS` check or get
// picked up as a spec of its own.
import type { Page } from "@playwright/test";
import type { Harness } from "../../scripts/e2e/launch.ts";

/**
 * Injects panel.js into the tab currently on `url`, queried by URL rather
 * than `lastFocusedWindow`: window focus is reliable on a desktop and
 * occasionally is not on a headless CI container, and every caller just set
 * `url`, so it cannot be ambiguous. panel.js is self-toggling: a first call
 * mounts it, a second call closes it, a third reopens it fresh — this is how
 * every e2e suite simulates "close and reopen the panel".
 */
export async function togglePanel(sw: Harness["sw"], url: string): Promise<void> {
  await sw.evaluate(async (target) => {
    const [tab] = await chrome.tabs.query({ url: target });
    if (tab?.id === undefined) {
      throw new Error(`e2e: no tab matched ${target}`);
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["panel.js"] });
  }, url);
}

/**
 * Loads the mock's one servable page, then moves the tab on via the History
 * API — same-document, no request — to `path`, which some seeded `origins`
 * entry recognises. `chrome.tabs.get` (and therefore recognise()/resolve)
 * sees this exactly as it would a real SPA-driven route change. Brings the
 * page to the front (every caller needs that before touching the panel) and
 * returns the resulting full url.
 */
export async function gotoRecognisedPage(
  page: Page,
  origin: string,
  path: string,
): Promise<string> {
  await page.goto(`${origin}/sample`);
  await page.evaluate((p) => history.pushState({}, "", p), path);
  await page.bringToFront();
  return `${origin}${path}`;
}
