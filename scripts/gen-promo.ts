// Generate the Chrome Web Store promo tiles (Small 440x280, Marquee 1400x560)
// by rendering a designed HTML template to an exact-size PNG with Playwright —
// the same Chromium tooling the screenshots script uses, so text is crisp and
// the output is reproducible. Run under node (not bun) for the same stdio reason
// as scripts/screenshots/capture.ts: `bun run build` is NOT required.
// Usage: `bun run promo`  (Playwright Chromium must be installed — `bun run screenshots:setup`).
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "store/promo");

interface TileSpec {
  readonly name: string;
  readonly w: number;
  readonly h: number;
  readonly icon: number;
  readonly title: number;
  readonly tagline: number;
  readonly chip: number;
  readonly gap: number;
}

const SPECS: readonly TileSpec[] = [
  {
    name: "small-tile-440x280",
    w: 440,
    h: 280,
    icon: 120,
    title: 30,
    tagline: 15,
    chip: 12,
    gap: 26,
  },
  {
    name: "marquee-1400x560",
    w: 1400,
    h: 560,
    icon: 236,
    title: 76,
    tagline: 32,
    chip: 23,
    gap: 60,
  },
];

/** The app mark: Nimbus cloud + clip/bookmark on the brand-blue rounded tile. */
const MARK = `
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b78ea"/>
      <stop offset="1" stop-color="#275fd4"/>
    </linearGradient>
  </defs>
  <rect x="3" y="3" width="122" height="122" rx="28" fill="url(#tile)"/>
  <g fill="#f6f9ff">
    <circle cx="47" cy="66" r="17"/>
    <circle cx="69" cy="53" r="23"/>
    <circle cx="88" cy="67" r="15"/>
    <rect x="39" y="68" width="55" height="18" rx="9"/>
  </g>
  <path d="M53 70 a8 8 0 0 1 8 -8 h14 a8 8 0 0 1 8 8 v34 l-15 -11 -15 11 z" fill="#275fd4"/>
  <path d="M56 71 a6 6 0 0 1 6 -6 h12 a6 6 0 0 1 6 6 v29 l-12 -9 -12 9 z" fill="#e6eeff"/>
</svg>`;

function html(s: TileSpec): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${s.w}px; height: ${s.h}px; }
    .tile {
      width: ${s.w}px; height: ${s.h}px;
      display: flex; align-items: center; justify-content: center; gap: ${s.gap}px;
      background: linear-gradient(135deg, #ffffff 0%, #e8f0ff 100%);
      font-family: "Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif;
    }
    .mark { width: ${s.icon}px; height: ${s.icon}px; flex: none;
      filter: drop-shadow(0 ${s.icon * 0.06}px ${s.icon * 0.14}px rgba(39, 95, 212, .30)); }
    .copy { display: flex; flex-direction: column; gap: ${s.gap * 0.34}px; }
    .title { font-size: ${s.title}px; font-weight: 700; color: #17356a; letter-spacing: -0.5px; line-height: 1.02; }
    .tagline { font-size: ${s.tagline}px; font-weight: 400; color: #4d5f80; line-height: 1.3; max-width: ${s.w * 0.5}px; }
    .chips { display: flex; gap: ${s.chip * 0.6}px; margin-top: ${s.gap * 0.18}px; }
    .chip { font-size: ${s.chip}px; font-weight: 600; color: #275fd4;
      background: #d9e6ff; border-radius: 999px; padding: ${s.chip * 0.34}px ${s.chip * 0.85}px; }
  </style></head><body>
    <div class="tile">
      <div class="mark">${MARK}</div>
      <div class="copy">
        <div class="title">Nimbus Web&nbsp;Clipper</div>
        <div class="tagline">Clip what you read into your private, local-first index.</div>
        <div class="chips">
          <span class="chip">Local-first</span>
          <span class="chip">No telemetry</span>
          <span class="chip">Loopback-only</span>
        </div>
      </div>
    </div>
  </body></html>`;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const s of SPECS) {
      const page = await browser.newPage({
        viewport: { width: s.w, height: s.h },
        deviceScaleFactor: 1,
      });
      await page.setContent(html(s), { waitUntil: "load" });
      await page.screenshot({
        path: resolve(OUT, `${s.name}.png`),
        clip: { x: 0, y: 0, width: s.w, height: s.h },
      });
      await page.close();
      console.log(`wrote store/promo/${s.name}.png (${s.w}x${s.h})`);
    }
  } finally {
    await browser.close();
  }
}

await main();
