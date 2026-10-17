import { isCanonicalRejection } from "../shared/canonical.ts";
import { isSourceShape } from "../shared/clip.ts";
import { PANEL_HOST_ID, PANEL_INTENT_HOOK, type PanelIntent } from "../shared/panel-host.ts";
import type { CaptureResult, CueState, ToastState } from "../shared/types.ts";

function isCaptureResult(v: unknown): v is CaptureResult {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    typeof o["url"] === "string" &&
    (o["canonicalUrl"] === undefined || typeof o["canonicalUrl"] === "string") &&
    (o["canonicalRejected"] === undefined || isCanonicalRejection(o["canonicalRejected"])) &&
    // Shallow for the reason given in messages.ts's isCaptureResult.
    (o["source"] === undefined || isSourceShape(o["source"])) &&
    typeof o["title"] === "string" &&
    (o["mode"] === "article" || o["mode"] === "selection") &&
    typeof o["body"] === "string" &&
    typeof o["readableFound"] === "boolean"
  );
}

/**
 * Inject the bundled capture.js (which sets globalThis.__nimbusCapture), then call it
 * via a tiny func injection whose completion value is the CaptureResult. The two-step
 * keeps the heavy Readability bundle out of the func body (func cannot carry imports).
 */
export async function runCapture(
  tabId: number,
  mode: "article" | "selection",
): Promise<CaptureResult> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["capture.js"] });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (m: "article" | "selection") =>
      (globalThis as unknown as { __nimbusCapture: (m: string) => unknown }).__nimbusCapture(m),
    args: [mode],
  });
  const value = results[0]?.result;
  if (!isCaptureResult(value)) {
    throw new Error("capture failed");
  }
  return value;
}

/** Inject the bundled panel.js into a tab. The script self-toggles on re-injection. */
export async function injectPanel(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["panel.js"] });
}

/**
 * Call the open panel's intent hook. Resolves `false` when there is no panel in
 * the tab — the caller's cue to mount one.
 *
 * Looked up by element id and property NAME rather than by importing anything
 * from the panel: `func` bodies are serialised and evaluated in the PAGE, with
 * no access to this bundle's imports. `shared/panel-host.ts` is what keeps the
 * two spellings from drifting.
 */
async function callIntentHook(tabId: number, intent: PanelIntent): Promise<boolean> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (hostId: string, hookName: string, it: PanelIntent) => {
      const host = document.getElementById(hostId) as
        | (HTMLElement & Record<string, unknown>)
        | null;
      const hook = host?.[hookName];
      if (typeof hook !== "function") {
        return false;
      }
      (hook as (i: PanelIntent) => void)(it);
      return true;
    },
    args: [PANEL_HOST_ID, PANEL_INTENT_HOOK, intent],
  });
  return results[0]?.result === true;
}

/**
 * Hand an intent (a menu selection, or a palette choice) to the panel in this
 * tab, opening one if none is there.
 *
 * NOT `injectPanel`: `panel.js` is a self-toggle, so injecting it to deliver an
 * intent would CLOSE the panel whenever one was already open — precisely when
 * the user is most likely to be using these entries. So: try the hook, and mount
 * only on a miss. The freshly mounted panel is then handed the same intent
 * rather than being left to read the page, because by then the click may already
 * have collapsed the selection.
 */
export async function deliverIntent(tabId: number, intent: PanelIntent): Promise<void> {
  if (await callIntentHook(tabId, intent)) {
    return;
  }
  await injectPanel(tabId);
  await callIntentHook(tabId, intent);
}

/** Inject toast.js then call its global with the state (two-step, like runCapture). */
export async function showToast(tabId: number, state: ToastState): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["toast.js"] });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (s: ToastState) =>
      (globalThis as unknown as { __nimbusToast: (x: ToastState) => void }).__nimbusToast(s),
    args: [state],
  });
}

/** Inject cue.js then call its global with the state (two-step, like showToast). */
export async function showCue(tabId: number, state: CueState): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["cue.js"] });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (s: CueState) =>
      (globalThis as unknown as { __nimbusCue: (x: CueState) => void }).__nimbusCue(s),
    args: [state],
  });
}
