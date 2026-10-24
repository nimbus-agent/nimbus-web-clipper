// src/capture/capture-in-page.ts
import { Readability } from "@mozilla/readability";
import {
  type CanonicalRejection,
  type CanonicalResult,
  declaredCanonicalHref,
  resolveCanonical,
} from "../shared/canonical.ts";
import type { CaptureResult, ClipSource } from "../shared/types.ts";
import { fallbackBody } from "./fallback.ts";
import { parsePublishedAt, readPageMeta } from "./page-meta.ts";

function metaDescription(doc: Document): string | undefined {
  for (const selector of ['meta[name="description"]', 'meta[property="og:description"]']) {
    const content = doc.querySelector(selector)?.getAttribute("content") ?? undefined;
    if (content !== undefined && content.trim() !== "") return content;
  }
  return undefined;
}

/**
 * What this file needs off a Readability parse, spelled out structurally
 * rather than imported, so a nullability mismatch under `strict` cannot get
 * papered over with an `any`.
 *
 * The keys are REQUIRED and their types carry `undefined`, which is how
 * Readability declares them — not optional keys. Under
 * `exactOptionalPropertyTypes` those are different types, and `byline?:
 * string | null` would not accept what `parse()` actually returns.
 */
interface ReadabilityMeta {
  readonly byline: string | null | undefined;
  readonly siteName: string | null | undefined;
  readonly lang: string | null | undefined;
  readonly publishedTime: string | null | undefined;
}

function clean(v: string | null | undefined): string | undefined {
  const trimmed = v?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Readability first, `readPageMeta` filling the gaps.
 *
 * Readability wins where it has an opinion because it already consults JSON-LD
 * and OpenGraph internally and picks between them; re-deciding that here would
 * be a second, worse ranking. It has no image field at all, so `leadImage`
 * only ever comes from the page meta.
 *
 * Returns `undefined` rather than `{}` when the page said nothing — an empty
 * object on the wire is noise the gateway would only have to strip.
 */
function mergeSource(page: ClipSource, article: ReadabilityMeta | null): ClipSource | undefined {
  const author = clean(article?.byline);
  const siteName = clean(article?.siteName);
  const lang = clean(article?.lang);
  const publishedAt = parsePublishedAt(clean(article?.publishedTime));
  const merged: ClipSource = {
    ...page,
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(siteName === undefined ? {} : { siteName }),
    ...(lang === undefined ? {} : { lang }),
  };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function sourcePart(source: ClipSource | undefined): { source?: ClipSource } {
  return source === undefined ? {} : { source };
}

function pageOnly(page: ClipSource): ClipSource | undefined {
  return Object.keys(page).length === 0 ? undefined : page;
}

/**
 * The canonical fields a capture carries: the resolved address, the refusal
 * reason, or neither. Spread into the result, so "none" contributes no key at
 * all rather than an explicit `undefined` — `exactOptionalPropertyTypes` treats
 * those as different things.
 */
function canonicalPartOf(
  canonical: CanonicalResult,
): { canonicalUrl: string } | { canonicalRejected: CanonicalRejection } | Record<string, never> {
  if (canonical.kind === "resolved") {
    return { canonicalUrl: canonical.url };
  }
  if (canonical.kind === "rejected") {
    return { canonicalRejected: canonical.reason };
  }
  return {};
}

function capture(mode: string): CaptureResult {
  const url = location.href;
  const title = document.title;
  const canonicalPart = canonicalPartOf(resolveCanonical(declaredCanonicalHref(document), url));
  const pageMeta = readPageMeta(document, url);

  if (mode === "selection") {
    const body = (window.getSelection()?.toString() ?? "").trim();
    // No Readability parse on this path — it returns before one happens — so
    // the page's own tags are all there is to go on.
    return {
      url,
      ...canonicalPart,
      ...sourcePart(pageOnly(pageMeta)),
      title,
      mode: "selection",
      body,
      readableFound: body !== "",
    };
  }

  // Readability mutates the DOM it parses — give it a clone. document.cloneNode(true)
  // is Mozilla's documented entry: `new Readability(document.cloneNode(true)).parse()`.
  const clone = document.cloneNode(true) as Document;
  const article = new Readability(clone).parse();
  const text = article?.textContent?.trim() ?? "";
  if (text !== "") {
    const articleTitle = article?.title;
    return {
      url,
      ...canonicalPart,
      ...sourcePart(mergeSource(pageMeta, article)),
      title:
        articleTitle !== undefined && articleTitle !== null && articleTitle !== ""
          ? articleTitle
          : title,
      mode: "article",
      body: text,
      readableFound: true,
    };
  }
  const desc = metaDescription(document);
  return {
    url,
    ...canonicalPart,
    // `article` is still in scope, and merging it costs nothing since the parse
    // is already paid for. It is worth LESS than it looks, though: measured
    // against @mozilla/readability 0.6.0, `parse()` returns null outright when
    // it finds no body — metadata included — so on a genuinely unreadable page
    // there is nothing here to merge. What this does catch is the narrow case
    // where Readability found a body and that body trimmed to empty. Free, so
    // take it; just do not read it as JSON-LD coverage for hard pages.
    ...sourcePart(mergeSource(pageMeta, article)),
    title,
    mode: "article",
    body: fallbackBody(desc !== undefined ? { description: desc, url } : { url }),
    readableFound: false,
  };
}

(globalThis as unknown as { __nimbusCapture: (mode: string) => CaptureResult }).__nimbusCapture =
  capture;
