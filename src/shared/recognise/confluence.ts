import { homeMatch, type Match, type ProductRule } from "./rule.ts";

// Cloud page ids are decimal. Verified live 2026-08-28 against
// lf-toip.atlassian.net/wiki/spaces/HOME/pages/22970764/Getting+Started+with+Confluence+Wiki.
const PAGE_ID = /^\d+$/;

function match(s: readonly string[]): Match | null {
  // Segments are relative to the `/wiki` prefix the host rule declares, which
  // `recognise()` has already stripped via `splitOrigin`.
  const [section, spaceKey, pages, id] = s;
  if (section === "spaces" && spaceKey !== undefined && pages === "pages") {
    if (id === undefined || !PAGE_ID.test(id)) {
      return null;
    }
    // The space key is taken as-is, not pattern-matched: personal spaces are
    // `~<accountId>`, and a key pattern would only add false negatives on a shape
    // Atlassian chose. The trailing title segment is deliberately outside
    // `matchedPath` — Confluence serves the same page with and without it and
    // rewrites it on rename, so it must not reach the ref.
    const path = `/spaces/${spaceKey}/pages/${id}`;
    return { kind: "doc", ref: `${spaceKey}/${id}`, path, matchedPath: path };
  }
  // The product root. Unlike a bare `/` on a tenant host, `/wiki` is reachable
  // only through this rule's own path prefix, so it names Confluence and nothing
  // else — the concern behind "a tenant-suffix rule must never claim bare `/`"
  // is the HOST being ambiguous, and the prefix is what removes that ambiguity.
  if (s.length === 0) {
    return homeMatch("");
  }
  // `/wiki/home` verified live (rtulv.atlassian.net/wiki/home);
  // `/wiki/dashboard.action` is documented in Atlassian Support's "Change the
  // landing page" and is what a site configured to the classic dashboard serves.
  if (s.length === 1 && (section === "home" || section === "dashboard.action")) {
    return homeMatch(`/${section}`);
  }
  // A space overview (`/spaces/<KEY>` and `/spaces/<KEY>/overview`) is NOT a
  // dashboard and falls through to here on purpose: `home` claims the whole
  // connector, and a single space is not that. Blog posts
  // (`/spaces/<KEY>/blog/<y>/<m>/<d>/<id>/<title>`) are simply not modelled yet.
  return null;
}

export const confluenceRule: ProductRule = {
  product: "confluence",
  serviceId: "confluence",
  name: "Confluence",
  hosts: [
    {
      kind: "suffix",
      suffix: ".atlassian.net",
      pattern: "https://*.atlassian.net/*",
      // The shared-host split: Confluence owns `/wiki`, Jira takes the rest.
      pathPrefix: "/wiki",
      // No `excludedLabels`, and that is a finding rather than an omission:
      // www.atlassian.net is a REAL Jira Cloud site (verified 2026-08-28 — it
      // 302s to id.atlassian.com carrying a live site ARI), so the labels a
      // vendor publishes for itself on `.pagerduty.com` have no counterpart
      // here. Atlassian sells the whole subdomain space to tenants.
    },
  ],
  corpus: "Confluence pages",
  // Confluence Data Center is a real self-hosted edition, commonly behind a
  // reverse proxy on `/wiki` — which the user's own entry expresses directly.
  selfHostable: true,
  match,
};
