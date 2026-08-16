// @vitest-environment jsdom
// test/unit/panel-in-page.test.ts
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import {
  AGENT_LANES,
  type AgentLane,
  type LaneState,
  type RelatedHit,
} from "../../src/shared/types.ts";
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

/** Advances FAKE timers by `ms`, awaiting any promise chains a fired timer
 *  kicks off along the way — the panel's agent-state poll reschedules its own
 *  next tick from inside an async callback, so the plain synchronous
 *  `vi.advanceTimersByTime` would fire a timer without ever letting that
 *  callback's `await sendMessage(...)` resolve. Callers must have
 *  `vi.useFakeTimers()` active already. */
async function advanceTimers(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
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
  script: {
    readonly resolve?: unknown[];
    readonly fetch?: unknown[];
    readonly capture?: unknown[];
    readonly clip?: unknown[];
  },
): Promise<HTMLElement> {
  const counters: Record<string, number> = {};
  harness.sendMessage.mockImplementation(async (message: unknown) => {
    const kind = (message as { kind?: string }).kind;
    if (kind === "related") {
      return { kind: "related", ok: true, items: [] };
    }
    if (kind !== "resolve" && kind !== "fetch" && kind !== "capture" && kind !== "clip") {
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

/**
 * Selects the panel's Fetch button — by CLASS, not position. Once a fetch
 * preview can be open, "the first button in the panel" is ambiguous between
 * this control and the preview's own Send/Cancel (see the fetch-state-machine
 * describe block below), so every caller that means "click Fetch" must say so
 * by class, never `panel.querySelector("button")`.
 */
function clickFetch(root: ParentNode): void {
  root.querySelector<HTMLButtonElement>("button.nimbus-related__fetch")?.click();
}

/** Selects the open preview's Send (confirm) control — by class, for the same
 *  reason as `clickFetch` above. */
function clickPreviewSend(root: ParentNode): void {
  root.querySelector<HTMLButtonElement>("button.nimbus-related__fetch-send")?.click();
}

/** Selects the open preview's Cancel control — by class, for the same reason
 *  as `clickFetch` above. */
function clickPreviewCancel(root: ParentNode): void {
  root.querySelector<HTMLButtonElement>("button.nimbus-related__fetch-cancel")?.click();
}

/** Selects the capture offer — by CLASS, for the same reason as `clickFetch`:
 *  once a confirm preview can be open, "the first button in the panel" is
 *  ambiguous. */
function clickCapture(root: ParentNode): void {
  root.querySelector<HTMLButtonElement>("button.nimbus-related__capture")?.click();
}

/** Selects the captured header's "Update this copy" control — by class, same
 *  reason as `clickFetch` above. */
function clickRecapture(root: ParentNode): void {
  root.querySelector<HTMLButtonElement>("button.nimbus-related__recapture")?.click();
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
  // A successful agent-run schedules a real in-worker poll timer via setTimeout;
  // vi.resetModules() does not cancel it. Restoring real timers here — rather
  // than as each fake-timer test's own last statement — means a test that fails
  // (and exits before reaching that statement) does not leave setTimeout faked
  // for every test that runs after it. Mirrors service-worker.test.ts's afterEach.
  vi.useRealTimers();
});

describe("panel-in-page mount()", () => {
  test("builds a shadow-root panel appended directly under <html>, with a loading placeholder before the query settles", async () => {
    // Hold each response open so we can observe the synchronous "Loading…"
    // state before resolving it — mockResolvedValue's promise settles too
    // quickly (before control returns to the test body) to observe reliably.
    // Related now waits on the header (mount's `loadHeader().then(loadRelated)`
    // chain), so "resolve" must settle before "related" is even sent — one
    // resolver per message kind, not one shared variable.
    const resolvers: Partial<Record<string, (value: unknown) => void>> = {};
    harness.sendMessage.mockImplementation(
      (message: unknown) =>
        new Promise((r) => {
          const kind = (message as { kind?: string }).kind ?? "unknown";
          resolvers[kind] = r;
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

    resolvers["resolve"]?.({
      kind: "resolve",
      ok: false,
      reason: "unreachable",
      recognition: { ok: false, reason: "unknown-host" },
    });
    await vi.waitFor(() => {
      expect(resolvers["related"]).toBeDefined();
    });
    resolvers["related"]?.({ kind: "related", ok: true, items: [] });
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

describe("panel-in-page related lane and the resolved item id", () => {
  const recognition = {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref: "acme/web #1",
    resolveUrl: "https://github.com/acme/web/pull/1",
  } as const;

  const resolvedItem = {
    id: "i1",
    service: "github",
    type: "pr",
    title: "Add thing",
    url: "https://github.com/acme/web/pull/1",
    modifiedAt: 1_700_000_000_000,
  };

  const resolvedResponse = {
    kind: "resolve",
    ok: true,
    recognition,
    outcome: { kind: "found", matchKind: "exact", item: resolvedItem },
  };

  // Finding 1: `loadRelated` reads the header SYNCHRONOUSLY, before its own
  // first `await`, so firing it alongside `loadHeader` on a plain panel open
  // (no selection involved) sent every related request with `itemId`
  // undefined — the header was still `{kind:"loading"}`. This pins the fix:
  // a resolved page's very first related request must carry the item id.
  test("sends itemId on a plain panel open of a resolved page", async () => {
    const relatedMessages: unknown[] = [];
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const kind = (message as { kind?: string }).kind;
      if (kind === "resolve") {
        return resolvedResponse;
      }
      if (kind === "related") {
        relatedMessages.push(message);
      }
      return { kind: "related", ok: true, items: [] };
    });

    await loadPanel();

    await vi.waitFor(() => {
      expect(relatedMessages.length).toBeGreaterThan(0);
    });
    expect(relatedMessages[0]).toMatchObject({ kind: "related", itemId: "i1" });
  });

  // Finding 2: an older gateway ignores `itemId` and applies no exclusion of
  // its own, so the resolved page's own title-matched hit would render as its
  // own top related result. The client filters it out regardless of what the
  // gateway did.
  test("filters the current item out of the rendered related list", async () => {
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const kind = (message as { kind?: string }).kind;
      if (kind === "resolve") {
        return resolvedResponse;
      }
      return {
        kind: "related",
        ok: true,
        items: [
          { id: "i1", title: "Self", service: "github", snippet: "s1", url: null },
          { id: "i2", title: "Other", service: "github", snippet: "s2", url: null },
        ],
      };
    });

    await loadPanel();

    await vi.waitFor(() => {
      expect(shadow()?.querySelectorAll(".nimbus-related__item")).toHaveLength(1);
    });
    expect(shadow()?.querySelector(".nimbus-related__title")?.textContent).toBe("Other");
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
    // No fetch button — nothing left to fetch. This is exactly the miss
    // offersCapture() covers, so a capture offer renders in its place; wiring
    // its click is a later task, but the render itself is this one's.
    expect(shadow()?.querySelector(".nimbus-related__fetch")).toBeNull();
    expect(shadow()?.querySelector(".nimbus-related__capture")).not.toBeNull();
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

  // The gap `headerFrom` closes: nothing else makes a COLD panel open (no
  // capture performed in this session) show the captured-copy header.
  // Without this branch, a page captured last week would present as ordinary
  // connector data the moment the panel is reopened — exactly the dishonesty
  // the `captured` header arm exists to prevent.
  it("a cold panel open on a captured item renders the captured header, not resolved", async () => {
    const panel = await mountPanelWithResolve({
      kind: "resolve",
      ok: true,
      recognition: {
        ok: true,
        product: "github",
        kind: "pr",
        label: "GitHub PR",
        ref: "acme/web #9",
        resolveUrl: "https://github.com/acme/web/pull/9",
      },
      outcome: {
        kind: "found",
        matchKind: "exact",
        item: {
          id: "nimbus:clip:1",
          service: "nimbus",
          type: "web_clip",
          title: "Runbook copy",
          url: "https://github.com/acme/web/pull/9",
          modifiedAt: 1_700_000_000_000,
        },
      },
    });

    expect(panel.textContent).toContain("Runbook copy");
    expect(panel.textContent).toContain("copy you saved");
    expect(panel.querySelector(".nimbus-related__recapture")).not.toBeNull();
    // The `resolved` arm WOULD render a surface line ("GitHub PR ·
    // acme/web #9") for this same recognised page — `captured` renders none,
    // which is the one observable difference proving `headerFrom` took the
    // `captured` branch rather than the `resolved` one it used to fall into.
    expect(panel.querySelector(".nimbus-related__surface")).toBeNull();
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

  it("pressing Fetch shows the target and sends NO fetch yet", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [miss],
      fetch: [indexed],
    });

    clickFetch(panel);
    await flush();

    // The assertion that matters: the trace shows the resolve only.
    expect(sent).toEqual(["resolve"]);
    expect(panel.textContent).toContain("Address");
  });

  it("confirming sends exactly one fetch", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [miss, found()],
      fetch: [indexed],
    });

    clickFetch(panel);
    await flush();
    clickPreviewSend(panel);
    await flush();

    expect(sent).toEqual(["resolve", "fetch", "resolve"]);
  });

  it("cancelling sends nothing AND leaves the fetch button usable", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [miss, found()],
      fetch: [indexed],
    });

    clickFetch(panel);
    await flush();
    clickPreviewCancel(panel);
    await flush();
    expect(sent).toEqual(["resolve"]);

    // `fetchSent` must NOT have latched. Cancelling is not an attempt, and a
    // latch here would turn "no thanks" into "never again" for this panel.
    clickFetch(panel);
    await flush();
    clickPreviewSend(panel);
    await flush();
    expect(sent).toEqual(["resolve", "fetch", "resolve"]);
  });

  it("fetches on click, then re-resolves to show the item", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [miss, found()],
      fetch: [indexed],
    });

    clickFetch(panel);
    await flush();
    clickPreviewSend(panel);
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

    clickFetch(panel);
    await flush();
    clickPreviewSend(panel);
    await flush();
    expect(panel.textContent).toContain("Still working");

    (panel.querySelector("button") as HTMLButtonElement).click(); // Check again
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

    clickFetch(panel); // Fetch
    await flush();
    clickPreviewSend(panel); // confirm
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

    clickFetch(panel);
    await flush();
    clickPreviewSend(panel);
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

    clickFetch(panel); // Fetch
    await flush();
    clickPreviewSend(panel); // confirm the first fetch
    await flush();
    (panel.querySelector("button") as HTMLButtonElement).click(); // Try again -> a fresh preview
    await flush();
    clickPreviewSend(panel); // confirm the second fetch
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

    clickFetch(panel); // Fetch
    await flush();
    clickPreviewSend(panel); // confirm
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

    clickFetch(panel); // Fetch
    await flush();
    clickPreviewSend(panel); // confirm
    await flush();

    expect(panel.textContent).toContain("GitHub PR · acme/web #1");
    expect(panel.textContent).toContain("Nimbus had an error fetching this page.");
    expect(panel.textContent).not.toContain("Not a recognised Nimbus surface");
  });
});

