// The one place a page-declared canonical URL is judged.
//
// WHY THIS EXISTS: the gateway derives a clip's identity from what we send —
// `clip:sha256(canonicalizeUrl(canonicalUrl ?? url))` in
// `packages/gateway/src/clips/clip-ingest.ts`. So a declared canonical is not a
// hint, it is the primary key. Forwarding it unvalidated means a relative href
// gets hashed literally (two sites declaring `/blog` collide onto one item), a
// site-wide canonical collapses a whole site into one row, and a cross-origin
// one files the clip under an address the user never visited.
//
// WHAT THIS MUST NEVER DO: canonicalise. No stripping fragments, tracking
// params or trailing slashes; no lower-casing. That is the GATEWAY's job, and
// its rules are load-bearing precisely because the identity hash is taken over
// their output — doing it here would be the same work under different rules.
// See `src/shared/recognise.ts:253`. This module only ever REJECTS or
// ABSOLUTISES: path, query and fragment are forwarded exactly as declared. The
// scheme and host come back case-normalised, because that is what the URL
// parser does to any input — it is not a dedup rule this module chose.
//
// ON NON-WEB PAGES: a `file://` or `chrome-extension://` page reaches the
// scheme rung and is refused — a protocol-relative canonical inherits the
// page's scheme (`file://example.com/a`), and an absolute `https://` one is not
// same-site with a `file:` page. Both outcomes are right: a local file has no
// web identity to claim, and the clip is filed under the address bar instead.
// Noted because it looks like a bug the first time you hit it while testing
// against a page opened from disk.

/**
 * The selector both injected scripts use to find candidate declarations.
 *
 * Three details are load-bearing, and each of them was a real miss:
 *
 * - **`~=`, not `=`.** `rel` is a space-separated token list, so
 *   `rel="alternate canonical"` is a canonical declaration and an exact-match
 *   selector silently ignores it.
 * - **The `i` flag.** HTML matches `rel` keywords ASCII-case-insensitively, so
 *   `rel="Canonical"` is equally valid. CSS attribute VALUES are case-sensitive
 *   by default, so without `i` a real browser drops it. (jsdom happens to be
 *   lenient here, which is exactly why this needs saying — a test-only check
 *   would not have caught it.)
 * - **`[href]`** skips a malformed `<link rel="canonical">` carrying no href at
 *   all, which would otherwise shadow a valid declaration further down the head.
 */
export const CANONICAL_LINK_SELECTOR = 'link[rel~="canonical" i][href]';

/**
 * The first USABLE canonical declaration in a document, or `undefined`.
 *
 * `[href]` in the selector only proves the attribute is present — `href=""`
 * satisfies it. An empty declaration is not a declaration, and taking the
 * first match blindly would let one shadow a valid canonical later in the
 * head, losing it entirely. So this scans for the first candidate whose href
 * is not blank rather than trusting `querySelector`'s first hit.
 *
 * Several well-formed canonical links on one page is a misconfiguration with
 * no right answer; first-usable-wins is as defensible as any other rule.
 *
 * Lives here, beside the judgement, so the two injected call sites read the
 * DOM the same way — two independent readings drifting apart is the failure
 * this module exists to end. It takes the document as an argument rather than
 * touching a global, so it stays a pure function of its input.
 */
export function declaredCanonicalHref(doc: Document): string | undefined {
  for (const link of doc.querySelectorAll(CANONICAL_LINK_SELECTOR)) {
    const href = link.getAttribute("href");
    if (href !== null && href.trim() !== "") {
      return href;
    }
  }
  return undefined;
}

/**
 * The one source of truth for the rejection reasons. `CanonicalRejection` and
 * `isCanonicalRejection` are both derived from this array rather than each
 * hand-listing the strings, so a variant added here cannot leave either of them
 * stale — and `preview.ts`'s notice table is a `Record` over the union, so
 * adding one without writing its user-facing sentence is a compile error.
 */
const CANONICAL_REJECTIONS = [
  "unparseable",
  "bad-scheme",
  "credentials",
  "cross-origin",
  "downgrade",
  "root-collapse",
] as const;

export type CanonicalRejection = (typeof CANONICAL_REJECTIONS)[number];

/** Type predicate for a rejection reason — sound against the closed union above. */
export function isCanonicalRejection(v: unknown): v is CanonicalRejection {
  return typeof v === "string" && (CANONICAL_REJECTIONS as readonly string[]).includes(v);
}

export type CanonicalResult =
  | { readonly kind: "none" }
  | { readonly kind: "resolved"; readonly url: string }
  | { readonly kind: "rejected"; readonly reason: CanonicalRejection; readonly declared: string };

