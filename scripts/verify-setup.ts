// Automated run of docs/development.md's "Manual verification — Setup that works"
// checklist (steps 1-6) against the built dist/chrome extension.
//
// Run: `bun run build && bun run verify:setup`
//
// WHY THIS EXISTS: that checklist had never been run. It is written for a human
// because it needs a gateway to start and stop on demand — but the repo already
// ships a loopback mock gateway that can be started and stopped in-process, and
// a Playwright harness that loads the real built extension. Steps 1-6 are
// mechanical assertions about what the Options page shows; a machine can make
// them, repeatedly, in CI.
//
// WHAT IT DOES NOT COVER, and why — do not read a green run as "the whole
// checklist passed":
//   - Step 7 (repeat in Firefox). Playwright cannot side-load an MV3 extension
//     into Firefox the way `--load-extension` does for Chromium. Still manual.
//   - Step 8 (the C2.3 service-lane backlog). It needs real GitHub / GitLab /
//     Bitbucket / Jira / Jenkins dashboards; the recognisers key on those real
//     hostnames, which this loopback fixture cannot present. Still manual.
//   - Step 5's clip is SYNTHESIZED. It sends the same `clip` message the popup
//     sends, through the same handler, so it does exercise `markClipSuccess` —
//     but it is not a real toolbar gesture, so it does not prove the popup
//     button is wired.
//
// Runs under `node`, not `bun` — same reason capture.ts documents: Playwright
// drives Chromium over `--remote-debugging-pipe`, which needs stdio fds 3/4,
// and Bun on Windows does not wire those up.

import type { Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page, type Worker } from "playwright";
import { startMockGateway } from "./screenshots/mock-gateway.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = resolve(ROOT, "dist/chrome");
// The port zero-config discovery probes. NOT the mock's default 8765 — the whole
// point of steps 2-3 is that discovery finds a gateway without being told where.
const DISCOVERY_PORT = 7474;
const ORIGIN = `http://127.0.0.1:${DISCOVERY_PORT}`;

interface Result {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
}

const results: Result[] = [];