describe("panel-in-page capture state machine", () => {
  const CAPTURE = {
    url: "https://wiki.example.com/runbook",
    title: "Runbook",
    mode: "article" as const,
    body: "Some readable body text.",
    readableFound: true,
  };

  const PREVIEW = {
    fields: [
      { label: "Title", value: "Runbook" },
      { label: "URL", value: "https://wiki.example.com/runbook" },
      { label: "Mode", value: "article" },
      { label: "Tags", value: "none" },
    ],
    excerpt: "Some readable body text.",
    bodyLength: 24,
    truncated: false,
  };

  // A recognised-but-unfetchable page — offers capture the same as an
  // unrecognised one (`offersCapture`), but keeps a surface line, which is
  // what the second resolve entry below relies on to reach the `found`/
  // `captured` branch of `headerFrom` (an unrecognised `recognition` never
  // gets that far — see the `headerFrom` gap test above).
  const UNFETCHABLE_MISS = {
    kind: "resolve",
    ok: true,
    recognition: {
      ok: true,
      product: "github",
      kind: "pr",
      label: "GitHub PR",
      ref: "acme/web #1",
      resolveUrl: "https://github.com/acme/web/pull/1",
    },
    outcome: { kind: "not-indexed", fetchable: false },
  };

  const CAPTURED_RESOLVE = {
    kind: "resolve",
    ok: true,
    recognition: UNFETCHABLE_MISS.recognition,
    outcome: {
      kind: "found",
      matchKind: "exact",
      item: {
        id: "nimbus:clip:1",
        service: "nimbus",
        type: "web_clip",
        title: "Runbook",
        url: "https://wiki.example.com/runbook",
        modifiedAt: 1_700_000_000_000,
      },
    },
  };

  it("preview OFF sends the clip and then re-resolves", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [UNFETCHABLE_MISS, CAPTURED_RESOLVE],
      capture: [{ kind: "capture", ok: true, capture: CAPTURE, preview: null }],
      clip: [{ kind: "clip", ok: true, status: "created", bookmarked: true }],
    });

    clickCapture(panel);
    await flush();

    expect(sent).toContain("capture");
    expect(sent).toContain("clip");
    // The re-resolve is what turns the header into the captured arm.
    expect(sent.filter((k) => k === "resolve").length).toBeGreaterThan(1);
    expect(panel.querySelector(".nimbus-related__recapture")).not.toBeNull();
  });

  it("preview ON does NOT clip until Send is clicked", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [UNFETCHABLE_MISS, CAPTURED_RESOLVE],
      capture: [{ kind: "capture", ok: true, capture: CAPTURE, preview: PREVIEW }],
      clip: [{ kind: "clip", ok: true, status: "created", bookmarked: true }],
    });

    clickCapture(panel);
    await flush();
    expect(sent).not.toContain("clip");

    clickPreviewSend(panel);
    await flush();
    expect(sent).toContain("clip");
  });

  it("a url-changed refusal says so and does not clip", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [UNFETCHABLE_MISS],
      capture: [{ kind: "capture", ok: false, reason: "url-changed" }],
    });

    clickCapture(panel);
    await flush();

    expect(sent).not.toContain("clip");
    expect(panel.textContent).toMatch(/moved|changed/i);
  });

  it("a second click while one is in flight sends only one capture", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [UNFETCHABLE_MISS],
      capture: [{ kind: "capture", ok: true, capture: CAPTURE, preview: PREVIEW }],
    });

    clickCapture(panel);
    clickCapture(panel);
    await flush();

    expect(sent.filter((k) => k === "capture")).toHaveLength(1);
  });

  // Update this copy runs the IDENTICAL flow — not a second one. Ingest
  // upserts on the canonicalised URL, so a re-capture refreshes the one item.
  it("Update this copy on the captured header runs the identical capture flow", async () => {
    const sent: string[] = [];
    const panel = await mountPanelWithScript(sent, {
      resolve: [CAPTURED_RESOLVE, CAPTURED_RESOLVE],
      capture: [{ kind: "capture", ok: true, capture: CAPTURE, preview: null }],
      clip: [{ kind: "clip", ok: true, status: "updated", bookmarked: true }],
    });

    clickRecapture(panel);
    await flush();

    expect(sent).toContain("capture");
    expect(sent).toContain("clip");
    expect(sent.filter((k) => k === "resolve").length).toBeGreaterThan(1);
  });

  // Every in-flight state renders: with preview OFF there is no confirm
  // step, so the status lines are the only sign that an injection, a POST
  // and a re-resolve are happening — a click that produces no visible change
  // reads as broken. Held open deliberately so the "Capturing…" status can be
  // observed before it resolves.
  it("shows a status line while capturing, before the capture response lands", async () => {
    let resolveCapture: (value: unknown) => void = () => {};
    harness.sendMessage.mockImplementation((message: unknown) => {
      const kind = (message as { kind?: string }).kind;
      if (kind === "resolve") {
        return Promise.resolve(UNFETCHABLE_MISS);
      }
      if (kind === "related") {
        return Promise.resolve({ kind: "related", ok: true, items: [] });
      }
      if (kind === "capture") {
        return new Promise((resolve) => {
          resolveCapture = resolve;
        });
      }
      throw new Error(`unscripted message kind ${String(kind)}`);
    });

    await loadPanel();
    await vi.waitFor(() => {
      expect(headerText()).not.toContain("Checking Nimbus");
    });
    const panel = shadow()?.querySelector<HTMLElement>(".nimbus-related__body");
    if (panel === null || panel === undefined) {
      throw new Error("panel body not found");
    }

    clickCapture(panel);
    await flush();

    expect(headerText()).toContain("Capturing this page");

    // Settle the held request so it doesn't leak into a later test — a plain
    // refusal, so this test stays about the ONE status line under test rather
    // than exercising the clip step too.
    resolveCapture({ kind: "capture", ok: false, reason: "empty" });
    await flush();
  });
});

