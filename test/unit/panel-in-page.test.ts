// @vitest-environment jsdom
// test/unit/panel-in-page.test.ts
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
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

/** The RELATED lane's status line. Scoped to the lane on purpose: since the panel
 *  grew a recognition header, that header carries its own `__status` element and
 *  an unscoped query would return it instead. */
function status(): string | null | undefined {
  return shadow()?.querySelector(".nimbus-related__lane .nimbus-related__status")?.textContent;
}

/** The recognition header's text — surface line plus item/status. */
function headerText(): string | null | undefined {
  return shadow()?.querySelector(".nimbus-related__header-state")?.textContent;
}

/** Mounts the panel with a stubbed "resolve" response (and an empty "related"
 *  response), waiting for the header to settle past "Checking Nimbus…". Returns
 *  the shadow root so callers can query/click into the rendered header. */
async function mountPanelWithResolve(resolveResponse: unknown): Promise<ShadowRoot> {
  harness.sendMessage.mockImplementation(async (message: unknown) => {
    const kind = (message as { kind?: string }).kind;
    if (kind === "resolve") {
      return resolveResponse;
    }
    return { kind: "related", ok: true, items: [] };
  });

  await loadPanel();
  await vi.waitFor(() => {
    expect(headerText()).not.toContain("Checking Nimbus");
  });

  const root = shadow();
  if (root === null) {
    throw new Error("panel shadow root not found");
  }
  return root;
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
  // Most tests leave the panel mounted; its Escape keydown listener lives on
  // `document` and only detaches via the host's own teardown hook. Close it
  // deterministically here, before the next test's beforeEach resets the DOM —
  // otherwise stale document-level listeners accumulate across tests (the
  // "Escape closes the panel" test below would then pass partly by luck).
  // No-op when no panel is mounted.
  const el = host();
  const closePanel = (el as unknown as { __nimbusClose?: () => void } | null)?.__nimbusClose;
  closePanel?.();
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

describe("panel-in-page recognition header", () => {
  const item = {
    id: "i1",
    service: "github",
    type: "pr",
    title: "Add thing",
    url: "https://github.com/acme/web/pull/1",
    modifiedAt: 1_700_000_000_000,
  };
  const recognition = {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref: "acme/web #1",
    resolveUrl: "https://github.com/acme/web/pull/1",
  } as const;

  /** Answer both messages the panel sends, by kind. */
  function respond(resolveResponse: unknown, relatedItems: RelatedHit[] = [hit]): void {
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const kind = (message as { kind?: string }).kind;
      if (kind === "resolve") {
        return resolveResponse;
      }
      return { kind: "related", ok: true, items: relatedItems };
    });
  }

  test("sends the page url for resolution", async () => {
    respond({
      kind: "resolve",
      ok: true,
      recognition,
      outcome: { kind: "found", matchKind: "exact", item },
    });
    await loadPanel();
    await vi.waitFor(() => {
      expect(harness.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "resolve", pageUrl: window.location.href }),
      );
    });
  });

  test("a resolved item is named in the header", async () => {
    respond({
      kind: "resolve",
      ok: true,
      recognition,
      outcome: { kind: "found", matchKind: "exact", item },
    });
    await loadPanel();
    await vi.waitFor(() => {
      expect(headerText()).toContain("GitHub PR · acme/web #1");
      expect(headerText()).toContain("Add thing");
    });
  });

  test("a miss says not indexed, and does NOT imply the related hits are the page", async () => {
    respond({
      kind: "resolve",
      ok: true,
      recognition,
      outcome: { kind: "not-indexed", fetchable: true },
    });
    await loadPanel();
    await vi.waitFor(() => {
      expect(shadow()?.textContent).toContain("Not indexed");
    });
  });

  test("an unsupported gateway is a first-class state, not an error", async () => {
    respond({ kind: "resolve", ok: false, recognition, reason: "unsupported" });
    await loadPanel();
    await vi.waitFor(() => {
      expect(shadow()?.textContent).toContain("can't resolve pages yet");
    });
  });

  test("the related lane still renders when resolve fails", async () => {
    respond({ kind: "resolve", ok: false, recognition, reason: "unreachable" });
    await loadPanel();
    await vi.waitFor(() => {
      expect(shadow()?.querySelectorAll(".nimbus-related__item")).toHaveLength(1);
    });
  });

  test("an unrecognised page still renders the related lane", async () => {
    respond({
      kind: "resolve",
      ok: true,
      recognition: { ok: false, reason: "unknown-host" },
      outcome: { kind: "not-indexed", fetchable: false },
    });
    await loadPanel();
    await vi.waitFor(() => {
      expect(shadow()?.textContent).toContain("Not a recognised Nimbus surface");
      expect(shadow()?.querySelectorAll(".nimbus-related__item")).toHaveLength(1);
    });
  });

  test("a malformed resolve response degrades to an error header, never a crash", async () => {
    respond({ kind: "resolve", ok: true });
    await loadPanel();
    await vi.waitFor(() => {
      expect(shadow()?.textContent).toContain("Couldn't read Nimbus's answer.");
    });
  });
});

