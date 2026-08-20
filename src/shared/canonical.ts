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
 * The selector both injected scripts use to find the declaration.
 *
 * It lives here, next to the judgement, so the two call sites cannot drift —
 * which is the same failure this module exists to end. `[href]` is load-bearing
 * rather than decorative: `querySelector` returns the FIRST match, so a
 * malformed `<link rel="canonical">` with no href would otherwise shadow a
 * valid declaration further down the head. Requiring the attribute skips it.
 *
 * A page with several well-formed canonical links is misconfigured and has no
 * right answer; first-wins is as defensible as any other rule, and it is what
 * `querySelector` gives us.
 */
export const CANONICAL_LINK_SELECTOR = 'link[rel="canonical"][href]';

export type CanonicalRejection = "unparseable" | "bad-scheme" | "cross-origin" | "root-collapse";

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

/** Same port, same-or-upgraded scheme, same host modulo one `www.` label. */
function sameSite(canonical: URL, page: URL): boolean {
  if (canonical.port !== page.port) {
    return false;
  }
  // An https page declaring an http canonical is a downgrade and is refused.
  // The opposite is the correct declaration during an HTTPS migration, and
  // refusing it would give one page two identities depending on which scheme
  // the reader happened to arrive on.
  const schemeOk =
    canonical.protocol === page.protocol ||
    (page.protocol === "http:" && canonical.protocol === "https:");
  return schemeOk && bareHost(canonical.hostname) === bareHost(page.hostname);
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
  if (!sameSite(canonical, page)) {
    return { kind: "rejected", reason: "cross-origin", declared };
  }
  // A real article never legitimately canonicalises to the homepage; a
  // site-wide canonical that does is the misconfiguration that makes every clip
  // from the site overwrite the same row. `URL` normalises an empty path to
  // "/", so this one comparison covers both spellings.
  if (canonical.pathname === "/" && page.pathname !== "/") {
    return { kind: "rejected", reason: "root-collapse", declared };
  }
  return { kind: "resolved", url: canonical.href };
}
