// Whether a brief also searches what the gateway has indexed.
//
// Carries no secret, so the composer and the Options page read and write it
// directly — the same arrangement preview-pref.ts and ambient-prefs.ts use.
import { storageGet, storageSet } from "../browser/storage.ts";

const INDEX_SEARCH_KEY = "index-search-enabled";

/**
 * DEFAULTS TO OFF, and any unreadable value falls back to OFF.
 *
 * This is the OPPOSITE direction from `isPreviewEnabled`, deliberately. There,
 * failing on shows a preview nobody asked for — a minor annoyance. Here, failing
 * on would widen what a run consults, and send a question to be matched against
 * a corpus the user never agreed to involve. The fail-safe direction for a
 * control like that is: don't.
 */
export async function isIndexSearchEnabled(): Promise<boolean> {
  const value = await storageGet(INDEX_SEARCH_KEY);
  return value === true;
}

export async function setIndexSearchEnabled(on: boolean): Promise<void> {
  await storageSet(INDEX_SEARCH_KEY, on);
}
