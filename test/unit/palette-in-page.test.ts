// @vitest-environment jsdom
// test/unit/palette-in-page.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PANEL_HOST_ID,
  PANEL_STATE_HOOK,
  type PaletteInit,
  type PanelHostState,
} from "../../src/shared/panel-host.ts";
import type { Recognition } from "../../src/shared/types.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

// palette-in-page.ts is an injected content script: importing it defines
// `globalThis.__nimbusPalette`. Re-injection (a second press of the command) is
// simulated by resetting the module registry and re-importing, which is what
// the browser does when `executeScript({files:["palette.js"]})` runs again.
const MODULE_PATH = "../../src/palette/palette-in-page.ts";
const HOST_ID = "nimbus-palette-host";

type PaletteFn = (init: PaletteInit) => void;

const PR: Recognition = {
  ok: true,
  product: "github",
  kind: "pr",
  label: "GitHub PR",
  ref: "acme/web #1",
  resolveUrl: "https://github.com/acme/web/pull/1",
  scope: "acme/web",
  origin: "https://github.com",
} as Recognition;

const ISSUE: Recognition = {
  ok: true,
  product: "jira",
  kind: "issue",
  label: "Jira issue",
  ref: "ABC-1",
  resolveUrl: "https://acme.atlassian.net/browse/ABC-1",
} as Recognition;

const NONE: Recognition = { ok: false, reason: "unknown-host" } as Recognition;

const ITEM = {
  id: "i1",
  service: "github",
  type: "pr",
  title: "Add thing",
  url: "https://github.com/acme/web/pull/1",
  modifiedAt: 1_700_000_000_000,
};

const RESOLVED_PR = {
  kind: "resolve",
  ok: true,
  recognition: PR,
  outcome: { kind: "found", matchKind: "exact", item: ITEM },
  offeredLanes: ["impact", "expert"],
};

const AMBIGUOUS_ISSUE = {
  kind: "resolve",
  ok: true,
  recognition: ISSUE,
  outcome: {
    kind: "ambiguous",
    fetchable: false,
    truncated: false,
    candidates: [
      { id: "a", service: "jira", type: "issue", title: "One", url: null },
      { id: "b", service: "jira", type: "issue", title: "Two", url: null },
    ],
  },
};

const UNRECOGNISED = {
  kind: "resolve",
  ok: true,
  recognition: NONE,
  outcome: { kind: "not-indexed", fetchable: false },
};

let harness: ChromeHarness;

// ---------------------------------------------------------------------------
// Trusted events. `isTrusted` is [Unforgeable]: jsdom stamps `false` on every
// event script dispatches, so a dispatched event can never reach past the
// palette's `!isTrusted` guard. The listeners the palette registers are
// captured here instead, and invoked with a hand-built event carrying
// `isTrusted: true` — the one field the guard reads. The order mirrors real
// propagation for a key press: window capture, document capture, then the
// target's own listeners; `stopImmediatePropagation` ends it.
// ---------------------------------------------------------------------------
interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly listener: EventListener;
  readonly capture: boolean;
  readonly signal: AbortSignal | undefined;
}
const recorded: Recorded[] = [];

function live(target: EventTarget, type: string, capture?: boolean): Recorded[] {
  return recorded.filter(
    (r) =>
      r.target === target &&
      r.type === type &&
      (capture === undefined || r.capture === capture) &&
      r.signal?.aborted !== true,
  );
}

interface FakeEvent {
  readonly isTrusted: boolean;
  readonly preventDefault: ReturnType<typeof vi.fn>;
  readonly stopPropagation: ReturnType<typeof vi.fn>;
  readonly stopImmediatePropagation: () => void;
  stopped: boolean;
  [key: string]: unknown;
}

function fakeEvent(props: Record<string, unknown>): FakeEvent {
  const ev: FakeEvent = {
    isTrusted: true,
    isComposing: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopped: false,
    stopImmediatePropagation: () => {
      ev.stopped = true;
    },
    ...props,
  };
  return ev;
}

function deliver(listeners: Recorded[], ev: FakeEvent): void {
  for (const r of listeners) {
    if (ev.stopped) {
      return;
    }
    r.listener(ev as unknown as Event);
  }
}

/** A trusted event on one target's own listeners. */
function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}): FakeEvent {
  const ev = fakeEvent({ type, target, ...props });
  deliver(live(target, type), ev);
  return ev;
}

