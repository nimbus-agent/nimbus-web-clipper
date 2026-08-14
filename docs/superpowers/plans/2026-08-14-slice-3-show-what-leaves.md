# Slice 3 — Show What Leaves: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user see exactly what leaves the browser — the clip payload before it is sent, and the item before the gateway is asked to go and fetch it.

**Architecture:** One pure builder (`shared/preview.ts`) produces both shapes from data the caller already holds, so the preview can never drift from the request. The popup gains a confirm step between capture and send, on by default with an off switch in Options. The panel's fetch button gains the same treatment through the same module. Quick-clip is deliberately untouched — its whole value is being one gesture.

**Tech Stack:** TypeScript (strict, no `any`), Vitest (node env; DOM tests opt into jsdom via a docblock), Biome, esbuild, MV3 (Chrome + Firefox), Bun as the runner.

**Spec:** [`docs/superpowers/specs/2026-08-14-setup-trust-and-lane-inputs-design.md`](../specs/2026-08-14-setup-trust-and-lane-inputs-design.md) — read the "Slice 3 — Show what leaves" section and the "Review Dispositions" table.

## Global Constraints

- **TypeScript strict, no `any`.** Cross-boundary data is `unknown`, narrowed by a guard.
- **No `console.*` anywhere in `src/`** — Biome enforces `noConsole` there.
- **Loopback only (I6).** This slice adds no new network destination; it only gates two existing calls behind a confirm.
- **THE BEARER TOKEN NEVER APPEARS IN A PREVIEW.** This is the invariant most likely to be broken by a future "just show the whole request" convenience. It gets its own test.
- **`textContent`, never `innerHTML`** — a preview renders a page title and a body excerpt, both attacker-controlled by definition.
- **Quick-clip stays one gesture.** Do not add a confirm to the hotkey or context-menu clip path.
- **Keep pure logic out of the `chrome.*` seam** (`src/browser/`).
- Merge new imports into the existing grouped import per module — Biome flags duplicates.
- **No new dependencies.**
- **Green bar:** `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build` before any commit.

### The copy this slice must fix

Slice 1 shipped a trust panel whose "What we send, and when" paragraph had to be written *around* the absence of this preview — an earlier draft claimed the preview existed and was caught in final review as a **Critical** (a trust panel that overclaims is worse than none). **Task 6 updates that copy.** Do not leave the panel describing a product that no longer exists: once the preview ships, the honest statement gets stronger, and failing to update it is the same defect in the opposite direction.

---

## File Structure

**Create:**
- `src/shared/preview.ts` — pure. Both preview shapes, built from data the caller already has.
- `src/popup/preview-view.ts` — pure. Renders the clip preview.
- `src/background/preview-pref.ts` — the on/off switch, stored like `ambient-prefs.ts`.
- `test/unit/preview.test.ts`, `test/unit/preview-view.test.ts`, `test/unit/preview-pref.test.ts`

**Modify:**
- `src/shared/types.ts` — add `FetchTarget`
- `src/popup/popup.html` / `popup.css` / `popup.ts` — the confirm step
- `src/options/options.html` / `options.ts` — the off switch in stage 4
- `src/panel/panel-view.ts` / `panel-in-page.ts` — the fetch confirm
- `CHANGELOG.md`, `docs/architecture.md`, `docs/development.md`, `ROADMAP.md`, and the trust-panel copy in `src/options/options.html`

---

## Task 1: The preview builders (pure)

**Files:**
- Create: `src/shared/preview.ts`
- Modify: `src/shared/types.ts` (add `FetchTarget`)
- Test: `test/unit/preview.test.ts`

**Interfaces:**
- Consumes: `ClipPayload` from `src/shared/clip.ts`; `Product`, `SurfaceKind` from `src/shared/types.ts`
- Produces:
  - `interface FetchTarget { readonly product: Product; readonly surface: SurfaceKind; readonly url: string }` (in `types.ts`)
  - `interface PreviewField { readonly label: string; readonly value: string }`
  - `interface ClipPreview { readonly fields: readonly PreviewField[]; readonly excerpt: string; readonly bodyLength: number; readonly truncated: boolean }`
  - `interface FetchPreview { readonly fields: readonly PreviewField[] }`
  - `buildClipPreview(payload: ClipPayload): ClipPreview`
  - `buildFetchPreview(target: FetchTarget): FetchPreview`
  - `EXCERPT_CHARS = 300`

- [ ] **Step 1: Write the failing test**

