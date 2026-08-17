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
 * (service-worker.ts's `enabledHosts`, via `hasOrigin`) is the second lock: it
 * catches a grant withdrawn through chrome://extensions, which clears the
 * browser's permission without touching the stored ambient-hosts preference
 * this callback cannot see.
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

/** One tab the brief composer may offer as a source. */
export type CandidateTab = {
  readonly id: number;
  readonly url: string;
  readonly title: string;
};

/**
 * `named` is every tab we may both describe and capture. `hiddenCount` is how
 * many others exist that we may do neither with.
 */
export type TabCandidates = {
  readonly named: readonly CandidateTab[];
  readonly hiddenCount: number;
  /**
   * True when the query itself failed, as opposed to genuinely finding nothing.
   *
   * These are different facts and must not render identically: an empty list
   * says "nothing here to brief on", a failed query says "we could not look".
   * This flag is how the failure reaches the user, which is the only place it
   * can go — `noConsole` is an error inside `src/` and this extension ships no
   * telemetry, so there is no log to write it to and there should not be one.
   */
  readonly enumerationFailed: boolean;
};

const RESTRICTED_TAB_SCHEMES = new Set([
  "chrome:",
  "chrome-extension:",
  "moz-extension:",
  "about:",
  "edge:",
  "view-source:",
]);

/**
 * Deliberately a local copy of `capture-tab.ts`'s scheme set rather than an
 * import: `src/browser/` is the `chrome.*` seam and must not depend on
 * `src/background/`. `captureTab` re-checks the same rule at injection time, so
 * this one is a UI filter and that one is the security boundary. A third copy
 * would belong in `src/shared/`.
 */
function isRestrictedTabUrl(url: string): boolean {
  try {
    return RESTRICTED_TAB_SCHEMES.has(new URL(url).protocol);
  } catch {
    return true;
  }
}

/**
 * The brief composer's source pool.
 *
 * The permission axis and the capability axis are the same set here, which is
 * why this needs no `tabs` permission. `chrome.tabs.query` returns a `Tab` for
 * every tab but strips `url` / `title` unless we hold host permission for it —
 * the same boundary `addNavigationListener` above relies on — and host
 * permission is exactly what `scripting.executeScript` needs to capture the
 * page. So a tab we can name is a tab we can read, and a tab we cannot name we
 * could not have captured either.
 *
 * An unnamed tab is COUNTED, never guessed at: "3 open tabs are on sites you
 * haven't granted page access to" is honest, and inventing a label for one is
 * not. An inline `chrome.permissions.request` cannot help — it needs the
 * concrete origins, which are precisely what is being withheld.
 *
 * Restricted-scheme tabs are in neither number. They are visible but
 * uninjectable, so listing one offers a capture that always fails, and counting
 * one as ungranted sends the user to Options to fix something no grant can.
 */
export async function listCandidateTabs(): Promise<TabCandidates> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return { named: [], hiddenCount: 0, enumerationFailed: true };
  }
  const named: CandidateTab[] = [];
  let hiddenCount = 0;
  for (const tab of tabs) {
    const id = tab.id;
    if (id === undefined) {
      continue;
    }
    const url = tab.url;
    if (typeof url !== "string" || url === "") {
      hiddenCount += 1;
      continue;
    }
    if (isRestrictedTabUrl(url)) {
      continue;
    }
    named.push({ id, url, title: tab.title ?? url });
  }
  return { named, hiddenCount, enumerationFailed: false };
}
