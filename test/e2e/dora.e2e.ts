/**
 * Covers `docs/development.md` → "Manual verification — Delivery metrics
 * (C10.2)".
 *
 * COVERS `dora-from-options`: Options' "DORA metrics" button opens the page;
 * with one binding it auto-selects and renders headlines and sparklines.
 *
 * COVERS `dora-from-panel`: a bound verdict's "Delivery metrics for <id>"
 * button opens `dora.html?service=<id>` through `open-dora`.
 *
 * COVERS `dora-old-gateway`: with `/v1/metrics/stats` absent (404) the
 * headlines still render and one "newer gateway" line replaces every trend.
 *
 * What this suite does NOT prove: a real gateway's metric values. It drives
 * the mock, which answers `statsFixture` for any metric.
 */
import { expect, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import { GATEWAY_PATHS } from "../../src/shared/gateway.ts";
import { gotoRecognisedPage, togglePanel } from "./helpers.ts";

export const COVERS = ["dora-from-options", "dora-from-panel", "dora-old-gateway"] as const;

type H = Awaited<ReturnType<typeof launchExtension>>;

async function seedBinding(h: H): Promise<void> {
  await h.sw.evaluate(async (origin) => {
    await chrome.storage.local.set({
      origins: [{ origin, product: "github" }],
      serviceBindings: [{ product: "github", origin, scope: "acme/web", serviceId: "web-ci" }],
    });
  }, h.origin);
}

test("Options opens the page, which auto-selects the one binding and draws its trends", async () => {
  const h = await launchExtension();
  try {
    await seedBinding(h);
    const options = await h.context.newPage();
    await options.goto(`chrome-extension://${h.extId}/options.html`);
    const [page] = await Promise.all([
      h.context.waitForEvent("page"),
      options.locator("#open-dora").click(),
    ]);
    await expect(page).toHaveURL(/dora\.html/);
    await expect(page.locator('[data-metric="deployment_frequency"] .dora-row__value')).toHaveText(
      "1.4 / day",
    );
    await expect(page.locator('[data-metric="mttr"] .dora-row__value')).toHaveText("—");
    await expect(page.locator("#delivery-rows svg").first()).toBeVisible();
    await expect(page.locator('[data-metric="pr-merges"] .dora-row__sample')).toContainText(
      "of 13 weeks reported",
    );
    await expect(page).toHaveURL(/\?service=web-ci$/);
  } finally {
    await h.close();
  }
});

test("a bound verdict links to the page for that service", async () => {
  const h = await launchExtension();
  try {
    await seedBinding(h);
    const pr = await h.context.newPage();
    const url = await gotoRecognisedPage(pr, h.origin, "/acme/web/pull/482");
    await togglePanel(h.sw, url);
    const link = pr.locator(".nimbus-deploy__dora-link");
    await expect(link).toHaveText("Delivery metrics for web-ci →");
    const [page] = await Promise.all([h.context.waitForEvent("page"), link.click()]);
    await expect(page).toHaveURL(`chrome-extension://${h.extId}/dora.html?service=web-ci`);
  } finally {
    await h.close();
  }
});

test("a gateway without the trend route keeps the headlines and says why the trends are missing", async () => {
  const h = await launchExtension({ scenario: { status: { [GATEWAY_PATHS.metricsStats]: 404 } } });
  try {
    await seedBinding(h);
    const page = await h.context.newPage();
    await page.goto(`chrome-extension://${h.extId}/dora.html?service=web-ci`);
    await expect(page.locator("#dora-notice")).toHaveText("Trends need a newer Nimbus gateway.");
    await expect(page.locator('[data-metric="deployment_frequency"] .dora-row__value')).toHaveText(
      "1.4 / day",
    );
    await expect(page.locator("svg")).toHaveCount(0);
  } finally {
    await h.close();
  }
});