Create `test/unit/preview.test.ts`:

```ts
// test/unit/preview.test.ts
import { describe, expect, test } from "vitest";
import type { ClipPayload } from "../../src/shared/clip.ts";
import { buildClipPreview, buildFetchPreview, EXCERPT_CHARS } from "../../src/shared/preview.ts";
import type { FetchTarget } from "../../src/shared/types.ts";

const payload: ClipPayload = {
  url: "https://ex.com/p?utm_source=x",
  canonicalUrl: "https://ex.com/p",
  title: "Designing local-first software",
  mode: "article",
  body: "Local-first software keeps your data on your own machine.",
  tags: ["research", "work"],
  capturedAt: 1_700_000_000_000,
};

describe("buildClipPreview", () => {
  test("names every field that actually leaves", () => {
    const labels = buildClipPreview(payload).fields.map((f) => f.label);
    expect(labels).toEqual(["Title", "URL", "Canonical URL", "Mode", "Tags"]);
  });

  test("shows the real values, not placeholders", () => {
    const byLabel = new Map(buildClipPreview(payload).fields.map((f) => [f.label, f.value]));
    expect(byLabel.get("Title")).toBe("Designing local-first software");
    expect(byLabel.get("URL")).toBe("https://ex.com/p?utm_source=x");
    expect(byLabel.get("Canonical URL")).toBe("https://ex.com/p");
    expect(byLabel.get("Mode")).toBe("article");
    expect(byLabel.get("Tags")).toBe("research, work");
  });

  test("a payload with no canonical URL omits that row rather than showing a blank", () => {
    const { canonicalUrl: _omitted, ...rest } = payload;
    const labels = buildClipPreview(rest as ClipPayload).fields.map((f) => f.label);
    expect(labels).not.toContain("Canonical URL");
  });

  test("no tags reads as words, never an empty cell", () => {
    const byLabel = new Map(
      buildClipPreview({ ...payload, tags: [] }).fields.map((f) => [f.label, f.value]),
    );
    expect(byLabel.get("Tags")).toBe("none");
  });

  test("a short body is shown whole and is not marked truncated", () => {
    const p = buildClipPreview(payload);
    expect(p.excerpt).toBe(payload.body);
    expect(p.truncated).toBe(false);
    expect(p.bodyLength).toBe(payload.body.length);
  });

  test("a long body is excerpted, and reports its TRUE length", () => {
    const body = "x".repeat(EXCERPT_CHARS + 500);
    const p = buildClipPreview({ ...payload, body });
    expect(p.excerpt.length).toBe(EXCERPT_CHARS);
    expect(p.truncated).toBe(true);
    // The whole point: the user is told what actually gets sent, which is the
    // FULL body — the excerpt is a display convenience, not the payload.
    expect(p.bodyLength).toBe(EXCERPT_CHARS + 500);
  });

  test("THE TOKEN NEVER APPEARS. A stray secret on the input object is not rendered.", () => {
    const contaminated = { ...payload, token: "secret-bearer-token" } as ClipPayload;
    const serialised = JSON.stringify(buildClipPreview(contaminated));
    expect(serialised).not.toContain("secret-bearer-token");
    expect(serialised.toLowerCase()).not.toContain("token");
  });
});

describe("buildFetchPreview", () => {
  const target: FetchTarget = {
    product: "github",
    surface: "pr",
    url: "https://github.com/acme/web/pull/482",
  };

  test("names what the gateway is being asked to go and get", () => {
    expect(buildFetchPreview(target).fields).toEqual([
      { label: "Service", value: "github" },
      { label: "Type", value: "pr" },
      { label: "Address", value: "https://github.com/acme/web/pull/482" },
    ]);
  });

  test("every surface kind produces a readable type, never a raw blank", () => {
    for (const surface of ["pr", "build", "issue", "home"] as const) {
      const value = buildFetchPreview({ ...target, surface }).fields[1]?.value;
      expect(value).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- preview`
Expected: FAIL — `Cannot find module '../../src/shared/preview.ts'`

- [ ] **Step 3: Write the implementation**

In `src/shared/types.ts`, add:

```ts
/**
 * What a targeted fetch is ABOUT — the three facts a user needs before agreeing
 * to have the gateway reach out on their behalf. Assembled by the panel from the
 * recognition it already holds; no new gateway read.
 */
export interface FetchTarget {
  readonly product: Product;
  readonly surface: SurfaceKind;
  readonly url: string;
}
```

Create `src/shared/preview.ts`:

