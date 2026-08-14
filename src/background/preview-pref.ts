// Whether the popup shows the payload before sending it.
//
// Carries no secret, so the Options page and the popup read and write it
// directly — the same arrangement ambient-prefs.ts uses, and unlike
// connection-store.ts which holds the token.
import { storageGet, storageSet } from "../browser/storage.ts";

const PREVIEW_KEY = "preview-enabled";

/**
 * DEFAULTS TO ON, and any unreadable value falls back to ON.
 *
 * Fail safe, not fail quiet: showing a preview the user switched off is a minor
 * annoyance, while sending without one because storage returned something odd is
 * precisely the outcome this slice exists to prevent.
 */
export async function isPreviewEnabled(): Promise<boolean> {
  const value = await storageGet(PREVIEW_KEY);
  return typeof value === "boolean" ? value : true;
}

export async function setPreviewEnabled(on: boolean): Promise<void> {
  await storageSet(PREVIEW_KEY, on);
}