/** A trusted key press: window capture → document capture → the input. */
function press(key: string, props: Record<string, unknown> = {}): FakeEvent {
  const ev = fakeEvent({ type: "keydown", key, target: input(), ...props });
  deliver(live(window, "keydown", true), ev);
  deliver(live(document, "keydown", true), ev);
  const target = input();
  if (target !== null) {
    deliver(live(target, "keydown"), ev);
  }
  return ev;
}

async function load(): Promise<PaletteFn> {
  vi.resetModules();
  await import(MODULE_PATH);
  const fn = (globalThis as { __nimbusPalette?: PaletteFn }).__nimbusPalette;
  if (fn === undefined) {
    throw new Error("palette script did not define __nimbusPalette");
  }
  return fn;
}

function hosts(): Element[] {
  return [...document.querySelectorAll(`#${HOST_ID}`)];
}
function root(): ShadowRoot | null {
  return document.getElementById(HOST_ID)?.shadowRoot ?? null;
}
function input(): HTMLInputElement | null {
  return root()?.querySelector("input") ?? null;
}
function dialog(): HTMLElement | null {
  return root()?.querySelector<HTMLElement>("[role=dialog]") ?? null;
}
function listbox(): HTMLElement | null {
  return root()?.querySelector<HTMLElement>("[role=listbox]") ?? null;
}
function rowTitles(): string[] {
  return [...(root()?.querySelectorAll(".nimbus-palette__title") ?? [])].map(
    (el) => el.textContent ?? "",
  );
}
function rowEl(title: string): HTMLElement {
  const el = [...(root()?.querySelectorAll<HTMLElement>("[role=option]") ?? [])].find(
    (o) => o.querySelector(".nimbus-palette__title")?.textContent === title,
  );
  if (el === undefined) {
    throw new Error(`no row titled ${title}`);
  }
  return el;
}
function activeTitle(): string | null {
  return root()?.querySelector("[aria-selected=true] .nimbus-palette__title")?.textContent ?? null;
}

/** Answer `resolve` with `res`; record every other message (and the page
 *  selection at the moment it was sent) for the assertions. */
const sent: Array<{ message: unknown; selection: string; hostPresent: boolean }> = [];
function respond(res: unknown): void {
  harness.sendMessage.mockImplementation(async (message: unknown) => {
    if ((message as { kind?: string }).kind === "resolve") {
      return res;
    }
    sent.push({
      message,
      selection: window.getSelection()?.toString() ?? "",
      hostPresent: hosts().length > 0,
    });
    return undefined;
  });
}

async function settle(): Promise<void> {
  await vi.waitFor(() => {
    expect(rowTitles()).not.toContain("Looking up this page…");
  });
}

function typeFilter(text: string): void {
  const el = input();
  if (el === null) {
    throw new Error("no input");
  }
  el.value = text;
  fire(el, "input");
}

beforeEach(() => {
  harness = installChromeMock();
  document.body.innerHTML = "";
  for (const el of document.documentElement.querySelectorAll(`#${HOST_ID}, #${PANEL_HOST_ID}`)) {
    el.remove();
  }
  window.getSelection()?.removeAllRanges();
  recorded.length = 0;
  sent.length = 0;
  record(EventTarget.prototype);
  // jsdom gives `window` its OWN addEventListener rather than inheriting
  // EventTarget.prototype's, so the prototype spy alone never sees it.
  record(window);
});

function record(on: EventTarget): void {
  const originalAdd = on.addEventListener;
  vi.spyOn(on, "addEventListener").mockImplementation(function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (typeof listener === "function") {
      const opts = typeof options === "object" ? options : { capture: options === true };
      recorded.push({
        target: this,
        type,
        listener,
        capture: opts.capture === true,
        signal: opts.signal,
      });
    }
    return originalAdd.call(this, type, listener, options);
  });
}

