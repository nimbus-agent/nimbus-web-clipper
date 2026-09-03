// What every product module declares, and the two helpers their matchers share.
// No product knowledge lives here — a rule that needed a special case in this
// file would be a rule the registry cannot treat like the others.
import type { Product, SurfaceKind } from "../types.ts";

/** One matched page. `path` is the matcher's NORMALISED form and `matchedPath`
 *  is what it matched in the incoming URL; `recognise()` swaps one for the other
 *  to build `resolveUrl`, which is why both are carried. */
export interface Match {
  readonly kind: SurfaceKind;
  readonly ref: string;
  readonly path: string;
  readonly matchedPath: string;
  /**
   * The forge coordinate, on a `file` match only.
   *
   * Carried here rather than re-derived at the call site from `path`: deriving one
   * from the other is exactly the drift the registry exists to prevent, and the three
   * forges spell the same coordinate differently (`/blob/`, `/-/blob/`, `/src/`).
   *
   * `refAndPath` is everything after the delimiter, ref and path STILL JOINED. A branch
   * name may contain slashes, so `feat/auth-v2/src/foo.ts` cannot be split here without
   * the repository's branch list — which would be a forge API call this client must
   * never make. The gateway holds the file list and splits it there.
   */
  readonly forgeFile?: { readonly repo: string; readonly refAndPath: string };
}

/**
 * A built-in host a product owns.
 *
 * `origin` is an exact origin (`https://github.com`). `suffix` is a tenant
 * scheme where every customer gets its own host (`*.atlassian.net`), so the
 * hosts cannot be enumerated and the permission `pattern` is a wildcard.
 */
export type HostRule =
  | { readonly kind: "origin"; readonly origin: string }
  | {
      readonly kind: "suffix";
      /**
       * MUST begin with a dot, and the type enforces it — a dotless
       * `"atlassian.net"` would make `endsWith` match `evilatlassian.net`, which
       * is a confidently wrong header on a host the owner does not control.
       * `` `.${string}` `` makes that a compile error rather than a review catch.
       *
       * The match is subdomains ONLY: the apex (`atlassian.net` itself) is not a
       * tenant, and recognising it would claim a marketing host as somebody's
       * Jira. `endsWith(".atlassian.net")` is already false for the apex, and the
       * pinning test in `recognise.test.ts` keeps it that way.
       */
      readonly suffix: `.${string}`;
      readonly pattern: string;
      /**
       * The path prefix this product owns on a host it SHARES with another
       * product. Confluence is `/wiki` on the `*.atlassian.net` host Jira also
       * claims; Jira declares no prefix and takes everything else.
       *
       * `suffixEntry` appends this to the page's origin and hands the candidates
       * to `matchOrigin`, so the winner is the LONGEST matching prefix — the same
       * rule that already settles two self-hosted products on one host, and the
       * same rule that gives `/wiki` its `${prefix}/` boundary check so it cannot
       * claim `/wikifoo`. Registry key order does not decide this and must not be
       * made to.
       */
      readonly pathPrefix?: string;
      /**
       * Leftmost host labels that are the VENDOR's own subdomains, not tenants.
       *
       * A suffix matches every subdomain, including the ones a vendor publishes
       * for itself, and those hosts serve the product's own paths:
       * `status.pagerduty.com/incidents` matches PagerDuty's suffix and a
       * recognised dashboard path at once. So a specific path is necessary and
       * not sufficient — the host has to be constrained too, and this is the
       * only place that happens. `suffixEntry` checks it BEFORE any matcher
       * runs, which is why one entry covers the item arm and the dashboard arm
       * together.
       *
       * PER-RULE, and that is load-bearing rather than incidental: the names a
       * vendor reserves are a fact about that vendor. `www.atlassian.net` is a
       * REAL Jira Cloud site, so one shared list containing "www" would break a
       * genuine tenant. `.atlassian.net` therefore declares none.
       *
       * A denylist cannot be exhaustive — tenant labels are arbitrary customer
       * strings with no structure to allowlist against — and nothing downstream
       * makes up for what it misses. A missed vendor label is treated as a
       * tenant, and the product's own matcher is then the last thing standing
       * between that page and a wrong header, so do not reason about an id
       * pattern as a second line of defence: a vendor's own ids look like the
       * product's own. Where the vendor documents a minimum subdomain length,
       * `minTenantLabelLength` carries the short labels structurally and this
       * list only has to name the long ones.
       */
      readonly excludedLabels?: readonly string[];
      /**
       * The vendor's DOCUMENTED minimum subdomain length. A leftmost label
       * shorter than this cannot be a customer tenant, so `suffixEntry` refuses
       * the host — the same effect as an `excludedLabels` entry, but derived
       * from a published rule rather than from someone having heard of the name,
       * so it also refuses the short vendor hosts nobody has enumerated.
       *
       * Declare it ONLY where the vendor publishes the rule. PagerDuty does
       * (Support, "Account Subdomains": "a minimum of five characters"), so its
       * rule says 5 and `go`, `app`, `api` and `www` need no entry in the list.
       * Atlassian publishes no such rule and `www.atlassian.net` is a real
       * tenant, so `.atlassian.net` declares nothing — a guessed floor there
       * would silence a genuine customer's site, which is the failure this whole
       * mechanism is trying to avoid in the other direction.
       */
      readonly minTenantLabelLength?: number;
    };

