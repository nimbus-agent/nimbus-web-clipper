/**
 * Covers `docs/development.md` → "Manual verification — Command palette (3.1)".
 *
 * COVERS steps 1-9 (ids palette-1..9). Playwright cannot fire `chrome.commands`,
 * so each test opens the palette through `openPalette` (helpers.ts), which makes
 * the two `executeScript` calls `showPalette` makes, with a `PaletteInit` computed
 * here by `recognise()` for the page it seeded. Keys and clicks are Playwright
 * input, which is trusted (`isTrusted`), as every palette handler requires.
 *
 * NOT covered here: the shortcut binding and the site collisions (human), and
 * command routing plus the restricted-page badge (unit tests).
 */
import { expect, type Page, test } from "@playwright/test";
import type { Harness } from "../../scripts/e2e/launch.ts";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import {
  AGENT_RUN_DONE,
  AGENT_RUN_DONE_GLOSSARY,
  type FedClip,
  type Scenario,
} from "../../scripts/screenshots/gateway-fixtures.ts";
import type { PaletteInit } from "../../src/shared/panel-host.ts";
import { recognise } from "../../src/shared/recognise/index.ts";
import type { ConfiguredOrigin } from "../../src/shared/types.ts";
import { gotoRecognisedPage, openPalette, togglePanel } from "./helpers.ts";

export const COVERS = [
  "palette-1",
  "palette-2",
  "palette-3",
  "palette-4",
  "palette-5",
  "palette-6",
  "palette-7",
  "palette-8",
  "palette-9",
] as const;

const PR_PATH = "/acme/web/pull/482";

interface Seeded {
  readonly page: Page;
  readonly url: string;
  readonly init: PaletteInit;
}

/** A page on a seeded GitHub origin, plus the init the worker would compute. */
async function seedPr(h: Harness): Promise<Seeded> {
  const origins: ConfiguredOrigin[] = [{ origin: h.origin, product: "github" }];
  await h.sw.evaluate(async (o) => {
    await chrome.storage.local.set({ origins: o });
  }, origins);
  const page = await h.context.newPage();
  const url = await gotoRecognisedPage(page, h.origin, PR_PATH);
  return { page, url, init: { recognition: recognise(url, origins) } };
}

const palette = (page: Page) => page.locator("#nimbus-palette-host");
const row = (page: Page, id: string) => page.locator(`#nimbus-palette-host [data-row-id="${id}"]`);
const input = (page: Page) => page.locator('#nimbus-palette-host [role="combobox"]');

/** Selects the first word of the sample page's first paragraph, in the page. */
async function selectWord(page: Page): Promise<string> {
  return page.evaluate(() => {
    const p = document.querySelector("p");
    const node = p?.firstChild;
    if (!p || !node) {
      throw new Error("e2e: no paragraph");
    }
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return sel?.toString() ?? "";
  });
}

test("typing filters the rows, and a miss leaves one disabled row", async () => {
  const h = await launchExtension();
  try {
    const { page, url, init } = await seedPr(h);
    await openPalette(h.sw, url, init);
    await expect(palette(page)).toHaveCount(1);
    await expect(input(page)).toBeFocused();
    // palette-1: resolve lands and the lane rows join the instant ones.
    await expect(row(page, "lane:impact")).toHaveCount(1);
    await expect(row(page, "clip-page")).toHaveCount(1);

    await page.keyboard.type("clip");
    const options = page.locator('#nimbus-palette-host [role="option"]');
    await expect(options).toHaveCount(2);
    await expect(row(page, "clip-page")).toHaveText(/Clip page/);

    await input(page).fill("zzzz");
    await expect(options).toHaveCount(1);
    await expect(options).toHaveText("No matching actions");
    await expect(options).toHaveAttribute("aria-disabled", "true");
  } finally {
    await h.close();
  }
});

test("Enter on a lane row opens the panel with that lane asked", async () => {
  const h = await launchExtension();
  try {
    const { page, url, init } = await seedPr(h);
    await openPalette(h.sw, url, init);
    await expect(row(page, "lane:impact")).toHaveCount(1);
    await page.keyboard.type("breaks");
    await page.keyboard.press("Enter");

    // palette-2: the palette is gone, the panel is up, and its lane answered.
    await expect(palette(page)).toHaveCount(0);
    const lane = page.locator('[data-lane="impact"]');
    await expect(lane).toHaveCount(1);
    await expect(lane.locator(".nimbus-related__brief")).toHaveText(AGENT_RUN_DONE.brief);
  } finally {
    await h.close();
  }
});

test("a selection defined from the palette reaches an already open panel", async () => {
  const h = await launchExtension({ scenario: { agentRun: AGENT_RUN_DONE_GLOSSARY } });
  try {
    const { page, url, init } = await seedPr(h);
    await togglePanel(h.sw, url);
    await expect(page.locator(".nimbus-related__surface")).toBeVisible();
    const word = await selectWord(page);
    expect(word).toBe("Local");

    await openPalette(h.sw, url, init);
    await expect(palette(page)).toHaveCount(1);
    await expect(row(page, "lane:glossary")).toHaveCount(1);
    await row(page, "lane:glossary").click();

    // palette-3: delivered to the panel that was open, not a re-injection that
    // would have toggled it shut.
    await expect(page.locator("#nimbus-related-host")).toHaveCount(1);
    const lane = page.locator('[data-lane="glossary"]');
    await expect(lane.locator("summary")).toHaveText("“Local”");
    await expect(lane.locator(".nimbus-findings")).toBeVisible();
  } finally {
    await h.close();
  }
});

