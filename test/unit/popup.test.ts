// @vitest-environment jsdom
// test/unit/popup.test.ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "../../src/popup/popup.ts";
import type { CaptureResult } from "../../src/shared/types.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

const FIXTURE = `
  <main class="popup">
    <input id="tags" type="text" />
    <div class="popup__actions">
      <button id="clip-page" type="button">Clip page</button>
      <button id="clip-selection" type="button">Clip selection</button>
    </div>
    <section id="preview" hidden>
      <h2>This is what gets sent</h2>
      <div id="preview-body"></div>
      <div class="preview__actions">
        <button id="preview-confirm" type="button">Send to Nimbus</button>
        <button id="preview-cancel" type="button">Cancel</button>
      </div>
    </section>
    <button id="show-related" type="button">Show related</button>
    <section id="queue" hidden>
      <h2>Waiting to sync (<span id="queue-count">0</span>)</h2>
      <div id="queue-list"></div>
      <button id="queue-retry-all" type="button">Retry all</button>
    </section>
    <output id="status"></output>
  </main>
`;

const ARTICLE_CAPTURE: CaptureResult = {
  url: "https://example.com/article",
  title: "An Article",
  mode: "article",
  body: "article body",
  readableFound: true,
};

let harness: ChromeHarness;

function statusText(): string {
  return document.getElementById("status")?.textContent ?? "";
}

function click(id: string): void {
  document.getElementById(id)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/**
 * The preview defaults ON, so every pre-existing clip test below now lands on
 * the preview instead of sending straight away. This waits for it and clicks
 * through, so those tests keep exercising send()'s behaviour unchanged.
 */
async function confirmPreview(): Promise<void> {
  await vi.waitFor(() => expect(previewSection().hidden).toBe(false));
  click("preview-confirm");
}

beforeEach(async () => {
  harness = installChromeMock();
  document.body.innerHTML = FIXTURE;
  document.dispatchEvent(new Event("DOMContentLoaded"));
  // Let the initial refreshQueue() (fired from DOMContentLoaded) settle before
  // each test configures its own mock sequencing.
  await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));
});

afterEach(() => {
  harness.restore();
});

describe("clip(article)", () => {
  test("success (created, not bookmarked) sends the clip and reports Saved to Nimbus.", async () => {
    harness.executeScript
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ result: ARTICLE_CAPTURE }]);
    harness.sendMessage.mockResolvedValueOnce({
      kind: "clip",
      ok: true,
      status: "created",
      bookmarked: false,
    });

    click("clip-page");
    await confirmPreview();

    await vi.waitFor(() => expect(statusText()).toBe("Saved to Nimbus."));

    expect(harness.tabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(harness.executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 1 },
      func: expect.any(Function),
      args: ["article"],
    });
    expect(harness.sendMessage).toHaveBeenCalledWith({
      kind: "clip",
      capture: ARTICLE_CAPTURE,
      tags: [],
    });
  });

  test("parses the tags input and sends it with the clip", async () => {
    harness.executeScript
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ result: ARTICLE_CAPTURE }]);
    harness.sendMessage.mockResolvedValueOnce({
      kind: "clip",
      ok: true,
      status: "created",
      bookmarked: false,
    });
    const tagsInput = document.getElementById("tags");
    if (tagsInput instanceof HTMLInputElement) {
      tagsInput.value = "research, work, research";
    }

    click("clip-page");
    await confirmPreview();

    await vi.waitFor(() => expect(statusText()).toBe("Saved to Nimbus."));
    expect(harness.sendMessage).toHaveBeenCalledWith({
      kind: "clip",
      capture: ARTICLE_CAPTURE,
      tags: ["research", "work"],
    });
  });

  test("bookmarked responses report Saved as a bookmark.", async () => {
    harness.executeScript
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ result: ARTICLE_CAPTURE }]);
    harness.sendMessage.mockResolvedValueOnce({
      kind: "clip",
      ok: true,
      status: "created",
      bookmarked: true,
    });

    click("clip-page");
    await confirmPreview();

    await vi.waitFor(() => expect(statusText()).toBe("Saved as a bookmark."));
  });

  test("updated status reports Updated in Nimbus.", async () => {
    harness.executeScript
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ result: ARTICLE_CAPTURE }]);
    harness.sendMessage.mockResolvedValueOnce({
      kind: "clip",
      ok: true,
      status: "updated",
      bookmarked: false,
    });

    click("clip-page");
    await confirmPreview();

    await vi.waitFor(() => expect(statusText()).toBe("Updated in Nimbus."));
  });

  test("no active tab reports the system-page message and never sends a clip", async () => {
    harness.tabsQuery.mockResolvedValueOnce([]);

    click("clip-page");

    await vi.waitFor(() =>
      expect(statusText()).toBe("Nimbus can't clip browser system or store pages."),
    );
    expect(harness.sendMessage).toHaveBeenCalledTimes(1); // only the initial refreshQueue call
  });

  test("an unexpected sendMessage response reports Unexpected response.", async () => {
    harness.executeScript
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ result: ARTICLE_CAPTURE }]);
    harness.sendMessage.mockResolvedValueOnce({ not: "a clip response" });

    click("clip-page");
    await confirmPreview();

    await vi.waitFor(() => expect(statusText()).toBe("Unexpected response."));
  });
});

