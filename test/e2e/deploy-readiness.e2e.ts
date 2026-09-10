/**
 * Covers `docs/development.md` → "Manual verification — Deploy readiness
 * (C10)".
 *
 * COVERS `deploy-bind`: on a repo with no service binding, the deploy-readiness
 * section renders the bind form pre-filled with a guess — the scope's last path
 * segment (`guessServiceId`, src/shared/services.ts) — and submitting it both
 * saves the binding (`POST`-shaped `service-bind` message, validated by asking
 * the gateway per design spec §3.2) and reveals the verdict in place, with no
 * page refresh: `mountDeploySection` re-asks (`ask()` after a successful bind,
 * deploy-section.ts) rather than the test reloading anything.
 *
 * COVERS `deploy-verdict`: a repo that already has a binding renders the verdict
 * directly — no bind form — and a `failing_ci_runs` finding carrying a `url`
 * renders as a clickable link through the same `findingLink` path C8.1/C9
 * established (design spec §4.5), not as inert text.
 *
 * What this suite does NOT prove: a real gateway's preflight answer. It drives
 * the mock, which answers whatever fixture a scenario hands it — same caveat
 * `item-links.e2e.ts` and `file-lanes.e2e.ts` both carry for their own routes.
 */
import { expect, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import { PREFLIGHT_WARN_CI, type Scenario } from "../../scripts/screenshots/gateway-fixtures.ts";
import { gotoRecognisedPage, togglePanel } from "./helpers.ts";

export const COVERS = ["deploy-bind", "deploy-verdict"] as const;

/** `/{owner}/{repo}/pull/{num}` — githubRule's PR arm, which is what supplies
 *  `Match.scope` ("acme/web") the deploy-readiness section keys a binding by. */
const PR_PATH = "/acme/web/pull/482";

/** Declares the mock's loopback origin a self-hosted GitHub, same recipe
 *  `file-lanes.e2e.ts` uses: the BARE origin, not `${origin}/sample` — `recognise()`
 *  strips the matched prefix before reading segments, and the PR arm needs all
 *  four of them (owner, repo, "pull", number). */
async function seedSelfHostedGithub(h: Awaited<ReturnType<typeof launchExtension>>): Promise<void> {
  await h.sw.evaluate(async (origin) => {
    await chrome.storage.local.set({ origins: [{ origin, product: "github" }] });
  }, h.origin);
}

test("an unbound repo shows a seeded bind form, and binding reveals the verdict with no refresh", async () => {
  const h = await launchExtension();
  try {
    await seedSelfHostedGithub(h);
    const page = await h.context.newPage();
    const url = await gotoRecognisedPage(page, h.origin, PR_PATH);
    await togglePanel(h.sw, url);

    // The section is a SIBLING of the shell, so nothing above it names it: it
    // carries its own heading, and that heading is the string Options and
    // development.md both send the user looking for.
    await expect(page.locator(".nimbus-deploy__title")).toHaveText("Deploy readiness");

    // deploy-bind: the unbound state renders the bind form, its input seeded
    // with the guess — the scope's last segment ("acme/web" -> "web") — not
    // left blank and not a silent auto-bind.
    const bindForm = page.locator(".nimbus-deploy__bind");
    const input = bindForm.locator('input[name="serviceId"]');
    await expect(input).toHaveValue("web");

    // deploy-bind: submitting the seeded guess binds it (the mock's default
    // preflight answer is not the all-unknown_service envelope, so the
    // validate-by-asking probe succeeds) and the SAME section repaints with the
    // verdict — no `page.reload()` anywhere in this test.
    await bindForm.locator('button[type="submit"]').click();

    await expect(page.locator(".nimbus-deploy__verdict")).toBeVisible();
    await expect(page.locator(".nimbus-deploy__bind")).toHaveCount(0);
    await expect(page.locator(".nimbus-deploy__verdict")).toContainText("Clear to deploy");
  } finally {
    await h.close();
  }
});

test("a bound repo with a failing CI run shows that finding as a link", async () => {
  const scenario: Scenario = {
    preflight: { "web-ci": PREFLIGHT_WARN_CI },
  };
  const h = await launchExtension({ scenario });
  try {
    await seedSelfHostedGithub(h);
    await h.sw.evaluate(async () => {
      await chrome.storage.local.set({
        serviceBindings: [{ product: "github", scope: "acme/web", serviceId: "web-ci" }],
      });
    });
    const page = await h.context.newPage();
    const url = await gotoRecognisedPage(page, h.origin, PR_PATH);
    await togglePanel(h.sw, url);

    // deploy-verdict: already bound, so the verdict renders directly — no
    // bind form is ever shown for this scope.
    await expect(page.locator(".nimbus-deploy__bind")).toHaveCount(0);
    await expect(page.locator(".nimbus-deploy__verdict")).toContainText(
      "thing to look at before deploying",
    );

    // deploy-verdict: the one failing CI run carries a `url` and renders as a
    // clickable link — its title, not the raw url, is the link text.
    const finding = page.locator(".nimbus-deploy__check a", { hasText: "build" });
    await expect(finding).toHaveAttribute("href", "https://github.com/acme/web/actions/runs/1");
  } finally {
    await h.close();
  }
});