describe("panel-in-page agent lanes", () => {
  const recognition = {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref: "acme/web #1",
    resolveUrl: "https://github.com/acme/web/pull/1",
  } as const;

  const resolvedItem = {
    id: "i1",
    service: "github",
    type: "pr",
    title: "Add thing",
    url: "https://github.com/acme/web/pull/1",
    modifiedAt: 1_700_000_000_000,
  };

  const resolvedResponse = {
    kind: "resolve",
    ok: true,
    recognition,
    outcome: { kind: "found", matchKind: "exact", item: resolvedItem },
  };

  const missResponse = {
    kind: "resolve",
    ok: true,
    recognition,
    outcome: { kind: "not-indexed", fetchable: false },
  };

  /**
   * Mounts the panel against a RESOLVED header — the only header kinds
   * (`resolved`/`chosen`) that render the two agent lanes — and records each
   * "agent-run"/"agent-state" message KIND sent into `sent`, in order.
   *
   * `initial` seeds the answer to a lane's FIRST "agent-run"/"agent-state" call
   * (defaulting to a generic `done`, for a lane not under test in a given
   * test). `runSequence`, when given, instead drives a whole SEQUENCE of
   * per-lane answers — consumed in order per lane, repeating the last entry
   * once exhausted — for a test that watches a lane progress through several
   * states across both the initial run and subsequent polls.
   */
  async function mountResolvedPanel(
    sent: string[],
    initial: Partial<Record<AgentLane, LaneState>> = {},
    runSequence?: readonly LaneState[],
  ): Promise<HTMLElement> {
    const counters: Partial<Record<AgentLane, number>> = {};
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const kind = (message as { kind?: string }).kind;
      if (kind === "resolve") {
        return resolvedResponse;
      }
      if (kind === "related") {
        return { kind: "related", ok: true, items: [] };
      }
      if (kind !== "agent-run" && kind !== "agent-state") {
        throw new Error(`mountResolvedPanel: unscripted message kind ${String(kind)}`);
      }
      sent.push(kind);
      const lane = (message as { lane: AgentLane }).lane;
      if (runSequence !== undefined) {
        const i = counters[lane] ?? 0;
        counters[lane] = i + 1;
        const state = runSequence[Math.min(i, runSequence.length - 1)];
        return { kind: "agent-state", lane, state };
      }
      const state: LaneState = initial[lane] ?? { kind: "done", brief: "ok" };
      return { kind: "agent-state", lane, state };
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

  /** Mounts the panel against a MISS header — there is no single resolved item
   *  to ask an agent about, so neither lane is offered at all. */
  async function mountMissPanel(): Promise<HTMLElement> {
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const kind = (message as { kind?: string }).kind;
      if (kind === "resolve") {
        return missResponse;
      }
      if (kind === "related") {
        return { kind: "related", ok: true, items: [] };
      }
      throw new Error(`mountMissPanel: unscripted message kind ${String(kind)}`);
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

  it("invokes a lane's agent when it is expanded, and only then", async () => {
    const sent: string[] = [];
    const panel = await mountResolvedPanel(sent);
    expect(sent.filter((k) => k === "agent-run")).toHaveLength(0); // collapsed: nothing

    (panel.querySelector('details[data-lane="impact"] summary') as HTMLElement).click();
    await flush();

    expect(sent.filter((k) => k === "agent-run")).toHaveLength(1);
  });

  it("does not re-invoke when a done lane is collapsed and expanded again", async () => {
    const sent: string[] = [];
    const panel = await mountResolvedPanel(sent, { impact: { kind: "done", brief: "b" } });
    const summary = panel.querySelector('details[data-lane="impact"] summary') as HTMLElement;
    summary.click();
    await flush();
    summary.click();
    await flush();
    summary.click();
    await flush();
    expect(sent.filter((k) => k === "agent-run")).toHaveLength(1);
  });

  it("shows no lanes when the page is not resolved", async () => {
    const panel = await mountMissPanel();
    expect(panel.querySelector('details[data-lane="impact"]')).toBeNull();
  });

  it("shows both lanes when the page resolves to one item", async () => {
    const panel = await mountResolvedPanel([]);
    expect(panel.querySelector('details[data-lane="impact"]')).not.toBeNull();
    expect(panel.querySelector('details[data-lane="expert"]')).not.toBeNull();
  });

  /**
   * The other half of the pair above: an AMBIGUOUS answer offers no lanes until
   * the user picks a candidate — and both lanes the moment they do (ROADMAP
   * C2.5).
   *
   * Before the pick there is nothing to ask about. After it there is, and the
   * picked id rides along on `agent-run` so `resolveForAgent` can honour it
   * instead of re-resolving into the same ambiguity and refusing with
   * `not_resolved` under a header naming the item just picked.
   */
  it("shows the lanes on an ambiguous page only once a candidate is chosen", async () => {
    const sent: string[] = [];
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const kind = (message as { kind?: string }).kind;
      if (kind === "resolve") {
        return {
          kind: "resolve",
          ok: true,
          recognition,
          outcome: {
            kind: "ambiguous",
            fetchable: false,
            truncated: false,
            candidates: [
              { id: "a", service: "github", type: "pr", title: "One", url: null },
              { id: "b", service: "github", type: "pr", title: "Two", url: null },
            ],
          },
        };
      }
      if (kind === "related") {
        return { kind: "related", ok: true, items: [] };
      }
      sent.push(String(kind));
      throw new Error(`ambiguous panel must not send ${String(kind)}`);
    });

    await loadPanel();
    await vi.waitFor(() => {
      expect(headerText()).not.toContain("Checking Nimbus");
    });
    const body = shadow()?.querySelector<HTMLElement>(".nimbus-related__body");
    if (body === null || body === undefined) {
      throw new Error("panel body not found");
    }

    // Before the pick: the chooser is up, and no lanes.
    expect(body.querySelectorAll("button.nimbus-related__candidate")).toHaveLength(2);
    for (const lane of AGENT_LANES) {
      expect(body.querySelector(`details[data-lane="${lane}"]`)).toBeNull();
    }

    (body.querySelectorAll("button.nimbus-related__candidate")[1] as HTMLButtonElement).click();
    await flush();

    // After the pick: the header names the chosen candidate, and the two
    // pull-request lanes are offered against it.
    expect(body.textContent).toContain("Two");
    expect(body.querySelectorAll("button.nimbus-related__candidate")).toHaveLength(0);
    expect(body.querySelector('details[data-lane="impact"]')).not.toBeNull();
    expect(body.querySelector('details[data-lane="expert"]')).not.toBeNull();
    // Still no glossary lane: nothing has selected a term.
    expect(body.querySelector('details[data-lane="glossary"]')).toBeNull();
    // Rendering lanes is not asking anything of them — a lane invokes on its
    // first expand, never on a repaint.
    expect(sent).toEqual([]);
  });

  // The reason the picked id has to travel: without it the worker re-resolves,
  // gets `ambiguous` a second time, and refuses.
  it("carries the picked candidate id on agent-run", async () => {
    const runs: Array<Record<string, unknown>> = [];
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const msg = message as Record<string, unknown>;
      const kind = String(msg["kind"]);
      if (kind === "resolve") {
        return {
          kind: "resolve",
          ok: true,
          recognition,
          outcome: {
            kind: "ambiguous",
            fetchable: false,
            truncated: false,
            candidates: [
              { id: "a", service: "github", type: "pr", title: "One", url: null },
              { id: "b", service: "github", type: "pr", title: "Two", url: null },
            ],
          },
        };
      }
      if (kind === "related") {
        return { kind: "related", ok: true, items: [] };
      }
      if (kind === "agent-run") {
        runs.push(msg);
        return { kind: "agent-state", lane: msg["lane"], state: { kind: "done", brief: "ok" } };
      }
      return { kind: "agent-state", lane: msg["lane"], state: { kind: "collapsed" } };
    });

    await loadPanel();
    await vi.waitFor(() => {
      expect(headerText()).not.toContain("Checking Nimbus");
    });
    const body = shadow()?.querySelector<HTMLElement>(".nimbus-related__body");
    if (body === null || body === undefined) {
      throw new Error("panel body not found");
    }
    (body.querySelectorAll("button.nimbus-related__candidate")[1] as HTMLButtonElement).click();
    await flush();

    const lane = body.querySelector<HTMLDetailsElement>('details[data-lane="impact"]');
    if (lane === null) {
      throw new Error("impact lane not rendered on the chosen candidate");
    }
    lane.open = true;
    lane.dispatchEvent(new Event("toggle"));
    await flush();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.["itemId"]).toBe("b");
  });

  // The rapid-toggle race the cached-state check alone cannot close: unlike the
  // "done, reopened" test above, the FIRST agent-run here never settles before
  // the second and third toggles fire, so `laneState` is still `collapsed` each
  // time — only the in-flight Set (see `laneInFlight`'s doc comment in
  // panel-in-page.ts) stops the second and third from sending their own
  // agent-run.
  it("guards a double invoke on rapid toggling: three quick toggles send exactly one agent-run", async () => {
    const sent: string[] = [];
    let resolveAgentRun: (value: unknown) => void = () => {};
    harness.sendMessage.mockImplementation((message: unknown) => {
      const kind = (message as { kind?: string }).kind;
      if (kind === "resolve") {
        return Promise.resolve(resolvedResponse);
      }
      if (kind === "related") {
        return Promise.resolve({ kind: "related", ok: true, items: [] });
      }
      if (kind === "agent-run") {
        sent.push(kind);
        // Held open deliberately: nothing has persisted `{kind:"running"}` yet
        // when the second and third toggles below fire.
        return new Promise((resolve) => {
          resolveAgentRun = resolve;
        });
      }
      throw new Error(`unscripted message kind ${String(kind)}`);
    });

    await loadPanel();
    await vi.waitFor(() => {
      expect(headerText()).not.toContain("Checking Nimbus");
    });
    const body = shadow()?.querySelector<HTMLElement>(".nimbus-related__body");
    if (body === null || body === undefined) {
      throw new Error("panel body not found");
    }

    const summary = body.querySelector('details[data-lane="impact"] summary') as HTMLElement;
    // Each click awaits a flush before the next: a real <details> queues its
    // "toggle" event as its own task (jsdom included) rather than firing it
    // synchronously, so three back-to-back clicks with no yield between them
    // would coalesce into a single net "open" toggle — a false pass that
    // would never exercise this guard at all. Awaiting between clicks is what
    // makes each one its own genuine open/close/open transition, matching a
    // real user's three separate clicks — while `resolveAgentRun` is what
    // keeps the first request from ever settling, which is the actual race:
    // `laneState` is still `collapsed` at every one of these three toggles.
    summary.click(); // expand — sends the only agent-run
    await flush();
    summary.click(); // collapse — the request is still in flight
    await flush();
    summary.click(); // expand again — must be ignored, not sent
    await flush();

    expect(sent).toHaveLength(1);

    // Let the held request settle so it doesn't leak into a later test.
    resolveAgentRun({ kind: "agent-state", lane: "impact", state: { kind: "done", brief: "b" } });
    await flush();
  });

  // The other half of the panel's two documented dead-control bugs (see the
  // rate-limited "Try again" button and the related panel's single unreachable
  // entry point): `renderLaneBody`'s onRerun is OPTIONAL so it stays testable
  // without one, but every lane THIS panel renders must supply a real handler —
  // never render one that quietly does nothing when clicked.
  it("wires every rendered lane's Re-run button so it isn't a dead control", async () => {
    const sent: string[] = [];
    const panel = await mountResolvedPanel(sent, {
      impact: { kind: "failed", reason: "unreachable" },
      expert: { kind: "failed", reason: "unreachable" },
    });

    for (const lane of ["impact", "expert"] as const) {
      (panel.querySelector(`details[data-lane="${lane}"] summary`) as HTMLElement).click();
      await flush();
    }
    expect(sent.filter((k) => k === "agent-run")).toHaveLength(2);

    const rerunButtons = Array.from(panel.querySelectorAll("button")).filter(
      (b) => b.textContent === "Re-run",
    );
    expect(rerunButtons).toHaveLength(2);
    for (const button of rerunButtons) {
      (button as HTMLButtonElement).click();
    }
    await flush();

    // A lane rendered WITHOUT a real onRerun handler would leave this at 2 —
    // the click would be a dead control.
    expect(sent.filter((k) => k === "agent-run")).toHaveLength(4);
  });

  // CRITICAL 1 (review round 1): `sendAgentRun` and `pollLane` both resume
  // after an `await` — a real round trip to the worker — with no liveness
  // check, so a response landing after the panel was already torn down would
  // start a BRAND NEW poll timer that `stopAgentPolls` has already run past
  // and can never clear. The whole invoke round trip is the window: expand a
  // lane, close the panel before the invoke answers, then let it answer.
  it("stops polling once the panel is closed — a response landing after teardown starts nothing new", async () => {
    const sent: string[] = [];
    let resolveAgentRun: (value: unknown) => void = () => {};
    harness.sendMessage.mockImplementation((message: unknown) => {
      const kind = (message as { kind?: string }).kind;
      if (kind === "resolve") {
        return Promise.resolve(resolvedResponse);
      }
      if (kind === "related") {
        return Promise.resolve({ kind: "related", ok: true, items: [] });
      }
      if (kind === "agent-run") {
        sent.push(kind);
        // Held open deliberately: this resolves only AFTER the panel below
        // is torn down, reproducing the exact window CRITICAL 1 describes.
        return new Promise((resolve) => {
          resolveAgentRun = resolve;
        });
      }
      if (kind === "agent-state") {
        sent.push(kind);
        // Still running, every time — if teardown failed to stop the loop,
        // this keeps a bad poll alive forever instead of settling it away.
        return Promise.resolve({
          kind: "agent-state",
          lane: "impact",
          state: { kind: "running", runId: "r1" },
        });
      }
      throw new Error(`unscripted message kind ${String(kind)}`);
    });

    await loadPanel();
    await vi.waitFor(() => {
      expect(headerText()).not.toContain("Checking Nimbus");
    });
    const panelBody = shadow()?.querySelector<HTMLElement>(".nimbus-related__body");
    if (panelBody === null || panelBody === undefined) {
      throw new Error("panel body not found");
    }

    (panelBody.querySelector('details[data-lane="impact"] summary') as HTMLElement).click();
    await flush();
    expect(sent).toEqual(["agent-run"]);

    // Close the panel BEFORE the invoke answers — Escape, same as a real user.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host()).toBeNull();

    // Switch to fake timers BEFORE the held response resolves: a buggy
    // `sendAgentRun` would call `scheduleLanePoll` — a `setTimeout` — as part
    // of resolving it. Enabling fake timers only AFTER that point would leave
    // any such timer running on the REAL clock, unreachable by
    // `advanceTimers` below and invisible to this test regardless of whether
    // the bug is present — exactly the false-pass this test exists to avoid.
    vi.useFakeTimers();

    // The invoke answers `running` only NOW, after teardown.
    resolveAgentRun({
      kind: "agent-state",
      lane: "impact",
      state: { kind: "running", runId: "r1" },
    });
    // Not `flush()`: `setTimeout` is fake now, so a real-timer flush would
    // hang. `advanceTimers(0)` drains the same pending microtask chain.
    await advanceTimers(0);

    // A live bug here starts a poll loop on a panel that no longer exists.
    // Advance well past several ticks and assert NOTHING further was sent.
    await advanceTimers(10_000);
    expect(sent).toEqual(["agent-run"]);
  });

  describe("agent-state polling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("polls agent-state while a lane is running and stops when it settles", async () => {
      const sent: string[] = [];
      const panel = await mountResolvedPanel(sent, {}, [
        { kind: "running", runId: "r1" },
        { kind: "running", runId: "r1" },
        { kind: "done", brief: "answered" },
      ]);
      (panel.querySelector('details[data-lane="impact"] summary') as HTMLElement).click();
      await advanceTimers(3_000);

      expect(panel.textContent).toContain("answered");
      const before = sent.filter((k) => k === "agent-state").length;
      await advanceTimers(5_000);
      // Settled: the panel must stop asking. A poll that never stops is a battery bug
      // and keeps the worker alive for no reason.
      expect(sent.filter((k) => k === "agent-state")).toHaveLength(before);
    });

    // This is an END-TO-END regression test for a USER-VISIBLE property, NOT
    // a test of `attachLaneToggle`'s own suppression — see
    // `describe("panel-in-page attachLaneToggle", …)` below for that. Do not
    // read a failure here as proof `attachLaneToggle` broke: TWO independent
    // fixes both prevent this specific outcome today (`attachLaneToggle`'s
    // synthetic-toggle suppression, AND `pollLane` no longer ever storing
    // `collapsed` for an open lane — see review round 2), so this test can
    // no longer tell you WHICH one is doing the work. It is kept anyway
    // because the property itself — repainting an expanded lane must never
    // auto-invoke an agent on its own — is worth holding independently of
    // which layer currently delivers it.
    //
    // Original finding (review round 1, CRITICAL 2): `renderLane`
    // (panel-view.ts) sets `details.open = lane.expanded` on a FRESH element
    // every repaint. Per the HTML spec — confirmed directly in jsdom — that
    // queues a "toggle" task just like a real click, even on a still-detached
    // element, regardless of when a listener is attached relative to it. So
    // repainting an EXPANDED lane always synthesises an open event out of
    // nothing. Left unguarded, once a lane's cached state went stale back to
    // `collapsed` (a resumed run's TTL lapsing, or eviction past
    // MAX_STORED_RUNS — handleAgentState's own `?? {kind:"collapsed"}`
    // fallback), each repaint invoked a brand-new gateway run, WHOSE OWN
    // optimistic+real repaints queued their own synthetic toggle too — a
    // tight, self-sustaining loop from one real click, confirmed directly
    // against the unfixed code (it did not merely grow linearly; it pegged
    // the event loop until the test runner itself gave up). The 3rd scripted
    // answer below is what keeps an unfixed run bounded rather than an actual
    // hang in this suite: `done` is neither `running` (nothing left to poll)
    // nor `collapsed` (`onLaneToggle`'s own guard then blocks any further
    // synthetic re-invoke), so a regression here fails with a clean, finite
    // assertion instead of timing out the whole file.
    it("does not auto-re-invoke when a repaint reflects a lane that has gone stale back to collapsed", async () => {
      const sent: string[] = [];
      const panel = await mountResolvedPanel(sent, {}, [
        { kind: "running", runId: "r1" },
        { kind: "collapsed" },
        { kind: "done", brief: "stop" },
      ]);
      (panel.querySelector('details[data-lane="impact"] summary') as HTMLElement).click();
      // Settle the click's own agent-run (`running`) and its first poll tick,
      // which answers `collapsed` — as if the run's TTL lapsed or its entry
      // was evicted while the panel sat open. The lane is still visually
      // expanded, so that repaint recreates its <details> with open=true
      // again — the HTML spec (see the probe referenced above) queues that as
      // its own toggle task even though nothing was clicked. This needs more
      // than one poll interval of virtual time for that queued task to
      // actually fire — 1_000ms alone is not enough headroom.
      await advanceTimers(2_000);

      expect(sent.filter((k) => k === "agent-run")).toHaveLength(1);
    });

    // Review round 2: the empty render this closes pre-dated CRITICAL 2's own
    // fix above — it just used to be masked, because the (buggy) synthetic
    // re-invoke silently replaced the blank `collapsed` lane with a fresh
    // `running` one before anyone could see it sitting empty. Once the
    // synthetic toggle stopped re-invoking, a lane the user has open that
    // polls back to `collapsed` (TTL lapse, eviction past MAX_STORED_RUNS, or
    // a resolve landing on a different item id — handlers.ts's own
    // `?? {kind:"collapsed"}` fallback) would otherwise sit open and
    // PERMANENTLY BLANK: `renderLaneBody`'s `collapsed` arm is a deliberately
    // empty box (correct for a lane never opened), and polling stops the
    // moment the answer isn't `running`, so nothing would ever repaint it
    // again without an invisible manual collapse+reopen. `pollLane` now
    // stores `failed`/`stale` instead whenever this happens to an OPEN lane —
    // the state that already exists for "this run is gone", with a Re-run
    // button that genuinely works.
    it("shows the stale message with a working Re-run — never a permanently blank lane — when a poll answers collapsed", async () => {
      const sent: string[] = [];
      const panel = await mountResolvedPanel(sent, {}, [
        { kind: "running", runId: "r1" },
        { kind: "collapsed" },
        { kind: "running", runId: "r2" },
      ]);
      (panel.querySelector('details[data-lane="impact"] summary') as HTMLElement).click();
      await advanceTimers(1_000); // fire the poll tick that answers `collapsed`

      expect(panel.textContent).toContain("This run is gone — re-run it.");
      const rerun = Array.from(panel.querySelectorAll("button")).find(
        (b) => b.textContent === "Re-run",
      );
      expect(rerun).toBeDefined();
      // No auto re-invoke — the one agent-run so far is the user's original
      // click, not something the stale-recovery repaint fired on its own.
      expect(sent.filter((k) => k === "agent-run")).toHaveLength(1);

      // The button is not a dead control either: handleAgentRun does not
      // short-circuit on a cached `failed` state, so this genuinely re-invokes.
      (rerun as HTMLButtonElement).click();
      await advanceTimers(0);
      expect(sent.filter((k) => k === "agent-run")).toHaveLength(2);
    });

    // CRITICAL 1's other half: `pollLane` resumes after its OWN await, not
    // just `sendAgentRun`'s. A poll already in flight when the panel closes
    // must not reschedule once its answer lands late, either.
    it("also stops a poll already in flight when the panel closes before it answers", async () => {
      const sent: string[] = [];
      let resolvePoll: (value: unknown) => void = () => {};
      let pollCalls = 0;
      harness.sendMessage.mockImplementation((message: unknown) => {
        const kind = (message as { kind?: string }).kind;
        if (kind === "resolve") {
          return Promise.resolve(resolvedResponse);
        }
        if (kind === "related") {
          return Promise.resolve({ kind: "related", ok: true, items: [] });
        }
        if (kind === "agent-run") {
          sent.push(kind);
          return Promise.resolve({
            kind: "agent-state",
            lane: "impact",
            state: { kind: "running", runId: "r1" },
          });
        }
        if (kind === "agent-state") {
          sent.push(kind);
          pollCalls += 1;
          if (pollCalls === 1) {
            // Held open: the panel closes WHILE this specific poll is in
            // flight, reproducing CRITICAL 1's window on the poll path.
            return new Promise((resolve) => {
              resolvePoll = resolve;
            });
          }
          // Only reached if a live bug reschedules a second poll.
          return Promise.resolve({
            kind: "agent-state",
            lane: "impact",
            state: { kind: "running", runId: "r1" },
          });
        }
        throw new Error(`unscripted message kind ${String(kind)}`);
      });

      await loadPanel();
      await vi.waitFor(() => {
        expect(headerText()).not.toContain("Checking Nimbus");
      });
      const panelBody = shadow()?.querySelector<HTMLElement>(".nimbus-related__body");
      if (panelBody === null || panelBody === undefined) {
        throw new Error("panel body not found");
      }

      (panelBody.querySelector('details[data-lane="impact"] summary') as HTMLElement).click();
      await advanceTimers(0); // settle agent-run (`running`), schedules the first poll
      expect(sent).toEqual(["agent-run"]);

      await advanceTimers(1_000); // fire the first poll tick — sent, held open
      expect(sent).toEqual(["agent-run", "agent-state"]);

      // Close the panel WHILE this poll is in flight.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(host()).toBeNull();

      // Let the held poll response land, now that the panel is gone.
      resolvePoll({ kind: "agent-state", lane: "impact", state: { kind: "running", runId: "r1" } });
      await advanceTimers(0);

      // A live bug reschedules another poll here. Advance well past several
      // ticks and confirm nothing further was sent.
      await advanceTimers(10_000);
      expect(sent).toEqual(["agent-run", "agent-state"]);
    });
  });
});

