/**
 * Covers `docs/development.md` → "Manual verification — Related lane (richer rows)".
 *
 * COVERS steps 1-5. Step 6 is NOT covered and cannot be: it asks whether the
 * service groups are mostly one row each, which is a design judgement about
 * whether grouping earns its place — not a property a machine can assert.
 */
import { expect, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";

export const COVERS = [
  "related-lane-1",
  "related-lane-2",
  "related-lane-3",
  "related-lane-4",
  "related-lane-5",
] as const;

test("a resolved page's related rows carry kind, freshness and grouping", async () => {
  const h = await launchExtension();
  try {
    const page = await h.context.newPage();
    await page.goto(`${h.origin}/sample`);
    await page.bringToFront();
    // Query by URL, not by `lastFocusedWindow`. capture.ts uses the latter and it
    // works there, but window focus is exactly the sort of thing that is reliable
    // on a developer's desktop and occasionally is not on a headless CI container
    // — and a gate that flakes is a gate people route around. The URL is something
    // this test just set, so it cannot be ambiguous.
    await h.sw.evaluate(async (origin) => {
      const [tab] = await chrome.tabs.query({ url: `${origin}/sample` });
      if (tab?.id === undefined) {
        throw new Error("e2e: no tab matched the sample page");
      }
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["panel.js"] });
    }, h.origin);

    const rows = page.locator(".nimbus-related__item");
    await expect(rows.first()).toBeVisible();

    // related-lane-2: every row names its kind.
    await expect(page.locator(".nimbus-related__kind").first()).toBeVisible();
    // related-lane-3: every row dates itself, in the header's wording.
    await expect(page.locator(".nimbus-related__age").first()).toContainText("Updated ");
    // related-lane-4: rows group under a service heading carrying a count.
    await expect(page.locator(".nimbus-related__group-head").first()).toContainText("·");
    // related-lane-5: the preview line is body prose, not the title repeated.
    const title = await rows.first().locator(".nimbus-related__title").innerText();
    const snippet = await rows.first().locator(".nimbus-related__snippet").innerText();
    expect(snippet).not.toBe(title);
    // related-lane-1: the fixture's hits are all present — nothing host-filtered away.
    await expect(rows).toHaveCount(3);
  } finally {
    await h.close();
  }
});
