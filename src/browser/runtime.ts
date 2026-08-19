import type { ExtensionRequest } from "../shared/messages.ts";

export async function sendMessage(req: ExtensionRequest): Promise<unknown> {
  return chrome.runtime.sendMessage(req);
}

export function addMessageListener(
  fn: (
    message: unknown,
    respond: (response: unknown) => void,
    sender: { readonly tabId?: number },
  ) => boolean,
): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
    fn(message, sendResponse, sender.tab?.id === undefined ? {} : { tabId: sender.tab.id }),
  );
}

/**
 * Listen for a broadcast the worker sends unprompted — not a reply to a
 * `sendMessage` call. Page-shaped, unlike `addMessageListener` above: no
 * `respond` callback and no return value, because a page listening for a
 * broadcast needs neither the async-response protocol nor a sender tab id.
 */
export function addBroadcastListener(fn: (message: unknown) => void): void {
  chrome.runtime.onMessage.addListener((message) => {
    fn(message);
  });
}

export function addInstalledListener(fn: () => void): void {
  chrome.runtime.onInstalled.addListener(() => fn());
}

/**
 * Is this the Firefox build?
 *
 * Derived from the extension's own URL scheme (`moz-extension:` vs
 * `chrome-extension:`), NOT from the user agent — the UA is spoofable and says
 * nothing about which package is running. Needed because the two browsers put
 * their keyboard-shortcut settings in different places and neither can be
 * reached by a link (see shortcuts-view.ts).
 */
export function isFirefoxRuntime(): boolean {
  try {
    return chrome.runtime.getURL("").startsWith("moz-extension:");
  } catch {
    return false;
  }
}