describe("clip(selection)", () => {
  test("empty selection body reports Select some text first. without sending a clip", async () => {
    harness.executeScript
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ result: { ...ARTICLE_CAPTURE, mode: "selection", body: "" } }]);

    click("clip-selection");

    await vi.waitFor(() => expect(statusText()).toBe("Select some text first."));
    expect(harness.sendMessage).toHaveBeenCalledTimes(1); // only the initial refreshQueue call
  });

  test("non-empty selection sends the clip in selection mode", async () => {
    const selectionCapture: CaptureResult = {
      ...ARTICLE_CAPTURE,
      mode: "selection",
      body: "selected text",
    };
    harness.executeScript
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ result: selectionCapture }]);
    harness.sendMessage.mockResolvedValueOnce({
      kind: "clip",
      ok: true,
      status: "created",
      bookmarked: false,
    });

    click("clip-selection");
    await confirmPreview();

    await vi.waitFor(() => expect(statusText()).toBe("Saved to Nimbus."));
    expect(harness.executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 1 },
      func: expect.any(Function),
      args: ["selection"],
    });
    expect(harness.sendMessage).toHaveBeenCalledWith({
      kind: "clip",
      capture: selectionCapture,
      tags: [],
    });
  });
});

describe("clip error mapping", () => {
  const errorCases: Array<{ reason: string; message: string }> = [
    { reason: "not_paired", message: "Pair a browser first (Options)." },
    { reason: "unauthorized", message: "Pairing expired — re-pair in Options." },
    { reason: "invalid_request", message: "Couldn't save this page." },
    { reason: "unreachable", message: "Can't reach Nimbus — is the gateway running?" },
    { reason: "server_error", message: "Nimbus had an error saving this." },
  ];

  for (const { reason, message } of errorCases) {
    test(`reason "${reason}" reports "${message}" and refreshes the queue`, async () => {
      harness.executeScript
        .mockResolvedValueOnce([{ result: undefined }])
        .mockResolvedValueOnce([{ result: ARTICLE_CAPTURE }]);
      harness.sendMessage
        .mockResolvedValueOnce({ kind: "clip", ok: false, reason })
        .mockResolvedValueOnce({ kind: "queue", items: [] });

      click("clip-page");
      await confirmPreview();

      await vi.waitFor(() => expect(statusText()).toBe(message));
      await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(3));
      expect(harness.sendMessage).toHaveBeenNthCalledWith(3, { kind: "queue-list" });
    });
  }

  test("an unmapped reason falls back to Couldn't save this page.", async () => {
    harness.executeScript
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ result: ARTICLE_CAPTURE }]);
    harness.sendMessage
      .mockResolvedValueOnce({ kind: "clip", ok: false, reason: "something_else" })
      .mockResolvedValueOnce({ kind: "queue", items: [] });

    click("clip-page");
    await confirmPreview();

    await vi.waitFor(() => expect(statusText()).toBe("Couldn't save this page."));
  });

  // rate_limited is queued too, but the gateway is UP — it must not claim otherwise.
  test("rate_limited reports the busy status rather than the offline one", async () => {
    harness.executeScript
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ result: ARTICLE_CAPTURE }]);
    harness.sendMessage
      .mockResolvedValueOnce({ kind: "clip", ok: false, reason: "rate_limited", queued: true })
      .mockResolvedValueOnce({ kind: "queue", items: [] });

    click("clip-page");
    await confirmPreview();

    await vi.waitFor(() =>
      expect(statusText()).toBe("Nimbus is busy — queued, will retry shortly."),
    );
  });

  test("queued:true reports Saved offline — will sync when Nimbus is back.", async () => {
    harness.executeScript
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ result: ARTICLE_CAPTURE }]);
    harness.sendMessage
      .mockResolvedValueOnce({ kind: "clip", ok: false, reason: "unreachable", queued: true })
      .mockResolvedValueOnce({ kind: "queue", items: [] });

    click("clip-page");
    await confirmPreview();

    await vi.waitFor(() =>
      expect(statusText()).toBe("Saved offline — will sync when Nimbus is back."),
    );
  });
});

