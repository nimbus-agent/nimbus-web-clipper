/**
 * Covers `docs/development.md` → "Manual verification — Passages as brief sources".
 *
 * COVERS steps 2-5 (ids passages-2..5). Step 1 (the right-click gesture itself)
 * is human: a browser context menu is OS-level chrome, outside the page, and
 * Playwright cannot open or click it. The collection is seeded through the
 * service worker instead, which is the same split `input-lanes.e2e.ts` already
 * documents for the two selection menus.
 */
import { expect, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";

export const COVERS = ["passages-2", "passages-3", "passages-4", "passages-5"] as const;

test("a seeded collection becomes one stitched source the gateway receives", async () => {
  const fed: { url: string; body: string }[] = [];
  const h = await launchExtension({ scenario: { onBriefSource: (b) => fed.push(b) } });
  try {
    // Seed two passages for one page: the gesture is human, the storage is not.
    await h.sw.evaluate(async () => {
      await chrome.storage.local.set({
        passages: [
          { url: "http://127.0.0.1/sample", title: "Sample", text: "first passage", at: 100 },
          { url: "http://127.0.0.1/sample#x", title: "Sample", text: "second passage", at: 200 },
        ],
      });
    });

    const page = await h.context.newPage();
    await page.goto(`chrome-extension://${h.extId}/brief.html`);

    // One row, saying two passages — not two rows, and not a whole page.
    const row = page.locator(".brief__tab", { hasText: "2 passages" });
    await expect(row).toHaveCount(1);
    await row.locator("input[type=checkbox]").check();
    await page.locator(".brief__question").first().click();

    // The preview shows the exact bytes, joins included.
    await expect(page.locator(".preview__passages .preview__body")).toContainText(
      "first passage\n\n[...]\n\nsecond passage",
    );

    await page.locator("#run").click();
    await expect(page.locator(".brief__banner")).toBeVisible();

    // The assertion no unit test can make: what the gateway actually received.
    expect(fed).toHaveLength(1);
    expect(fed[0]?.url).toBe("http://127.0.0.1/sample");
    expect(fed[0]?.body).toBe("first passage\n\n[...]\n\nsecond passage");

    // Fed groups are forgotten once /run was accepted.
    const left = await h.sw.evaluate(async () => {
      const got = await chrome.storage.local.get("passages");
      return got["passages"];
    });
    expect(left).toEqual([]);
  } finally {
    await h.close();
  }
});
