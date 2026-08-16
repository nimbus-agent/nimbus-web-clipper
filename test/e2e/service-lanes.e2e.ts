/**
 * Covers `docs/development.md` → "Manual verification — Service lanes (C2.3)".
 *
 * COVERS steps 1-4 (ids service-lanes-1..4): the dashboard header names the
 * surface and the scope; a service lane runs to a brief and is never empty;
 * closing and reopening the panel replays the stored brief without a second
 * invoke; and a resolved pull request shows the two ITEM lanes with none of
 * the three service lanes.
 *
 * Step 5 (no ambient cue on the dashboard) is NOT covered here, and that is a
 * finding, not a shortcut: the ambient cue is decided by a 600ms in-worker
 * debounce (`AMBIENT_DEBOUNCE_MS`, service-worker.ts) with no outbound
 * request for a HOME page — `handleResolve` answers a dashboard synthetically,
 * without ever calling the gateway (see handlers.ts's own comment on that
 * branch) — so there is no request this suite's `onRequest` counter (see
 * service-lanes-2/3 below) or the mock's `delayMs` can hold open or count to
 * make the debounce's conclusion observable. Proving silence would mean
 * waiting past a timer with nothing to assert on until the wait itself
 * elapses, which is exactly what this project's own no-arbitrary-sleep rule
 * (`docs/superpowers/plans/2026-08-16-e2e-verification-harness.md`: "assert on
 * observable state … never on elapsed time. A test that cannot be made
 * deterministic is deleted, not retried into submission") rules out. The pure
 * decision this step exercises is already exhaustively covered by
 * `ambient.test.ts`'s unit suite (see that module's own header comment); what
 * is missing is a way to observe the REAL debounced worker settling on a
 * verdict without timing it — a deliberate completion hook exposed from the
 * ambient machinery itself (not the mock) would close this gap.
 *
 * Step 6 (the `ownership` lane's gap brief when no `[[filesystem.roots]]` is
 * configured) is human: it needs the REAL `ownership` agent noticing the
 * absent root and writing the gap brief, including its `nimbus index add`
 * line — the mock's fixed, canned brief (`AGENT_RUN_DONE`) cannot produce
 * that, by construction (see gateway-fixtures.ts's own doc comment on it).
 */
import { expect, test } from "@playwright/test";
import type { Harness } from "../../scripts/e2e/launch.ts";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import { AGENT_RUN_DONE, type Scenario } from "../../scripts/screenshots/gateway-fixtures.ts";
import { GATEWAY_PATHS } from "../../src/shared/gateway.ts";
import { PANEL_HOST_ID } from "../../src/shared/panel-host.ts";

export const COVERS = [
  "service-lanes-1",
  "service-lanes-2",
  "service-lanes-3",
  "service-lanes-4",
] as const;

/**
 * Injects panel.js into the tab currently on `url`, queried by URL rather
 * than `lastFocusedWindow` — same reasoning as capture.e2e.ts's identical
 * helper: window focus is reliable on a desktop and occasionally is not on a
 * headless CI container, and this test just set `url`, so it cannot be
 * ambiguous. Self-toggling, like `panel.js` itself: a first call mounts it, a
 * second closes it.
 */
async function togglePanel(sw: Harness["sw"], url: string): Promise<void> {
  await sw.evaluate(async (target) => {
    const [tab] = await chrome.tabs.query({ url: target });
    if (tab?.id === undefined) {
      throw new Error(`e2e: no tab matched ${target}`);
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["panel.js"] });
  }, url);
}

