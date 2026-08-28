// Pure page classification: URL + the user's configured origins → what item this
// page is. No I/O, no chrome.*, no DOM — the service worker calls this before it
// asks the gateway anything.
//
// The product is NEVER guessed from the path. A proxied or path-prefixed
// self-hosted instance would produce a confidently wrong header, and on a surface
// whose whole job is recognition, a wrong header is worse than no header.
import { hostPermissionPattern, matchOrigin, splitOrigin } from "../origins.ts";
import type { ConfiguredOrigin, Product, Recognition, SurfaceKind } from "../types.ts";
import { PRODUCT_RULES, RULE_BY_PRODUCT } from "./registry.ts";

/** SaaS hosts that need no configuration. Derived: a product's built-in origins
 *  are the `origin` host rules it declares. Suffix hosts (Jira Cloud) are not
 *  origins and are matched by `suffixEntry` below. */
export const BUILT_IN_ORIGINS: readonly ConfiguredOrigin[] = PRODUCT_RULES.flatMap((rule) =>
  rule.hosts
    .filter((host) => host.kind === "origin")
    .map((host) => ({ origin: host.origin, product: rule.product })),
);

/**
 * A built-in surface as the Options page shows it: a host the extension
 * recognises without configuration, and the permission pattern its page-access
 * grant is keyed by.
 *
 * DERIVED from the registry's host rules. An `origin` host's label is its
 * hostname and its pattern is `hostPermissionPattern(origin)`; a `suffix` host
 * has no origin at all, so it labels itself `*<suffix>` and carries the wildcard
 * pattern its rule declares. A product with no built-in host (Jenkins)
 * contributes no row.
 */
export interface BuiltInSurface {
  /** Shown in Options. Not an origin: Jira Cloud's is a host pattern. */
  readonly label: string;
  readonly product: Product;
  readonly pattern: string;
}

export const BUILT_IN_SURFACES: readonly BuiltInSurface[] = PRODUCT_RULES.flatMap((rule) =>
  rule.hosts.map((host) =>
    host.kind === "origin"
      ? {
          label: new URL(host.origin).hostname,
          product: rule.product,
          pattern: hostPermissionPattern(host.origin) ?? host.origin,
        }
      : {
          // The prefix is part of the LABEL because two products can share one
          // suffix, and `options.ts` routes a grant/revoke click by finding the
          // row whose label equals the clicked row's — identical labels would
          // route one product's button to the other's pattern. The `pattern` is
          // deliberately NOT prefixed: a WebExtension host permission is
          // host-scoped, so both rows share one grant, and revoking from either
          // withdraws page access for both. `options.ts`'s revoke handler already
          // says as much for sibling entries.
          label: `*${host.suffix}${host.pathPrefix ?? ""}`,
          product: rule.product,
          pattern: host.pattern,
        },
  ),
);

const KIND_NAMES: Record<SurfaceKind, string> = {
  pr: "PR",
  build: "build",
  issue: "issue",
  home: "dashboard",
  doc: "doc",
  incident: "incident",
};

function labelFor(product: Product, kind: SurfaceKind): string {
  if (product === "gitlab" && kind === "pr") {
    return "GitLab MR";
  }
  return `${RULE_BY_PRODUCT[product].name} ${KIND_NAMES[kind]}`;
}

/**
 * A built-in host whose tenant is a subdomain.
 *
 * Generalised from a hardcoded Jira Cloud check: every tenant of `*.atlassian.net`
 * is its own host, so the hosts cannot be enumerated and cannot appear in
 * `BUILT_IN_ORIGINS`. Checked only AFTER `matchOrigin`, so a user-configured
 * entry on such a host still wins.
 *
 * Two products may claim one suffix (Confluence owns `/wiki` on the host Jira
 * takes the rest of). Rather than settle that by iteration order, every matching
 * rule becomes a candidate `ConfiguredOrigin` carrying its own `pathPrefix`, and
 * `matchOrigin` picks the longest matching prefix — the same longest-prefix rule
 * that already settles two self-hosted products on one host, and the same one
 * whose `${prefix}/` boundary check stops `/wiki` matching `/wikifoo`.
 */