describe("showRelated", () => {
  test("injects the panel into the active tab and closes the popup", async () => {
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);

    click("show-related");

    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
    expect(harness.tabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(harness.executeScript).toHaveBeenCalledWith({
      target: { tabId: 1 },
      files: ["panel.js"],
    });

    closeSpy.mockRestore();
  });

  test("no active tab reports the system-page message and never closes the popup", async () => {
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);
    harness.tabsQuery.mockResolvedValueOnce([]);

    click("show-related");

    await vi.waitFor(() =>
      expect(statusText()).toBe("Nimbus can't show related on browser system pages."),
    );
    expect(closeSpy).not.toHaveBeenCalled();

    closeSpy.mockRestore();
  });
});

describe("queue rendering", () => {
  test("a non-empty queue response renders items and reveals the section", async () => {
    harness.sendMessage.mockResolvedValueOnce({
      kind: "queue",
      items: [
        { url: "https://ex.com/a", title: "A", queuedAt: 0, attempts: 0 },
        {
          url: "https://ex.com/b",
          title: "B",
          queuedAt: 0,
          attempts: 1,
          lastReason: "unreachable",
        },
      ],
    });

    click("queue-retry-all");

    await vi.waitFor(() =>
      expect(document.querySelectorAll("#queue-list .queue__item")).toHaveLength(2),
    );
    const section = document.getElementById("queue");
    expect(section instanceof HTMLElement && section.hidden).toBe(false);
    expect(document.getElementById("queue-count")?.textContent).toBe("2");
  });

  test("an empty queue response hides the section", async () => {
    const section = document.getElementById("queue");
    if (section instanceof HTMLElement) {
      section.hidden = false;
    }
    harness.sendMessage.mockResolvedValueOnce({ kind: "queue", items: [] });

    click("queue-retry-all");

    await vi.waitFor(() => {
      const el = document.getElementById("queue");
      expect(el instanceof HTMLElement && el.hidden).toBe(true);
    });
  });
});

describe("onQueueClick", () => {
  beforeEach(async () => {
    harness.sendMessage.mockResolvedValueOnce({
      kind: "queue",
      items: [{ url: "https://ex.com/a", title: "A", queuedAt: 0, attempts: 0 }],
    });
    click("queue-retry-all");
    await vi.waitFor(() =>
      expect(document.querySelectorAll("#queue-list .queue__item")).toHaveLength(1),
    );
  });

  test("clicking Retry sends queue-retry with the entry's url", async () => {
    harness.sendMessage.mockResolvedValueOnce({ kind: "queue", items: [] });
    const retryButton = document.querySelector(".queue__retry");
    expect(retryButton).not.toBeNull();

    retryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({
        kind: "queue-retry",
        url: "https://ex.com/a",
      }),
    );
  });

  test("clicking Remove sends queue-remove with the entry's url", async () => {
    harness.sendMessage.mockResolvedValueOnce({ kind: "queue", items: [] });
    const removeButton = document.querySelector(".queue__remove");
    expect(removeButton).not.toBeNull();

    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({
        kind: "queue-remove",
        url: "https://ex.com/a",
      }),
    );
  });

  test("clicking outside a button (the list itself) sends nothing new", async () => {
    const list = document.getElementById("queue-list");
    const callsBefore = harness.sendMessage.mock.calls.length;

    list?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Give any (incorrect) async handling a chance to run before asserting nothing changed.
    await Promise.resolve();
    expect(harness.sendMessage.mock.calls).toHaveLength(callsBefore);
  });

  test("retry-all sends queue-retry without a url", async () => {
    harness.sendMessage.mockResolvedValueOnce({ kind: "queue", items: [] });

    click("queue-retry-all");

    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({ kind: "queue-retry" }),
    );
  });
});

/** Stubs the two-step capture the way every existing clip test in this file does. */
function stubCapture(): void {
  harness.executeScript
    .mockResolvedValueOnce([{ result: undefined }])
    .mockResolvedValueOnce([{ result: ARTICLE_CAPTURE }]);
}

