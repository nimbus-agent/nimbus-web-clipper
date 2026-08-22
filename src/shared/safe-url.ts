// One home for "is this string safe to put in an href".
//
// Promoted out of panel-view.ts when the brief page needed the same rule. Every
// URL this extension renders as a link arrives from outside it — a related hit,
// a resolve candidate, a brief citation — and a scheme check is the only thing
// between that and `javascript:` executing on click.

/**
 * Returns the parsed href when the scheme is http or https; null otherwise.
 *
 * Rejects `javascript:`, `data:`, `vbscript:` and malformed URLs — and,
 * without a `base`, relative paths too. Callers render the raw string as TEXT
 * when this returns null, rather than hiding the citation — the user should
 * still see what was claimed, just not be able to click it into an executable
 * scheme.
 *
 * `base` is the page the raw string was read FROM. Pass it when the string
 * came out of a document — a `<meta property="og:image">` href is routinely
 * root-relative — and omit it when the string is already an absolute URL from
 * the gateway.
 *
 * It deliberately applies no ORIGIN check, and that is not an oversight: this
 * is the rule for a DISPLAY reference, which never enters a clip's identity
 * hash. The origin, downgrade and root-collapse rungs live in `canonical.ts`
 * and belong only to the field that decides identity. Applying them here would
 * reject the common case rather than an attack — hero images live on
 * `cdn.example.com` far more often than on the page's own origin.
 */
export function safeHttpUrl(raw: string, base?: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw, base);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
}
