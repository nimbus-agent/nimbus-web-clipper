// Which hosts have the ambient cue switched on.
//
// Keyed by HOST PERMISSION PATTERN — the same identifier the page-access grant
// is keyed by (shared/origins.ts#hostPermissionPattern, and the Jira Cloud
// wildcard) — so the toggle and the grant can never end up describing different
// hosts. Carries no secret, like origin-store.ts and unlike connection-store.ts,
// so the Options page reads and writes it directly.
//
// There is deliberately no in-memory cache. See the design spec's "Deferred,
// with reasons": the read sits behind three filters already, and a cache's
// failure mode is a cue appearing on a host the user just switched off.
import { storageGet, storageSet } from "../browser/storage.ts";
import { patternMatchesUrl } from "../shared/origins.ts";

const AMBIENT_KEY = "ambient-hosts";

/** Stored data is external input: filter through the guard, never cast. */
export async function getAmbientHosts(): Promise<string[]> {
  const value = await storageGet(AMBIENT_KEY);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
}

export async function setAmbientHost(pattern: string, on: boolean): Promise<void> {
  const current = await getAmbientHosts();
  const next = on
    ? [...new Set([...current, pattern])]
    : current.filter((existing) => existing !== pattern);
  await storageSet(AMBIENT_KEY, next);
}

/** Pure: is this page URL on a host the user switched the cue on for? */
export function isAmbientUrl(url: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => patternMatchesUrl(pattern, url));
}