// Review round 3: `attachLaneToggle`'s own invariant, pinned one level down
// from the full panel — no panel state, message scripting, or poll. The
// end-to-end test above ("does not auto-re-invoke when a repaint reflects a
// lane that has gone stale back to collapsed") no longer discriminates this
// function in isolation, since a second, independent fix (pollLane never
// storing `collapsed` for an open lane) now also prevents that outcome. THIS
// describe block is what actually exercises `attachLaneToggle`'s own
// contract: swallow exactly the first toggle that just repeats the value the
// element was created with, and deliver every other one.
describe("panel-in-page attachLaneToggle", () => {
  /** `panel-in-page.ts` runs mount() as a module-level side effect on import
   *  (see the file's own docblock) — there is no way to import it without
   *  that side effect firing. `attachLaneToggle` itself needs none of that
   *  side effect's state: it is a pure DOM-level helper, so the mounted panel
   *  this leaves behind is inert clutter, cleaned up like every other test's
   *  by the file's global `afterEach`. */
  async function loadAttachLaneToggle(): Promise<
    (el: HTMLDetailsElement, onToggle: (open: boolean) => void) => void
  > {
    vi.resetModules();
    const mod = (await import(MODULE_PATH)) as {
      attachLaneToggle: (el: HTMLDetailsElement, onToggle: (open: boolean) => void) => void;
    };
    return mod.attachLaneToggle;
  }

  it("swallows a toggle event whose open value matches what the element started with — a programmatic open is not a user action", async () => {
    const attachLaneToggle = await loadAttachLaneToggle();
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    details.append(summary);
    // As renderLane does for an already-expanded lane: `open` is set on a
    // FRESH element BEFORE any listener is attached.
    details.open = true;
    document.body.append(details);

    const calls: boolean[] = [];
    attachLaneToggle(details, (open) => calls.push(open));

    // Let the HTML-spec-queued "toggle" task fire — confirmed directly in
    // jsdom that setting `open` on a fresh element queues this task even
    // though nothing was clicked, and even on an element not yet attached to
    // the document at the moment `open` was set.
    await flush();

    expect(calls).toEqual([]);
  });

  it("still delivers a genuine second toggle on the same element — the guard does not just swallow everything", async () => {
    const attachLaneToggle = await loadAttachLaneToggle();
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    details.append(summary);
    details.open = true;
    document.body.append(details);

    const calls: boolean[] = [];
    attachLaneToggle(details, (open) => calls.push(open));
    await flush(); // the synthetic one, swallowed — see the test above

    summary.click(); // a REAL user click — flips `open` to a DIFFERENT value
    await flush();

    // A guard that simply swallowed every event would leave this empty too —
    // this is the positive control that proves it does not.
    expect(calls).toEqual([false]);
  });

  it("delivers the very first toggle when the element was created collapsed — a real first expand is never mistaken for a synthetic one", async () => {
    const attachLaneToggle = await loadAttachLaneToggle();
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    details.append(summary);
    // Left at the default `false` — no attribute change happens, so no
    // synthetic task is ever queued for this element in the first place.
    document.body.append(details);

    const calls: boolean[] = [];
    attachLaneToggle(details, (open) => calls.push(open));

    summary.click(); // a REAL first expand
    await flush();

    expect(calls).toEqual([true]);
  });
});

