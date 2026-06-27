// Thin typed seam over chrome.action's toolbar badge — no permission required.
export async function setBadgeCount(n: number): Promise<void> {
  await chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
}

export async function setBadgeBackground(color: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color });
}