afterEach(() => {
  // Close anything a test left open, so its window listener cannot leak.
  for (const el of hosts()) {
    const close = (el as HTMLElement & { __nimbusClose?: () => void }).__nimbusClose;
    if (typeof close === "function") {
      close();
    }
    el.remove();
  }
  harness.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("host trust and the toggle", () => {
  it("removes a planted decoy and mounts", async () => {
    respond(RESOLVED_PR);
    const decoy = document.createElement("div");
    decoy.id = HOST_ID;
    document.documentElement.append(decoy);
    const fn = await load();
    fn({ recognition: PR });
    expect(decoy.isConnected).toBe(false);
    expect(hosts()).toHaveLength(1);
    expect(dialog()?.getAttribute("aria-label")).toBeTruthy();
  });

  it("a second call closes it: no host, every listener detached", async () => {
    respond(RESOLVED_PR);
    const fn = await load();
    fn({ recognition: PR });
    expect(hosts()).toHaveLength(1);
    fn({ recognition: PR });
    expect(hosts()).toHaveLength(0);
    const mine = recorded.filter((r) => r.signal !== undefined);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.signal?.aborted === true)).toBe(true);
    // An Escape after the close reaches nothing of the palette's.
    expect(live(window, "keydown", true)).toHaveLength(0);
  });

  it("two presses across a re-evaluated bundle toggle: open then closed, never two hosts", async () => {
    respond(RESOLVED_PR);
    const first = await load();
    first({ recognition: PR });
    expect(hosts()).toHaveLength(1);
    const second = await load();
    expect(second).not.toBe(first);
    second({ recognition: PR });
    expect(hosts()).toHaveLength(0);
  });

  it("every listener it adds hangs off its one AbortController", async () => {
    respond(RESOLVED_PR);
    const fn = await load();
    recorded.length = 0;
    fn({ recognition: PR });
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((r) => r.signal !== undefined)).toBe(true);
  });
});

describe("ARIA and placement", () => {
  it("wires combobox → listbox and tracks the active row", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    const el = input();
    const list = listbox();
    expect(el?.getAttribute("role")).toBe("combobox");
    expect(el?.getAttribute("aria-controls")).toBe(list?.id);
    const active = root()?.querySelector("[aria-selected=true]");
    expect(active?.getAttribute("role")).toBe("option");
    expect(el?.getAttribute("aria-activedescendant")).toBe(active?.id);
    expect(document.activeElement).toBe(document.getElementById(HOST_ID));
    expect(root()?.activeElement).toBe(el);
  });

  it("no match: one disabled row and no active descendant", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    await settle();
    typeFilter("zzzz");
    expect(rowTitles()).toEqual(["No matching actions"]);
    expect(input()?.hasAttribute("aria-activedescendant")).toBe(false);
    press("Enter");
    expect(sent).toHaveLength(0);
    expect(hosts()).toHaveLength(1);
  });

  it("sits beside an open panel", async () => {
    respond(RESOLVED_PR);
    plantPanel({ pinnedUrl: "https://elsewhere.test/", chosenId: null });
    (await load())({ recognition: PR });
    expect(dialog()?.classList.contains("nimbus-palette--beside-panel")).toBe(true);
  });

  it("sits top-centre with no panel", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    expect(dialog()?.classList.contains("nimbus-palette--beside-panel")).toBe(false);
  });
});

function plantPanel(state: {
  pinnedUrl: string;
  chosenId: string | null;
  pinnedRecognition?: Recognition | null;
}): HTMLElement {
  const panel = document.createElement("div") as unknown as HTMLElement & Record<string, unknown>;
  panel.id = PANEL_HOST_ID;
  const full: PanelHostState = { pinnedRecognition: null, ...state };
  panel[PANEL_STATE_HOOK] = () => full;
  document.documentElement.append(panel);
  return panel;
}

