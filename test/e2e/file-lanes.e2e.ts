/**
 * Covers `docs/development.md` → "Manual verification — The file surface (C7)".
 *
 * COVERS steps 1-4 (ids file-lanes-1..4): a resolved file names itself and
 * offers the three lanes under file-specific titles; one lane runs to a brief;
 * each miss reason renders its OWN sentence and no lanes; and a gateway that
 * does not serve the probe route leaves the page exactly as it rendered
 * before C7 — recognised, no lanes, no banner, silently.
 *
 * **What this suite proves, and what it cannot.** It drives the mock gateway,
 * so it covers the client half: the coordinate the recogniser builds, the
 * request the worker sends, and what the panel renders from each answer. It
 * does NOT prove a real gateway resolves anything, and the origin it uses
 * could not be resolved by one even in principle — the mock is registered as a
 * SELF-HOSTED GitHub (the only way to reach a forge surface on loopback), and
 * upstream `parseRemoteUrl` accepts only `github.com`, `gitlab.com` and
 * `bitbucket.org`. Real-gateway resolution stays a manual step in
 * `development.md`, and reading a green run here as end-to-end proof is the
 * mistake this paragraph exists to prevent.
 */
import { expect, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import {
  AGENT_RUN_DONE,
  RESOLVE_FILE_MISS_NOT_INDEXED,
  RESOLVE_FILE_MISS_UNTRACKED,
  type Scenario,
} from "../../scripts/screenshots/gateway-fixtures.ts";
import { GATEWAY_PATHS } from "../../src/shared/gateway.ts";
import { gotoRecognisedPage, togglePanel } from "./helpers.ts";

export const COVERS = ["file-lanes-1", "file-lanes-2", "file-lanes-3", "file-lanes-4"] as const;

/**
 * `/{owner}/{repo}/blob/{ref}/{path}` — six segments, which is what
 * `matchGithub`'s file arm requires (`s.length < 5` declines, since a ref alone
 * is a tree listing with nothing to answer about).
 */
const FILE_PATH = "/acme/web/blob/main/src/foo.ts";

/** `surfaceLine` is `${label} · ${ref}`, and the GitHub file arm's `ref` is
 *  `${owner}/${repo} ${lastSegment(refAndPath)}` — not the whole path. */
const SURFACE = "GitHub file · acme/web foo.ts";

/** Declares the mock's loopback origin a self-hosted GitHub. The bare origin,
 *  not `${origin}/sample`: `recognise()` strips the matched prefix before
 *  reading segments, and this surface needs all six of them. */
async function seedSelfHostedGithub(h: Awaited<ReturnType<typeof launchExtension>>): Promise<void> {
  await h.sw.evaluate(async (origin) => {
    await chrome.storage.local.set({ origins: [{ origin, product: "github" }] });
  }, h.origin);
}

test("a resolved file names itself, offers the three lanes, and one runs to a brief", async () => {
  const h = await launchExtension();
  try {
    await seedSelfHostedGithub(h);
    const page = await h.context.newPage();
    const url = await gotoRecognisedPage(page, h.origin, FILE_PATH);
    await togglePanel(h.sw, url);

    // file-lanes-1: the header names the file, and carries NO banner — a hit
    // and an unsupported gateway render the same header (see the `file` arm of
    // `headerState`, panel-in-page.ts), so the banner's absence here is only
    // half the claim. The lanes below are the other half.
    await expect(page.locator(".nimbus-related__surface")).toHaveText(SURFACE);
    await expect(page.locator(".nimbus-related__header-state .nimbus-related__status")).toHaveCount(
      0,
    );

    // file-lanes-2: the three lanes, under the FILE titles rather than the PR
    // ones. Asserting the text, not just the count: `SURFACE_LANE_TITLES.file`
    // is a separate object from the item titles precisely so the two can
    // diverge, and a regression that fell back to the item copy would still
    // render three lanes.
    await expect(page.locator('[data-lane="impact"] .nimbus-related__lane-title')).toHaveText(
      "What breaks if this changes",
    );
    await expect(page.locator('[data-lane="expert"] .nimbus-related__lane-title')).toHaveText(
      "Who knows this file",
    );
    await expect(page.locator('[data-lane="ownership"] .nimbus-related__lane-title')).toHaveText(
      "Who owns this",
    );
    // Related IS present. The lane is withheld on `home` alone — see the
    // dashboard comment at panel-in-page.ts's lane assembly — and a file takes
    // the same arm every other recognised surface does. Pinned as-is rather
    // than asserted away: whether a blob page's title is a good `/clips/related`
    // key is a product question, and a test that quietly expected zero would
    // hide the current answer instead of recording it.
    await expect(page.locator('[data-lane="related"]')).toHaveCount(1);
    // No capture offer, though: `offersCapture` is false for a `file` header.
    await expect(page.locator(".nimbus-related__capture")).toHaveCount(0);

    // Expanding one lane runs it end to end — invoke, poll, brief — rather
    // than only proving the lane was offered.
    await page.locator('[data-lane="impact"] summary').click();
    await expect(page.locator('[data-lane="impact"] .nimbus-related__brief')).toHaveText(
      AGENT_RUN_DONE.brief,
    );
  } finally {
    await h.close();
  }
});

// file-lanes-3: the two miss reasons are different facts with different
// remediations, and the panel says which. Parameterised over both fixtures
// rather than asserting one, because a regression that collapsed them into a
// single sentence would still pass a test that only ever saw one.
for (const { fixture, sentence } of [
  {
    fixture: RESOLVE_FILE_MISS_UNTRACKED,
    sentence: "Nimbus has no local checkout of `acme/web`, so it cannot answer about its files.",
  },
  {
    fixture: RESOLVE_FILE_MISS_NOT_INDEXED,
    sentence: "Nimbus has a checkout of `acme/web`, but this file is not in its index.",
  },
]) {
  test(`the ${fixture.reason} miss says so, and offers no lanes`, async () => {
    const scenario: Scenario = { resolveFileDefault: fixture };
    const h = await launchExtension({ scenario });
    try {
      await seedSelfHostedGithub(h);
      const page = await h.context.newPage();
      const url = await gotoRecognisedPage(page, h.origin, FILE_PATH);
      await togglePanel(h.sw, url);

      await expect(page.locator(".nimbus-related__surface")).toHaveText(SURFACE);
      await expect(
        page.locator(".nimbus-related__header-state .nimbus-related__status"),
      ).toHaveText(sentence);
      for (const lane of ["impact", "expert", "ownership"]) {
        await expect(page.locator(`[data-lane="${lane}"]`)).toHaveCount(0);
      }
      await expect(page.locator(".nimbus-related__capture")).toHaveCount(0);
    } finally {
      await h.close();
    }
  });
}

test("a gateway without the probe route changes nothing about the page", async () => {
  // The fail-quiet contract, and the reason C7 could ship inert without anyone
  // noticing: `resolveFile` maps 404 to `{kind:"unsupported"}` (gateway-client.ts),
  // which the panel renders as a bare recognised header. This is the ONE
  // behaviour that was true on every gateway in existence for the whole time
  // the client half was shipped, and nothing exercised it until now.
  const scenario: Scenario = { status: { [GATEWAY_PATHS.resolveFile]: 404 } };
  const h = await launchExtension({ scenario });
  try {
    await seedSelfHostedGithub(h);
    const page = await h.context.newPage();
    const url = await gotoRecognisedPage(page, h.origin, FILE_PATH);
    await togglePanel(h.sw, url);

    // file-lanes-4: recognised, named, and otherwise silent. No lanes, no
    // banner, and above all no error state — an older gateway is not a fault.
    await expect(page.locator(".nimbus-related__surface")).toHaveText(SURFACE);
    await expect(page.locator(".nimbus-related__header-state .nimbus-related__status")).toHaveCount(
      0,
    );
    for (const lane of ["impact", "expert", "ownership"]) {
      await expect(page.locator(`[data-lane="${lane}"]`)).toHaveCount(0);
    }
    await expect(page.locator(".nimbus-related__capture")).toHaveCount(0);
  } finally {
    await h.close();
  }
});
