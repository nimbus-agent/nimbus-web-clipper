/**
 * Covers `docs/development.md` → "Manual verification — Also search what
 * Nimbus has indexed (C5.4)", steps 1-5 (ids index-brief-1..5).
 *
 * Every step is client-side — the composer checkbox, the preview disclosure,
 * and the citation rendering all run in the extension, so this proves the
 * whole chain against the mock without needing a real gateway index.
 *
 * The mock's own `serve()` used to silently drop every POST body (fixed for
 * C5.3 — see `test/e2e/passages.e2e.ts`'s header), so before writing this the
 * mock was re-checked: `POST /v1/briefs` now genuinely receives `useIndex`
 * (see `mock-gateway.ts`'s create-route body parse), and `onBriefCreate`
 * below asserts against that real received body, not the client's own idea
 * of what it sent.
 */
import { expect, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";
import type { FedBriefCreate } from "../../scripts/screenshots/gateway-fixtures.ts";

export const COVERS = [
  "index-brief-1",
  "index-brief-2",
  "index-brief-3",
  "index-brief-4",
  "index-brief-5",
] as const;

test("ticking Also search discloses more, sends useIndex, and the report cites the index — stickily", async () => {
  const created: FedBriefCreate[] = [];
  const h = await launchExtension({ scenario: { onBriefCreate: (b) => created.push(b) } });
  try {
    // A named tab for the composer to offer: host permission on 127.0.0.1
    // already covers the mock's own port, so this tab is visible to
    // `chrome.tabs.query` without any extra grant.
    const tabPage = await h.context.newPage();
    await tabPage.goto(`${h.origin}/sample`);
    await tabPage.bringToFront();

    const page = await h.context.newPage();
    await page.goto(`chrome-extension://${h.extId}/brief.html`);

    const row = page.locator(".brief__tab", { hasText: "Designing local-first software" });
    await expect(row).toHaveCount(1);
    await row.locator('input[type="checkbox"]').check();

    // Type a question — through the "Ask your own question" disclosure, which
    // must be opened first or the textarea inside is not actionable.
    await page.locator(".brief__custom summary").click();
    await page.locator("#custom-question").fill("What changed here?");

    const preview = page.locator("#preview");
    await expect(preview).toBeVisible();
    const previewBody = page.locator("#preview-body");
    const notes = previewBody.locator(".preview__note");

    // index-brief-1: the preview says nothing about the index before ticking —
    // only the synthesis notice, never the index one.
    await expect(notes).toHaveCount(1);
    await expect(previewBody).not.toContainText("index");

    await page.locator("#use-index").check();

    // index-brief-2: ticked, the preview now discloses the wider reach — the
    // bound it cannot exceed, that the members can't be named in advance, and
    // that the question itself is what gets searched.
    await expect(notes).toHaveCount(2);
    await expect(previewBody).toContainText("up to 8 items");
    await expect(previewBody).toContainText("cannot be listed");
    await expect(previewBody).toContainText("Your question is the text that gets searched");

    await page.locator("#run").click();
    await expect(page.locator(".brief__banner")).toBeVisible();

    // index-brief-3: the assertion no unit test can make — what the mock
    // actually received on the wire, not the client's own idea of the body.
    expect(created).toHaveLength(1);
    expect(created[0]?.useIndex).toBe(true);

    // index-brief-4: indexed citations are marked "from your index" with a
    // readable type label — one of them a connector type
    // (`slack_message`) this client's code has never heard of — and no raw
    // item id or clip id appears anywhere on the page.
    const origins = page.locator(".brief__cite-origin");
    await expect(origins).toHaveCount(2);
    await expect(origins).toContainText([
      "from your index · web clip",
      "from your index · slack message",
    ]);
    const body = page.locator("body");
    await expect(body).not.toContainText("item_idx_001");
    await expect(body).not.toContainText("item_idx_002");
    await expect(body).not.toContainText("clip_idx_001");

    // index-brief-5: reopen the composer — the preference is sticky.
    await page.reload();
    await expect(page.locator("#use-index")).toBeChecked();
  } finally {
    await h.close();
  }
});