describe("resolve", () => {
  it("swaps 'Looking up this page…' for 'Couldn't connect to Nimbus.' on a rejected resolve", async () => {
    let reject: (e: Error) => void = () => undefined;
    harness.sendMessage.mockImplementation(
      () =>
        new Promise((_resolve, rej) => {
          reject = rej;
        }),
    );
    (await load())({ recognition: PR });
    expect(rowTitles()[0]).toBe("Looking up this page…");
    expect(harness.sendMessage).toHaveBeenCalledWith({
      kind: "resolve",
      pageUrl: window.location.href,
      title: document.title,
    });
    reject(new Error("worker gone"));
    await vi.waitFor(() => {
      expect(rowTitles()[0]).toBe("Couldn't connect to Nimbus.");
    });
    expect(rowTitles()).not.toContain("Looking up this page…");
  });

  it("an unreadable answer is done, with the error header's sentence", async () => {
    respond({ nonsense: true });
    (await load())({ recognition: PR });
    await vi.waitFor(() => {
      expect(rowTitles()[0]).toBe("Couldn't read Nimbus's answer.");
    });
  });

  it("the first lane takes the active row when lanes arrive untouched", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    expect(activeTitle()).toBe("Deploy readiness");
    await settle();
    expect(activeTitle()).toBe("What breaks if it lands");
  });

  it("an open panel's pick on this page lists lanes, not 'Pick the item'", async () => {
    respond(AMBIGUOUS_ISSUE);
    plantPanel({ pinnedUrl: `${window.location.href}#frag`, chosenId: "a" });
    (await load())({ recognition: ISSUE });
    await settle();
    expect(rowTitles()).not.toContain("Pick the item in the panel");
    expect(rowTitles()).toContain("How did we get here");
  });

  const AMBIGUOUS_PR = { ...AMBIGUOUS_ISSUE, recognition: PR };

  it("a panel pinned to the same item at another path lends its pick: lanes, no 'Pick the item'", async () => {
    respond(AMBIGUOUS_PR);
    // The panel opened on the PR's Conversation tab; the palette opens on its
    // Files changed tab — a different URL, the same item.
    plantPanel({
      pinnedUrl: "https://github.com/acme/web/pull/1",
      pinnedRecognition: PR,
      chosenId: "a",
    });
    (await load())({ recognition: PR });
    await settle();
    expect(rowTitles()).not.toContain("Pick the item in the panel");
    expect(rowTitles()).toContain("What breaks if it lands");
  });

  it("a panel pinned to a different item at another path lends no pick", async () => {
    respond(AMBIGUOUS_PR);
    plantPanel({
      pinnedUrl: "https://github.com/acme/web/pull/2",
      pinnedRecognition: { ...PR, ref: "acme/web #2" } as Recognition,
      chosenId: "a",
    });
    (await load())({ recognition: PR });
    await settle();
    expect(rowTitles()).toContain("Pick the item in the panel");
  });

  it("a panel at another path whose resolve has not landed lends no pick", async () => {
    respond(AMBIGUOUS_PR);
    plantPanel({ pinnedUrl: "https://github.com/acme/web/pull/1", chosenId: "a" });
    (await load())({ recognition: PR });
    await settle();
    expect(rowTitles()).toContain("Pick the item in the panel");
  });

  const FILE: Recognition = {
    ok: true,
    product: "github",
    kind: "file",
    label: "GitHub file",
    ref: "acme/web src/a.ts",
    resolveUrl: "https://github.com/acme/web/blob/main/src/a.ts",
  } as Recognition;
  const fileAnswer = (file: unknown): unknown => ({
    kind: "resolve",
    ok: true,
    recognition: FILE,
    outcome: { kind: "not-indexed", fetchable: false },
    file,
  });

  it("a file page whose probe placed the file offers its lanes", async () => {
    respond(fileAnswer({ kind: "found", path: "src/a.ts" }));
    (await load())({ recognition: FILE });
    await settle();
    expect(rowTitles()).toContain("What breaks if this changes");
  });

  it("a file page whose probe missed offers no file lane, and says why", async () => {
    respond(fileAnswer({ kind: "miss", reason: "file_not_indexed", repo: "acme/web" }));
    (await load())({ recognition: FILE });
    await settle();
    expect(rowTitles()).not.toContain("What breaks if this changes");
    expect(rowTitles().join(" ")).toContain("this file is not in its index");
  });

  it("a panel pinned elsewhere lends no pick", async () => {
    respond(AMBIGUOUS_ISSUE);
    plantPanel({ pinnedUrl: "https://elsewhere.test/", chosenId: "a" });
    (await load())({ recognition: ISSUE });
    await settle();
    expect(rowTitles()).toContain("Pick the item in the panel");
  });

  it("a resolve landing after close paints nothing", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    harness.sendMessage.mockImplementation(
      () =>
        new Promise((res) => {
          resolve = res;
        }),
    );
    const fn = await load();
    fn({ recognition: PR });
    fn({ recognition: PR });
    resolve(RESOLVED_PR);
    await new Promise((r) => setTimeout(r, 0));
    expect(hosts()).toHaveLength(0);
  });
});

