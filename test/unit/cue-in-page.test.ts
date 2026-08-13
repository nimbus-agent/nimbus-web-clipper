// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CueState } from "../../src/shared/types.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

const STATE: CueState = { label: "GitHub PR", ref: "acme/web #482" };

interface CueGlobal {
  __nimbusCue?: (state: CueState) => void;
}

let harness: ChromeHarness;

async function loadCue(): Promise<(state: CueState) => void> {
  vi.resetModules();
  await import("../../src/panel/cue-in-page.ts");
  const fn = (globalThis as CueGlobal).__nimbusCue;
  if (fn === undefined) {
    throw new Error("cue script did not define __nimbusCue");
  }
  return fn;
}

function cueEl(): Element | null {
  const host = document.getElementById("nimbus-cue-host");
  return host?.shadowRoot?.querySelector(".nimbus-cue") ?? null;
}

/**
 * `isTrusted` is an [Unforgeable] DOM property: jsdom (like real browsers)
 * defines it as non-configurable on every event instance, and its own
 * `dispatchEvent` unconditionally stamps `isTrusted: false` on anything
 * script hands it — so there is no way to make a *dispatched* event trusted
 * from test code. Instead we capture the actual listener cue-in-page.ts
 * registers (via this addEventListener spy) and invoke it directly with a
 * hand-built event carrying `isTrusted: true`, which is exactly what the
 * handler under test reads.
 */
const clickListeners: Array<{ target: EventTarget; listener: EventListener }> = [];

function trustedClick(actionEl: Element): void {
  const root = cueEl();
  const entry = [...clickListeners].reverse().find((c) => c.target === root);
  if (entry === undefined) {
    throw new Error("no click listener captured for the mounted cue");
  }
  entry.listener({ isTrusted: true, target: actionEl } as unknown as MouseEvent);
}

