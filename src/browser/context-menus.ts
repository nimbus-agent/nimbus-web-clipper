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
  await chrome.contextMenus.removeAll();
}

export function addMenuClickListener(
  fn: (menuItemId: string, tabId: number | undefined) => void,
): void {
  chrome.contextMenus.onClicked.addListener((info, tab) => fn(String(info.menuItemId), tab?.id));
}
