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

/** Flushes pending microtasks (chained `await`s in the click handlers under
 *  test) via a real macrotask tick — Node drains the microtask queue fully
 *  before any queued macrotask runs, so one tick is enough regardless of how
 *  deep the awaited chain is (e.g. fetch -> re-resolve). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

/**
 * Mounts the panel with a scripted SEQUENCE of responses per message kind, and
 * records each "resolve"/"fetch" kind sent (in order) into `sent` — the
 * assertion surface for "exactly one fetch, ever". "related" traffic is
 * answered with a fixed empty response and deliberately NOT recorded: it fires
 * in parallel with every mount and isn't part of the fetch state machine under
 * test, so recording it would make `sent` an unpredictable interleave instead
 * of the ordered ["resolve", "fetch", ...] trace these tests assert on.
 *
 * Each kind's array is consumed in order; once exhausted, its last entry
 * repeats for any further call of that kind (a recovery resolve after a single
 * scripted miss keeps returning that same miss).
 *
 * Returns the panel's BODY element (not the full shadow root) so callers can
 * do `panel.querySelector("button")` unambiguously — the shadow root's first
 * button is the panel's own close control, which lives outside the body.
 */
async function mountPanelWithScript(
  sent: string[],
  script: { readonly resolve?: unknown[]; readonly fetch?: unknown[] },
): Promise<HTMLElement> {
  const counters: Record<string, number> = {};
  harness.sendMessage.mockImplementation(async (message: unknown) => {
    const kind = (message as { kind?: string }).kind;
    if (kind === "related") {
      return { kind: "related", ok: true, items: [] };
    }
    if (kind !== "resolve" && kind !== "fetch") {
      throw new Error(`mountPanelWithScript: unscripted message kind ${String(kind)}`);
    }
    sent.push(kind);
    const responses = script[kind] ?? [];
    const i = counters[kind] ?? 0;
    counters[kind] = i + 1;
    return responses[Math.min(i, responses.length - 1)];
  });

  await loadPanel();
  await vi.waitFor(() => {
    expect(headerText()).not.toContain("Checking Nimbus");
  });

  const body = shadow()?.querySelector<HTMLElement>(".nimbus-related__body");
  if (body === null || body === undefined) {
    throw new Error("panel body not found");
  }
  return body;
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

  // Closes the gap where `outcome.fetchable` flows from the wire into the header:
  // every panel-view.test.ts fixture passes `fetchable` as a hardcoded literal, so
  // it alone can't tell a real wire-through from a hardcoded `false`. This drives
  // a genuine ResolveResponse end to end through headerFrom/renderShell.
  test("a fetchable miss offers a fetch button naming the product", async () => {
    respond({
      kind: "resolve",
      ok: true,
      recognition,
      outcome: { kind: "not-indexed", fetchable: true },
    });
    await loadPanel();
    await vi.waitFor(() => {
      expect(headerText()).toContain("Not indexed");
    });
    expect(shadow()?.querySelector(".nimbus-related__header-state button")?.textContent).toBe(
      "Fetch this from GitHub",
    );
  });

  test("an unfetchable miss offers no fetch button", async () => {
    respond({
      kind: "resolve",
      ok: true,
      recognition,
      outcome: { kind: "not-indexed", fetchable: false },
    });
    await loadPanel();
    await vi.waitFor(() => {
      expect(headerText()).toContain("Not indexed");
    });
    expect(shadow()?.querySelector(".nimbus-related__header-state button")).toBeNull();
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

describe("panel-in-page fetch state machine", () => {
  const recognition = {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref: "acme/web #1",
    resolveUrl: "https://github.com/acme/web/pull/1",
  } as const;

  const miss = {
    kind: "resolve",
    ok: true,
    recognition,
    outcome: { kind: "not-indexed", fetchable: true },
  };

  function found(): unknown {
    return {
      kind: "resolve",
      ok: true,
      recognition,
      outcome: {
        kind: "found",
        matchKind: "exact",
        item: {
          id: "i1",
          service: "github",
          type: "pr",
          title: "Add thing",
          url: "https://github.com/acme/web/pull/1",
          modifiedAt: Date.now(),
        },
      },
    };
  }

  const indexed = {
    kind: "fetch",
    ok: true,
    recognition,
    outcome: { kind: "indexed", itemId: "i1" },
  };

  const timedOut = {
    kind: "fetch",
    ok: false,
    recognition,
    reason: "timeout",
  };

  const rateLimited = {
    kind: "fetch",
    ok: true,
    recognition,
    outcome: { kind: "rate-limited" },
  };

  it("fetches on click, then re-resolves to show the item", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [miss, found()],
      fetch: [indexed],
    });

    (panel.querySelector("button") as HTMLButtonElement).click();
    await flush();

    expect(sent).toEqual(["resolve", "fetch", "resolve"]);
    expect(panel.textContent).toContain("Updated just now");
  });

  it("after a timeout, Check again re-resolves and does NOT fetch again", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [miss],
      fetch: [timedOut],
    });

    (panel.querySelector("button") as HTMLButtonElement).click();
    await flush();
    expect(panel.textContent).toContain("Still working");

    (panel.querySelector("button") as HTMLButtonElement).click();
    await flush();

    // One fetch, ever. The recovery click is a resolve.
    expect(sent.filter((k) => k === "fetch")).toHaveLength(1);
    expect(sent[sent.length - 1]).toBe("resolve");
  });

  it("does not re-offer the Fetch button when the recovery resolve is still a miss", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [miss],
      fetch: [timedOut],
    });

    (panel.querySelector("button") as HTMLButtonElement).click(); // Fetch
    await flush();
    (panel.querySelector("button") as HTMLButtonElement).click(); // Check again
    await flush();

    // Falling back to not-indexed would restore the Fetch button and allow a second
    // outbound request for work possibly still in flight.
    expect(panel.textContent).toContain("Still working");
    expect(panel.textContent).not.toContain("Fetch this from");
    expect(sent.filter((k) => k === "fetch")).toHaveLength(1);
  });

  it("a rate-limited outcome renders Try again", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [miss],
      fetch: [rateLimited],
    });

    (panel.querySelector("button") as HTMLButtonElement).click();
    await flush();

    expect(panel.textContent).toContain("Rate limited");
    const labels = Array.from(panel.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toContain("Try again");
  });

  it("clicking Try again after rate-limited sends a second fetch", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [miss],
      fetch: [rateLimited, indexed],
    });

    (panel.querySelector("button") as HTMLButtonElement).click(); // Fetch
    await flush();
    (panel.querySelector("button") as HTMLButtonElement).click(); // Try again
    await flush();

    // rate_limited is returned before any outbound call happens — unlike
    // timeout, a second fetch after it is exactly as safe as the first.
    expect(sent.filter((k) => k === "fetch")).toHaveLength(2);
  });

  it("pins the distinction: a timeout followed by a recovery click still sends exactly one fetch", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [miss],
      fetch: [timedOut],
    });

    (panel.querySelector("button") as HTMLButtonElement).click(); // Fetch
    await flush();
    (panel.querySelector("button") as HTMLButtonElement).click(); // Check again
    await flush();

    // Unlike rate-limited, timeout means an outbound call may still be
    // running — the latch must stay set and the recovery click must be a
    // resolve, not a second fetch.
    expect(sent.filter((k) => k === "fetch")).toHaveLength(1);
    expect(sent[sent.length - 1]).toBe("resolve");
  });

  // FIX 1: a fetch response that fails with a synthesised, non-recognising
  // `recognition` (the service worker's catch-all on a rejected getOrigins/
  // getConnection — see service-worker.ts's isFetchRequest branch) must NOT
  // discard the surface the panel already knows from the prior resolve. The
  // panel closure's own `surface`, not `res.recognition`, is what
  // `fetchOutcomeHeader` renders — checking `res.recognition` first (the old
  // order) threw that away and rendered "Not a recognised Nimbus surface" for
  // a page the panel had just correctly identified.
  it("a fetch failure with a non-recognising recognition keeps the surface line, not 'unrecognised'", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [miss],
      fetch: [
        {
          kind: "fetch",
          ok: false,
          reason: "server_error",
          recognition: { ok: false, reason: "unknown-host" },
        },
      ],
    });

    (panel.querySelector("button") as HTMLButtonElement).click(); // Fetch
    await flush();

    expect(panel.textContent).toContain("GitHub PR · acme/web #1");
    expect(panel.textContent).toContain("Nimbus had an error fetching this page.");
    expect(panel.textContent).not.toContain("Not a recognised Nimbus surface");
  });
});