beforeEach(() => {
  harness = installChromeMock();
  document.body.innerHTML = "";
  // jsdom shares one `document` across every test in this file (no per-test
  // reset), and two tests below plant a `#nimbus-related-host` stand-in
  // directly on documentElement (mirroring where the real panel mounts) — so
  // it has to be swept here too, or it leaks into every test that follows.
  for (const el of document.documentElement.querySelectorAll(
    "#nimbus-cue-host, #nimbus-related-host",
  )) {
    el.remove();
  }
  clickListeners.length = 0;
  const originalAdd = Element.prototype.addEventListener;
  vi.spyOn(Element.prototype, "addEventListener").mockImplementation(function (
    this: Element,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (type === "click" && typeof listener === "function") {
      clickListeners.push({ target: this, listener });
    }
    return originalAdd.call(this, type, listener, options);
  });
});
afterEach(() => {
  harness.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the injected cue", () => {
  test("mounts inside a shadow root and names the item", async () => {
    const show = await loadCue();
    show(STATE);
    expect(cueEl()?.textContent).toContain("acme/web #482");
  });

  test("does not mount while the panel is already open on this page", async () => {
    const panel = document.createElement("div");
    panel.id = "nimbus-related-host";
    document.documentElement.append(panel);
    const show = await loadCue();
    show(STATE);
    expect(document.getElementById("nimbus-cue-host")).toBeNull();
  });

  test("clicking it asks the worker to open the panel, then removes itself", async () => {
    const show = await loadCue();
    show(STATE);
    const open = cueEl()?.querySelector('[data-action="open"]') as HTMLButtonElement;
    trustedClick(open);
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledWith({ kind: "cue-open" });
    expect(document.getElementById("nimbus-cue-host")).toBeNull();
  });

  test("dismissing removes it without messaging the worker — the tab memory already holds", async () => {
    const show = await loadCue();
    show(STATE);
    const dismiss = cueEl()?.querySelector('[data-action="dismiss"]') as HTMLButtonElement;
    trustedClick(dismiss);
    expect(document.getElementById("nimbus-cue-host")).toBeNull();
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  test("a page-synthesized click on the open control is ignored: no message, cue stays mounted", async () => {
    const show = await loadCue();
    show(STATE);
    const open = cueEl()?.querySelector('[data-action="open"]') as HTMLButtonElement;
    // What a hostile page does through the open shadow root:
    // `host.shadowRoot.querySelector('[data-action=open]').click()`. Both
    // `.click()` and a plain `dispatchEvent(new MouseEvent(...))` produce an
    // untrusted event — this must not open the panel or retract the cue.
    open.click();
    await Promise.resolve();
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(document.getElementById("nimbus-cue-host")).not.toBeNull();
    expect(cueEl()).not.toBeNull();
  });

  test("retracts itself when the page navigates to something else", async () => {
    vi.useFakeTimers();
    const show = await loadCue();
    show(STATE);
    expect(cueEl()).not.toBeNull();
    window.history.pushState({}, "", "/acme/web/pull/517");
    vi.advanceTimersByTime(600);
    expect(document.getElementById("nimbus-cue-host")).toBeNull();
  });

  test("retracts itself when the panel is opened by any other route", async () => {
    vi.useFakeTimers();
    const show = await loadCue();
    show(STATE);
    expect(cueEl()).not.toBeNull();
    // The hotkey, the popup button and the context menu all inject the panel
    // without going through the cue — from in here, all three look like this.
    const panel = document.createElement("div");
    panel.id = "nimbus-related-host";
    document.documentElement.append(panel);
    vi.advanceTimersByTime(600);
    expect(document.getElementById("nimbus-cue-host")).toBeNull();
  });

  test("a second call replaces the first cue rather than stacking a second one", async () => {
    const show = await loadCue();
    show(STATE);
    show({ label: "GitHub PR", ref: "acme/web #517" });
    expect(document.querySelectorAll("#nimbus-cue-host")).toHaveLength(1);
    expect(cueEl()?.textContent).toContain("#517");
  });

  test("a host planted by the page is replaced, never written into", async () => {
    const planted = document.createElement("div");
    planted.id = "nimbus-cue-host";
    planted.attachShadow({ mode: "open" });
    document.documentElement.append(planted);
    const show = await loadCue();
    show(STATE);
    const host = document.getElementById("nimbus-cue-host");
    expect(host).not.toBe(planted);
    expect(host?.shadowRoot?.querySelector(".nimbus-cue")).not.toBeNull();
  });

  test("a shadow root planted by the page is left empty — nothing of ours is ever written into it", async () => {
    const planted = document.createElement("div");
    planted.id = "nimbus-cue-host";
    const plantedRoot = planted.attachShadow({ mode: "open" });
    document.documentElement.append(planted);
    const show = await loadCue();
    show(STATE);
    expect(plantedRoot.querySelector(".nimbus-cue")).toBeNull();
    expect(plantedRoot.childNodes).toHaveLength(0);
  });

  test("two hosts planted by the page are both removed, not just the first", async () => {
    const first = document.createElement("div");
    first.id = "nimbus-cue-host";
    document.documentElement.append(first);
    const second = document.createElement("div");
    second.id = "nimbus-cue-host";
    document.documentElement.append(second);
    const show = await loadCue();
    show(STATE);
    expect(document.contains(first)).toBe(false);
    expect(document.contains(second)).toBe(false);
    expect(document.querySelectorAll("#nimbus-cue-host")).toHaveLength(1);
  });

  test("clears its poll interval when opened", async () => {
    vi.useFakeTimers();
    const show = await loadCue();
    show(STATE);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const open = cueEl()?.querySelector('[data-action="open"]') as HTMLButtonElement;
    trustedClick(open);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("clears its poll interval when dismissed", async () => {
    vi.useFakeTimers();
    const show = await loadCue();
    show(STATE);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const dismiss = cueEl()?.querySelector('[data-action="dismiss"]') as HTMLButtonElement;
    trustedClick(dismiss);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("stops polling once its host is detached directly, not only through teardown", async () => {
    vi.useFakeTimers();
    const show = await loadCue();
    show(STATE);
    const host = document.getElementById("nimbus-cue-host");
    expect(host).not.toBeNull();
    // The page removing our node directly — host.remove(), or wiping
    // documentElement's children — bypasses teardown() entirely, unlike
    // dismiss/open above which call it. Without the isConnected check, the
    // interval has no way to learn the host is gone and keeps firing at 2 Hz
    // forever, with nothing left to tear down or paint into.
    host?.remove();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(600);
    expect(vi.getTimerCount()).toBe(0);
  });
});
