export async function storageGet(key: string): Promise<unknown> {
  const got = await chrome.storage.local.get(key);
  return (got as Record<string, unknown>)[key];
}

export async function storageSet(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function storageRemove(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}
