/**
 * Covers `docs/development.md` → "Manual verification — Lanes that take an
 * input (C2.5 · glossary · 4.2)".
 *
 * COVERS steps 1-9 (ids input-lanes-1..9). Five of those steps — 1, 2, 3, 5
 * and 6 — begin, in the checklist, with a right-click on an extension context
 * menu ("Define in Nimbus" / "What's related to this?"). Extension context
 * menus are not part of the page; Playwright has no way to click one. What
 * this suite drives instead is the same worker path EVERY menu entry
 * converges on — the panel's own selection hook (`PANEL_SELECTION_HOOK` on
 * the element `PANEL_HOST_ID`, both from src/shared/panel-host.ts), the exact
 * lookup `callSelectionHook` (src/browser/scripting.ts) performs — by calling
 * that hook directly through `chrome.scripting.executeScript` from the
 * service worker (see `deliverSelection` below for why that, and not
 * `page.evaluate`, is the faithful stand-in). A CLOSED panel is injected
 * first and then handed the selection, in two visible steps, because that is
 * the one branch (`deliverSelection`'s — the production one's — mount-on-miss
 * fallback) this suite must not pretend a single call already covers. Each of
 * those five steps' text below carries both its marker AND the sentence
 * "(e2e covers the handler; the context-menu gesture itself is human)" for
 * exactly this reason.
 *
 * Steps 4, 7, 8 and 9 need no gesture stand-in at all — repeating step 1 on
 * an unrecognised page (4, folded into the same test as 1 below), an empty
 * panel with no selection anywhere (7), an ambiguous page's own chooser (8),
 * and an SPA re-read (9) — so they carry a plain marker with no caveat.
 *
 * NOT covered: the context-menu registration itself, the worker's click
 * routing to `deliverSelection`, or the browser's OWN capture of
 * `info.selectionText` from inside a form control (step 5's real point — see
 * that test's own comment for the honest boundary there).
 *
 * Step 10 (repeat 1, 2, 6 and 8 in Firefox) is human: Firefox is out of Phase
 * 1 entirely, and this harness loads only the Chrome build.
 */
import { expect, test } from "@playwright/test";
import type { Harness } from "../../scripts/e2e/launch.ts";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import { AGENT_RUN_DONE, type Scenario } from "../../scripts/screenshots/gateway-fixtures.ts";
import { GATEWAY_PATHS } from "../../src/shared/gateway.ts";
import { PANEL_HOST_ID, PANEL_SELECTION_HOOK } from "../../src/shared/panel-host.ts";

export const COVERS = [
  "input-lanes-1",
  "input-lanes-2",
  "input-lanes-3",
  "input-lanes-4",
  "input-lanes-5",
  "input-lanes-6",
  "input-lanes-7",
  "input-lanes-8",
  "input-lanes-9",
] as const;

/**
 * Injects panel.js into the tab currently on `url`, queried by URL rather
 * than `lastFocusedWindow` — same reasoning as capture.e2e.ts's identical
 * helper. Self-toggling, like `panel.js` itself: a first call mounts it, a
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

/**
 * Calls an ALREADY-OPEN panel's selection hook — the same lookup
 * `callSelectionHook` (src/browser/scripting.ts) performs, by element id and
 * hook property NAME, both imported from `shared/panel-host.ts` rather than
 * retyped so a rename breaks this test loudly instead of silently skipping
 * the hook.
 *
 * Driven through `chrome.scripting.executeScript` from the SERVICE WORKER,
 * not `page.evaluate` — found the hard way, by running this suite: MV3
 * content scripts (panel.js, injected with no `world` option and so
 * defaulting to `ISOLATED`) get their own JS realm, and a custom property one
 * script sets on a DOM element is invisible to a DIFFERENT realm reading the
 * SAME element — including Playwright's `page.evaluate`, which runs in the
 * page's MAIN world. `chrome.scripting.executeScript` with no `world` option
 * lands in that SAME isolated world panel.js itself runs in, which is
 * exactly what makes this the faithful stand-in for the hook lookup
 * `callSelectionHook` performs — not a same-effect substitute for it.
 */