describe("keys", () => {
  it("ArrowDown + Enter on a lane row removes the host, then sends the lane intent", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    await settle();
    press("ArrowDown");
    expect(activeTitle()).toBe("Who should review it");
    const enter = press("Enter");
    expect(enter.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.message).toEqual({
      kind: "palette-intent",
      intent: { kind: "lane", lane: "expert" },
    });
    expect(sent[0]?.hostPresent).toBe(false);
  });

  it("ArrowUp wraps to the last enabled row", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    await settle();
    press("ArrowUp");
    expect(activeTitle()).toBe("Clip page");
  });

  it("Enter on Clip selection restores the saved range before sending quick-clip", async () => {
    respond(UNRECOGNISED);
    document.body.innerHTML = "<p id='p'>hello world</p>";
    const range = document.createRange();
    const text = document.getElementById("p")?.firstChild;
    if (text === null || text === undefined) {
      throw new Error("no text node");
    }
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()?.addRange(range);
    (await load())({ recognition: NONE });
    // Focusing the input collapses the page selection in a real browser.
    window.getSelection()?.removeAllRanges();
    await settle();
    typeFilter("Clip sel");
    expect(activeTitle()).toBe("Clip selection");
    press("Enter");
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.message).toEqual({ kind: "quick-clip", mode: "selection" });
    expect(sent[0]?.selection).toBe("hello");
    expect(sent[0]?.hostPresent).toBe(false);
  });

  it("the glossary row carries the selection it saved", async () => {
    respond(UNRECOGNISED);
    document.body.innerHTML = "<p id='p'>idempotent</p>";
    const range = document.createRange();
    const p = document.getElementById("p");
    if (p === null) {
      throw new Error("no p");
    }
    range.selectNodeContents(p);
    window.getSelection()?.addRange(range);
    (await load())({ recognition: NONE });
    await settle();
    press("Enter");
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.message).toEqual({
      kind: "palette-intent",
      intent: { kind: "selection", text: "idempotent", intent: "define" },
    });
  });

  it("Escape closes only the palette, ahead of the panel's document-capture listener", async () => {
    respond(RESOLVED_PR);
    const panelEscape = vi.fn();
    plantPanel({ pinnedUrl: window.location.href, chosenId: null });
    document.addEventListener(
      "keydown",
      (e) => {
        if ((e as KeyboardEvent).key === "Escape") {
          panelEscape();
        }
      },
      { capture: true },
    );
    (await load())({ recognition: PR });
    const ev = press("Escape");
    expect(hosts()).toHaveLength(0);
    expect(panelEscape).not.toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(document.getElementById(PANEL_HOST_ID)).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("a non-Escape key passes the window listener by", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    const ev = fakeEvent({ type: "keydown", key: "a" });
    deliver(live(window, "keydown", true), ev);
    expect(ev.stopped).toBe(false);
    expect(hosts()).toHaveLength(1);
  });

  it("a synthetic Enter does nothing", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    await settle();
    input()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    press("Enter", { isTrusted: false });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0);
    expect(hosts()).toHaveLength(1);
  });

  it("an untrusted input event leaves the filter alone", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    await settle();
    const el = input();
    if (el === null) {
      throw new Error("no input");
    }
    el.value = "zzzz";
    fire(el, "input", { isTrusted: false });
    expect(rowTitles()).not.toEqual(["No matching actions"]);
  });

  it("Escape mid-composition is the IME's: the palette stays open and lets it through", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    const ev = press("Escape", { isComposing: true });
    expect(hosts()).toHaveLength(1);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it("Enter mid-composition does nothing", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    await settle();
    press("Enter", { isComposing: true });
    expect(hosts()).toHaveLength(1);
  });

  it("Tab closes the palette without trapping focus", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    const ev = press("Tab");
    expect(hosts()).toHaveLength(0);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it("keys typed in the palette do not bubble to the page's shortcuts", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    const ev = press("s");
    expect(ev.stopPropagation).toHaveBeenCalled();
    const d = dialog();
    if (d === null) {
      throw new Error("no dialog");
    }
    expect(fire(d, "keyup").stopPropagation).toHaveBeenCalled();
    expect(fire(d, "keypress").stopPropagation).toHaveBeenCalled();
    expect(fire(d, "keyup", { isTrusted: false }).stopPropagation).not.toHaveBeenCalled();
  });
});

