// Thin typed seam over chrome.contextMenus — the only place the API is touched,
// so the SW's menu logic stays unit-testable.
/**
 * The string VALUES of chrome.contextMenus.ContextType, not its enum members.
 *
 * @types/chrome 0.2.5 turned ContextType from a string union into a real TS enum, so the bare
 * `ContextType[]` stopped accepting literals like "page" — an enum member is not its own string.
 * The extension API has not changed: it still takes those strings, and Chrome's own signature is
 * now spelled with this same template-literal form. Writing the enum here instead would force
 * every call site to import a value at runtime purely to satisfy the checker.
 */
export type MenuContext = `${chrome.contextMenus.ContextType}`;

export interface MenuItem {
  readonly id: string;
  readonly title: string;
  /**
   * Non-empty by construction. chrome.contextMenus.create rejects an empty `contexts`, and
   * @types/chrome now encodes that as a non-empty tuple — so an empty literal is a compile
   * error here rather than a runtime failure inside the service worker.
   */
  readonly contexts: readonly [MenuContext, ...MenuContext[]];
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
