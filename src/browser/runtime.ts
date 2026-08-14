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