describe("pointer and focus", () => {
  it("a click on a row runs it", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    await settle();
    const list = listbox();
    if (list === null) {
      throw new Error("no listbox");
    }
    fire(list, "click", { target: rowEl("Related items").querySelector(".nimbus-palette__title") });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.message).toEqual({ kind: "palette-intent", intent: { kind: "related" } });
  });

  it("a click on a disabled row, or an untrusted click, does nothing", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    const list = listbox();
    if (list === null) {
      throw new Error("no listbox");
    }
    fire(list, "click", { target: rowEl("Clip selection") });
    fire(list, "click", { target: rowEl("Clip page"), isTrusted: false });
    fire(list, "click", { target: list });
    fire(list, "click", { target: null });
    expect(hosts()).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it("pointerdown on the dialog keeps focus in the input", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    const d = dialog();
    if (d === null) {
      throw new Error("no dialog");
    }
    expect(fire(d, "pointerdown").preventDefault).toHaveBeenCalled();
    expect(fire(d, "pointerdown", { isTrusted: false }).preventDefault).not.toHaveBeenCalled();
  });

  it("focusout closes only when focus leaves the shadow root", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    const d = dialog();
    if (d === null) {
      throw new Error("no dialog");
    }
    fire(d, "focusout", { relatedTarget: listbox() });
    expect(hosts()).toHaveLength(1);
    fire(d, "focusout", { relatedTarget: null, isTrusted: false });
    expect(hosts()).toHaveLength(1);
    fire(d, "focusout", { relatedTarget: null });
    expect(hosts()).toHaveLength(0);
  });

  it("focus moving to a page element closes without pulling it back", async () => {
    respond(RESOLVED_PR);
    document.body.innerHTML = "<button id='a'>a</button><input id='b'>";
    const a = document.getElementById("a") as HTMLButtonElement;
    const b = document.getElementById("b") as HTMLInputElement;
    a.focus();
    (await load())({ recognition: PR });
    const d = dialog();
    if (d === null) {
      throw new Error("no dialog");
    }
    b.focus();
    fire(d, "focusout", { relatedTarget: b });
    expect(hosts()).toHaveLength(0);
    expect(document.activeElement).toBe(b);
  });

  it("Escape refocuses the element active at mount", async () => {
    respond(RESOLVED_PR);
    document.body.innerHTML = "<button id='a'>a</button>";
    const a = document.getElementById("a") as HTMLButtonElement;
    a.focus();
    (await load())({ recognition: PR });
    expect(document.activeElement).not.toBe(a);
    press("Escape");
    expect(document.activeElement).toBe(a);
  });

  it("the element focused at mount removed, then Escape: no throw", async () => {
    respond(RESOLVED_PR);
    document.body.innerHTML = "<button id='a'>a</button>";
    const a = document.getElementById("a") as HTMLButtonElement;
    a.focus();
    (await load())({ recognition: PR });
    a.remove();
    expect(() => press("Escape")).not.toThrow();
    expect(hosts()).toHaveLength(0);
  });

  it("a panel intent refocuses nothing on the page", async () => {
    respond(RESOLVED_PR);
    document.body.innerHTML = "<button id='a'>a</button>";
    const a = document.getElementById("a") as HTMLButtonElement;
    a.focus();
    (await load())({ recognition: PR });
    await settle();
    press("Enter");
    expect(hosts()).toHaveLength(0);
    expect(document.activeElement).not.toBe(a);
  });

  it("Clip page refocuses the element active at mount", async () => {
    respond(RESOLVED_PR);
    document.body.innerHTML = "<button id='a'>a</button>";
    const a = document.getElementById("a") as HTMLButtonElement;
    a.focus();
    (await load())({ recognition: PR });
    const focus = vi.spyOn(a, "focus");
    typeFilter("Clip page");
    press("Enter");
    expect(focus).toHaveBeenCalled();
    expect(document.activeElement).toBe(a);
    await vi.waitFor(() => {
      expect(sent[0]?.message).toEqual({ kind: "quick-clip", mode: "article" });
    });
  });

  it("Clip selection restores the selection and does not refocus the mount-time element", async () => {
    respond(RESOLVED_PR);
    document.body.innerHTML = "<button id='a'>a</button><p id='p'>hello world</p>";
    const a = document.getElementById("a") as HTMLButtonElement;
    const p = document.getElementById("p") as HTMLElement;
    a.focus();
    const range = document.createRange();
    range.selectNodeContents(p);
    // jsdom's focus() leaves a collapsed range behind, and addRange is a no-op
    // while one exists.
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    (await load())({ recognition: PR });
    // Focusing the input collapses the page selection in a real browser.
    window.getSelection()?.removeAllRanges();
    // Refocusing a contenteditable after addRange can move the very selection
    // the capture reads, so Clip selection refocuses nothing.
    const focus = vi.spyOn(a, "focus");
    typeFilter("Clip sel");
    press("Enter");
    expect(focus).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sent[0]?.message).toEqual({ kind: "quick-clip", mode: "selection" });
    });
    expect(sent[0]?.selection).toBe("hello world");
  });

  it("a send that rejects is swallowed", async () => {
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      if ((message as { kind?: string }).kind === "resolve") {
        return RESOLVED_PR;
      }
      throw new Error("worker gone");
    });
    (await load())({ recognition: PR });
    typeFilter("Clip page");
    press("Enter");
    await new Promise((r) => setTimeout(r, 0));
    expect(hosts()).toHaveLength(0);
  });
});

