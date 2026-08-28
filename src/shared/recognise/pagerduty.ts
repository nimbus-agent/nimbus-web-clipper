import { homeMatch, type Match, type ProductRule } from "./rule.ts";

/**
 * PagerDuty resource ids are upper-case alphanumeric ("PT4KHLK").
 *
 * This is BELT TO THE DENYLIST'S BRACE, not decoration. PagerDuty publishes no
 * reserved-subdomain list, so `excludedLabels` below cannot be exhaustive — and
 * the collision it guards against, `status.pagerduty.com/incidents/<id>`, is a
 * Statuspage URL whose ids are LOWER-CASE ("hbjm8pfyzs7q", verified live
 * 2026-08-28). Requiring upper-case therefore rejects the shape of the very
 * pages the denylist exists to remove, including ones it has not learned about.
 *
 * The trade-off, stated plainly: if PagerDuty ever mints a lower-case id we miss
 * a real incident. That failure is a missing header, which this repo prefers to
 * a wrong one.
 */
const INCIDENT_ID = /^[A-Z0-9]{6,}$/;

function match(s: readonly string[]): Match | null {
  const [section, id] = s;
  if (section !== "incidents") {
    return null;
  }
  if (id !== undefined) {
    if (!INCIDENT_ID.test(id)) {
      return null;
    }
    // Trailing segments are left outside `matchedPath` and preserved in the
    // resolveUrl, the same way GitHub's `/pull/482/files` keeps its sub-tab.
    const path = `/incidents/${id}`;
    return { kind: "incident", ref: id, path, matchedPath: path };
  }
  // Exactly `/incidents` — the connector-wide list. Checked only after the item
  // arm has declined, so an incident page can never land here.
  return s.length === 1 ? homeMatch("/incidents") : null;
}

export const pagerdutyRule: ProductRule = {
  product: "pagerduty",
  serviceId: "pagerduty",
  name: "PagerDuty",
  hosts: [
    {
      kind: "suffix",
      // Every account is its own subdomain (`acme.pagerduty.com`), and EU-region
      // accounts add a region label (`acme.eu.pagerduty.com`) that this suffix
      // still covers.
      suffix: ".pagerduty.com",
      pattern: "https://*.pagerduty.com/*",
      /**
       * PagerDuty's own published subdomains. Two groups:
       *
       * VERIFIED vendor hosts, each fetched on 2026-08-28 — `status` (a
       * Statuspage whose `/incidents/<id>` pages collide with ours exactly),
       * `support`, `developer`, `community`, `response` (the public incident
       * response guide), `identity` (the SSO entry point named in PagerDuty's
       * "Log In to PagerDuty").
       *
       * STRUCTURALLY IMPOSSIBLE as tenants — PagerDuty Support's "Account
       * Subdomains" requires five or more characters, so `www`, `api`, `docs`,
       * `blog` and `eu` can never be an account. Cheap hardening with no risk of
       * excluding a real customer.
       *
       * The list is not exhaustive and cannot be: PagerDuty publishes no reserved
       * list. `INCIDENT_ID` above is the second line of defence.
       */
      excludedLabels: [
        "api",
        "blog",
        "community",
        "developer",
        "docs",
        "eu",
        "identity",
        "response",
        "status",
        "support",
        "www",
      ],
    },
  ],
  corpus: "PagerDuty incidents",
  // SaaS only — there is no PagerDuty edition a user could point Nimbus at.
  selfHostable: false,
  match,
};
