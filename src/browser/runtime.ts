import type { ExtensionRequest } from "../shared/messages.ts";

export async function sendMessage(req: ExtensionRequest): Promise<unknown> {
  return chrome.runtime.sendMessage(req);
}

export function addMessageListener(
  fn: (message: unknown, respond: (response: unknown) => void) => boolean,
): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
    fn(message, sendResponse),
  );
}

export function addCommandListener(fn: (command: string) => void): void {
  chrome.commands.onCommand.addListener(fn);
}

export function addInstalledListener(fn: () => void): void {
  chrome.runtime.onInstalled.addListener(() => fn());
}