async function deliverSelection(
  sw: Harness["sw"],
  url: string,
  text: string,
  intent: "define" | "related",
): Promise<void> {
  await sw.evaluate(
    async ([target, hostId, hook, sel]) => {
      const [tab] = await chrome.tabs.query({ url: target as string });
      if (tab?.id === undefined) {
        throw new Error(`e2e: no tab matched ${target}`);
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (hostId2: string, hook2: string, sel2: unknown) => {
          const host = document.getElementById(hostId2) as
            | (HTMLElement & Record<string, unknown>)
            | null;
          const fn = host?.[hook2];
          if (typeof fn === "function") {
            (fn as (s: unknown) => void)(sel2);
          }
        },
        args: [hostId as string, hook as string, sel],
      });
    },
    [url, PANEL_HOST_ID, PANEL_SELECTION_HOOK, { text, intent }] as const,
  );
}

test("Define in Nimbus opens a closed panel with the glossary lane already answered, recognised page or not", async () => {
  const h = await launchExtension();
  try {
    // No origins configured — deliberately unrecognised (input-lanes-4's own
    // page). The mock's /sample is under no built-in or configured origin, so
    // this is the same "internal wiki" case the checklist step names.
    const page = await h.context.newPage();
    const url = `${h.origin}/sample`;
    await page.goto(url);
    await page.bringToFront();

    // Two visible steps, deliberately not one: the panel is not open yet, so
    // this is `deliverSelection`'s mount-on-miss fallback, not its
    // already-open hook call (see this suite's own header comment).
    await togglePanel(h.sw, url); // inject
    await deliverSelection(h.sw, url, "cache", "define"); // hand it the selection

    // input-lanes-1: the panel is open, the glossary lane is already
    // expanded, and it answers.
    const glossaryLane = page.locator('[data-lane="glossary"]');
    await expect(glossaryLane).toHaveCount(1);
    await expect(glossaryLane.locator("summary")).toHaveText("“cache”");
    await expect(glossaryLane.locator(".nimbus-related__brief")).toHaveText(AGENT_RUN_DONE.brief);

    // input-lanes-4: this is the "slice's central claim" — the lane works on
    // a page Nimbus does not recognise, AND the PAGE lanes stay absent (there
    // is no subject for them to be about). Related is not one of those: it
    // renders on any non-home page regardless of recognition (panel-in-page.ts
    // only withholds it on a product dashboard) — its own absence would be the
    // wrong claim to make here.
    await expect(page.locator('[data-lane="related"]')).toHaveCount(1);
    for (const lane of ["impact", "expert", "catchup", "decisions", "ownership"]) {
      await expect(page.locator(`[data-lane="${lane}"]`)).toHaveCount(0);
    }
  } finally {
    await h.close();
  }
});

test("Define in Nimbus on a second word retitles the still-open panel instead of reopening it", async () => {
  const h = await launchExtension();
  try {
    const page = await h.context.newPage();
    const url = `${h.origin}/sample`;
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url); // open, with no selection yet

    await deliverSelection(h.sw, url, "alpha", "define");
    const glossaryLane = page.locator('[data-lane="glossary"]');
    await expect(glossaryLane.locator("summary")).toHaveText("“alpha”");
    await expect(glossaryLane.locator(".nimbus-related__brief")).toHaveText(AGENT_RUN_DONE.brief);

    // input-lanes-2: a SECOND selection while the panel is still open is
    // delivered the SAME way — no re-injection — which is exactly the toggle
    // hazard this step exists to guard: `panel.js` self-toggles, so if the
    // worker ever re-injected to deliver this it would close the panel the
    // user is looking at.
    await deliverSelection(h.sw, url, "beta", "define");

    await expect(page.locator(`#${PANEL_HOST_ID}`)).toHaveCount(1);
    await expect(glossaryLane.locator("summary")).toHaveText("“beta”");
    await expect(glossaryLane.locator(".nimbus-related__brief")).toHaveText(AGENT_RUN_DONE.brief);
  } finally {
    await h.close();
  }
});

