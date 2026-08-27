// The page's own account of itself, read from <meta> and <html lang>.
//
// WHY IT IS SEPARATE from capture-in-page.ts: only the ARTICLE path has an
// article for Readability to mine. Selection captures and the fallback path
// (`readableFound: false`) have none, so this covers all three — and, like
// fallback.ts, it stays a pure function of a Document, so its cases can be
// driven directly instead of through a full Readability parse.
//
// It does NOT canonicalise (see `src/shared/recognise/index.ts`) and it does NOT
// bound. Bounding happens at the trust boundary in `buildClipPayload`, because
// a hostile page can inject a `source` object past this module entirely by
// overwriting `__nimbusCapture` — so a bound applied only here would be a
// bound applied only to honest pages.
import { safeHttpUrl } from "../shared/safe-url.ts";
import type { ClipSource } from "../shared/types.ts";

/**
 * The first non-blank `content` among the given selectors, in order.
 *
 * The `i` flags are load-bearing, and were a real miss in `canonical.ts`: HTML
 * matches these keywords ASCII-case-insensitively, while CSS attribute VALUES
 * are case-sensitive by default — so a page writing `property="OG:Image"` is
 * valid HTML that a flagless selector silently drops. jsdom is lenient here,
 * which is exactly why the flag needs stating rather than testing alone.
 */
function metaContent(doc: Document, selectors: readonly string[]): string | undefined {
  for (const selector of selectors) {
    for (const el of doc.querySelectorAll(selector)) {
      const content = el.getAttribute("content")?.trim() ?? "";
      if (content !== "") {
        return content;
      }
    }
  }
  return undefined;
}

/** Date's own representable range, matching the gateway's `epochMs`. */
const DATE_RANGE_MAX_MS = 8_640_000_000_000_000;

/**
 * A page's published-time string as epoch ms, or `undefined`.
 *
 * `article:published_time` and JSON-LD `datePublished` are "whatever the page
 * wrote". `Date.parse` is the only reasonable reader for the ISO 8601 forms
 * the OpenGraph spec actually asks for, and anything it cannot read is omitted
 * rather than guessed: a wrong date is worse than no date on a record whose
 * whole point is being citable.
 *
 * THE DIGIT BRANCH, and why its length floor is not optional. A minority of
 * CMSes put a bare Unix timestamp in this tag, and `Date.parse` returns NaN
 * for those, so without this branch those sites silently lose their date. But
 * `/^\d+$/` alone would be a REGRESSION rather than a fix: `Date.parse("2024")`
 * is valid ISO 8601 for 2024-01-01, and a naive numeric branch would seize it
 * first and turn a correct 2024 into 1970-01-01. Ten digits is the fence — a
 * four-digit year cannot reach the branch, and ten digits of seconds is 2001
 * onward. Below 1e11 is seconds (through the year 5138); at or above it, the
 * page already wrote milliseconds.
 */
export function parsePublishedAt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (/^\d{10,}$/.test(trimmed)) {
    const n = Number(trimmed);
    const ms = n < 1e11 ? n * 1000 : n;
    return Number.isInteger(ms) && Math.abs(ms) <= DATE_RANGE_MAX_MS ? ms : undefined;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) && Math.abs(ms) <= DATE_RANGE_MAX_MS ? ms : undefined;
}

/**
 * Returns an empty object rather than `undefined` when the page says nothing —
 * the caller decides whether an empty result is worth sending, and merging an
 * object is simpler than merging a maybe-object.
 */
export function readPageMeta(doc: Document, pageUrl: string): ClipSource {
  const author = metaContent(doc, ['meta[name="author" i]', 'meta[property="article:author" i]']);
  const siteName = metaContent(doc, [
    'meta[property="og:site_name" i]',
    'meta[name="og:site_name" i]',
  ]);
  const publishedAt = parsePublishedAt(
    metaContent(doc, [
      'meta[property="article:published_time" i]',
      'meta[name="article:published_time" i]',
    ]),
  );
  const declaredLang = doc.documentElement.getAttribute("lang")?.trim() ?? "";
  const lang = declaredLang === "" ? undefined : declaredLang;
  const declaredImage = metaContent(doc, [
    'meta[property="og:image" i]',
    'meta[name="og:image" i]',
  ]);
  const leadImage = declaredImage === undefined ? null : safeHttpUrl(declaredImage, pageUrl);

  return {
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(siteName === undefined ? {} : { siteName }),
    ...(lang === undefined ? {} : { lang }),
    ...(leadImage === null ? {} : { leadImage }),
  };
}