/** One product, as the registry sees it. */
export interface ProductRule {
  readonly product: Product;
  /** The gateway's connector id. Convention between two repos, not contract —
   *  see the `PRODUCT_SERVICE_ID` doc comment. */
  readonly serviceId: string;
  /** Display name: "GitHub", "Jira". */
  readonly name: string;
  readonly hosts: readonly HostRule[];
  /**
   * What this connector's indexed items ARE, for a dashboard's scope line
   * ("Nimbus can answer across all indexed GitHub repositories"). The noun is a
   * claim about coverage — a wrong one reads as a promise the answer does not
   * keep, which is why it lives beside the product rather than in a table one
   * file away that a new product can be added without.
   */
  readonly corpus: string;
  /**
   * Does this product have a self-hosted edition a user could point Nimbus at?
   *
   * Gates the Options page's self-hosted product picker AND the submit path
   * behind it (`addSurface` in `options.ts` re-checks it before storing an
   * entry, not just at render). A SaaS-only product offered there is an
   * invitation to configure something that cannot exist — the user types an
   * origin, the entry stores, and recognition then matches a host the vendor
   * does not run.
   */
  readonly selfHostable: boolean;
  match(segments: readonly string[]): Match | null;
}

/**
 * A dashboard match. `ref` is the EMPTY STRING, constant per product, and that
 * is load-bearing: `sameItem` compares `(product, kind, ref)`, so two
 * self-hosted instances of one product compare equal here. That is correct,
 * not a bug — `serviceId` is a flat connector id, so both instances are the same
 * scope and share one answer. `path`/`matchedPath` echo the incoming path so
 * `resolveUrl` is left exactly as it arrived (nothing resolves a dashboard).
 */
export function homeMatch(path: string): Match {
  return { kind: "home", ref: "", path, matchedPath: path };
}

const NUMBER = /^\d+$/;

/** A path segment that is a bare decimal id (a PR number, a build number). */
export function isNumber(segment: string): boolean {
  return NUMBER.test(segment);
}

/**
 * The last path segment — the file's own name, for a header that must fit one line.
 *
 * `src/very/deep/path/handler.ts` reads as `handler.ts`; the full coordinate is still
 * carried in `forgeFile` for the gateway, which needs all of it.
 */
export function lastSegment(p: string): string {
  const parts = p.split("/");
  return parts.at(-1) ?? p;
}
