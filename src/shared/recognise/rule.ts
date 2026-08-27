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
