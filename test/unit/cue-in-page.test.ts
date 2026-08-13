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
});
afterEach(() => {
  harness.restore();
  vi.useRealTimers();
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
    open.click();
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledWith({ kind: "cue-open" });
    expect(document.getElementById("nimbus-cue-host")).toBeNull();
  });

  test("dismissing removes it without messaging the worker — the tab memory already holds", async () => {
    const show = await loadCue();
    show(STATE);
    const dismiss = cueEl()?.querySelector('[data-action="dismiss"]') as HTMLButtonElement;
    dismiss.click();
    expect(document.getElementById("nimbus-cue-host")).toBeNull();
    expect(harness.sendMessage).not.toHaveBeenCalled();
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
});
