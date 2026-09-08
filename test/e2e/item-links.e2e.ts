/**
 * Covers `docs/development.md` → "Manual verification — Item links (C9)".
 *
 * COVERS step 1 (id item-links-1): once a `catchup` run lands `done`, the
 * background worker resolves its evidence ids against
 * `GET /v1/items/resolve-ids` and persists the map alongside the run — a
 * SECOND, unawaited write after the terminal one (design spec §2, §5). This
 * suite proves the whole round trip, not just the renderer's own unit-level
 * wiring: the lane first renders its items as plain text (the terminal write
 * lands before the resolve call even starts), and only becomes a link once
 * the panel's next ~1s repaint poll picks up the second write — the
 * assertions below rely on Playwright's auto-retrying `expect` to observe
 * that transition rather than asserting against a fixed snapshot.
 *
 * It also proves the per-id nature of the map, off ONE response: the
 * billing-service item's id is in `RESOLVE_IDS_CATCHUP_HIT`, the
 * checkout-service item's is not (an unindexed id, not a null url — a
 * different fact, spec §4), and only the first becomes a link.
 *
 * What this suite does NOT prove: the 404 capability-signal fallback and the
 * byte-budget chunking are already pinned at the unit level
 * (`item-urls.test.ts`, `gateway-client.test.ts`) — this file's job is the
 * end-to-end wire-up the unit suites cannot reach: a real background worker,
 * a real store write, a real panel repaint.
 */
import { expect, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import {
  AGENT_RUN_DONE_CATCHUP,
  RESOLVE_IDS_CATCHUP_HIT,
  type Scenario,
} from "../../scripts/screenshots/gateway-fixtures.ts";
import { togglePanel } from "./helpers.ts";

export const COVERS = ["item-links-1"] as const;

test("catchup's resolved item id becomes a link; its unresolved sibling stays plain text", async () => {
  const scenario: Scenario = {
    agentRun: AGENT_RUN_DONE_CATCHUP,
    resolveIds: RESOLVE_IDS_CATCHUP_HIT,
  };
  const h = await launchExtension({ scenario });
  try {
    await h.sw.evaluate(async (origin) => {
      await chrome.storage.local.set({
        origins: [{ origin: `${origin}/sample`, product: "github" }],
      });
    }, h.origin);

    const url = `${h.origin}/sample`;
    const page = await h.context.newPage();
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url);

    const catchupLane = page.locator('[data-lane="catchup"]');
    await catchupLane.locator("summary").click();

    const findings = catchupLane.locator(".nimbus-findings");
    await expect(findings).toHaveCount(1);
    const groups = findings.locator(".nimbus-findings__group");
    await expect(groups).toHaveCount(2);

    // item-links-1: billing-service's item (id "github:acme/web#482") IS in
    // the resolve-ids response. Its title starts as plain text — the terminal
    // `putRun` lands before `resolveAndPersistItemUrls` has even been called —
    // and becomes a link only once the background's second write lands and a
    // repaint picks it up.
    const resolvedItem = groups.first().locator(".nimbus-findings__item").first();
    await expect(resolvedItem.locator("a")).toHaveAttribute(
      "href",
      "https://github.com/acme/web/pull/482",
    );
    await expect(resolvedItem.locator("a")).toHaveText("Cache the readability pass");

    // checkout-service's item (id "jira:PLAT-91") is absent from the SAME
    // resolve-ids response and stays plain text — not a temporary state
    // waiting on the same poll, but the permanent "unresolved" outcome.
    const unresolvedItem = groups.nth(1).locator(".nimbus-findings__item").first();
    await expect(unresolvedItem).toContainText("Clipper is slow on large articles");
    await expect(unresolvedItem.locator("a")).toHaveCount(0);
  } finally {
    await h.close();
  }
});
