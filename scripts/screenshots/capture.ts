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
import { launchExtension } from "../e2e/launch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_CHROME = resolve(ROOT, "store/screenshots/chrome");
const OUT_FIREFOX = resolve(ROOT, "store/screenshots/firefox");
const VIEWPORT = { width: 1280, height: 800 } as const;
const SHOTS = ["popup.png", "options.png", "panel.png"] as const;

async function main(): Promise<void> {
  mkdirSync(OUT_CHROME, { recursive: true });
  mkdirSync(OUT_FIREFOX, { recursive: true });

  const { context, sw, extId, origin, close } = await launchExtension({ viewport: VIEWPORT });

  try {
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
    await sample.goto(`${origin}/sample`);
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
    await close();
  }
}

await main();
