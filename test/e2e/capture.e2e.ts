/**
 * Covers `docs/development.md` → "Manual verification — Capture as the last
 * resort (C3.2)".
 *
 * COVERS steps 1, 2, 3, 4, 6 and 7 (ids capture-1..4, capture-6, capture-7).
 * Step 5 ("Update this copy" reports `updated`, and `nimbus search` shows one
 * item for that page, not two) is human: it asserts against a REAL index —
 * this harness's mock gateway holds no index at all, just canned per-request
 * answers keyed by url, so it cannot honestly stand in for "one item, not
 * two". A mock that tried would just be asserting its own bookkeeping.
 */
import { expect, test } from "@playwright/test";
import type { Harness } from "../../scripts/e2e/launch.ts";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import type { Scenario } from "../../scripts/screenshots/gateway-fixtures.ts";
import { PANEL_HOST_ID } from "../../src/shared/panel-host.ts";

export const COVERS = [
  "capture-1",
  "capture-2",
  "capture-3",
  "capture-4",
  "capture-6",
  "capture-7",
] as const;

/**
 * Injects panel.js into the tab currently on `url`, queried by URL rather than
 * `lastFocusedWindow` — see related-lane.e2e.ts's identical helper-site
 * comment for why: window focus is reliable on a desktop and occasionally is
 * not on a headless CI container, and this test just set `url`, so it cannot
 * be ambiguous.
 *
 * panel.js is self-toggling: a first call mounts it, a second call closes it,
 * a third reopens it fresh — this is how every test below simulates "close
 * and reopen the panel".
 */
async function togglePanel(sw: Harness["sw"], url: string): Promise<void> {
  await sw.evaluate(async (target) => {
    const [tab] = await chrome.tabs.query({ url: target });
    if (tab?.id === undefined) {
      throw new Error(`e2e: no tab matched ${target}`);
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["panel.js"] });
  }, url);
}

test("an unrecognised page offers a capture, confirms the save, and forgets it on reopen", async () => {
  const h = await launchExtension();
  try {
    const page = await h.context.newPage();
    const url = `${h.origin}/sample`;
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url);

    // capture-1: nothing recognises this page — the mock's /sample is not
    // under any configured or built-in origin — so the panel's only move is
    // the last-resort capture offer.
    const offer = page.locator(".nimbus-related__capture");
    await expect(offer).toBeVisible();
    await offer.click();

    // The 1.3 preview confirm defaults ON (preview-pref.ts's own fail-safe),
    // so this offer opens a confirm step before anything is sent — same as
    // the popup's own clip confirm. Send it.
    await page.locator(".nimbus-related__fetch-send").click();

    // capture-2: the copy is labelled as ours via the terminal line. This
    // page never reaches resolve (recognition fails before any gateway call —
    // see handleResolve in src/background/handlers.ts), so this line, not a
    // captured header, is the one honest signal here.
    await expect(
      page.locator(".nimbus-related__status", { hasText: "Saved a copy of" }),
    ).toBeVisible();

    // capture-4: close and reopen. No durable header survives — the page is
    // still unrecognised (resolve is never even asked), so it shows the same
    // plain offer again, never "Update this copy".
    await togglePanel(h.sw, url); // close
    await expect(page.locator(`#${PANEL_HOST_ID}`)).toHaveCount(0);
    await togglePanel(h.sw, url); // reopen
    await expect(page.locator(".nimbus-related__capture")).toBeVisible();
    await expect(page.locator(".nimbus-related__recapture")).toHaveCount(0);
  } finally {
    await h.close();
  }
});

/** A resolve answer shaped like a copy the user already saved — `isCapturedCopy`
 *  (src/shared/capture-offer.ts) keys on exactly this service/type pair. */
const CAPTURED_ITEM_RESOLVE = {
  found: true,
  matchKind: "exact",
  item: {
    id: "clip_e2e_0001",
    service: "nimbus",
    type: "web_clip",
    title: "A copy saved earlier",
    url: null,
    modified_at: 1_700_000_000_000,
  },
} as const;

