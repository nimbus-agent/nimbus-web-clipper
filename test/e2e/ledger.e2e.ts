/**
 * Covers `docs/development.md` → "Manual verification — Activity: what the
 * gateway did for you (C4.1)", steps 1-4 (ids ledger-summary, ledger-page,
 * ledger-verify, ledger-old-gateway).
 *
 * Everything asserted here is client-side: the partition, the scope toggle, the
 * verification claim and the too-old-gateway state all run in the extension, so
 * the mock's four read routes are enough to prove the whole chain without a real
 * gateway ledger.
 *
 * Step 5 (Export proof) is deliberately not automated: it asserts a file
 * download, and the claim that matters about it — that it never fires on load —
 * is proven by the fact that no test here presses it and the mock records no
 * request to `/v1/egress/prove`.
 */
import { expect, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import { GATEWAY_PATHS } from "../../src/shared/gateway.ts";

export const COVERS = [
  "ledger-summary",
  "ledger-page",
  "ledger-verify",
  "ledger-old-gateway",
] as const;

test("the trust panel summarises, the page partitions, and verification is only ever claimed on request", async () => {
  const seen: string[] = [];
  const h = await launchExtension({ scenario: { onRequest: (p) => seen.push(p) } });
  try {
    // ── Step 1: the trust panel's second half ──────────────────────────────
    const options = await h.context.newPage();
    await options.goto(`chrome-extension://${h.extId}/options.html`);
    const summary = options.locator("#trust-ledger");
    // FOUR actions, though the window holds five rows: the fifth is an outcome
    // marker, which is bookkeeping about egress rather than egress itself.
    await expect(summary).toContainText("4 outbound actions recorded");
    // One of the four rows carries this browser's label in the fixture.
    await expect(summary).toContainText("of them from this browser");
    // Verification is an action, and its result belongs where the action is.
    await expect(summary).not.toContainText("verified");

    // ── Step 2: the page, and the two scopes ───────────────────────────────
    const page = await h.context.newPage();
    await page.goto(`chrome-extension://${h.extId}/ledger.html`);

    const rows = page.locator(".ledger__row");
    await expect(rows).toHaveCount(1);
    await expect(page.locator(".ledger__body")).toContainText("Agent run");
    // A targeted fetch nothing can attribute is named, not hidden.
    await expect(page.locator(".ledger__notice")).toContainText("1 targeted fetch");
    await expect(page.locator(".ledger__notice")).toContainText("cannot be attributed");

    await page.locator("#scope-all").click();
    // Still four: the outcome marker is never a row of its own.
    await expect(rows).toHaveCount(4);
    await expect(page.locator(".ledger__body")).toContainText("Not attributable");
    // The fetch's outcome, joined to its authorising row by rowHash. It lives in
    // All because the fetch itself is unattributable on this gateway.
    await expect(page.locator(".ledger__body")).toContainText("Indexed");
    await expect(page.locator(".ledger__body")).toContainText("github:acme/web#482");

    // ── Step 3: the verification claim ─────────────────────────────────────
    await expect(page.locator(".ledger__verdict")).toHaveCount(0);
    await page.locator("#verify").click();
    await expect(page.locator(".ledger__verdict")).toContainText("Chain verified.");

    // Export proof was never pressed, so the signing route was never called.
    expect(seen).not.toContain(GATEWAY_PATHS.egressProve);
  } finally {
    await h.close();
  }
});

test("a gateway without the route is named as such, never shown an empty list", async () => {
  const h = await launchExtension({
    scenario: { status: { [GATEWAY_PATHS.egress]: 404 } },
  });
  try {
    const page = await h.context.newPage();
    await page.goto(`chrome-extension://${h.extId}/ledger.html`);
    // "No route" must never render as "no activity" — that would read as a
    // reassuring answer to a question the gateway never actually answered.
    await expect(page.locator(".ledger__error")).toContainText("does not offer");
    await expect(page.locator(".ledger__row")).toHaveCount(0);
  } finally {
    await h.close();
  }
});