function suffixEntry(url: URL): ConfiguredOrigin | null {
  // The leftmost label only. `split(".")[0]` on a hostname is always present and
  // always lower-case, so no normalisation is needed on either side.
  const [label = ""] = url.hostname.split(".");
  const candidates: ConfiguredOrigin[] = [];
  for (const rule of PRODUCT_RULES) {
    for (const host of rule.hosts) {
      if (host.kind !== "suffix" || !url.hostname.endsWith(host.suffix)) {
        continue;
      }
      if (host.excludedLabels?.includes(label) === true) {
        continue;
      }
      candidates.push({ origin: `${url.origin}${host.pathPrefix ?? ""}`, product: rule.product });
    }
  }
  return matchOrigin(candidates, url);
}

export function recognise(url: string, origins: readonly ConfiguredOrigin[]): Recognition {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "unknown-host" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unknown-host" };
  }
  // User entries first so a configured prefix can win over a built-in bare host.
  const entry = matchOrigin([...origins, ...BUILT_IN_ORIGINS], parsed) ?? suffixEntry(parsed);
  if (entry === null) {
    return { ok: false, reason: "unknown-host" };
  }
  const split = splitOrigin(entry.origin);
  if (split === null) {
    return { ok: false, reason: "unknown-host" };
  }
  const rest = parsed.pathname.slice(split.prefix.length);
  const segments = rest.split("/").filter((part) => part !== "");
  const match = RULE_BY_PRODUCT[entry.product].match(segments);
  if (match === null) {
    return { ok: false, reason: "unrecognised-path" };
  }
  // The URL we hand the gateway. It is the ADDRESS-BAR URL with one narrow
  // change: the matched path prefix is swapped for the matcher's normalised form
  // (today only Jira does this, upper-casing the issue key). Everything else —
  // sub-tab segments, query string — is preserved deliberately.
  //
  // Canonicalisation is the GATEWAY's job: canonicalizeUrl drops the fragment,
  // utm_*/click-ids and a trailing slash, then the ladder tries the exact key, the
  // query-stripped key, and up to three trimmed path segments. Doing any of that
  // here would be work the gateway redoes under different rules — and its rules
  // are load-bearing, because externalIdFor hashes canonicalizeUrl's output.
  //
  // Identity normalisation is NOT canonicalisation and stays here: the ladder is
  // case-sensitive, so a lower-cased Jira key would miss rungs 1 and 2 and then
  // trim away the key entirely on rung 3.
  const matchedPrefix = `${split.base}${split.prefix}${match.matchedPath}`;
  const resolveUrl = url.startsWith(matchedPrefix)
    ? `${split.base}${split.prefix}${match.path}${url.slice(matchedPrefix.length)}`
    : url;
  return {
    ok: true,
    product: entry.product,
    kind: match.kind,
    label: labelFor(entry.product, match.kind),
    ref: match.ref,
    resolveUrl,
  };
}

/**
 * "Bitbucket PR · acme/web #482" — the panel header's first line.
 *
 * A home recognition carries an EMPTY `ref` (see `homeMatch`), so it renders as
 * the label alone rather than trailing a bare separator.
 */
export function surfaceLine(r: Recognition): string | null {
  if (!r.ok) {
    return null;
  }
  return r.ref === "" ? r.label : `${r.label} · ${r.ref}`;
}

/**
 * Whether two recognitions name the SAME indexed item.
 *
 * NOT a URL comparison, and it must not become one: `resolveUrl` above keeps
 * sub-tab segments and the query string on purpose, so `/pull/482` and
 * `/pull/482/files` differ as URLs while being one pull request. The identity is
 * `(product, kind, ref)`, all three of which the matchers normalise.
 *
 * Two UNRECOGNISED pages compare EQUAL: both are "no item here", and their
 * `reason` describes the URL, not a different item. The panel's navigation watcher
 * relies on that — otherwise moving between two unrecognised pages under an open
 * panel would announce a change the user cannot see.
 */
export function sameItem(a: Recognition, b: Recognition): boolean {
  if (!a.ok || !b.ok) {
    return !a.ok && !b.ok;
  }
  return a.product === b.product && a.kind === b.kind && a.ref === b.ref;
}
