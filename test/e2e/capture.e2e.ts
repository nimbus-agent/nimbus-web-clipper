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
 *
 * Step 7 was split in two. What is left under "7" here — the offer replaced
 * by in-flight feedback, "Saving to Nimbus…" genuinely observed (via the
 * mock's `delayMs`, not a sleep in this file), and the run ending on the
 * terminal line with no confirm box ever shown — is covered. The other half,
 * "Capturing this page…", is now its own step 8 and stays "not yet
 * automated": that phase makes no request to the mock gateway at all (it is
 * `chrome.scripting.executeScript` plus a local DOM read in the tab), so
 * `delayMs` has nothing to hold open for it.
 */
import { expect, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import type { Scenario } from "../../scripts/screenshots/gateway-fixtures.ts";
import { GATEWAY_PATHS } from "../../src/shared/gateway.ts";
import { PANEL_HOST_ID } from "../../src/shared/panel-host.ts";
import { gotoRecognisedPage, togglePanel } from "./helpers.ts";

export const COVERS = [
  "capture-1",
  "capture-2",
  "capture-3",
  "capture-4",
  "capture-6",
  "capture-7",
] as const;

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
    const url = await gotoRecognisedPage(page, h.origin, "/job/widget/7");
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

test("an SPA navigation before the offer is clicked refuses with url-changed, pre-injection", async () => {
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
    // what an SPA route change looks like from the background's side. This
    // pushState happens BEFORE `offer.click()`, so by the time the click's
    // message reaches the worker the tab's LIVE url already differs from the
    // pinned one — `captureTab`'s PRE-injection guard (capture-tab.ts:74)
    // catches this before `capture.js` is ever injected. It is deterministic,
    // not a race: the check runs first and `runCapture` is never called.
    //
    // This does NOT exercise the separate MID-capture guard (capture-tab.ts:
    // 93) — the one that catches a navigation happening DURING the injected
    // capture's own round trip, after `runCapture` has already been called.
    // That branch is covered by test/unit/capture-tab.test.ts instead; see
    // docs/development.md's capture-6 bracket for why.
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
  // The mock deliberately holds the clip POST open — not a sleep in this
  // test, a real reason the response is slow (see `delayMs` on `Scenario`) —
  // long enough that "Saving to Nimbus…" is genuinely, observably in flight
  // rather than a state that only sometimes survives to be caught. On
  // loopback the ingest response would otherwise settle in well under a
  // millisecond, too fast for even an auto-retrying assertion to reliably
  // see. 1500ms, not a smaller value: this assertion has to catch the
  // transient inside whatever window Playwright's assertion polling actually
  // samples on a loaded CI runner, and missing it is a hard 30s timeout (the
  // status element is gone entirely once the run settles) — 1500ms is cheap
  // insurance against that against a 30s per-test timeout.
  const scenario: Scenario = { delayMs: { [GATEWAY_PATHS.ingest]: 1500 } };
  const h = await launchExtension({ scenario });
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
    // — no Send button ever clicked — runs straight through to the terminal
    // line.
    await page.locator(".nimbus-related__capture").click();

    // "Saving to Nimbus…" IS the claim this step makes: that the in-flight
    // feedback does not depend on the preview being on. The delayed ingest
    // response is what makes this an ordinary, auto-retrying assertion
    // instead of a race against a sub-millisecond round trip.
    //
    // NOT asserted here: "Capturing this page…", the line shown while
    // capture.js is read out of the page. That phase makes no request to the
    // mock gateway at all — it is `chrome.scripting.executeScript` plus a
    // local DOM read — so `delayMs` has nothing to hold open for it.
    // docs/development.md's own step 8 (split out of what used to be a
    // second half of step 7) is left "not yet automated" for exactly this
    // reason.
    await expect(
      page.locator(".nimbus-related__status", { hasText: "Saving to Nimbus" }),
    ).toBeVisible();

    await expect(
      page.locator(".nimbus-related__status", { hasText: "Saved a copy of" }),
    ).toBeVisible();
    await expect(page.locator(".nimbus-related__fetch-send")).toHaveCount(0);
  } finally {
    await h.close();
  }
});
