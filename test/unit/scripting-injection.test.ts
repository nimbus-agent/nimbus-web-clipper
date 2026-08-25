// @vitest-environment jsdom
// test/unit/scripting-injection.test.ts
//
// The `func` bodies `src/browser/scripting.ts` hands to `chrome.scripting`.
//
// Those bodies are serialised and evaluated in the PAGE, not in this bundle, so
// `browser-seam.test.ts` — which only asserts what was HANDED to executeScript —
// cannot reach them: it stubs the result instead of producing it. Here the fake
// `executeScript` does what the browser does, calling `injection.func(...args)`
// against a jsdom document. That is the only way the panel-host contract
// (`shared/panel-host.ts`'s element id and property NAME) is exercised end to
// end; a mismatch there fails SILENTLY in production.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { deliverSelection, runCapture, showCue, showToast } from "../../src/browser/scripting.ts";
import { PANEL_HOST_ID, PANEL_SELECTION_HOOK } from "../../src/shared/panel-host.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

interface Injection {
  readonly target: { tabId: number };
  readonly files?: string[];
  readonly func?: (...args: never[]) => unknown;
  readonly args?: unknown[];
}

let harness: ChromeHarness;
/** Every injection the code asked for, in order — files and funcs alike. */
let injections: Injection[];

/**
 * Run the injected function for real.
 *
 * `onFiles` stands in for what loading a bundle does to the page: `panel.js`
 * mounts the host element, so a test that wants "the panel was not there, then
 * it was" hands one in.
 */
function driveExecuteScript(onFiles?: (files: string[]) => void): void {
  harness.executeScript.mockImplementation(async (raw: unknown) => {
    const injection = raw as Injection;
    injections.push(injection);
    if (injection.files !== undefined) {
      onFiles?.(injection.files);
      return [{ result: undefined }];
    }
    const fn = injection.func as ((...args: unknown[]) => unknown) | undefined;
    return [{ result: fn === undefined ? undefined : fn(...(injection.args ?? [])) }];
  });
}

/** Mount a panel host carrying the selection hook, and record what it receives. */
function mountPanelHost(): { received: unknown[] } {
  const received: unknown[] = [];
  const host = document.createElement("div");
  host.id = PANEL_HOST_ID;
  (host as unknown as Record<string, unknown>)[PANEL_SELECTION_HOOK] = (sel: unknown): void => {
    received.push(sel);
  };
  document.body.append(host);
  return { received };
}

function funcInjections(): Injection[] {
  return injections.filter((i) => i.func !== undefined);
}

function injectedFiles(): string[] {
  return injections.flatMap((i) => i.files ?? []);
}

beforeEach(() => {
  harness = installChromeMock();
  injections = [];
  document.body.innerHTML = "";
});

afterEach(() => {
  harness.restore();
  vi.restoreAllMocks();
});

describe("runCapture's injected body", () => {
  const capture = {
    url: "https://ex.com/p",
    title: "P",
    mode: "selection" as const,
    body: "b",
    readableFound: true,
  };

  test("calls the page's __nimbusCapture with the mode it was asked for", async () => {
    // The two-step exists because `func` cannot carry imports: capture.js sets
    // the global, and this body is the call. If the two spellings drift, the
    // call throws in the page and the clip never happens.
    const nimbusCapture = vi.fn(() => capture);
    (globalThis as unknown as Record<string, unknown>)["__nimbusCapture"] = nimbusCapture;
    driveExecuteScript();

    expect(await runCapture(7, "selection")).toEqual(capture);
    expect(nimbusCapture).toHaveBeenCalledWith("selection");
    expect(injectedFiles()).toEqual(["capture.js"]);
  });

  test("rejects when the page global returns something that is not a CaptureResult", async () => {
    // A page can define `__nimbusCapture` itself. Whatever it returns is
    // untrusted input crossing back into the extension, so it is guarded here
    // rather than downstream.
    (globalThis as unknown as Record<string, unknown>)["__nimbusCapture"] = (): unknown => ({
      url: "https://ex.com/p",
    });
    driveExecuteScript();

    await expect(runCapture(7, "article")).rejects.toThrow();
  });
});

describe("deliverSelection", () => {
  const selection = { text: "idempotent", intent: "define" as const };

  test("hands the selection to an OPEN panel without re-injecting panel.js", async () => {
    // `panel.js` is a self-toggle: injecting it to deliver a selection would
    // CLOSE the panel whenever one was already open — precisely when the user is
    // most likely to be using these menu entries.
    const { received } = mountPanelHost();
    driveExecuteScript();

    await deliverSelection(7, selection);

    expect(received).toEqual([selection]);
    expect(injectedFiles()).toEqual([]);
  });

  test("mounts a panel on a miss, then hands the SAME selection to it", async () => {
    // The freshly mounted panel is handed the selection rather than being left
    // to read the page: by then the click may already have collapsed it.
    let mounted: { received: unknown[] } | null = null;
    driveExecuteScript((files) => {
      if (files.includes("panel.js")) {
        mounted = mountPanelHost();
      }
    });

    await deliverSelection(7, selection);

    expect(injectedFiles()).toEqual(["panel.js"]);
    expect(mounted).not.toBeNull();
    expect((mounted as unknown as { received: unknown[] }).received).toEqual([selection]);
    // Hook, mount, hook — the second hook call is what actually delivers.
    expect(funcInjections()).toHaveLength(2);
  });

  test("treats a host whose hook is not a function as no panel at all", async () => {
    // A page is free to own an element with that id. Calling a non-function
    // would throw in the page, so the body checks the TYPE before calling.
    const host = document.createElement("div");
    host.id = PANEL_HOST_ID;
    (host as unknown as Record<string, unknown>)[PANEL_SELECTION_HOOK] = "not a function";
    document.body.append(host);
    driveExecuteScript();

    await deliverSelection(7, selection);

    expect(injectedFiles()).toEqual(["panel.js"]);
  });

  test("looks the panel up by the SHARED id and hook name, not by a local copy", async () => {
    // A host under any other id must not be found: that is the drift this
    // asserts against, and it is the failure that is silent in production.
    const host = document.createElement("div");
    host.id = `${PANEL_HOST_ID}-other`;
    (host as unknown as Record<string, unknown>)[PANEL_SELECTION_HOOK] = (): void => undefined;
    document.body.append(host);
    driveExecuteScript();

    await deliverSelection(7, selection);

    expect(injectedFiles()).toEqual(["panel.js"]);
  });
});

describe("showToast / showCue injected bodies", () => {
  test("showToast calls the page's __nimbusToast with the state", async () => {
    const nimbusToast = vi.fn();
    (globalThis as unknown as Record<string, unknown>)["__nimbusToast"] = nimbusToast;
    driveExecuteScript();

    await showToast(7, { variant: "success", text: "Clipped" });

    expect(injectedFiles()).toEqual(["toast.js"]);
    expect(nimbusToast).toHaveBeenCalledWith({ variant: "success", text: "Clipped" });
  });

  test("showCue calls the page's __nimbusCue with the state", async () => {
    const nimbusCue = vi.fn();
    (globalThis as unknown as Record<string, unknown>)["__nimbusCue"] = nimbusCue;
    driveExecuteScript();

    await showCue(7, { label: "GitHub PR", ref: "acme/web #482" });

    expect(injectedFiles()).toEqual(["cue.js"]);
    expect(nimbusCue).toHaveBeenCalledWith({ label: "GitHub PR", ref: "acme/web #482" });
  });
});
