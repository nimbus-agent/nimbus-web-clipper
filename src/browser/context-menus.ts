// Thin typed seam over chrome.contextMenus — the only place the API is touched,
// so the SW's menu logic stays unit-testable.
export interface MenuItem {
  readonly id: string;
  readonly title: string;
  readonly contexts: readonly chrome.contextMenus.ContextType[];
}

export function createMenu(item: MenuItem): void {
  chrome.contextMenus.create({ id: item.id, title: item.title, contexts: [...item.contexts] });
}

export async function removeAllMenus(): Promise<void> {
  // removeAll is callback-style and returns void, so `await`ing it directly
  // resolved immediately — before the removal had actually completed, letting a
  // subsequent createMenu race a still-pending teardown into duplicate ids.
  // Promisify the callback so the await means what it says. Passing an explicit
  // callback (rather than relying on Chrome 91+ returning a promise) also keeps
  // this working on Firefox MV3.
  await new Promise<void>((resolve) => {
    chrome.contextMenus.removeAll(() => resolve());
  });
}

export function addMenuClickListener(
  fn: (menuItemId: string, tabId: number | undefined) => void,
): void {
  chrome.contextMenus.onClicked.addListener((info, tab) => fn(String(info.menuItemId), tab?.id));
}