describe("lifetime", () => {
  it("a stale close called twice is a no-op the second time", async () => {
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    const host = document.getElementById(HOST_ID) as HTMLElement & { __nimbusClose?: () => void };
    host.__nimbusClose?.();
    expect(hosts()).toHaveLength(0);
    expect(() => host.__nimbusClose?.()).not.toThrow();
  });

  it("a document with no selection object mounts and closes cleanly", async () => {
    respond(RESOLVED_PR);
    vi.spyOn(window, "getSelection").mockReturnValue(null);
    (await load())({ recognition: PR });
    expect(rowEl("Clip selection").getAttribute("aria-disabled")).toBe("true");
    press("Escape");
    expect(hosts()).toHaveLength(0);
  });

  it("a URL change closes it", async () => {
    vi.useFakeTimers();
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    const before = window.location.href;
    await vi.advanceTimersByTimeAsync(500);
    expect(hosts()).toHaveLength(1);
    history.pushState(null, "", "/moved");
    await vi.advanceTimersByTimeAsync(500);
    expect(hosts()).toHaveLength(0);
    history.pushState(null, "", before);
  });

  it("a fragment-only URL change (a scroll-spy replaceState) keeps it open", async () => {
    vi.useFakeTimers();
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    const before = window.location.href;
    history.replaceState(null, "", "#section-2");
    await vi.advanceTimersByTimeAsync(1000);
    expect(hosts()).toHaveLength(1);
    history.replaceState(null, "", before);
  });

  it("a palette closed from inside its own focus call leaves no running timer", async () => {
    respond(RESOLVED_PR);
    document.body.innerHTML = "<button id='trap'>trap</button>";
    const trap = document.getElementById("trap") as HTMLButtonElement;
    const trapOff = new AbortController();
    // A page focus trap: it answers our focusin by taking focus back, which
    // reaches the palette as a trusted focusout naming the trap.
    document.addEventListener(
      "focusin",
      (e) => {
        const d = dialog();
        if (e.target !== trap && d !== null) {
          trap.focus();
          fire(d, "focusout", { relatedTarget: trap });
        }
      },
      { signal: trapOff.signal },
    );
    const fn = await load();
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    fn({ recognition: PR });
    trapOff.abort();
    expect(hosts()).toHaveLength(0);
    expect(setSpy).toHaveBeenCalledTimes(1);
    const id = setSpy.mock.results[0]?.value;
    expect(id).toBeDefined();
    expect(clearSpy).toHaveBeenCalledWith(id);
  });

  it("a tick after a close whose clear was missed stops the timer itself", async () => {
    respond(RESOLVED_PR);
    const fn = await load();
    const setSpy = vi.spyOn(globalThis, "setInterval");
    fn({ recognition: PR });
    const tick = setSpy.mock.calls[0]?.[0];
    const id = setSpy.mock.results[0]?.value;
    if (typeof tick !== "function") {
      throw new Error("no interval tick captured");
    }
    // The close's own clear is skipped, as if it had never run.
    const clearSpy = vi.spyOn(globalThis, "clearInterval").mockImplementationOnce(() => undefined);
    press("Escape");
    expect(hosts()).toHaveLength(0);
    clearSpy.mockClear();
    tick();
    expect(clearSpy).toHaveBeenCalledWith(id);
  });

  it("a host the page detached tears itself down", async () => {
    vi.useFakeTimers();
    respond(RESOLVED_PR);
    (await load())({ recognition: PR });
    const host = document.getElementById(HOST_ID);
    host?.remove();
    await vi.advanceTimersByTimeAsync(500);
    expect(live(window, "keydown", true)).toHaveLength(0);
  });
});