/**
 * One leading `www.` label removed — but only when what remains is still a
 * dotted host, so a pathological `www.com` does not decay to `com`.
 *
 * This is the ONLY host relaxation. A general "same registrable domain" rule
 * would need a public-suffix list to know that `bbc.co.uk` is not registrable
 * the way `example.com` is, which is real weight in a bundle that ships with no
 * runtime dependencies. `www` is exempt from that argument because it is a
 * single well-known label rather than a guess.
 */
function bareHost(hostname: string): string {
  const rest = hostname.slice("www.".length);
  return hostname.startsWith("www.") && rest.includes(".") ? rest : hostname;
}

/**
 * How the declared canonical relates to the page: the same site, the same site
 * over an insecure scheme, or somewhere else entirely.
 *
 * Three-way rather than a boolean because the caller has to tell the user WHY,
 * and "another site's address" is simply false for a same-host downgrade — a
 * well-known SEO misconfiguration, so real readers meet it. The refusal is the
 * same either way; only the reason and its sentence differ.
 *
 * Only `http:`/`https:` reach here — the scheme rung runs first.
 */
function siteRelation(canonical: URL, page: URL): "same" | "downgrade" | "different" {
  if (canonical.port !== page.port) {
    return "different";
  }
  if (bareHost(canonical.hostname) !== bareHost(page.hostname)) {
    return "different";
  }
  if (canonical.protocol === page.protocol) {
    return "same";
  }
  // An http page declaring an https canonical is the correct declaration
  // during a migration; refusing it would give one page two identities
  // depending on which scheme the reader happened to arrive on. The reverse —
  // same host, same port, https page pointing at http — is a downgrade.
  return page.protocol === "http:" && canonical.protocol === "https:" ? "same" : "downgrade";
}

export function resolveCanonical(declared: string | undefined, pageUrl: string): CanonicalResult {
  if (declared === undefined || declared.trim() === "") {
    return { kind: "none" };
  }
  let canonical: URL;
  let page: URL;
  try {
    page = new URL(pageUrl);
    canonical = new URL(declared, pageUrl);
  } catch {
    return { kind: "rejected", reason: "unparseable", declared };
  }
  if (canonical.protocol !== "http:" && canonical.protocol !== "https:") {
    return { kind: "rejected", reason: "bad-scheme", declared };
  }
  // Userinfo is REFUSED rather than stripped. Stripping would mean rewriting
  // what the page declared, and this module only ever rejects or absolutises —
  // the moment it starts editing a declaration it is canonicalising, which is
  // the gateway's job (`src/shared/recognise.ts:253`). Refusing costs nothing:
  // the clip falls back to the address bar like any other rejection, and a
  // credentials-shaped string stays out of both the identity hash and the
  // pre-send preview, where it would otherwise be rendered verbatim.
  //
  // Reading `username`/`password` off the parsed URL, rather than looking for
  // an "@" in the raw string, is what keeps `https://host/a@b` — an "@" in the
  // PATH, which is perfectly ordinary — resolving normally.
  if (canonical.username !== "" || canonical.password !== "") {
    return { kind: "rejected", reason: "credentials", declared };
  }
  const relation = siteRelation(canonical, page);
  if (relation === "downgrade") {
    return { kind: "rejected", reason: "downgrade", declared };
  }
  if (relation === "different") {
    return { kind: "rejected", reason: "cross-origin", declared };
  }
  // A real article never legitimately canonicalises to the homepage; a
  // site-wide canonical that does is the misconfiguration that makes every clip
  // from the site overwrite the same row. `URL` normalises an empty path to
  // "/", so this one comparison covers both spellings.
  //
  // RESIDUAL: this compares `pathname` only. A page at `https://site.com/?p=123`
  // has `pathname === "/"`, so a site-wide `<link rel="canonical"
  // href="https://site.com/">` is ACCEPTED and every such page still collapses
  // onto one item — on exactly the legacy-CMS shape (`?p=`, `?page_id=`,
  // `index.php?id=`) where a hardcoded site-wide canonical is most likely. This
  // stays as-is on purpose: requiring an empty `page.search` too would reject
  // the very common "homepage reached with `?utm_source=`" case and show a
  // false "would overwrite your other clips" notice for a page that really is
  // the homepage. Telling a tracking parameter apart from a routing parameter
  // client-side would BE canonicalisation, which this module is forbidden from
  // doing — see `src/shared/recognise.ts:253`.
  if (canonical.pathname === "/" && page.pathname !== "/") {
    return { kind: "rejected", reason: "root-collapse", declared };
  }
  return { kind: "resolved", url: canonical.href };
}