```ts
// What leaves the browser, in the user's words, before it leaves.
//
// Pure and shared so the two previews cannot drift from each other or from the
// requests they describe: both are built from exactly the data the caller is
// about to send, not from a second description of it.
import type { ClipPayload } from "./clip.ts";
import type { FetchTarget } from "./types.ts";

/** How much body text the preview shows. The FULL body is still what is sent. */
export const EXCERPT_CHARS = 300;

export interface PreviewField {
  readonly label: string;
  readonly value: string;
}

export interface ClipPreview {
  readonly fields: readonly PreviewField[];
  readonly excerpt: string;
  /** Length of the WHOLE body, not the excerpt — see buildClipPreview. */
  readonly bodyLength: number;
  readonly truncated: boolean;
}

export interface FetchPreview {
  readonly fields: readonly PreviewField[];
}

/**
 * The clip payload, field by field.
 *
 * FIELDS ARE LISTED EXPLICITLY, never derived by iterating the object's keys.
 * That is the whole defence of this module's one hard invariant — the bearer
 * token must never appear in a preview. A `for (const k of Object.keys(payload))`
 * would faithfully render whatever a future caller happened to pass in, which is
 * exactly how a secret ends up on screen. Adding a field here is deliberate;
 * inheriting one is not possible.
 *
 * `bodyLength` is the length of the WHOLE body even when the excerpt is cut,
 * because the user is agreeing to send the whole body. A preview that quietly
 * described only the part it showed would understate what leaves.
 */
export function buildClipPreview(payload: ClipPayload): ClipPreview {
  const fields: PreviewField[] = [
    { label: "Title", value: payload.title },
    { label: "URL", value: payload.url },
  ];
  if (payload.canonicalUrl !== undefined) {
    fields.push({ label: "Canonical URL", value: payload.canonicalUrl });
  }
  fields.push({ label: "Mode", value: payload.mode });
  // The word "none", not an empty string: a blank cell reads as a rendering bug,
  // and the same reasoning already governs the shortcuts readout's "Not set".
  fields.push({ label: "Tags", value: payload.tags.length === 0 ? "none" : payload.tags.join(", ") });
  const truncated = payload.body.length > EXCERPT_CHARS;
  return {
    fields,
    excerpt: truncated ? payload.body.slice(0, EXCERPT_CHARS) : payload.body,
    bodyLength: payload.body.length,
    truncated,
  };
}

/**
 * What the gateway is being asked to go and get.
 *
 * A targeted fetch is an I13 WRITE — it makes the gateway reach out to a
 * configured provider under the user's stored credential. So this names the
 * target rather than asking "Fetch this item?", which would invite a yes to
 * something the user has not been told.
 */
export function buildFetchPreview(target: FetchTarget): FetchPreview {
  return {
    fields: [
      { label: "Service", value: target.product },
      { label: "Type", value: target.surface },
      { label: "Address", value: target.url },
    ],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- preview`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/preview.ts src/shared/types.ts test/unit/preview.test.ts
git commit -m "feat(preview): name what leaves, field by explicit field"
```

---

## Task 2: The preview renderer (pure)

**Files:**
- Create: `src/popup/preview-view.ts`
- Test: `test/unit/preview-view.test.ts`

**Interfaces:**
- Consumes: `ClipPreview`, `FetchPreview`, `PreviewField` from `src/shared/preview.ts` (Task 1)
- Produces: `renderPreview(doc: Document, preview: ClipPreview | FetchPreview): DocumentFragment`

- [ ] **Step 1: Write the failing test**

Create `test/unit/preview-view.test.ts`:

```ts
// @vitest-environment jsdom
// test/unit/preview-view.test.ts
import { describe, expect, test } from "vitest";
import { renderPreview } from "../../src/popup/preview-view.ts";
import type { ClipPreview, FetchPreview } from "../../src/shared/preview.ts";

const clip: ClipPreview = {
  fields: [
    { label: "Title", value: "Designing local-first software" },
    { label: "URL", value: "https://ex.com/p" },
  ],
  excerpt: "Local-first software keeps your data on your own machine.",
  bodyLength: 57,
  truncated: false,
};

const fetchPreview: FetchPreview = {
  fields: [
    { label: "Service", value: "github" },
    { label: "Type", value: "pr" },
  ],
};

