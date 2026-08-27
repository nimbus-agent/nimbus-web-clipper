// The configured-origin model: which page origins may be recognised, and which
// product each one is running.
//
// DELIBERATELY SEPARATE from shared/gateway.ts. That module validates the ONE
// loopback origin the extension may talk to, and its rule is a security
// invariant (I6). This module validates origins whose PAGES may be recognised —
// a different axis entirely. Sharing a helper between the two would invite a
// change that quietly relaxes one by editing the other.
import type { ConfiguredOrigin, Product } from "./types.ts";
import { PRODUCT_IDS } from "./types.ts";

const PRODUCTS: ReadonlySet<string> = new Set<string>(PRODUCT_IDS);

export function isProduct(v: unknown): v is Product {
  return typeof v === "string" && PRODUCTS.has(v);
}

export function isConfiguredOrigin(v: unknown): v is ConfiguredOrigin {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const rec = v as Record<string, unknown>;
  return typeof rec["origin"] === "string" && isProduct(rec["product"]);
}

/**
 * Split a stored origin into its URL origin and its path prefix ("" when none).
 * The URL parser does the normalising: it lowercases scheme and host and drops a
 * default port, so two spellings of the same origin cannot diverge here.
 *
 * The PATH is deliberately left case-sensitive. URL paths are case-sensitive per
 * RFC 3986 and on the servers these instances run on, so "/Jenkins" and
 * "/jenkins" really are different context paths. More importantly, the prefix is
 * carried verbatim into `resolveUrl`, which must be byte-identical to the
 * `canonical_url` the connector indexed — case-folding it would silently turn a
 * resolvable page into a permanent miss.
 */
export function splitOrigin(origin: string): { base: string; prefix: string } | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  // Strip EVERY trailing slash, not just one: "/jira//" must normalise to the
  // same "/jira" a user who typed it cleanly gets, or the two spellings become
  // two entries that dedupe can't see are the same, and which of them wins a
  // match then depends on insertion order.
  //
  // A backward scan, NOT `replace(/\/+$/, "")`. That pattern is quadratic on a
  // path whose slash run does not reach the end: the engine matches the run, fails
  // `$`, gives a character back, fails again, then restarts the whole walk from the
  // next position in the run. Measured: 20 000 leading slashes 90 ms, 40 000 363 ms
  // — 2x input, 4x time. The path comes from `new URL()` over a string the user
  // pastes into the options page, so `http://x/` + 40 000 slashes + `a` is a
  // one-paste stall; and because the stored origin is re-split on every page
  // recognition (`recognise.ts`) and once per row in the surfaces list, the cost is
  // re-paid on every use rather than once at entry. Scanning back from the end
  // touches each trailing slash exactly once.
  const pathname = url.pathname;
  let end = pathname.length;
  while (end > 0 && pathname[end - 1] === "/") end -= 1;
  return { base: url.origin, prefix: pathname.slice(0, end) };
}

/** Parse user input into a stored entry, or null when it isn't a usable origin. */
export function parseConfiguredOrigin(raw: string, product: Product): ConfiguredOrigin | null {
  const split = splitOrigin(raw.trim());
  if (split === null) {
    return null;
  }
  return { origin: `${split.base}${split.prefix}`, product };
}

/** Add or replace by origin+prefix — one product per entry, not per host. */
export function upsertOrigin(
  list: readonly ConfiguredOrigin[],
  entry: ConfiguredOrigin,
): ConfiguredOrigin[] {
  return [...list.filter((o) => o.origin !== entry.origin), entry];
}

export function removeConfiguredOrigin(
  list: readonly ConfiguredOrigin[],
  origin: string,
): ConfiguredOrigin[] {
  return list.filter((o) => o.origin !== origin);
}

/**
 * Longest-prefix-wins lookup for a page URL. This is what lets one host carry
 * several products (/jira and /jenkins) and what settles a bare host entry
 * sitting alongside a prefixed one. The `${prefix}/` boundary check stops
 * "/jira" from matching "/jiraffe".
 */
export function matchOrigin(list: readonly ConfiguredOrigin[], url: URL): ConfiguredOrigin | null {
  let best: ConfiguredOrigin | null = null;
  let bestLength = -1;
  for (const entry of list) {
    const split = splitOrigin(entry.origin);
    if (split?.base !== url.origin) {
      continue;
    }
    const path = url.pathname;
    const hit = split.prefix === "" || path === split.prefix || path.startsWith(`${split.prefix}/`);
    if (hit && split.prefix.length > bestLength) {
      best = entry;
      bestLength = split.prefix.length;
    }
  }
  return best;
}

/**
 * The match pattern requested for a configured origin. HOST-SCOPED on purpose,
 * even when the origin carries a path prefix: the browser's permission warning is
 * per-host either way, so a path-scoped pattern buys no privacy while costing
 * exact-pattern bookkeeping in `permissions.contains` and revocation.
 *
 * The PORT IS DROPPED because a WebExtension match pattern's host component may
 * not contain one — `https://stash.corp.example:8443/*` is not a valid pattern,
 * and passing it to permissions.request fails. Self-hosted Bitbucket Server and
 * Jenkins commonly run on :8443 / :8080, so this is the normal case here, not an
 * edge case. A portless pattern is also the only thing expressible: it matches
 * the host on every port, which is what the browser gives us either way.
 */
export function hostPermissionPattern(origin: string): string | null {
  const split = splitOrigin(origin);
  if (split === null) {
    return null;
  }
  // `split.base` is a valid absolute origin, so this parse cannot throw.
  const url = new URL(split.base);
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * Does a host permission pattern cover this URL?
 *
 * Deliberately NOT a general match-pattern implementation. The only patterns
 * this extension can produce are `scheme://host/*` (hostPermissionPattern
 * above) and the ONE subdomain-wildcard form Jira Cloud needs, because its
 * tenant hosts are not enumerable. `<all_urls>`, scheme wildcards and path
 * components are rejected rather than interpreted: nothing here may create
 * them, so accepting them could only ever widen a match by accident.
 *
 * The PORT is ignored, exactly as the browser does — a pattern's host may not
 * carry one (see hostPermissionPattern), so a granted host is granted on every
 * port it serves.
 */
export function patternMatchesUrl(pattern: string, url: string): boolean {
  const parts = /^(https?):\/\/(\*\.)?([^/*:]+)\/\*$/.exec(pattern);
  if (parts === null) {
    return false;
  }
  const [, scheme, wildcard, host] = parts;
  if (scheme === undefined || host === undefined) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== `${scheme}:`) {
    return false;
  }
  const found = parsed.hostname.toLowerCase();
  const want = host.toLowerCase();
  if (wildcard === undefined) {
    return found === want;
  }
  // The `.` boundary is what stops "*.atlassian.net" matching
  // "evilatlassian.net"; the bare host itself is included, matching how the
  // browser reads the same pattern.
  return found === want || found.endsWith(`.${want}`);
}
