/**
 * Covers `docs/development.md` → "Manual verification — Capture as the last
 * resort (C3.2)", the metadata step (id metadata-1).
 *
 * `readPageMeta` (src/capture/page-meta.ts), the merge in `capture-in-page.ts`
 * and the rebuild in `buildClipSource` are all reached by unit tests through
 * jsdom already. What jsdom cannot give is a REAL page in a REAL Chromium
 * loading the REAL built extension — and, the reason this leg earns its
 * runtime, browser-accurate CSS attribute-selector semantics: jsdom is lenient
 * about the `i` flag that `page-meta.ts` depends on, and Chromium is not.
 *
 * It asserts on the wire as well as the preview, for the same reason
 * canonical.e2e.ts does: a regression could hide a row and still send the
 * field, or show a row and send nothing.
 */
import { expect, type Page, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import type { FedClip } from "../../scripts/screenshots/gateway-fixtures.ts";
import { togglePanel } from "./helpers.ts";

export const COVERS = ["metadata-1"] as const;

/** The confirm preview's row for a given field label, wherever it renders
 *  (both the fetch and capture confirm boxes share `renderPreview`,
 *  shared/preview-view.ts — `.preview__row` > `.preview__label` /
 *  `.preview__value`). */
function previewRow(page: Page, label: string) {
  return page.locator(".preview__row").filter({
    has: page.locator(".preview__label", { hasText: label }),
  });
}

test("the page's byline, date, site and image reach the preview and the wire", async () => {
  const sent: FedClip[] = [];
  const h = await launchExtension({ scenario: { onClipIngest: (b) => sent.push(b) } });
  try {
    const page = await h.context.newPage();
    const url = `${h.origin}/sample`;
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url);

    // /sample is unrecognised by any configured or built-in origin, so the
    // panel's only move is the last-resort capture offer — the same entry
    // point canonical.e2e.ts and capture.e2e.ts use.
    await page.locator(".nimbus-related__capture").click();

    await expect(previewRow(page, "Author").locator(".preview__value")).toHaveText("Ada Lovelace");
    await expect(previewRow(page, "Published").locator(".preview__value")).toHaveText("2024-03-11");
    await expect(previewRow(page, "Site").locator(".preview__value")).toHaveText("Example Journal");
    await expect(previewRow(page, "Language").locator(".preview__value")).toHaveText("en");
    // Declared relative in the page, so this is the absolutise path running in
    // a real browser against whatever ephemeral port the mock bound.
    await expect(previewRow(page, "Lead image").locator(".preview__value")).toHaveText(
      `${h.origin}/img/hero.jpg`,
    );

    await page.locator(".nimbus-related__fetch-send").click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]?.source).toEqual({
      author: "Ada Lovelace",
      publishedAt: Date.parse("2024-03-11T09:30:00Z"),
      siteName: "Example Journal",
      lang: "en",
      leadImage: `${h.origin}/img/hero.jpg`,
    });
  } finally {
    await h.close();
  }
});
