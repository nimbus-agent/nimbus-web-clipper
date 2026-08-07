// Persistence for the user's recognised-surface origins.
//
// Unlike connection-store.ts (which holds the bearer token and is background-only),
// this store carries no secret and is read directly by the Options page as well —
// chrome.storage.local is shared across extension contexts.
import { storageGet, storageSet } from "../browser/storage.ts";
import { isConfiguredOrigin } from "../shared/origins.ts";
import type { ConfiguredOrigin } from "../shared/types.ts";

const ORIGINS_KEY = "origins";

/** Stored data is external input: filter through the guard, never cast. */
export async function getOrigins(): Promise<ConfiguredOrigin[]> {
  const value = await storageGet(ORIGINS_KEY);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isConfiguredOrigin);
}

export async function setOrigins(list: readonly ConfiguredOrigin[]): Promise<void> {
  await storageSet(ORIGINS_KEY, [...list]);
}
