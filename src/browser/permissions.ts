// The only place chrome.permissions is touched.
//
// Patterns handed to these functions are HOST-scoped (see
// shared/origins.ts#hostPermissionPattern). `request` must run inside a user
// gesture, so it is only ever called from an Options page click handler — never
// from the service worker, where it would reject.
export async function hasOrigin(pattern: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [pattern] });
}

/** Resolves false when the user declines or the call rejects (no gesture). */
export async function requestOrigin(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

export async function removeOrigin(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    return false;
  }
}