describe("the panel pins the page it was opened on", () => {
  const RESOLVED = {
    kind: "resolve",
    ok: true,
    recognition: {
      ok: true,
      product: "github",
      kind: "pr",
      label: "GitHub PR",
      ref: "acme/web #482",
      resolveUrl: "https://github.com/acme/web/pull/482",
    },
    outcome: {
      kind: "found",
      matchKind: "exact",
      item: {
        id: "it-1",
        service: "github",
        type: "pr",
        title: "Add retry budget",
        url: "https://github.com/acme/web/pull/482",
        modifiedAt: Date.now(),
      },
    },
  };

  it("sends the pinned url after a client-side navigation, not the live one", async () => {
    window.history.pushState({}, "", "/acme/web/pull/482");
    const pinned = window.location.href;
    const root = await mountPanelWithResolve(RESOLVED);

    window.history.pushState({}, "", "/acme/web/pull/517");
    expect(window.location.href).not.toBe(pinned);

    const lane = root.querySelector<HTMLDetailsElement>('[data-lane="impact"]');
    expect(lane).not.toBeNull();
    if (lane !== null) {
      lane.open = true;
    }
    lane?.dispatchEvent(new Event("toggle"));
    await flush();

    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent-run", lane: "impact", pageUrl: pinned }),
    );
  });
});

