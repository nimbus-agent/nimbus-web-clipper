// @vitest-environment jsdom
// test/unit/panel-in-page.test.ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RelatedHit } from "../../src/shared/types.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

// panel-in-page.ts is an injected content script: it runs its mount/self-toggle
// logic as a module-level side effect on import (see the file's final lines).
// Re-injection is simulated here by resetting the module registry and
// re-importing — the same way the browser re-runs the injected script.
const MODULE_PATH = "../../src/panel/panel-in-page.ts";
const HOST_ID = "nimbus-related-host";

let harness: ChromeHarness;

async function loadPanel(): Promise<void> {
  vi.resetModules();
  await import(MODULE_PATH);
}

function host(): HTMLElement | null {
  return document.getElementById(HOST_ID);
}

function shadow(): ShadowRoot | null {
  return host()?.shadowRoot ?? null;
}

function status(): string | null | undefined {
  return shadow()?.querySelector(".nimbus-related__status")?.textContent;
}

const hit: RelatedHit = {
  id: "1",
  title: "Doc",
  service: "drive",
  snippet: "a snippet",
  url: "https://ex.com/d",
};

beforeEach(() => {
  // Fresh <html> on every test: drops any host/listeners a prior test left behind
  // and resets document.title (the <title> element lives in <head>).
  document.documentElement.innerHTML = "<head></head><body></body>";
  window.getSelection()?.removeAllRanges();
  harness = installChromeMock();
});

afterEach(() => {
  harness.restore();
});

describe("panel-in-page mount()", () => {
  test("builds a shadow-root panel appended directly under <html>, with a loading placeholder before the query settles", async () => {
    // Hold the response open so we can observe the synchronous "Loading…" state
    // before resolving it — mockResolvedValue's promise settles too quickly
    // (before control returns to the test body) to observe reliably.
    let resolve: (value: unknown) => void = () => {};
    harness.sendMessage.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );

    await loadPanel();

    const el = host();
    expect(el).not.toBeNull();
    expect(el?.parentElement).toBe(document.documentElement);

    const root = shadow();
    expect(root).not.toBeNull();
    expect(root?.querySelector(".nimbus-related")).not.toBeNull();
    expect(root?.querySelector(".nimbus-related__heading")?.textContent).toBe("Related in Nimbus");
    expect(root?.querySelector(".nimbus-related__close")).not.toBeNull();
    expect(status()).toBe("Loading…");

    resolve({ kind: "related", ok: true, items: [] });
    await vi.waitFor(() => {
      expect(status()).toBe("No related items found.");
    });
  });
});

describe("panel-in-page readContext()", () => {
  test("flows document.title, the canonical link, and the current selection into the related request", async () => {
    document.title = "My Page";
    const link = document.createElement("link");
    link.rel = "canonical";
    link.href = "https://example.com/canon";
    document.head.append(link);

    const p = document.createElement("p");
    p.textContent = "selected text";
    document.body.append(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    harness.sendMessage.mockResolvedValue({ kind: "related", ok: true, items: [] });

    await loadPanel();

    expect(harness.sendMessage).toHaveBeenCalledWith({
      kind: "related",
      title: "My Page",
      canonicalUrl: "https://example.com/canon",
      selection: "selected text",
    });
  });

  test("omits canonicalUrl when there is no canonical link, and sends an empty selection", async () => {
    document.title = "Untitled";
    harness.sendMessage.mockResolvedValue({ kind: "related", ok: true, items: [] });

    await loadPanel();

    expect(harness.sendMessage).toHaveBeenCalledWith({
      kind: "related",
      title: "Untitled",
      selection: "",
    });
  });
});

describe("panel-in-page query()", () => {
  test("renders hits via renderHits on a successful response", async () => {
    harness.sendMessage.mockResolvedValue({ kind: "related", ok: true, items: [hit] });

    await loadPanel();

    await vi.waitFor(() => {
      expect(shadow()?.querySelector(".nimbus-related__item")).not.toBeNull();
    });
    expect(shadow()?.querySelector(".nimbus-related__title")?.textContent).toBe("Doc");
    expect(status()).toBeUndefined();
  });

  test("renders the empty-state message when there are no hits", async () => {
    harness.sendMessage.mockResolvedValue({ kind: "related", ok: true, items: [] });

    await loadPanel();

    await vi.waitFor(() => {
      expect(status()).toBe("No related items found.");
    });
  });

  test("maps a well-formed failure response to its user-facing message", async () => {
    harness.sendMessage.mockResolvedValue({ kind: "related", ok: false, reason: "not_paired" });

    await loadPanel();

    await vi.waitFor(() => {
      expect(status()).not.toBe("Loading…");
    });
    expect(status()).toBe("Pair a browser first (Options).");
  });

  test("falls back to a generic failure message for an unrecognized reason", async () => {
    harness.sendMessage.mockResolvedValue({ kind: "related", ok: false, reason: "weird" });

    await loadPanel();

    await vi.waitFor(() => {
      expect(status()).not.toBe("Loading…");
    });
    expect(status()).toBe("Couldn't fetch related items.");
  });

  test("renders an error when sendMessage rejects (not stuck on Loading…)", async () => {
    harness.sendMessage.mockRejectedValue(new Error("boom"));

    await loadPanel();

    await vi.waitFor(() => {
      expect(status()).not.toBe("Loading…");
    });
    expect(status()).toBe("Couldn't connect to Nimbus.");
  });

  test("renders a generic error for a malformed response", async () => {
    harness.sendMessage.mockResolvedValue({ kind: "related", ok: true, items: [{ bad: true }] });

    await loadPanel();

    await vi.waitFor(() => {
      expect(status()).not.toBe("Loading…");
    });
    expect(status()).toBe("Unexpected response.");
  });
});

describe("panel-in-page teardown / self-toggle", () => {
  test("clicking the close control removes the panel from the document", async () => {
    harness.sendMessage.mockResolvedValue({ kind: "related", ok: true, items: [] });
    await loadPanel();
    expect(host()).not.toBeNull();

    shadow()?.querySelector<HTMLButtonElement>(".nimbus-related__close")?.click();

    expect(host()).toBeNull();
  });

  test("Escape closes the panel", async () => {
    harness.sendMessage.mockResolvedValue({ kind: "related", ok: true, items: [] });
    await loadPanel();
    expect(host()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(host()).toBeNull();
  });

  test("re-injection while a panel is open closes it instead of mounting a second one", async () => {
    harness.sendMessage.mockResolvedValue({ kind: "related", ok: true, items: [] });
    await loadPanel();
    expect(host()).not.toBeNull();

    await loadPanel();

    expect(host()).toBeNull();
    // Only a single host ever existed at once — no leaked duplicate.
    expect(document.documentElement.querySelectorAll(`#${HOST_ID}`)).toHaveLength(0);
  });

  test("a stray host lacking the teardown hook is simply removed (fallback branch)", async () => {
    const stale = document.createElement("div");
    stale.id = HOST_ID;
    document.documentElement.append(stale);

    await loadPanel();

    expect(host()).toBeNull();
    // The fallback path never mounts a fresh panel in the same pass.
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });
});