test("a passage refuses locally, with no glossary invoke ever sent", async () => {
  const glossaryInvokes: string[] = [];
  const scenario: Scenario = {
    onRequest: (pathname) => {
      if (pathname === `${GATEWAY_PATHS.agents}/glossary`) {
        glossaryInvokes.push(pathname);
      }
    },
  };
  const h = await launchExtension({ scenario });
  try {
    const page = await h.context.newPage();
    const url = `${h.origin}/sample`;
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url);

    // Well over MAX_TERM_LENGTH (128) — a paragraph, not a term.
    const passage =
      "Local-first software keeps your data on your own machine while still " +
      "supporting collaboration and sync, and this sentence alone is already " +
      "long enough on its own to cross the term limit by a comfortable margin.";
    expect(passage.length).toBeGreaterThan(128);
    await deliverSelection(h.sw, url, passage, "define");

    // input-lanes-3: the lane still appears — the refusal is what the user
    // is owed — but says why, locally, and reaches the gateway for nothing.
    const glossaryLane = page.locator('[data-lane="glossary"]');
    await expect(glossaryLane).toHaveCount(1);
    await expect(glossaryLane.locator(".nimbus-related__status")).toHaveText(
      "That's a passage, not a term — select a word or phrase.",
    );
    expect(glossaryInvokes.length).toBe(0);
  } finally {
    await h.close();
  }
});

test("a selection lifted from inside a form control still reaches the glossary lane", async () => {
  const h = await launchExtension();
  try {
    const page = await h.context.newPage();
    const url = `${h.origin}/sample`;
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url);

    // NOT a proof that the browser's own context-menu capture
    // (`info.selectionText`) reaches into a `<textarea>` where
    // `window.getSelection()` cannot — that capture is the browser's own
    // gesture mechanics and is human (see this suite's header comment).
    // What this DOES prove: once such a selection is handed to the panel —
    // by whatever delivered it — the glossary lane treats it like any other
    // term. The term below is read from a real `<textarea>`'s own selection
    // range so the fixture is at least honestly SOURCED from a form control,
    // even though the delivery here bypasses the browser's capture entirely.
    const term = await page.evaluate(() => {
      const ta = document.createElement("textarea");
      ta.value = "the quick brown fox";
      document.body.append(ta);
      ta.focus();
      ta.setSelectionRange(4, 9); // "quick"
      return ta.value.substring(ta.selectionStart ?? 0, ta.selectionEnd ?? 0);
    });
    expect(term).toBe("quick");

    await deliverSelection(h.sw, url, term, "define");

    // input-lanes-5.
    const glossaryLane = page.locator('[data-lane="glossary"]');
    await expect(glossaryLane.locator("summary")).toHaveText("“quick”");
    await expect(glossaryLane.locator(".nimbus-related__brief")).toHaveText(AGENT_RUN_DONE.brief);
  } finally {
    await h.close();
  }
});

test("What's related to this? reruns Related and leaves glossary collapsed and unrun", async () => {
  const relatedCalls: string[] = [];
  const glossaryInvokes: string[] = [];
  const scenario: Scenario = {
    onRequest: (pathname) => {
      if (pathname === GATEWAY_PATHS.related) {
        relatedCalls.push(pathname);
      }
      if (pathname === `${GATEWAY_PATHS.agents}/glossary`) {
        glossaryInvokes.push(pathname);
      }
    },
  };
  const h = await launchExtension({ scenario });
  try {
    const page = await h.context.newPage();
    const url = `${h.origin}/sample`;
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url);

    // Wait for the panel's OWN mount-time related call to settle — a locator,
    // not a sleep — before taking the baseline count, so the assertion below
    // can only be satisfied by a SECOND request this test itself triggers.
    await expect(page.locator('[data-lane="related"] .nimbus-related__item')).toHaveCount(3);
    const baseline = relatedCalls.length;

    await deliverSelection(h.sw, url, "hybrid retrieval", "related");

    // input-lanes-6: Related re-ran — a genuinely SECOND request landed, a
    // value this test can assert on rather than a repaint that merely looks
    // the same (the mock's fixture is unconditional on the query, so the DOM
    // itself would look identical either way — see related-lane.e2e.ts's own
    // step 6 comment on that same limitation).
    await expect.poll(() => relatedCalls.length).toBeGreaterThan(baseline);

    // The glossary lane appears — the term is now visible to the panel — but
    // COLLAPSED and never run: nobody asked a question, so no agent run is
    // spent on one.
    const glossaryLane = page.locator('[data-lane="glossary"]');
    await expect(glossaryLane).toHaveCount(1);
    expect(await glossaryLane.getAttribute("open")).toBeNull();
    await expect(glossaryLane.locator(".nimbus-related__brief")).toHaveCount(0);
    expect(glossaryInvokes.length).toBe(0);
  } finally {
    await h.close();
  }
});