function previewSection(): HTMLElement {
  const el = document.getElementById("preview");
  if (!(el instanceof HTMLElement)) {
    throw new Error("missing #preview");
  }
  return el;
}

function clipKinds(): string[] {
  return harness.sendMessage.mock.calls
    .map((c) => (c[0] as { kind?: string }).kind)
    .filter((k): k is string => k === "clip");
}

describe("preview before sending", () => {
  test("clicking Clip page shows the preview and sends NOTHING yet", async () => {
    stubCapture();
    harness.sendMessage.mockClear();

    click("clip-page");
    await vi.waitFor(() => expect(previewSection().hidden).toBe(false));

    // The assertion that matters: no clip message left the popup.
    expect(clipKinds()).toEqual([]);
  });

  test("confirming sends the clip", async () => {
    stubCapture();
    click("clip-page");
    await vi.waitFor(() => expect(previewSection().hidden).toBe(false));
    harness.sendMessage.mockClear();
    harness.sendMessage.mockResolvedValueOnce({
      kind: "clip",
      ok: true,
      status: "created",
      bookmarked: false,
    });

    click("preview-confirm");

    await vi.waitFor(() => expect(statusText()).toBe("Saved to Nimbus."));
    expect(clipKinds()).toEqual(["clip"]);
  });

  test("cancelling sends nothing and hides the preview", async () => {
    stubCapture();
    click("clip-page");
    await vi.waitFor(() => expect(previewSection().hidden).toBe(false));
    harness.sendMessage.mockClear();

    click("preview-cancel");

    await vi.waitFor(() => expect(previewSection().hidden).toBe(true));
    expect(clipKinds()).toEqual([]);
    expect(statusText()).toBe("Cancelled — nothing was sent.");
  });

  test("with the preference OFF, clipping sends immediately and shows no preview", async () => {
    harness.storage.set("preview-enabled", false);
    stubCapture();
    harness.sendMessage.mockResolvedValueOnce({
      kind: "clip",
      ok: true,
      status: "created",
      bookmarked: false,
    });

    click("clip-page");

    await vi.waitFor(() => expect(statusText()).toBe("Saved to Nimbus."));
    expect(previewSection().hidden).toBe(true);
  });

  test("the preview names the page being clipped", async () => {
    stubCapture();
    click("clip-page");
    await vi.waitFor(() => expect(previewSection().hidden).toBe(false));
    expect(previewSection().textContent).toContain(ARTICLE_CAPTURE.url);
  });

  test("the capture buttons and the tags field are locked while a decision is pending", async () => {
    stubCapture();
    click("clip-page");
    await vi.waitFor(() => expect(previewSection().hidden).toBe(false));

    const actions = document.querySelector(".popup__actions");
    const tags = document.getElementById("tags");
    expect(actions instanceof HTMLElement && actions.hidden).toBe(true);
    expect(tags instanceof HTMLInputElement && tags.disabled).toBe(true);
  });

  test("cancelling unlocks them again", async () => {
    stubCapture();
    click("clip-page");
    await vi.waitFor(() => expect(previewSection().hidden).toBe(false));

    click("preview-cancel");
    await vi.waitFor(() => expect(previewSection().hidden).toBe(true));

    const actions = document.querySelector(".popup__actions");
    const tags = document.getElementById("tags");
    expect(actions instanceof HTMLElement && actions.hidden).toBe(false);
    expect(tags instanceof HTMLInputElement && tags.disabled).toBe(false);
  });

  test("the tags SENT are the tags PREVIEWED, even if the field changes after", async () => {
    const tags = document.getElementById("tags");
    if (tags instanceof HTMLInputElement) {
      tags.value = "research";
    }
    stubCapture();
    click("clip-page");
    await vi.waitFor(() => expect(previewSection().hidden).toBe(false));

    // Simulate the field being changed behind the preview's back. The composer
    // lock makes this unreachable by hand, which is the point — this asserts the
    // send path does not RE-READ it even if something else does.
    if (tags instanceof HTMLInputElement) {
      tags.value = "totally-different";
    }
    harness.sendMessage.mockClear();
    harness.sendMessage.mockResolvedValueOnce({
      kind: "clip",
      ok: true,
      status: "created",
      bookmarked: false,
    });

    click("preview-confirm");
    await vi.waitFor(() => expect(statusText()).toBe("Saved to Nimbus."));

    const sent = harness.sendMessage.mock.calls[0]?.[0] as { tags?: string[] };
    expect(sent.tags).toEqual(["research"]);
  });
});
