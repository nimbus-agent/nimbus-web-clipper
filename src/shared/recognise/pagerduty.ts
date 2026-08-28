import { homeMatch, type Match, type ProductRule } from "./rule.ts";

/**
 * PagerDuty resource ids are upper-case alphanumeric ("PT4KHLK").
 *
 * This narrows the ITEM arm, and it is NOT a host guard. The host-level defence
 * is entirely `minTenantLabelLength` plus `excludedLabels` below, both checked in
 * `suffixEntry` before any matcher runs. Do not read this regex as a backstop for
 * them: PagerDuty's own status page mints ids of exactly this shape (`PV31RQ5` —
 * seven characters, upper-case, `P`-prefixed), so a vendor subdomain the host
 * rules failed to refuse would sail straight through it.
 *
 * What it actually buys is narrowness on a host that IS a tenant: a segment
 * under `/incidents/` that is not an incident id at all — `/incidents/new` (the
 * create form), a slug, a lower-case token — must not be read as an incident, or
 * the panel puts a confident incident header on a page that is not one.
 *
 * The trade-off, stated plainly: PagerDuty documents no id format anywhere, so
 * this is an inference from first-party examples (all upper-case, 7 to 23
 * characters). If PagerDuty ever mints a lower-case id we miss a real incident.
 * That failure is a missing header, which this repo prefers to a wrong one.
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
  // Exactly `/incidents` — the connector-wide list. Reached only when there is
  // no second segment: `section === "incidents"` fixes the first one and
  // `id === undefined` means there is no second, so `s.length` is 1 here and a
  // length check would be a condition that can never be false.
  return homeMatch("/incidents");
}

export const pagerdutyRule: ProductRule = {
  product: "pagerduty",
  serviceId: "pagerduty",
  name: "PagerDuty",
  hosts: [
    {
      kind: "suffix",
      // Every account is its own subdomain (`acmeco.pagerduty.com`), and
      // EU-region accounts add a region label (`acmeco.eu.pagerduty.com`) that
      // this suffix still covers — the leftmost label is the tenant either way.
      suffix: ".pagerduty.com",
      pattern: "https://*.pagerduty.com/*",
      /**
       * PagerDuty Support's "Account Subdomains" is explicit: "There is a
       * minimum of five characters for PagerDuty subdomains." So every shorter
       * leftmost label — `go`, `app`, `api`, `www`, `eu`, `csg`, `docs`, `blog`,
       * `help`, `info`, `www2` — is structurally impossible as a customer and is
       * refused without anyone having to have heard of it. That is the half of
       * the guard that scales; the list below is the half that cannot.
       */
      minTenantLabelLength: 5,
      /**
       * PagerDuty's own published subdomains that are five characters or longer,
       * i.e. the ones the length rule above cannot settle.
       *
       * Together with `minTenantLabelLength` this is the WHOLE host-level
       * defence — nothing downstream re-checks it. A vendor host that gets past
       * both is handed to `match` as if it were a tenant, and only that
       * matcher's narrowness stands between it and a wrong header.
       *
       * OBSERVED — fetched or resolved on 2026-08-28: `status` (PagerDuty's own
       * status-page product, not an Atlassian Statuspage), `support`,
       * `developer`, `community`, `response` (the public incident-response
       * guide), `identity` (redirects into `oauth/authorize?…client_id=
       * PagerDutyLogin`), `login`, `events`, `careers`, `tickets`,
       * `postmortems`, `signup`, `summit`.
       *
       * INFERRED — the host exists but what it serves was not confirmed:
       * `university` and `investor`/`investors` answer 403 from a WAF, and
       * `packages`, `static-assets`, `static-content` and `trust` come from
       * certificate transparency for `*.pagerduty.com` rather than a fetch.
       * All are PagerDuty-controlled names no customer could hold.
       *
       * The list is not exhaustive and cannot be: `*.pagerduty.com` is a DNS
       * wildcard, PagerDuty publishes no reserved-name list, and `status` — the
       * label that motivated the whole mechanism — does not even appear in
       * certificate transparency. Adding a name here is the only remedy when one
       * is found.
       */
      excludedLabels: [
        "careers",
        "community",
        "developer",
        "events",
        "identity",
        "investor",
        "investors",
        "login",
        "packages",
        "postmortems",
        "response",
        "signup",
        "static-assets",
        "static-content",
        "status",
        "summit",
        "support",
        "tickets",
        "trust",
        "university",
      ],
    },
  ],
  corpus: "PagerDuty incidents",
  // SaaS only — there is no PagerDuty edition a user could point Nimbus at.
  selfHostable: false,
  match,
};
