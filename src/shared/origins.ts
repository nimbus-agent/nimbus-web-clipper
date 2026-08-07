// The configured-origin model: which page origins may be recognised, and which
// product each one is running.
//
// DELIBERATELY SEPARATE from shared/gateway.ts. That module validates the ONE
// loopback origin the extension may talk to, and its rule is a security
// invariant (I6). This module validates origins whose PAGES may be recognised —
// a different axis entirely. Sharing a helper between the two would invite a
// change that quietly relaxes one by editing the other.
import type { ConfiguredOrigin, Product } from "./types.ts";

const PRODUCTS: ReadonlySet<string> = new Set(["bitbucket", "github", "gitlab", "jenkins", "jira"]);

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
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return { base: url.origin, prefix: path };
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
 */
export function hostPermissionPattern(origin: string): string | null {
  const split = splitOrigin(origin);
  return split === null ? null : `${split.base}/*`;
}
