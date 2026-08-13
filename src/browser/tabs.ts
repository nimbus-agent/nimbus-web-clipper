export async function activeTab(): Promise<{ id: number; url: string; title: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    throw new Error("no active tab");
  }
  return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
}

/** A tab arriving at a new URL. `active` is the tab's own flag at event time. */
export interface TabNavigation {
  readonly tabId: number;
  readonly url: string;
  readonly active: boolean;
}

/**
 * Every navigation the extension is ALLOWED to see.
 *
 * The permission boundary is the browser's, not ours: `changeInfo.url` is
 * populated only for tabs we hold host permission on, so a page on an ungranted
 * host never reaches this callback at all. The ambient gate's own granted-check
 * is the second lock, not the first.
 *
 * Fires for history-API navigations too, which is what makes an SPA (GitHub,
 * GitLab, Jira) reach the callback without a page load.
 */
export function addNavigationListener(fn: (nav: TabNavigation) => void): void {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo.url;
    if (typeof url !== "string" || url === "") {
      return;
    }
    fn({ tabId, url, active: tab.active === true });
  });
}

export function addTabClosedListener(fn: (tabId: number) => void): void {
  chrome.tabs.onRemoved.addListener((tabId) => fn(tabId));
}

/**
 * The tab's CURRENT url, or null when the tab is gone or its url is not visible
 * to us. Null is a normal answer, not an error: it is exactly what a tab closed
 * mid-resolve looks like.
 */
export async function tabUrl(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return typeof tab.url === "string" && tab.url !== "" ? tab.url : null;
  } catch {
    return null;
  }
}