describe("lanes appear only where they can answer", () => {
  function resolved(product: string, kind: string, ref: string): unknown {
    return {
      kind: "resolve",
      ok: true,
      recognition: {
        ok: true,
        product,
        kind,
        label: `${product} ${kind}`,
        ref,
        resolveUrl: "https://example.test/x",
      },
      outcome: {
        kind: "found",
        matchKind: "exact",
        item: {
          id: "it-1",
          service: product,
          type: kind,
          title: "An indexed item",
          url: "https://example.test/x",
          modifiedAt: Date.now(),
        },
      },
    };
  }

  it("offers both lanes on a resolved pull request", async () => {
    const root = await mountPanelWithResolve(resolved("github", "pr", "acme/web #482"));
    expect(root.querySelector('[data-lane="impact"]')).not.toBeNull();
    expect(root.querySelector('[data-lane="expert"]')).not.toBeNull();
  });

  // Before LANE_SURFACES these appeared here too, and expanding one handed the
  // issue/build URL to agents.impact as its `fileOrPrUrl`.
  it("offers no agent lane on a resolved Jira issue", async () => {
    const root = await mountPanelWithResolve(resolved("jira", "issue", "ABC-12"));
    expect(root.querySelector('[data-lane="impact"]')).toBeNull();
    expect(root.querySelector('[data-lane="expert"]')).toBeNull();
    // The Related lane is unaffected — it works in every header state.
    expect(root.querySelector('[data-lane="related"]')).not.toBeNull();
  });

  it("offers no agent lane on a resolved Jenkins build", async () => {
    const root = await mountPanelWithResolve(resolved("jenkins", "build", "web #482"));
    expect(root.querySelector('[data-lane="impact"]')).toBeNull();
    expect(root.querySelector('[data-lane="expert"]')).toBeNull();
  });
});