describe("renderPreview", () => {
  test("renders one row per field, label and value both present", () => {
    const frag = renderPreview(document, clip);
    const rows = frag.querySelectorAll(".preview__row");
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain("Title");
    expect(rows[0]?.textContent).toContain("Designing local-first software");
  });

  test("a clip preview shows the body excerpt", () => {
    expect(renderPreview(document, clip).textContent).toContain("keeps your data");
  });

  test("a fetch preview has no body section at all — there is no body to send", () => {
    const frag = renderPreview(document, fetchPreview);
    expect(frag.querySelector(".preview__body")).toBeNull();
  });

  test("a truncated body says so, and reports the FULL length", () => {
    const frag = renderPreview(document, {
      ...clip,
      excerpt: "x".repeat(300),
      bodyLength: 5000,
      truncated: true,
    });
    const text = frag.textContent ?? "";
    expect(text).toContain("5000");
    expect(text.toLowerCase()).toContain("showing the first");
  });

  test("values are rendered as TEXT, never as markup", () => {
    const frag = renderPreview(document, {
      ...clip,
      fields: [{ label: "Title", value: "<img src=x onerror=alert(1)>" }],
    });
    expect(frag.querySelector("img")).toBeNull();
    expect(frag.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("an excerpt containing markup is also text", () => {
    const frag = renderPreview(document, { ...clip, excerpt: "<script>alert(1)</script>" });
    expect(frag.querySelector("script")).toBeNull();
    expect(frag.textContent).toContain("<script>alert(1)</script>");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- preview-view`
Expected: FAIL — `Cannot find module '../../src/popup/preview-view.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/popup/preview-view.ts`:

```ts
// Renders either preview shape. Pure: takes a Document, returns a fragment.
import type { ClipPreview, FetchPreview, PreviewField } from "../shared/preview.ts";

function row(doc: Document, field: PreviewField): HTMLElement {
  const el = doc.createElement("div");
  el.className = "preview__row";
  const label = doc.createElement("span");
  label.className = "preview__label";
  label.textContent = field.label;
  const value = doc.createElement("span");
  value.className = "preview__value";
  // textContent, never innerHTML. Every value here is attacker-controlled by
  // definition — a page title and a URL come from the page being clipped.
  value.textContent = field.value;
  el.append(label, value);
  return el;
}

function isClipPreview(p: ClipPreview | FetchPreview): p is ClipPreview {
  return "excerpt" in p;
}

export function renderPreview(
  doc: Document,
  preview: ClipPreview | FetchPreview,
): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const field of preview.fields) {
    frag.append(row(doc, field));
  }
  if (!isClipPreview(preview)) {
    // A fetch sends no body, so there is no body section. Rendering an empty one
    // would imply content the request does not carry.
    return frag;
  }
  const body = doc.createElement("div");
  body.className = "preview__body";
  body.textContent = preview.excerpt;
  frag.append(body);
  if (preview.truncated) {
    const note = doc.createElement("p");
    note.className = "preview__note";
    // Names the FULL length: the user is agreeing to send all of it, not the
    // part shown.
    note.textContent = `Showing the first ${preview.excerpt.length} characters of ${preview.bodyLength}. All of it is sent.`;
    frag.append(note);
  }
  return frag;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- preview-view`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/popup/preview-view.ts test/unit/preview-view.test.ts
git commit -m "feat(popup): render a preview as text, never as markup"
```

---

## Task 3: The preview preference

**Files:**
- Create: `src/background/preview-pref.ts`
- Test: `test/unit/preview-pref.test.ts`

**Interfaces:**
- Consumes: `storageGet`, `storageSet` from `src/browser/storage.ts`
- Produces: `isPreviewEnabled(): Promise<boolean>`, `setPreviewEnabled(on: boolean): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/preview-pref.test.ts`:

```ts
// test/unit/preview-pref.test.ts
import { afterEach, describe, expect, test } from "vitest";
import { isPreviewEnabled, setPreviewEnabled } from "../../src/background/preview-pref.ts";
import { installChromeStub } from "./chrome-stub.ts";

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

describe("preview-pref", () => {
  test("DEFAULTS ON — an unset preference means the preview shows", async () => {
    installChromeStub();
    expect(await isPreviewEnabled()).toBe(true);
  });

  test("switching it off persists", async () => {
    installChromeStub();
    await setPreviewEnabled(false);
    expect(await isPreviewEnabled()).toBe(false);
  });

  test("switching it back on persists", async () => {
    installChromeStub({ storage: { "preview-enabled": false } });
    await setPreviewEnabled(true);
    expect(await isPreviewEnabled()).toBe(true);
  });

  test("a non-boolean stored value falls back to ON, not to off", async () => {
    // Corrupt storage must fail SAFE: showing a preview nobody asked for is a
    // minor annoyance; silently sending without one is the thing this slice exists
    // to prevent.
    installChromeStub({ storage: { "preview-enabled": "nope" } });
    expect(await isPreviewEnabled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- preview-pref`
Expected: FAIL — `Cannot find module '../../src/background/preview-pref.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/background/preview-pref.ts`:

```ts
// Whether the popup shows the payload before sending it.
//
// Carries no secret, so the Options page and the popup read and write it
// directly — the same arrangement ambient-prefs.ts uses, and unlike
// connection-store.ts which holds the token.
import { storageGet, storageSet } from "../browser/storage.ts";

const PREVIEW_KEY = "preview-enabled";

/**
 * DEFAULTS TO ON, and any unreadable value falls back to ON.
 *
 * Fail safe, not fail quiet: showing a preview the user switched off is a minor
 * annoyance, while sending without one because storage returned something odd is
 * precisely the outcome this slice exists to prevent.
 */
export async function isPreviewEnabled(): Promise<boolean> {
  const value = await storageGet(PREVIEW_KEY);
  return typeof value === "boolean" ? value : true;
}

export async function setPreviewEnabled(on: boolean): Promise<void> {
  await storageSet(PREVIEW_KEY, on);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- preview-pref`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/background/preview-pref.ts test/unit/preview-pref.test.ts
git commit -m "feat(preview): an off switch that fails safe"
```

---

## Task 4: The popup confirms before it sends

**Files:**
- Modify: `src/popup/popup.html`, `src/popup/popup.css`, `src/popup/popup.ts`
- Test: `test/unit/popup.test.ts`

**Interfaces:**
- Consumes: `buildClipPreview` (Task 1), `renderPreview` (Task 2), `isPreviewEnabled` (Task 3)
- Produces: element ids `preview`, `preview-body`, `preview-confirm`, `preview-cancel`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/popup.test.ts`, following that file's existing boot/flush helpers:

```ts
describe("preview before sending", () => {
  test("clicking Clip page shows the preview and sends NOTHING yet", async () => {
    await bootPopup();
    harness.sendMessage.mockClear();
    clickButton("clip-page");
    await flush();

    expect(el("preview").hidden).toBe(false);
    // The assertion that matters: no clip message left the popup.
    const kinds = harness.sendMessage.mock.calls.map((c) => (c[0] as { kind?: string }).kind);
    expect(kinds).not.toContain("clip");
  });

  test("confirming sends the clip", async () => {
    await bootPopup();
    clickButton("clip-page");
    await flush();
    harness.sendMessage.mockClear();
    clickButton("preview-confirm");
    await flush();

    const kinds = harness.sendMessage.mock.calls.map((c) => (c[0] as { kind?: string }).kind);
    expect(kinds).toContain("clip");
  });

  test("cancelling sends nothing and hides the preview", async () => {
    await bootPopup();
    clickButton("clip-page");
    await flush();
    harness.sendMessage.mockClear();
    clickButton("preview-cancel");
    await flush();

    const kinds = harness.sendMessage.mock.calls.map((c) => (c[0] as { kind?: string }).kind);
    expect(kinds).not.toContain("clip");
    expect(el("preview").hidden).toBe(true);
  });

  test("with the preference OFF, clipping sends immediately and shows no preview", async () => {
    harness = installChromeMock();
    harness.storage.set("preview-enabled", false);
    await bootPopup();
    clickButton("clip-page");
    await flush();

    const kinds = harness.sendMessage.mock.calls.map((c) => (c[0] as { kind?: string }).kind);
    expect(kinds).toContain("clip");
    expect(el("preview").hidden).toBe(true);
  });

  test("the preview names the page being clipped", async () => {
    await bootPopup();
    clickButton("clip-page");
    await flush();
    expect(el("preview").textContent).toContain("https://ex.com/p");
  });
});
```

> **Harness note.** `test/unit/popup.test.ts` already has boot/flush machinery and
> a chrome mock whose `activeTab` and capture results are seeded. Read the file
> and reuse its existing helpers and seeding — the names above (`bootPopup`,
> `clickButton`, `el`) are indicative; **use whatever that file actually
> defines** rather than introducing parallel helpers. If the capture stub does
> not yield a URL, seed it the way the existing clip tests do.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- popup`
Expected: FAIL — there is no `#preview` element and clipping sends immediately

- [ ] **Step 3: Write the implementation**

In `src/popup/popup.html`, after the actions block:

```html
      <section id="preview" class="preview" hidden>
        <h2 class="preview__heading">This is what gets sent</h2>
        <div id="preview-body"></div>
        <div class="preview__actions">
          <button id="preview-confirm" type="button">Send to Nimbus</button>
          <button id="preview-cancel" type="button">Cancel</button>
        </div>
      </section>
```

In `src/popup/popup.css`:

```css
.preview { margin-top: 0.75em; border-top: 1px solid rgba(128, 128, 128, 0.35); padding-top: 0.6em; }
.preview__heading { font-size: 0.95rem; margin: 0 0 0.4em; }
.preview__row { display: flex; gap: 0.6em; padding: 0.1em 0; }
.preview__label { flex: 0 0 7.5em; opacity: 0.75; }
.preview__value { word-break: break-all; }
.preview__body { margin-top: 0.5em; max-height: 8em; overflow-y: auto; white-space: pre-wrap; opacity: 0.9; }
.preview__note { font-size: 0.85rem; opacity: 0.75; }
.preview__actions { display: flex; gap: 0.5em; margin-top: 0.6em; }
```

In `src/popup/popup.ts`, hold the pending payload and split `clip()` into capture-then-send:

```ts
/** The payload captured and shown, waiting on the user's yes. */
let pending: ClipPayload | null = null;

function hidePreview(): void {
  const section = document.getElementById("preview");
  if (section instanceof HTMLElement) {
    section.hidden = true;
  }
  pending = null;
}

function showPreview(payload: ClipPayload): void {
  const section = document.getElementById("preview");
  const body = document.getElementById("preview-body");
  if (!(section instanceof HTMLElement) || body === null) {
    // No preview UI in the DOM — send rather than silently dropping the clip.
    void send(payload);
    return;
  }
  pending = payload;
  body.replaceChildren(renderPreview(document, buildClipPreview(payload)));
  section.hidden = false;
  setStatus("");
}
```

Rework `clip(mode)` so that after a successful capture it builds the payload with `buildClipPreview`'s input (`buildClipPayload(capture, tags, Date.now())`), then either calls `send(payload)` directly or `showPreview(payload)` depending on `await isPreviewEnabled()`. Move the existing message-send and status-mapping code into `send(payload: ClipPayload)` unchanged — **do not rewrite the status vocabulary**; it is shared with the quick-clip toast on purpose.

Wire the two buttons in `DOMContentLoaded`:

```ts
  document.getElementById("preview-confirm")?.addEventListener("click", () => {
    const payload = pending;
    hidePreview();
    if (payload !== null) {
      void send(payload);
    }
  });
  document.getElementById("preview-cancel")?.addEventListener("click", () => {
    hidePreview();
    setStatus("Cancelled — nothing was sent.");
  });
```

> **VERIFIED — read this instead of re-deriving it.** The clip message carries
> `{ kind: "clip", capture, tags }` and the service worker builds the payload:
> `handleClip` calls the **same** `buildClipPayload` from `src/shared/clip.ts`
> (`handlers.ts:1` and `:66`), with `deps.nowMs()`.
>
> So the popup building `buildClipPayload(capture, tags, Date.now())` for the
> preview produces a byte-identical payload **except `capturedAt`**, which differs
> by the milliseconds between confirming and sending. That field is deliberately
> **not** one of the previewed fields, so the divergence is invisible and the
> preview is honest.
>
> **Do NOT change the message contract in this task.** Keep sending
> `{ kind: "clip", capture, tags }`; use `buildClipPayload` only to build the
> preview. Moving payload construction into the popup would be a larger change
> that buys nothing here — both call sites already share one builder, which is
> what makes the preview trustworthy. If you find any *other* divergence, stop
> and report it rather than papering over it: a preview describing a payload
> built differently from the one sent is worse than no preview.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test`
Expected: PASS, whole suite green

- [ ] **Step 5: Commit**

```bash
git add src/popup/popup.html src/popup/popup.css src/popup/popup.ts test/unit/popup.test.ts
git commit -m "feat(popup): show the payload, then send it"
```

---

## Task 5: The panel confirms before the gateway reaches out

**Files:**
- Modify: `src/panel/panel-view.ts`, `src/panel/panel-in-page.ts`
- Test: `test/unit/panel-view.test.ts`, `test/unit/panel-in-page.test.ts`

**Interfaces:**
- Consumes: `buildFetchPreview` (Task 1), `renderPreview` (Task 2), `FetchTarget` (Task 1)
- Produces: no new exports — a new state in the existing fetch flow

- [ ] **Step 1: Write the failing test**

Append to `test/unit/panel-in-page.test.ts`, using that file's existing harness:

```ts
describe("fetch preview", () => {
  test("pressing Fetch shows what will be fetched and sends NOTHING yet", async () => {
    // Boot the panel on a recognised, not-indexed page using this file's
    // existing helper for that state.
    await bootNotIndexed();
    sendMessageMock.mockClear();
    clickFetchButton();
    await flush();

    const kinds = sendMessageMock.mock.calls.map((c) => (c[0] as { kind?: string }).kind);
    expect(kinds).not.toContain("fetch");
    expect(panelText()).toContain("github");
  });

  test("confirming sends the fetch", async () => {
    await bootNotIndexed();
    clickFetchButton();
    await flush();
    sendMessageMock.mockClear();
    clickConfirm();
    await flush();

    const kinds = sendMessageMock.mock.calls.map((c) => (c[0] as { kind?: string }).kind);
    expect(kinds).toContain("fetch");
  });

  test("cancelling sends nothing and the Fetch button is still usable", async () => {
    await bootNotIndexed();
    clickFetchButton();
    await flush();
    sendMessageMock.mockClear();
    clickCancel();
    await flush();

    const kinds = sendMessageMock.mock.calls.map((c) => (c[0] as { kind?: string }).kind);
    expect(kinds).not.toContain("fetch");
    // `fetchSent` must NOT have latched — cancelling is not an attempt.
    clickFetchButton();
    await flush();
    expect(panelText()).toContain("github");
  });
});
```

> **Harness note.** `test/unit/panel-in-page.test.ts` already boots the panel
> against a mocked `sendMessage` and has helpers for reaching the not-indexed
> state and clicking panel controls. **Read the file and use its real helpers** —
> the names above are indicative. Do not add a second harness.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- panel-in-page`
Expected: FAIL — pressing Fetch sends the message immediately

- [ ] **Step 3: Write the implementation**

In `src/panel/panel-in-page.ts`, split `sendFetch` in two. The button handler now shows the preview; a confirm handler performs the request:

- Add a `fetchPreview: FetchTarget | null` alongside the existing `fetchState`.
- The Fetch button sets `fetchPreview = { product, surface, url: pinnedUrl }` and repaints. **It must not set `fetchSent`** — see below.
- A **Send** control clears `fetchPreview`, then runs the existing `sendFetch` body unchanged.
- A **Cancel** control clears `fetchPreview` and repaints.

**`fetchSent` must stay exactly where it is — inside the confirmed path.** It is the one-fetch-per-panel latch. Setting it when the preview *opens* would mean a cancelled preview permanently disables the button, turning "no thanks" into "never again". A test asserts the button still works after a cancel.

In `src/panel/panel-view.ts`, render the preview block from `renderPreview(doc, buildFetchPreview(target))` plus Send / Cancel controls, in the same style as the existing fetch button.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test`
Expected: PASS, whole suite green

- [ ] **Step 5: Commit**

```bash
git add src/panel/panel-view.ts src/panel/panel-in-page.ts test/unit/panel-view.test.ts test/unit/panel-in-page.test.ts
git commit -m "feat(panel): name the item before asking the gateway to fetch it"
```

---

## Task 6: The off switch, the trust copy, and the docs

**Files:**
- Modify: `src/options/options.html` (stage 4 — the switch **and** the trust copy), `src/options/options.ts`
- Modify: `CHANGELOG.md`, `docs/architecture.md`, `docs/development.md`, `ROADMAP.md`
- Test: `test/unit/options.test.ts`

**Interfaces:**
- Consumes: `isPreviewEnabled`, `setPreviewEnabled` (Task 3)
- Produces: element id `preview-toggle`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/options.test.ts` (remember: seed the harness, then `bootOptions()`; never `boot()` followed by a second `DOMContentLoaded` dispatch — and add `preview-toggle` to the file's hand-rolled `FIXTURE`):

```ts
describe("preview toggle", () => {
  test("reflects the stored preference", async () => {
    harness = installChromeMock();
    harness.storage.set("preview-enabled", false);
    await bootOptions();
    const toggle = document.getElementById("preview-toggle");
    expect(toggle instanceof HTMLInputElement && toggle.checked).toBe(false);
  });

  test("defaults to on when nothing is stored", async () => {
    harness = installChromeMock();
    await bootOptions();
    const toggle = document.getElementById("preview-toggle");
    expect(toggle instanceof HTMLInputElement && toggle.checked).toBe(true);
  });

  test("switching it off persists", async () => {
    harness = installChromeMock();
    await bootOptions();
    const toggle = document.getElementById("preview-toggle");
    if (toggle instanceof HTMLInputElement) {
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change"));
    }
    await flush();
    expect(harness.storage.get("preview-enabled")).toBe(false);
  });
});

describe("the trust panel matches what ships", () => {
  test("it now states the popup shows you the payload first", () => {
    expect(html.toLowerCase()).toContain("before it is sent");
  });

  test("it still says the hotkey does not preview", () => {
    expect(html.toLowerCase()).toContain("hotkey");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- options`
Expected: FAIL — no `preview-toggle`, and the trust copy does not mention a preview

- [ ] **Step 3: Write the implementation**

Add the switch to `#stage-trust` in `src/options/options.html`:

```html
        <p class="options__toggle">
          <label for="preview-toggle">
            <input id="preview-toggle" type="checkbox" checked />
            Show me the payload before sending, when I clip from the toolbar
          </label>
        </p>
```

**Rewrite the stage-4 "What we send, and when" paragraph** so it matches what now ships. It must state: clipping from the toolbar shows the whole payload first and sends nothing until you confirm; the hotkey and context menu stay one gesture and report afterwards in the toast; and asking Nimbus to fetch an item names that item first. Keep the repo's plain voice and read the neighbouring paragraphs before writing.

In `src/options/options.ts`, add a `refreshPreviewToggle()` that sets `checked` from `isPreviewEnabled()` (wrapped in try/catch — it is `void`-called, and an unhandled rejection fails the Vitest run), and a `change` listener calling `setPreviewEnabled(toggle.checked)`.

- [ ] **Step 4: Docs**

- **`CHANGELOG.md`**, under `## [Unreleased]` → `### Added`:

```markdown
- **See exactly what leaves, before it leaves.** Clipping from the toolbar now
  shows you the whole payload first — title, URL, tags, and the body it will
  send — and sends nothing until you say so. The hotkey and right-click stay one
  gesture and tell you afterwards, as before. You can switch the preview off in
  Options if you'd rather not be asked.
- **Asking Nimbus to fetch an item tells you which item.** The panel's fetch
  button now names the service, the type and the address before your gateway
  reaches out for it.
```

- **`docs/architecture.md`**: one pure builder feeding both previews so they cannot drift from the requests; why fields are listed explicitly rather than iterated (the token invariant); why `bodyLength` reports the whole body while the excerpt is cut; why `fetchSent` stays in the confirmed path; and why quick-clip has no preview.
- **`docs/development.md`**: a manual checklist for both previews, including cancelling and confirming each, and the off switch.
- **`ROADMAP.md`**: mark **1.3** and **C4.2** shipped with `**Status**` lines in the established format.

- [ ] **Step 5: Commit**

```bash
bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build
git add -A
git commit -m "feat(options): an off switch, and a trust panel that matches what ships"
```

---

## Self-Review Notes

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| One pure builder, two shapes | 1 |
| `FetchTarget` in `shared/types.ts` | 1 |
| The token never in a preview, asserted by test | 1 |
| `preview-view.ts` renders the clip shape | 2, 4 |
| The panel renders the fetch shape | 2, 5 |
| Preview on by default in the popup | 3, 4 |
| Off switch in Options stage 4 | 3, 6 |
| Quick-clip unchanged | all — asserted in Global Constraints |
| The fetch preview names the target, not "Fetch this item?" | 1, 5 |
| Trust-panel copy updated to match | 6 |

**Two things a reviewer should check hardest,** because they are where this slice could ship a lie:
1. **The preview must describe the payload actually sent.** Verified while writing this plan: both the popup preview and `handleClip` go through the same `buildClipPayload`, so the only difference is `capturedAt`, which is not a previewed field. The risk is a future change moving one construction and not the other — a preview that describes a payload built differently from the one sent is decoration, not a trust surface.
2. **`fetchSent` must not latch on preview-open.** Otherwise a cancelled preview permanently disables the fetch button — "no thanks" becoming "never again".

**Known follow-up:** `src/popup/popup.ts` grows a state machine (idle → previewing → sending). It stays small here, but if slice 5 adds the already-clipped lookup to the same file, the two should be lifted into a pure `popup-state.ts` rather than interleaved as flags.
