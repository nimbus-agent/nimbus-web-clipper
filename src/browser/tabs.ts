export async function activeTab(): Promise<{ id: number; url: string; title: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    throw new Error("no active tab");
  }
  return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
}