describe("following a client-side navigation", () => {
  const PR482 = {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref: "acme/web #482",
    resolveUrl: "https://github.com/acme/web/pull/482",
  };
  const PR517 = {
    ...PR482,
    ref: "acme/web #517",
    resolveUrl: "https://github.com/acme/web/pull/517",
  };

  function resolvedFor(recognition: unknown): unknown {
    return {
      kind: "resolve",
      ok: true,
      recognition,
      outcome: {
        kind: "found",
        matchKind: "exact",
        item: {
          id: "it-1",
          service: "github",
          type: "pr",
          title: "Add retry budget",
          url: "https://github.com/acme/web/pull/482",
          modifiedAt: Date.now(),
        },
      },
    };
  }

  /** Mounts on #482 with `recognise` answered from a URL→recognition table. */
  async function mountWatching(table: Record<string, unknown>): Promise<ShadowRoot> {
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string; pageUrl?: string };
      if (m.kind === "resolve") return resolvedFor(PR482);
      if (m.kind === "recognise") {
        const hit = Object.entries(table).find(([path]) => (m.pageUrl ?? "").includes(path));
        return {
          kind: "recognition",
          ok: true,
          recognition: hit?.[1] ?? { ok: false, reason: "unrecognised-path" },
        };
      }
      return { kind: "related", ok: true, items: [] };
    });
    window.history.pushState({}, "", "/acme/web/pull/482");
    await loadPanel();
    await vi.waitFor(() => expect(headerText()).not.toContain("Checking Nimbus"));
    const root = shadow();
    if (root === null) throw new Error("panel shadow root not found");
    return root;
  }

  function notice(root: ShadowRoot): Element | null {
    return root.querySelector(".nimbus-related__navaway");
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says nothing when only the sub-tab changed", async () => {
    const root = await mountWatching({ "/pull/482": PR482 });
    window.history.pushState({}, "", "/acme/web/pull/482/files");
    await advanceTimers(600);
    expect(notice(root)).toBeNull();
  });

  it("names the pinned item once the tab shows a different one", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    expect(notice(root)?.textContent).toContain("acme/web #482");
  });

  it("clears itself when the user comes back, with no re-read", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    expect(notice(root)).not.toBeNull();
    window.history.pushState({}, "", "/acme/web/pull/482/files");
    await advanceTimers(600);
    expect(notice(root)).toBeNull();
  });

  it("checks nothing while the tab is hidden, and immediately once it is visible", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(2000);
    expect(notice(root)).toBeNull();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await advanceTimers(0); // not flush() -- fake timers are active here, same reasoning as above
    expect(notice(root)).not.toBeNull();
  });

  // Property 1: `paint()` is response-driven, never tick-driven. A tick whose
  // `recognise` answer leaves `navAway` unchanged (same item, only the sub-tab
  // differs) must not repaint at all — only an actual flip may.
  it("paints on a navAway flip, and only on a flip", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    const body = root.querySelector<HTMLElement>(".nimbus-related__body");
    if (body === null) throw new Error("panel body not found");
    const replaceChildren = vi.spyOn(body, "replaceChildren");
    replaceChildren.mockClear(); // drop the mount-time paints; count only from here

    // Same item, only the sub-tab changed: checkNavigation's own
    // `away === navAway` (false === false) returns before paint() runs.
    window.history.pushState({}, "", "/acme/web/pull/482/files");
    await advanceTimers(600);
    expect(replaceChildren).not.toHaveBeenCalled();

    // A genuine identity change is the one tick that must paint — exactly once.
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    expect(replaceChildren).toHaveBeenCalledTimes(1);
  });

  // The ordering guard. A -> B(same item) -> C(different item) with B's answer
  // deliberately delivered LAST must leave the notice correct for C.
  it("ignores a stale recognition answer that lands after a newer one", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    // Matches the file's own `resolveAgentRun`/`resolvePoll` pattern above: a
    // no-op initial value, not `null` — a `let` reassigned only inside a
    // nested Promise executor narrows to `never` at a later read otherwise
    // (a TypeScript control-flow limitation, not a runtime concern).
    let releaseStale: () => void = () => {};
    // Without this, the test can pass vacuously: if the "/files" branch below
    // were never reached (e.g. a regression that skips sending it, or coalesces
    // it away), `releaseStale` would stay the initial no-op and the test would
    // still see the notice stand — for the wrong reason.
    let staleBranchEntered = false;
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string; pageUrl?: string };
      if (m.kind !== "recognise") return { kind: "related", ok: true, items: [] };
      if ((m.pageUrl ?? "").includes("/files")) {
        staleBranchEntered = true;
        await new Promise<void>((resolve) => {
          releaseStale = resolve;
        });
        return { kind: "recognition", ok: true, recognition: PR482 };
      }
      return { kind: "recognition", ok: true, recognition: PR517 };
    });
    window.history.pushState({}, "", "/acme/web/pull/482/files");
    await advanceTimers(600);
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    expect(staleBranchEntered).toBe(true);
    expect(notice(root)).not.toBeNull();
    releaseStale();
    await advanceTimers(0); // not flush() -- fake timers are active here, same reasoning as above
    expect(notice(root)).not.toBeNull();
  });

  // The false-notice path the response envelope exists to prevent: a storage
  // failure in the worker must not read as "you navigated away" on a page the
  // user never left.
  it("does not raise the notice when the worker could not classify the url", async () => {
    const root = await mountWatching({ "/pull/482": PR482 });
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string };
      if (m.kind === "recognise") return { kind: "recognition", ok: false, reason: "server_error" };
      return { kind: "related", ok: true, items: [] };
    });
    // Same item, only the sub-tab changed — so even a successful check would not
    // notify. The failure arm must not notify either.
    window.history.pushState({}, "", "/acme/web/pull/482/files");
    await advanceTimers(600);
    expect(notice(root)).toBeNull();
  });

  // Every OTHER test in this file mounts via `mountWatching`, which awaits the
  // header settling past "Checking Nimbus…" before doing anything else — so
  // none of them ever navigates while `pinnedRecognition` is still null. This
  // one does, deliberately: the interval starts at `createPanel`, before the
  // first resolve is even sent, and `reread()` nulls the pin again for its own
  // whole round trip — both are real windows, not edge cases.
  it("does not permanently suppress the notice for a navigation that lands before the pin exists", async () => {
    let resolveHeader: (value: unknown) => void = () => {};
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string; pageUrl?: string };
      if (m.kind === "resolve") {
        return await new Promise((resolve) => {
          resolveHeader = resolve;
        });
      }
      if (m.kind === "recognise") {
        return {
          kind: "recognition",
          ok: true,
          recognition: (m.pageUrl ?? "").includes("/pull/517") ? PR517 : PR482,
        };
      }
      return { kind: "related", ok: true, items: [] };
    });
    window.history.pushState({}, "", "/acme/web/pull/482");
    await loadPanel();
    expect(headerText()).toContain("Checking Nimbus");

    // Navigate away WHILE the pin does not exist yet. Without the fix, this
    // tick marks `lastCheckedUrl` as "/pull/517" and never rolls it back
    // (there is no pin to compare against, so `away` is trivially false) —
    // burning the only check this URL will ever get.
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);

    // Let the header resolve now, for the originally pinned page (#482).
    resolveHeader(resolvedFor(PR482));
    await advanceTimers(0); // not flush() -- fake timers are active here, same reasoning as above
    await vi.waitFor(() => expect(headerText()).not.toContain("Checking Nimbus"));
    const root = shadow();
    if (root === null) throw new Error("panel shadow root not found");

    // The tab is still on #517 and a pin now exists — this tick must still be
    // free to notice it. Without the fix, `lastCheckedUrl` already equals the
    // current URL from the burned check above, so this tick is a no-op and the
    // notice never appears.
    await advanceTimers(600);
    expect(notice(root)?.textContent).toContain("acme/web #482");
  });

  it("re-reads on request: new header, lanes reset, nothing running", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    const impactLane = (): HTMLDetailsElement | null =>
      root.querySelector<HTMLDetailsElement>('[data-lane="impact"]');

    // Expand impact on the PINNED item before the re-read. Without this, the
    // "lanes reset" assertion below passes vacuously — a lane that was never
    // open stays "closed" whether or not reread() actually resets anything.
    const beforeReread = impactLane();
    if (beforeReread !== null) {
      beforeReread.open = true;
    }
    beforeReread?.dispatchEvent(new Event("toggle"));
    await advanceTimers(0); // not flush() -- fake timers are active here, same reasoning as above
    expect(impactLane()?.open).toBe(true);

    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);

    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string };
      if (m.kind === "resolve") return resolvedFor(PR517);
      if (m.kind === "recognise") return { kind: "recognition", ok: true, recognition: PR517 };
      return { kind: "related", ok: true, items: [] };
    });
    const callsBeforeReread = harness.sendMessage.mock.calls.length;
    root.querySelector<HTMLButtonElement>(".nimbus-related__navaway button")?.click();
    await advanceTimers(0); // not flush() -- fake timers are active here, same reasoning as above

    expect(notice(root)).toBeNull();
    expect(headerText()).toContain("acme/web #517");
    // Scoped to calls made AFTER the re-read click: the pre-reread expand above
    // genuinely sent its own "agent-run", so an unscoped `not.toHaveBeenCalledWith`
    // would fail for the wrong reason. What "nothing running" actually claims is
    // that the re-read itself starts no run on the new item.
    const sentAfterReread = harness.sendMessage.mock.calls
      .slice(callsBeforeReread)
      .map((call) => (call[0] as { kind?: string }).kind);
    expect(sentAfterReread).not.toContain("agent-run");
    expect(impactLane()?.open).toBe(false);
  });

  // A navigation check has no button and no error state, so the next tick is the
  // only recovery there is — a failed check must not be recorded as a done one.
  it("re-checks the same url after the worker was briefly unreachable", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    let failOnce = true;
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string };
      if (m.kind !== "recognise") return { kind: "related", ok: true, items: [] };
      if (failOnce) {
        failOnce = false;
        throw new Error("worker unreachable");
      }
      return { kind: "recognition", ok: true, recognition: PR517 };
    });
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    expect(notice(root)).toBeNull();
    await advanceTimers(600);
    expect(notice(root)?.textContent).toContain("acme/web #482");
  });

  // IMPORTANT 1 regression: `ok: false` means the worker could not classify the
  // URL — a check that reached no conclusion — not "nothing changed here". The
  // existing "worker unreachable" test above navigates to the SAME item, so it
  // cannot tell a burned check from a correct one: no notice is due either way.
  // This one navigates to a DIFFERENT item, so a bug here is directly
  // observable: if the first (ok:false) check is wrongly treated as completed,
  // `lastCheckedUrl` stays marked at the new URL forever and the second,
  // real answer is never even asked for.
  it("re-checks the same url after the worker answered ok:false, and still raises the notice", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    let failOnce = true;
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string };
      if (m.kind !== "recognise") return { kind: "related", ok: true, items: [] };
      if (failOnce) {
        failOnce = false;
        return { kind: "recognition", ok: false, reason: "server_error" };
      }
      return { kind: "recognition", ok: true, recognition: PR517 };
    });
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    expect(notice(root)).toBeNull();
    await advanceTimers(600);
    expect(notice(root)?.textContent).toContain("acme/web #482");
  });

  // clearLanePoll cancels a PENDING timer; only the generation guard can stop a
  // poll whose answer is already in flight from starting a fresh loop for the item
  // the panel has stopped describing.
  it("a poll in flight during a re-read neither repaints nor reschedules", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    // No-op initial value, not `null` — see the identical note on `releaseStale`
    // above.
    let releasePoll: (value: unknown) => void = () => {};
    const kinds: string[] = [];
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string };
      kinds.push(m.kind ?? "");
      if (m.kind === "resolve") return resolvedFor(PR517);
      if (m.kind === "recognise") return { kind: "recognition", ok: true, recognition: PR517 };
      if (m.kind === "agent-run") {
        return { kind: "agent-state", lane: "impact", state: { kind: "running", runId: "r1" } };
      }
      if (m.kind === "agent-state") {
        return await new Promise((resolve) => {
          releasePoll = resolve;
        });
      }
      return { kind: "related", ok: true, items: [] };
    });

    // Start impact on the pinned PR, then let its first poll go out and hang.
    // `el.open = true` BEFORE dispatching: attachLaneToggle swallows a toggle
    // that merely repeats the element's own starting value (see its doc
    // comment) — this is what makes the dispatch below a genuine expand.
    const impactLane = root.querySelector<HTMLDetailsElement>('[data-lane="impact"]');
    if (impactLane !== null) {
      impactLane.open = true;
    }
    impactLane?.dispatchEvent(new Event("toggle"));
    await advanceTimers(0); // not flush() -- fake timers are active here, same reasoning as above
    await advanceTimers(1200); // past AGENT_POLL_MS (1000) — the poll is now awaiting
    expect(kinds).toContain("agent-state");

    // Re-read while that poll is still in flight.
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    root.querySelector<HTMLButtonElement>(".nimbus-related__navaway button")?.click();
    await advanceTimers(0); // not flush() -- fake timers are active here, same reasoning as above
    const afterReread = kinds.length;

    releasePoll({ kind: "agent-state", lane: "impact", state: { kind: "running", runId: "r1" } });
    await advanceTimers(3000);
    expect(kinds.slice(afterReread).filter((k) => k === "agent-state")).toEqual([]);
    expect(headerText()).toContain("acme/web #517");
  });

  // Task 6 proves the view renders the generic copy for `pinnedRef: null`; this
  // proves the panel actually produces null when the pinned page had no ref.
  it("uses the generic copy when the pinned page was unrecognised", async () => {
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string; pageUrl?: string };
      if (m.kind === "resolve") {
        return {
          kind: "resolve",
          ok: true,
          recognition: { ok: false, reason: "unrecognised-path" },
          outcome: { kind: "not-indexed", fetchable: false },
        };
      }
      if (m.kind === "recognise") {
        return {
          kind: "recognition",
          ok: true,
          recognition: (m.pageUrl ?? "").includes("/pull/482")
            ? PR482
            : { ok: false, reason: "unrecognised-path" },
        };
      }
      return { kind: "related", ok: true, items: [] };
    });
    window.history.pushState({}, "", "/acme/web");
    await loadPanel();
    await vi.waitFor(() => expect(headerText()).not.toContain("Checking Nimbus"));
    const root = shadow();
    if (root === null) throw new Error("panel shadow root not found");

    window.history.pushState({}, "", "/acme/web/pull/482");
    await advanceTimers(600);
    expect(notice(root)?.textContent).toContain(
      "This panel is still about the page you opened it on.",
    );
  });

  it("sends the NEW pinned url after a re-read", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    const newPin = window.location.href;

    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string };
      if (m.kind === "resolve") return resolvedFor(PR517);
      if (m.kind === "recognise") return { kind: "recognition", ok: true, recognition: PR517 };
      if (m.kind === "agent-run")
        return { kind: "agent-state", lane: "impact", state: { kind: "done", brief: "b" } };
      return { kind: "related", ok: true, items: [] };
    });
    root.querySelector<HTMLButtonElement>(".nimbus-related__navaway button")?.click();
    await advanceTimers(0); // not flush() -- fake timers are active here, same reasoning as above
    // `el.open = true` BEFORE dispatching — see the identical note above.
    const impactLane = root.querySelector<HTMLDetailsElement>('[data-lane="impact"]');
    if (impactLane !== null) {
      impactLane.open = true;
    }
    impactLane?.dispatchEvent(new Event("toggle"));
    await advanceTimers(0); // not flush() -- fake timers are active here, same reasoning as above

    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent-run", pageUrl: newPin }),
    );
  });

  // IMPORTANT 2: the design spec's reset test promised coverage of "lane state,
  // `chosen`, `fetchState` and `fetchSent`" — the shipped tests cover only lane
  // state and the header. If `reread()` ever dropped `fetchState = null`,
  // `paint()`'s `fetchState !== null` precedence would keep showing the OLD
  // page's fetch-in-progress header over a panel now pinned to a different
  // item; if it dropped `fetchSent = false`, `headerFrom` would force
  // `fetchable: false` on every resolve for the rest of the panel's life.
  // Neither has a dedicated test today.
  it("reread resets fetchState and fetchSent — the new page's own miss offers a fresh Fetch button", async () => {
    const missPR482 = {
      kind: "resolve",
      ok: true,
      recognition: PR482,
      outcome: { kind: "not-indexed", fetchable: true },
    };
    const missPR517 = {
      kind: "resolve",
      ok: true,
      recognition: PR517,
      outcome: { kind: "not-indexed", fetchable: true },
    };
    const timedOutFetch = {
      kind: "fetch",
      ok: false,
      recognition: PR482,
      reason: "timeout",
    };

    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string; pageUrl?: string };
      if (m.kind === "resolve") {
        return (m.pageUrl ?? "").includes("/pull/517") ? missPR517 : missPR482;
      }
      if (m.kind === "fetch") {
        return timedOutFetch;
      }
      if (m.kind === "recognise") {
        return {
          kind: "recognition",
          ok: true,
          recognition: (m.pageUrl ?? "").includes("/pull/517") ? PR517 : PR482,
        };
      }
      return { kind: "related", ok: true, items: [] };
    });

    window.history.pushState({}, "", "/acme/web/pull/482");
    await loadPanel();
    await vi.waitFor(() => expect(headerText()).not.toContain("Checking Nimbus"));
    const root = shadow();
    if (root === null) throw new Error("panel shadow root not found");

    // Fetch on the pinned page — the first click opens the confirm preview,
    // the second (Send) confirms it. It times out — `fetchState` latches to
    // `fetch-retry`/`still-working` and `fetchSent` latches `true`, per
    // `sendFetch`'s own doc comment, for the life of THIS page.
    clickFetch(root);
    await advanceTimers(0);
    clickPreviewSend(root);
    await advanceTimers(0);
    expect(headerText()).toContain("Still working");

    // Navigate to a different item and re-read.
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    root.querySelector<HTMLButtonElement>(".nimbus-related__navaway button")?.click();
    await advanceTimers(0);

    // (a) the header describes the NEW item and shows no fetch-in-progress
    // text — a stale `fetchState` would keep "Still working" (or "Fetching…")
    // as the header of a panel now pinned to a different item entirely.
    expect(headerText()).toContain("acme/web #517");
    expect(headerText()).not.toContain("Still working");
    expect(headerText()).not.toContain("Fetching");

    // (b) the Fetch affordance is available again for the new page — a stale
    // `fetchSent` would force `fetchable: false` on every resolve for the rest
    // of the panel's life.
    expect(
      root.querySelector<HTMLButtonElement>(".nimbus-related__header-state button")?.textContent,
    ).toBe("Fetch this from GitHub");
  });
});

