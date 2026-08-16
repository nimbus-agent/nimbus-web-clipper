// Shared Chromium-with-extension launcher: loads the built dist/chrome
// extension, resolves its dynamically-generated extension id, and seeds a
// paired connection pointing at a loopback mock gateway on an ephemeral port.
// Used by the store-screenshot script (capture.ts) and the e2e suite — one
// copy, so the mechanics below never drift between the two.
//
// NOTE: like capture.ts, anything importing this must run under `node`, not
// `bun`. Playwright drives Chromium over `--remote-debugging-pipe`, which
// needs stdio fds 3/4; Bun on Windows does not wire those up, so every launch
// hangs until timeout.
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Worker } from "playwright";
import type { Scenario } from "../screenshots/gateway-fixtures.ts";
import { startMockGateway } from "../screenshots/mock-gateway.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXT_DIR = resolve(ROOT, "dist/chrome");

// A fixed "paired since" instant (2026-07-01T09:30:00Z). Not `0` — the options
// page renders this date, and the epoch reads as "Jan 1, 1970" (looks like a bug
// in a store screenshot). Pinned with timezoneId/locale below so the rendered
// date is identical on every machine.
const PAIRED_AT = 1_782_898_200_000;

export interface Harness {
  readonly context: BrowserContext;
  readonly sw: Worker; // playwright's service-worker handle
  readonly extId: string;
  readonly origin: string; // http://127.0.0.1:<ephemeral>
  readonly close: () => Promise<void>;
}

export async function launchExtension(opts?: {
  scenario?: Scenario;
  viewport?: { width: number; height: number };
  timezoneId?: string;
  locale?: string;
  pairedAt?: number;
}): Promise<Harness> {
  const viewport = opts?.viewport ?? { width: 1280, height: 800 };
  const timezoneId = opts?.timezoneId ?? "UTC";
  const locale = opts?.locale ?? "en-US";
  const pairedAt = opts?.pairedAt ?? PAIRED_AT;

  // Port 0 asks the OS for a free port — a fixed port collides under
  // Playwright's parallel workers and between concurrent CI jobs. Wait for
  // "listening" before reading it back: listen() is async, and address()
  // returns null until the underlying handle is bound.
  const server = startMockGateway(opts?.scenario ?? {}, 0);
  await new Promise<void>((done) => server.once("listening", done));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  // headless: true resolves to Playwright's separate "headless shell" binary,
  // which silently loads no extensions (the MV3 service worker never appears).
  // Force the regular Chromium binary into new-headless mode via the CLI flag so
  // the extension actually loads.
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    viewport,
    timezoneId,
    locale,
    args: [
      "--headless=new",
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ],
  });

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
  // The ephemeral port rides in on `origin`; nothing else needs to know it.
  await sw.evaluate(
    async (conn) => {
      await chrome.storage.local.set({ connection: conn });
    },
    {
      origin,
      token: "mock-bearer-token-not-a-real-secret",
      label: "Mock Device",
      pairedAt,
    },
  );

  return {
    context,
    sw,
    extId,
    origin,
    close: async () => {
      await context.close();
      server.close();
    },
  };
}
