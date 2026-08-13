import type { CaptureResult, CueState, ToastState } from "../shared/types.ts";

function isCaptureResult(v: unknown): v is CaptureResult {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    typeof o["url"] === "string" &&
    (o["canonicalUrl"] === undefined || typeof o["canonicalUrl"] === "string") &&
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