describe("the dashboard panel", () => {
  const HOME_RESOLVE = {
    kind: "resolve",
    ok: true,
    recognition: {
      ok: true,
      product: "github",
      kind: "home",
      label: "GitHub dashboard",
      ref: "",
      resolveUrl: "https://github.com/",
    },
    outcome: { kind: "not-indexed", fetchable: false },
  };

  const PR_RESOLVE = {
    kind: "resolve",
    ok: true,
    recognition: {
      ok: true,
      product: "github",
      kind: "pr",
      label: "GitHub PR",
      ref: "acme/web #482",
      resolveUrl: "https://github.com/acme/web/pull/482",
    },
    outcome: {
      kind: "found",
      matchKind: "exact",
      item: {
        id: "github:482",
        service: "github",
        type: "pr",
        title: "Add the thing",
        url: "https://github.com/acme/web/pull/482",
        modifiedAt: 1_800_000_000_000,
      },
    },
  };

  const laneIds = (root: ShadowRoot): (string | null)[] =>
    [...root.querySelectorAll("details[data-lane]")].map((el) => el.getAttribute("data-lane"));

  it("renders the service header and the three service lanes", async () => {
    const root = await mountPanelWithResolve(HOME_RESOLVE);
    expect(headerText()).toContain("GitHub dashboard");
    expect(laneIds(root)).toEqual(["catchup", "decisions", "ownership"]);
  });

  it("shows no related lane on a dashboard", async () => {
    const root = await mountPanelWithResolve(HOME_RESOLVE);
    expect(root.querySelector('details[data-lane="related"]')).toBeNull();
  });

  it("still shows related and the item lanes on a pull request", async () => {
    const root = await mountPanelWithResolve(PR_RESOLVE);
    expect(laneIds(root)).toEqual(["related", "impact", "expert"]);
  });
});

describe("the glossary lane", () => {
  const recognition = {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref: "acme/web #1",
    resolveUrl: "https://github.com/acme/web/pull/1",
  } as const;

  const PR_RESOLVE = {
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
        modifiedAt: 1_700_000_000_000,
      },
    },
  };

  const UNRECOGNISED_RESOLVE = {
    kind: "resolve",
    ok: true,
    recognition: { ok: false, reason: "unknown-host" },
  };

  /** Put a real selection on the page, the way a user would. */
  function selectText(text: string): void {
    const p = document.createElement("p");
    p.textContent = text;
    document.body.append(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  /** Hand a selection to the mounted panel, exactly as the service worker's
   *  `deliverSelection` does — by calling the hook on the host element. */
  function deliver(text: string, intent: "define" | "related"): void {
    const el = document.getElementById(HOST_ID) as
      | (HTMLElement & { __nimbusSelection?: (s: unknown) => void })
      | null;
    if (el?.__nimbusSelection === undefined) {
      throw new Error("no selection hook on the panel host");
    }
    el.__nimbusSelection({ text, intent });
  }

  function lane(root: ShadowRoot): HTMLDetailsElement | null {
    return root.querySelector<HTMLDetailsElement>('details[data-lane="glossary"]');
  }

  /** Mounts with a caller-supplied message script. NOT `mountPanelWithResolve`,
   *  which installs its own implementation and would silently replace one set
   *  here — every test below needs to script `agent-run` itself. */
  async function mountWith(
    impl: (message: Record<string, unknown>) => unknown,
  ): Promise<ShadowRoot> {
    harness.sendMessage.mockImplementation(async (message: unknown) =>
      impl(message as Record<string, unknown>),
    );
    await loadPanel();
    await vi.waitFor(() => {
      expect(headerText()).not.toContain("Checking Nimbus");
    });
    const root = shadow();
    if (root === null) {
      throw new Error("no panel");
    }
    return root;
  }

  it("does not exist until a term does", async () => {
    const root = await mountPanelWithResolve(PR_RESOLVE);
    expect(lane(root)).toBeNull();
  });

  it("appears titled with the term when a selection is live at mount, and asks nothing", async () => {
    selectText("  idempotency   key ");
    const sent: string[] = [];
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const kind = String((message as { kind?: string }).kind);
      sent.push(kind);
      return kind === "resolve" ? PR_RESOLVE : { kind: "related", ok: true, items: [] };
    });
    await loadPanel();
    await vi.waitFor(() => {
      expect(headerText()).not.toContain("Checking Nimbus");
    });
    const root = shadow();
    if (root === null) {
      throw new Error("no panel");
    }
    // Normalised on the way in — the title is the term, not the raw drag.
    expect(lane(root)?.querySelector("summary")?.textContent).toContain("idempotency key");
    // The mount snapshot is the convenience path: it makes the term visible,
    // it does not ask a question nobody asked.
    expect(sent).not.toContain("agent-run");
  });

  it("runs on Define, carrying the term", async () => {
    const runs: Array<Record<string, unknown>> = [];
    const root = await mountWith((msg) => {
      const kind = String(msg["kind"]);
      if (kind === "resolve") {
        return PR_RESOLVE;
      }
      if (kind === "related") {
        return { kind: "related", ok: true, items: [] };
      }
      if (kind === "agent-run") {
        runs.push(msg);
        return {
          kind: "agent-state",
          lane: "glossary",
          state: { kind: "done", brief: "A token…" },
        };
      }
      return { kind: "agent-state", lane: msg["lane"], state: { kind: "collapsed" } };
    });
    deliver("idempotency key", "define");
    await flush();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ lane: "glossary", term: "idempotency key" });
    // Expanded and answered, because the user asked a question.
    expect(lane(root)?.open).toBe(true);
    expect(root.textContent).toContain("A token…");
  });

  it("re-runs related on the selection without spending an agent run", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const root = await mountWith((msg) => {
      sent.push(msg);
      return String(msg["kind"]) === "resolve"
        ? PR_RESOLVE
        : { kind: "related", ok: true, items: [] };
    });
    deliver("blast radius", "related");
    await flush();

    const related = sent.filter((m) => m["kind"] === "related");
    expect(related.at(-1)?.["selection"]).toBe("blast radius");
    expect(sent.some((m) => m["kind"] === "agent-run")).toBe(false);
    // The term is visible to the panel now, so the lane is there — collapsed,
    // and unasked.
    expect(lane(root)).not.toBeNull();
    expect(lane(root)?.open).toBe(false);
  });

  // Refused, never truncated: answering about the first 128 characters of a
  // 3,000-character selection would look exactly like the feature working.
  it("refuses a passage in the lane instead of sending it", async () => {
    const sent: string[] = [];
    const root = await mountWith((msg) => {
      const kind = String(msg["kind"]);
      sent.push(kind);
      return kind === "resolve" ? PR_RESOLVE : { kind: "related", ok: true, items: [] };
    });
    deliver("x".repeat(400), "define");
    await flush();

    expect(sent).not.toContain("agent-run");
    expect(root.textContent).toContain("That's a passage, not a term");
    // No term to name, so the lane falls back to its generic title.
    expect(lane(root)?.querySelector("summary")?.textContent).toContain("Definition");
  });

  // The decision this slice turns on: glossary's input is not the page, so no
  // property of the page can withhold it.
  it("works on a page the recogniser rejects", async () => {
    const runs: Array<Record<string, unknown>> = [];
    const root = await mountWith((msg) => {
      const kind = String(msg["kind"]);
      if (kind === "resolve") {
        return UNRECOGNISED_RESOLVE;
      }
      if (kind === "related") {
        return { kind: "related", ok: true, items: [] };
      }
      if (kind === "agent-run") {
        runs.push(msg);
        return { kind: "agent-state", lane: "glossary", state: { kind: "done", brief: "defined" } };
      }
      return { kind: "agent-state", lane: msg["lane"], state: { kind: "collapsed" } };
    });
    deliver("runbook", "define");
    await flush();

    expect(lane(root)).not.toBeNull();
    expect(runs[0]).toMatchObject({ lane: "glossary", term: "runbook" });
    // And still no page lanes, which DO depend on the page.
    expect(root.querySelector('details[data-lane="impact"]')).toBeNull();
  });
});
