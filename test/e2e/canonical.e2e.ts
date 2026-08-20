/**
 * Covers `docs/development.md` → "Manual verification — Capture as the last
 * resort (C3.2)", steps 9 and 10 (ids canonical-1, canonical-2).
 *
 * `resolveCanonical` (src/shared/canonical.ts) and the two call sites that
 * use it (`capture-in-page.ts`, `panel-in-page.ts`) are already reached by
 * `test/unit/capture-in-page.test.ts` and `test/unit/panel-in-page.test.ts`
 * through jsdom — those cover every rejection reason and the absolutise path
 * in isolation. What jsdom cannot give is a REAL page in a REAL Chromium
 * loading the REAL built extension end to end: this spec drives the whole
 * pipeline — `<link rel="canonical">` on an actual DOM, through the injected
 * `capture.js`, into the pre-send preview the user actually sees — against
 * the mock's two sample pages (`scripts/screenshots/mock-gateway.ts`).
 */
import { expect, type Page, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import { togglePanel } from "./helpers.ts";

export const COVERS = ["canonical-1", "canonical-2"] as const;

/** The confirm preview's row for a given field label, wherever it renders
 *  (both the fetch and capture confirm boxes share `renderPreview`,
 *  shared/preview-view.ts — `.preview__row` > `.preview__label` /
 *  `.preview__value`). */
function previewRow(page: Page, label: string) {
  return page.locator(".preview__row").filter({
    has: page.locator(".preview__label", { hasText: label }),
  });
}

test("a relative canonical is absolutised into the clip preview", async () => {
  const h = await launchExtension();
  try {
    const page = await h.context.newPage();
    const url = `${h.origin}/sample`;
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url);

    // /sample is unrecognised by any configured/built-in origin, so the
    // panel's only move is the last-resort capture offer — same entry point
    // as test/e2e/capture.e2e.ts's first spec.
    await page.locator(".nimbus-related__capture").click();

    // canonical-2: the mock's /sample declares a RELATIVE canonical
    // (`href="/sample"`) — see mock-gateway.ts's samplePage doc comment for
    // why that, and not a port-pinned absolute href, is what belongs here.
    // Absolutised against the page URL, it lands on the mock's own origin.
    const canonicalRow = previewRow(page, "Canonical URL");
    await expect(canonicalRow).toBeVisible();
    await expect(canonicalRow.locator(".preview__value")).toHaveText(`${h.origin}/sample`);

    // A resolved declaration carries no rejection notice.
    await expect(previewRow(page, "Note")).toHaveCount(0);
  } finally {
    await h.close();
  }
});

test("a cross-origin canonical is refused, not forwarded, and the preview says so", async () => {
  const h = await launchExtension();
  try {
    const page = await h.context.newPage();
    const url = `${h.origin}/sample-bad-canonical`;
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url);

    await page.locator(".nimbus-related__capture").click();

    // canonical-1: the mock's /sample-bad-canonical declares
    // `https://elsewhere.example/stolen` — cross-origin to the mock's own
    // loopback address, so `resolveCanonical` refuses it. No Canonical URL
    // row is sent...
    await expect(previewRow(page, "Canonical URL")).toHaveCount(0);

    // ...and the preview names the refusal, using the exact cross-origin
    // notice string from src/shared/preview.ts.
    const note = previewRow(page, "Note");
    await expect(note).toBeVisible();
    await expect(note.locator(".preview__value")).toContainText("another site's address");
  } finally {
    await h.close();
  }
});