test("a recognised page's captured header survives closing and reopening the panel", async () => {
  // `resolveDefault` rather than a url-keyed `resolve` entry: the mock's port
  // is ephemeral and unknown until `launchExtension` returns, so the exact
  // resolve URL cannot be known at scenario-construction time. Answering every
  // url with the captured item sidesteps that — and is exactly what proves
  // durability: each panel open re-asks resolve from scratch and the mock
  // genuinely answers again, rather than the UI merely remembering state.
  const scenario: Scenario = { resolveDefault: CAPTURED_ITEM_RESOLVE };
  const h = await launchExtension({ scenario });
  try {
    // A custom origin recognised as a Jenkins build page. Any non-"home" kind
    // works here — a "home" recognition (a product's own dashboard) never
    // reaches resolve at all (handleResolve's dedicated branch), so it alone
    // could never show a captured header.
    await h.sw.evaluate(async (origin) => {
      await chrome.storage.local.set({ origins: [{ origin, product: "jenkins" }] });
    }, h.origin);

    // The mock only serves 200 for /sample, so load that first, then move the
    // tab on via the History API — same-document, no request — to a path the
    // seeded origin recognises as a Jenkins build. `chrome.tabs.get` (and
    // therefore recognise()/resolve, and the `chrome.tabs.query` below) sees
    // this exactly as it would a real SPA-driven route change.
    const page = await h.context.newPage();
    await page.goto(`${h.origin}/sample`);
    const url = `${h.origin}/job/widget/7`;
    await page.evaluate((path) => history.pushState({}, "", path), "/job/widget/7");
    await page.bringToFront();
    await togglePanel(h.sw, url);

    // capture-3: the captured header — "Update this copy" — on first open.
    await expect(page.locator(".nimbus-related__recapture")).toBeVisible();

    await togglePanel(h.sw, url); // close
    await expect(page.locator(`#${PANEL_HOST_ID}`)).toHaveCount(0);
    await togglePanel(h.sw, url); // reopen

    // …and still there after a close-and-reopen: a fresh panel instance, a
    // fresh resolve round trip, the same answer.
    await expect(page.locator(".nimbus-related__recapture")).toBeVisible();
  } finally {
    await h.close();
  }
});

test("an SPA navigation before the capture lands refuses with url-changed", async () => {
  const h = await launchExtension();
  try {
    const page = await h.context.newPage();
    const url = `${h.origin}/sample`;
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url);

    const offer = page.locator(".nimbus-related__capture");

    // The panel pinned `url` at mount (`pinnedUrl`, panel-in-page.ts — set
    // once at mount and only ever re-read by the explicit "Re-read page"
    // action, never by the background navigation watcher). A same-document
    // navigation moves the TAB on without moving the panel's pin — exactly
    // what an SPA route change looks like from the background's side. This is
    // deterministic, not a race: `captureTab` (src/background/capture-tab.ts)
    // reads the tab's LIVE url and compares it to the pinned one BEFORE it
    // ever injects capture.js, so the mismatch is already there the instant
    // the click's message reaches the worker.
    await page.evaluate(() => history.pushState({}, "", "/sample-moved"));

    await offer.click();

    // capture-6: refused, not silently filed under the page's old address.
    await expect(
      page.locator(".nimbus-related__capture-refusal", { hasText: "moved on" }),
    ).toBeVisible();
  } finally {
    await h.close();
  }
});

test("with the confirm preview off, one click runs capture through to the terminal line", async () => {
  const h = await launchExtension();
  try {
    // The 1.3 preview pref, seeded directly through the worker rather than
    // driven through the Options UI — see preview-pref.ts: it carries no
    // secret, so both surfaces read and write it the same way.
    await h.sw.evaluate(async () => {
      await chrome.storage.local.set({ "preview-enabled": false });
    });

    const page = await h.context.newPage();
    const url = `${h.origin}/sample`;
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url);

    // capture-7: with no confirm step in between, a SINGLE click on the offer
    // — no Send button ever clicked — reaches the same terminal line as
    // capture-2's ordinary (preview-on) run. Asserting on the two in-flight
    // status lines themselves is deliberately not done here: they are
    // genuinely transient (a network round trip on loopback can settle in
    // under a millisecond), and this suite does not use arbitrary sleeps to
    // try to catch them. The end-to-end claim this step makes — no confirm
    // gate stood in the way — is exactly what "one click, no Send click,
    // terminal line" proves.
    await page.locator(".nimbus-related__capture").click();
    await expect(
      page.locator(".nimbus-related__status", { hasText: "Saved a copy of" }),
    ).toBeVisible();
    await expect(page.locator(".nimbus-related__fetch-send")).toHaveCount(0);
  } finally {
    await h.close();
  }
});