describe("panel-in-page resolve outcomes", () => {
  it("renders scope guidance for an insufficient_scope reason", async () => {
    const panel = await mountPanelWithResolve({
      kind: "resolve",
      ok: false,
      reason: "insufficient_scope",
      recognition: {
        ok: true,
        product: "github",
        kind: "pr",
        label: "GitHub PR",
        ref: "a/b #1",
        resolveUrl: "https://github.com/a/b/pull/1",
      },
    });
    expect(panel.textContent).toContain("nimbus clip scopes");
    expect(panel.textContent).not.toContain("had an error");
  });

  it("renders the real built command when the 403 carried a scope gap", async () => {
    const panel = await mountPanelWithResolve({
      kind: "resolve",
      ok: false,
      reason: "insufficient_scope",
      recognition: {
        ok: true,
        product: "github",
        kind: "pr",
        label: "GitHub PR",
        ref: "a/b #1",
        resolveUrl: "https://github.com/a/b/pull/1",
      },
      scopeGap: { label: "chrome", required: "resolve", granted: ["clip", "briefs"] },
    });
    expect(panel.textContent).toContain("nimbus clip scopes chrome --set clip,briefs,resolve");
  });

  it("renders the chooser for an ambiguous outcome and settles on the clicked candidate", async () => {
    const panel = await mountPanelWithResolve({
      kind: "resolve",
      ok: true,
      recognition: {
        ok: true,
        product: "jira",
        kind: "issue",
        label: "Jira issue",
        ref: "ABC-1",
        resolveUrl: "https://acme.atlassian.net/browse/ABC-1",
      },
      outcome: {
        kind: "ambiguous",
        fetchable: false,
        truncated: false,
        candidates: [
          { id: "a", service: "jira", type: "issue", title: "One", url: null },
          { id: "b", service: "jira", type: "issue", title: "Two", url: null },
        ],
      },
    });

    const buttons = panel.querySelectorAll("button.nimbus-related__candidate");
    expect(buttons).toHaveLength(2);
    (buttons[1] as HTMLButtonElement).click();

    expect(panel.textContent).toContain("Two");
    expect(panel.querySelectorAll("button.nimbus-related__candidate")).toHaveLength(0);
  });
});

describe("panel-in-page lane state", () => {
  test("a lane the user collapsed stays collapsed across the next repaint", async () => {
    // resolve and related settle at different times and each repaints the shell.
    let settleResolve: (value: unknown) => void = () => {};
    harness.sendMessage.mockImplementation((message: unknown) => {
      const kind = (message as { kind?: string }).kind;
      if (kind === "related") {
        return Promise.resolve({ kind: "related", ok: true, items: [hit] });
      }
      return new Promise((r) => {
        settleResolve = r;
      });
    });

    await loadPanel();
    const lane = (): HTMLDetailsElement | null | undefined =>
      shadow()?.querySelector<HTMLDetailsElement>('[data-lane="related"]');
    await vi.waitFor(() => {
      expect(lane()?.open).toBe(true);
    });

    // The user collapses the lane while the resolve request is still in flight.
    const details = lane();
    if (details) {
      details.open = false;
    }

    settleResolve({
      kind: "resolve",
      ok: true,
      recognition: { ok: false, reason: "unknown-host" },
      outcome: { kind: "not-indexed", fetchable: false },
    });

    await vi.waitFor(() => {
      expect(shadow()?.textContent).toContain("Not a recognised Nimbus surface");
    });
    expect(lane()?.open).toBe(false);
  });
});