test("a dashboard's service lanes name the scope, run to a brief, and replay from cache on reopen", async () => {
  // Counts POSTs to the catchup lane's invoke route — the value this test
  // asserts "no second run" against (service-lanes-3), rather than timing how
  // fast the second answer comes back. See `onRequest`'s own doc comment
  // (gateway-fixtures.ts) for why a value beats a race here.
  const invokeCalls: string[] = [];
  const catchupInvoke = `${GATEWAY_PATHS.agents}/catchup`;
  const scenario: Scenario = {
    onRequest: (pathname) => {
      if (pathname === catchupInvoke) {
        invokeCalls.push(pathname);
      }
    },
    // Holds the FIRST invoke open long enough for the optimistic "Working…"
    // state (set synchronously, before this response lands — see
    // `sendAgentRun`, panel-in-page.ts) to be genuinely observable rather than
    // a race against a loopback round trip fast enough to settle before the
    // next assertion poll — the same reasoning, and the same mechanism, as
    // capture.e2e.ts's "Saving to Nimbus…" test. A reopened panel's re-expand
    // never reaches this route at all (handleAgentRun's cache short-circuit —
    // see service-lanes-3 below), so this delay cannot mask a second run.
    delayMs: { [catchupInvoke]: 300 },
  };
  const h = await launchExtension({ scenario });
  try {
    const url = `${h.origin}/sample`;
    // A ConfiguredOrigin whose path PREFIX is "/sample" itself, not the bare
    // host: `recognise()` strips the matched prefix before reading segments,
    // so a page sitting exactly AT the prefix has none left over — the same
    // branch a product's bare root takes (see `matchGithub`'s `s.length === 0`
    // arm in recognise.ts). This lets the mock's one servable page double as a
    // product dashboard without inventing a second mock route.
    await h.sw.evaluate(async (origin) => {
      await chrome.storage.local.set({
        origins: [{ origin: `${origin}/sample`, product: "github" }],
      });
    }, h.origin);

    const page = await h.context.newPage();
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url);

    // service-lanes-1: the header names the surface and the scope; no Related
    // lane and no fetch button belong on a dashboard.
    await expect(page.locator(".nimbus-related__surface")).toHaveText("GitHub dashboard");
    await expect(page.locator(".nimbus-related__header-state .nimbus-related__status")).toHaveText(
      "Nimbus can answer across all indexed GitHub repositories.",
    );
    await expect(page.locator('[data-lane="related"]')).toHaveCount(0);
    await expect(page.locator(".nimbus-related__fetch")).toHaveCount(0);
    await expect(page.locator('[data-lane="catchup"]')).toHaveCount(1);
    await expect(page.locator('[data-lane="decisions"]')).toHaveCount(1);
    await expect(page.locator('[data-lane="ownership"]')).toHaveCount(1);

    // service-lanes-2: expand one lane. It reaches `running` — the exact
    // "Working…" line `renderLaneBody` (panel-view.ts) emits for that
    // state, held open long enough to observe by this scenario's own
    // `delayMs` above — then settles on `done` with a brief. Never an empty
    // lane.
    await page.locator('[data-lane="catchup"] summary').click();
    await expect(page.locator('[data-lane="catchup"] .nimbus-related__status')).toHaveText(
      "Working…",
    );
    const brief = page.locator('[data-lane="catchup"] .nimbus-related__brief');
    await expect(brief).toHaveText(AGENT_RUN_DONE.brief);
    expect(invokeCalls.length).toBe(1);

    // service-lanes-3: close and reopen the panel, then re-expand the same
    // lane. The stored brief replays, and the invoke counter above — not a
    // race against how quickly the answer comes back — is what proves no
    // second run started: `handleAgentRun`'s cache check (handlers.ts) reads
    // the persisted answer and returns it WITHOUT ever calling
    // `invokeWithRetry`, so a second POST would only happen if that
    // short-circuit failed.
    await togglePanel(h.sw, url); // close
    await expect(page.locator(`#${PANEL_HOST_ID}`)).toHaveCount(0);
    await togglePanel(h.sw, url); // reopen
    await page.locator('[data-lane="catchup"] summary').click();
    const repaintedBrief = page.locator('[data-lane="catchup"] .nimbus-related__brief');
    await expect(repaintedBrief).toHaveText(AGENT_RUN_DONE.brief);
    expect(invokeCalls.length).toBe(1);
  } finally {
    await h.close();
  }
});

test("a resolved pull request shows the item lanes, never the service lanes", async () => {
  const h = await launchExtension();
  try {
    // A bare-root ConfiguredOrigin (no path prefix) so a PR-shaped path under
    // it matches `matchGithub`'s pull-request pattern rather than its home
    // branch — the opposite configuration from the dashboard test above.
    await h.sw.evaluate(async (origin) => {
      await chrome.storage.local.set({ origins: [{ origin, product: "github" }] });
    }, h.origin);

    // The mock only serves 200 for /sample, so load that first, then move the
    // tab on via the History API — same-document, no request — to a PR path
    // the seeded origin recognises. Same technique as capture.e2e.ts's
    // recognised-page test: `chrome.tabs.get` (and therefore recognise/resolve)
    // sees this exactly as it would a real SPA-driven route change.
    const page = await h.context.newPage();
    await page.goto(`${h.origin}/sample`);
    const url = `${h.origin}/acme/web/pull/482`;
    await page.evaluate((path) => history.pushState({}, "", path), "/acme/web/pull/482");
    await page.bringToFront();
    await togglePanel(h.sw, url);

    // service-lanes-4: Related and the two page (item) lanes are present;
    // none of the three service lanes are — the surface gate (`LANE_RULES`,
    // shared/types.ts) is exclusive, not additive.
    await expect(page.locator('[data-lane="related"]')).toHaveCount(1);
    await expect(page.locator('[data-lane="impact"]')).toHaveCount(1);
    await expect(page.locator('[data-lane="expert"]')).toHaveCount(1);
    await expect(page.locator('[data-lane="catchup"]')).toHaveCount(0);
    await expect(page.locator('[data-lane="decisions"]')).toHaveCount(0);
    await expect(page.locator('[data-lane="ownership"]')).toHaveCount(0);
  } finally {
    await h.close();
  }
});
