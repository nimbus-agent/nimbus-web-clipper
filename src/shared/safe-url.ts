// One home for "is this string safe to put in an href".
//
// Promoted out of panel-view.ts when the brief page needed the same rule. Every
// URL this extension renders as a link arrives from outside it — a related hit,
// a resolve candidate, a brief citation — and a scheme check is the only thing
// between that and `javascript:` executing on click.

/**
 * Returns the parsed href when the scheme is http or https; null otherwise.
 *
 * Rejects `javascript:`, `data:`, `vbscript:`, relative paths and malformed
 * URLs. Callers render the raw string as TEXT when this returns null, rather
 * than hiding the citation — the user should still see what was claimed, just
 * not be able to click it into an executable scheme.
 */
export function safeHttpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
}