function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}\n      ${detail}`);
}

/** Read a stage section's data-state, or "<absent>" when the element is missing. */
async function stageState(page: Page, id: string): Promise<string> {
  return await page.evaluate(
    (elId) => document.getElementById(elId)?.dataset["state"] ?? "<absent>",
    id,
  );
}

async function textOf(page: Page, id: string): Promise<string> {
  return await page.evaluate(
    (elId) => document.getElementById(elId)?.textContent?.trim() ?? "<absent>",
    id,
  );
}

/** Open a fresh Options tab and wait for its async render to settle. */
async function openOptions(ctx: BrowserContext, extId: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.waitForLoadState("networkidle");
  // The stage render is driven by a message round-trip to the service worker,
  // not by load — poll for it rather than racing it with a fixed sleep.
  await page
    .waitForFunction(
      () => document.getElementById("stage-connect")?.dataset["state"] !== undefined,
      { timeout: 5000 },
    )
    .catch(() => undefined);
  return page;
}

async function main(): Promise<void> {
  let server: Server | null = null;

  const context = await chromium.launchPersistentContext("", {
    headless: false,
    viewport: { width: 1280, height: 900 },
    timezoneId: "UTC",
    locale: "en-US",
    args: [
      "--headless=new",
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ],
  });

  try {
    await context.newPage();
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
    }
    const worker: Worker = sw;
    const extId = new URL(worker.url()).host;
    console.log(`extension id: ${extId}\n`);

    // ---- Step 1: fresh profile shows stage 1 active, 2-3 dimmed --------------
    {
      const page = await openOptions(context, extId);
      const connect = await stageState(page, "stage-connect");
      const connection = await stageState(page, "stage-connection");
      const sites = await stageState(page, "stage-sites");
      const trust = await stageState(page, "stage-trust");
      record(
        "1. fresh profile: stage 1 active, 2-3 dimmed",
        connect === "active" && connection === "locked" && sites === "locked",
        `connect=${connect} connection=${connection} sites=${sites} trust=${trust}`,
      );
      await page.close();
    }

    // ---- Step 2: gateway stopped -> "No gateway found", URL still editable ---
    {
      const page = await openOptions(context, extId);
      await page.click("#discover");
      await page.waitForFunction(
        () => (document.getElementById("discover-status")?.textContent ?? "") !== "Looking…",
        { timeout: 15_000 },
      );
      const status = await textOf(page, "discover-status");
      const editable = await page.evaluate(() => {
        const el = document.getElementById("origin");
        return el instanceof HTMLInputElement && !el.disabled && !el.readOnly;
      });
      record(
        "2. gateway stopped: no gateway found, URL still editable",
        status.toLowerCase().includes("no gateway found") && editable,
        `status=${JSON.stringify(status)} originEditable=${editable}`,
      );
      await page.close();
    }

    // ---- Step 3: gateway started -> the URL fills in -------------------------
    server = startMockGateway({}, DISCOVERY_PORT);
    {
      const page = await openOptions(context, extId);
      await page.click("#discover");
      await page.waitForFunction(
        () => (document.getElementById("discover-status")?.textContent ?? "") !== "Looking…",
        { timeout: 15_000 },
      );
      const status = await textOf(page, "discover-status");
      const originValue = await page.evaluate(() => {
        const el = document.getElementById("origin");
        return el instanceof HTMLInputElement ? el.value : "<absent>";
      });
      record(
        "3. gateway started: the URL fills in",
        originValue === ORIGIN,
        `origin=${JSON.stringify(originValue)} status=${JSON.stringify(status)}`,
      );
      await page.close();
    }

    // ---- Step 4: pair -> stages 2-3 open, health line names the origin -------
    {
      const page = await openOptions(context, extId);
      await page.fill("#origin", ORIGIN);
      await page.fill("#code", "429173");
      await page.click("#pair");
      await page.waitForFunction(
        () => document.getElementById("stage-connection")?.dataset["state"] === "active",
        { timeout: 15_000 },
      );
      const connection = await stageState(page, "stage-connection");
      const sites = await stageState(page, "stage-sites");
      const health = await textOf(page, "health-line");
      record(
        "4. paired: stages 2-3 open, health line names the origin",
        connection === "active" && sites === "active" && health.includes(ORIGIN),
        `connection=${connection} sites=${sites} health=${JSON.stringify(health)}`,
      );
      await page.close();
    }

    // ---- Step 5: clip -> health line reports the last clip -------------------
    // SYNTHESIZED: sends the same `clip` message the popup sends, through the
    // same handler. Exercises markClipSuccess; does NOT prove the popup button.
    {
      // Sent from an EXTENSION PAGE, not from the service worker. A worker's own
      // `chrome.runtime.sendMessage` does not reach its own `onMessage` listener
      // ("Receiving end does not exist") — the popup is a page, so a page is the
      // faithful sender here.
      const sender = await openOptions(context, extId);
      const clipped = await sender.evaluate(async () => {
        return await chrome.runtime.sendMessage({
          kind: "clip",
          capture: {
            url: "http://127.0.0.1:7474/sample",
            title: "Designing local-first software",
            mode: "article",
            body: "Local-first software keeps your data on your own machine.",
            readableFound: true,
          },
          tags: [],
        });
      });
      await sender.close();
      const page = await openOptions(context, extId);
      const health = await textOf(page, "health-line");
      record(
        "5. after a clip: health line reports the last clip",
        health.includes("Last clip"),
        `clipResponse=${JSON.stringify(clipped)} health=${JSON.stringify(health)}`,
      );
      await page.close();
    }

    // ---- Step 6: gateway stopped -> "Can't reach", stages 2-3 STILL usable ---
    // `close()` alone is NOT "the gateway stopped": it stops accepting NEW
    // connections but leaves established keep-alive sockets serving, and
    // Chromium holds one from the probes above — so the health GET would still
    // succeed and this step would report a false PASS. Destroy the sockets too.
    server.closeAllConnections();
    server.close();
    server = null;
    await new Promise((r) => setTimeout(r, 500));
    {
      const page = await openOptions(context, extId);
      const health = await textOf(page, "health-line");
      const connection = await stageState(page, "stage-connection");
      const sites = await stageState(page, "stage-sites");
      // The locked CSS kills pointer-events on buttons; if stage 2 re-locked,
      // Unpair would be unclickable — the exact failure the design forbids.
      const unpairClickable = await page.evaluate(() => {
        const btn = document.getElementById("unpair");
        if (!(btn instanceof HTMLButtonElement)) return false;
        return getComputedStyle(btn).pointerEvents !== "none" && !btn.disabled;
      });
      record(
        "6. gateway stopped: can't-reach shown, stages 2-3 still usable",
        health.toLowerCase().includes("can't reach") &&
          connection === "active" &&
          sites === "active" &&
          unpairClickable,
        `health=${JSON.stringify(health)} connection=${connection} sites=${sites} unpairClickable=${unpairClickable}`,
      );
      await page.close();
    }
  } finally {
    if (server !== null) {
      server.close();
    }
    await context.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  console.log("NOT COVERED: step 7 (Firefox) and step 8 (C2.3 dashboards) remain manual.");
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await main();