test("a panel opened with no selection anywhere carries no glossary lane at all", async () => {
  const h = await launchExtension();
  try {
    const page = await h.context.newPage();
    const url = `${h.origin}/sample`;
    await page.goto(url);
    await page.bringToFront();
    await togglePanel(h.sw, url);

    // input-lanes-7: no hook call at all — the mount-time page selection read
    // finds nothing either, since nothing was ever selected.
    await expect(page.locator(".nimbus-related__surface")).toBeVisible();
    await expect(page.locator('[data-lane="glossary"]')).toHaveCount(0);
  } finally {
    await h.close();
  }
});

/** A resolve answer with two indexed pull requests matching one page — the
 *  wire shape `ambiguous` parses to (see `parseResolveBody`, gateway-client.ts). */
const AMBIGUOUS_RESOLVE = {
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
} as const;

test("picking a candidate on an ambiguous page answers the item lanes about that item", async () => {
  // `resolveDefault`, not a url-keyed `resolve` entry — the mock's port is
  // ephemeral and unknown until `launchExtension` returns, so the exact
  // resolve URL cannot be known at scenario-construction time. Same technique
  // as capture.e2e.ts's captured-header test.
  const scenario: Scenario = { resolveDefault: AMBIGUOUS_RESOLVE };
  const h = await launchExtension({ scenario });
  try {
    await h.sw.evaluate(async (origin) => {
      await chrome.storage.local.set({ origins: [{ origin, product: "github" }] });
    }, h.origin);

    const page = await h.context.newPage();
    await page.goto(`${h.origin}/sample`);
    const url = `${h.origin}/acme/web/pull/482`;
    await page.evaluate((path) => history.pushState({}, "", path), "/acme/web/pull/482");
    await page.bringToFront();
    await togglePanel(h.sw, url);

    await expect(page.locator(".nimbus-related__candidate")).toHaveCount(2);
    await page.locator(".nimbus-related__candidate").first().click();

    // input-lanes-8: the two page lanes now appear UNDER the chosen header
    // and answer about that item — never the "couldn't pin this page to one
    // indexed item" refusal `not_resolved` renders.
    await expect(page.locator(".nimbus-related__header-item")).toHaveText(
      "Cache the readability pass",
    );
    const impactLane = page.locator('[data-lane="impact"]');
    await expect(impactLane).toHaveCount(1);
    await impactLane.locator("summary").click();
    await expect(impactLane.locator(".nimbus-related__brief")).toHaveText(AGENT_RUN_DONE.brief);
    await expect(impactLane.locator(".nimbus-related__status")).toHaveCount(0);
  } finally {
    await h.close();
  }
});

test("an SPA navigation away, then re-read, drops the glossary lane for the old selection", async () => {
  const h = await launchExtension();
  try {
    await h.sw.evaluate(async (origin) => {
      await chrome.storage.local.set({ origins: [{ origin, product: "jenkins" }] });
    }, h.origin);

    const page = await h.context.newPage();
    await page.goto(`${h.origin}/sample`);
    const firstUrl = `${h.origin}/job/widget/7`;
    await page.evaluate((path) => history.pushState({}, "", path), "/job/widget/7");
    await page.bringToFront();
    await togglePanel(h.sw, firstUrl);

    await deliverSelection(h.sw, firstUrl, "widget", "define");
    const glossaryLane = page.locator('[data-lane="glossary"]');
    await expect(glossaryLane.locator(".nimbus-related__brief")).toHaveText(AGENT_RUN_DONE.brief);

    // A DIFFERENT recognised item (a different build number), not merely a
    // different URL — `sameItem` compares identity, and two unrecognised
    // pages compare equal on purpose (recognise.ts), so this has to be a
    // second recognised item for the "You've moved on" notice to appear at
    // all.
    await page.evaluate((path) => history.pushState({}, "", path), "/job/widget/9");

    // A locator wait, not a sleep: the panel's own nav-check interval
    // (NAV_CHECK_MS) is what flips this on, and this assertion polls for
    // that real event rather than timing it.
    const navAway = page.locator(".nimbus-related__navaway");
    await expect(navAway).toBeVisible();

    await navAway.locator(".nimbus-related__action").click();

    // input-lanes-9: the glossary lane is gone — the selection belonged to
    // the page this panel has stopped describing.
    await expect(glossaryLane).toHaveCount(0);
    await expect(page.locator(".nimbus-related__surface")).toHaveText("Jenkins build · widget #9");
  } finally {
    await h.close();
  }
});
