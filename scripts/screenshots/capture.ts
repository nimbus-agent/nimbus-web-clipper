// Deterministic store-screenshot capture. Loads the built dist/chrome extension
// in Chromium, seeds a paired connection pointing at the loopback mock gateway,
// and shoots the popup, options page, and injected related panel at 1280×800.
// Run: `bun run build && bun run screenshots`. Manual/integration — not a unit test.
//
// NOTE: this is the one script in the repo that runs under `node`, not `bun` (see
// the `screenshots` script in package.json). Playwright drives Chromium over
// `--remote-debugging-pipe`, which needs stdio fds 3/4; Bun on Windows does not
// wire those up, so every launch hangs until timeout. Node runs this file's TS
// directly via type-stripping, so no build step is needed.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { DEFAULT_PORT, startMockGateway } from "./mock-gateway.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXT_DIR = resolve(ROOT, "dist/chrome");
const OUT_CHROME = resolve(ROOT, "store/screenshots/chrome");
const OUT_FIREFOX = resolve(ROOT, "store/screenshots/firefox");
const ORIGIN = `http://127.0.0.1:${DEFAULT_PORT}`;
const VIEWPORT = { width: 1280, height: 800 } as const;
const SHOTS = ["popup.png", "options.png", "panel.png"] as const;
// A fixed "paired since" instant (2026-07-01T09:30:00Z). Not `0` — the options
// page renders this date, and the epoch reads as "Jan 1, 1970" (looks like a bug
// in a store screenshot). Pinned with timezoneId/locale below so the rendered
// date is identical on every machine.
const PAIRED_AT = 1_782_898_200_000;

async function main(): Promise<void> {
  mkdirSync(OUT_CHROME, { recursive: true });
  mkdirSync(OUT_FIREFOX, { recursive: true });

  const server = startMockGateway();
  // headless: true resolves to Playwright's separate "headless shell" binary,
  // which silently loads no extensions (the MV3 service worker never appears).
  // Force the regular Chromium binary into new-headless mode via the CLI flag so
  // the extension actually loads.
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    viewport: VIEWPORT,
    timezoneId: "UTC",
    locale: "en-US",
    args: [
      "--headless=new",
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ],
  });

  try {
    // Resolve the dynamically-generated extension id from the MV3 service worker.
    // MV3 workers can register lazily under headless, so nudge activation by
    // opening a page first, then resolve via Playwright's serviceWorkers()/event
    // with a timeout (fail loudly, don't hang). Note: the Puppeteer
    // `targetcreated` / `target.type()` form does not exist in Playwright.
    await context.newPage();
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
    }
    const extId = new URL(sw.url()).host;

    // Seed a paired connection (storage key "connection") pointing at the mock.
    await sw.evaluate(
      async (conn) => {
        await chrome.storage.local.set({ connection: conn });
      },
      {
        origin: ORIGIN,
        token: "mock-bearer-token-not-a-real-secret",
        label: "Mock Device",
        pairedAt: PAIRED_AT,
      },
    );

    // Popup — composited centered on a padded canvas (the popup is ~360px wide).
    const popup = await context.newPage();
    await popup.setViewportSize(VIEWPORT);
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    // popup.css sets no width on <body> (only `.popup { min-width: 280px }`), so
    // pin an explicit width here — otherwise the flex-centered body renders at an
    // unnatural width. 360px matches the popup's natural min-width + padding.
    await popup.addStyleTag({
      content:
        "html{margin:0;min-height:800px;display:flex;align-items:center;justify-content:center;background:#eef1f7}" +
        "body{width:360px;box-shadow:0 12px 40px rgba(0,0,0,.18);border-radius:12px;overflow:hidden}",
    });
    await popup.screenshot({ path: resolve(OUT_CHROME, "popup.png") });

    // Options — paired state fills the viewport.
    const options = await context.newPage();
    await options.setViewportSize(VIEWPORT);
    await options.goto(`chrome-extension://${extId}/options.html`);
    await options.waitForLoadState("networkidle");
    await options.screenshot({ path: resolve(OUT_CHROME, "options.png") });

    // Related panel — inject panel.js into the loopback sample page, wait for items.
    const sample = await context.newPage();
    await sample.setViewportSize(VIEWPORT);
    await sample.goto(`${ORIGIN}/sample`);
    await sample.bringToFront();
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id !== undefined) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["panel.js"] });
      }
    });
    await sample.locator(".nimbus-related__item").first().waitFor({ timeout: 5000 });
    await sample.screenshot({ path: resolve(OUT_CHROME, "panel.png") });

    // Firefox reuses the Chromium captures (AMO dimension rules are looser).
    for (const name of SHOTS) {
      copyFileSync(resolve(OUT_CHROME, name), resolve(OUT_FIREFOX, name));
    }
    console.log(`wrote ${SHOTS.length} screenshots to store/screenshots/{chrome,firefox}/`);
  } finally {
    await context.close();
    server.close();
  }
}

await main();