test("a lane run from the palette honours the candidate already picked in the panel", async () => {
  const scenario: Scenario = {
    resolveDefault: {
      found: false,
      reason: "ambiguous",
      fetchable: false,
      truncated: false,
      candidates: [
        {
          id: "gh-pr-1",
          service: "github",
          type: "pr",
          title: "Cache the readability pass",
          url: "https://github.com/acme/web/pull/1",
        },
        {
          id: "gh-pr-2",
          service: "github",
          type: "pr",
          title: "Retry queue backoff",
          url: "https://github.com/acme/web/pull/2",
        },
      ],
    },
  };
  const h = await launchExtension({ scenario });
  try {
    const { page, url, init } = await seedPr(h);
    await togglePanel(h.sw, url);
    await page.locator(".nimbus-related__candidate").first().click();
    await expect(page.locator(".nimbus-related__header-item")).toHaveText(
      "Cache the readability pass",
    );

    await openPalette(h.sw, url, init);
    // palette-4: the pick is folded in, so the lane is offered and runs
    // instead of the "Pick the item in the panel" row.
    await expect(row(page, "lane:impact")).toHaveCount(1);
    await expect(row(page, "candidates")).toHaveCount(0);
    await row(page, "lane:impact").click();

    const lane = page.locator('[data-lane="impact"]');
    await expect(lane.locator(".nimbus-related__brief")).toHaveText(AGENT_RUN_DONE.brief);
    await expect(page.locator(".nimbus-related__header-item")).toHaveText(
      "Cache the readability pass",
    );
  } finally {
    await h.close();
  }
});

test("Esc closes the palette first and leaves the panel open", async () => {
  const h = await launchExtension();
  try {
    const { page, url, init } = await seedPr(h);
    await togglePanel(h.sw, url);
    await expect(page.locator(".nimbus-related__surface")).toBeVisible();
    await openPalette(h.sw, url, init);
    await expect(input(page)).toBeFocused();

    // palette-5: one Esc takes only the palette.
    await page.keyboard.press("Escape");
    await expect(palette(page)).toHaveCount(0);
    await expect(page.locator("#nimbus-related-host")).toHaveCount(1);
  } finally {
    await h.close();
  }
});

test("clicking a row runs it", async () => {
  const h = await launchExtension();
  try {
    const { page, url, init } = await seedPr(h);
    await openPalette(h.sw, url, init);
    await expect(row(page, "related")).toHaveCount(1);
    await row(page, "related").click();

    // palette-6: the click reached the row (pointerdown did not steal focus).
    await expect(palette(page)).toHaveCount(0);
    await expect(page.locator('[data-lane="related"] .nimbus-related__item').first()).toBeVisible();
  } finally {
    await h.close();
  }
});

test("Clip page sends the page to the gateway", async () => {
  const sent: FedClip[] = [];
  const h = await launchExtension({ scenario: { onClipIngest: (b) => sent.push(b) } });
  try {
    const { page, url, init } = await seedPr(h);
    await openPalette(h.sw, url, init);
    await expect(row(page, "clip-page")).toHaveCount(1);
    await page.keyboard.type("clip page");
    await page.keyboard.press("Enter");

    // palette-7
    await expect(palette(page)).toHaveCount(0);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]?.url).toBe(url);
  } finally {
    await h.close();
  }
});

test("Clip selection clips the selection the palette's focus took away", async () => {
  const sent: FedClip[] = [];
  const h = await launchExtension({ scenario: { onClipIngest: (b) => sent.push(b) } });
  try {
    const { page, url, init } = await seedPr(h);
    const word = await selectWord(page);
    await openPalette(h.sw, url, init);
    await expect(input(page)).toBeFocused();
    // The premise: focusing the palette input really did take the page selection
    // away (the selection is document-wide, so the main world can read it). Without
    // this the test would pass with the restore logic deleted.
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe(word);
    await expect(row(page, "clip-selection")).not.toHaveAttribute("aria-disabled", "true");
    await row(page, "clip-selection").click();

    // palette-8: focusing the input collapsed the page selection; the palette
    // restored it before the worker read it, and the clip carries it.
    await expect(palette(page)).toHaveCount(0);
    await expect.poll(() => sent.length).toBe(1);
    expect((sent[0] as { body?: unknown }).body).toBe(word);
  } finally {
    await h.close();
  }
});

test("Tab closes the palette, and so does focus moving to the page", async () => {
  const h = await launchExtension();
  try {
    const { page, url, init } = await seedPr(h);
    // `pageerror` does see exceptions thrown in the extension's isolated world
    // (proved with a deliberately throwing executeScript func and listener), so an
    // error thrown from focusout during host.remove() would land here.
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await openPalette(h.sw, url, init);
    await expect(input(page)).toBeFocused();
    await page.keyboard.press("Tab");
    // palette-9: closed once, with no error from the host being removed while
    // it held focus.
    await expect(palette(page)).toHaveCount(0);

    await page.evaluate(() => {
      const b = document.createElement("button");
      b.id = "page-button";
      b.textContent = "page";
      document.body.append(b);
    });
    await openPalette(h.sw, url, init);
    await expect(input(page)).toBeFocused();
    await page.evaluate(() => document.getElementById("page-button")?.focus());
    await expect(palette(page)).toHaveCount(0);
    await expect(page.locator("#page-button")).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await h.close();
  }
});
