import { safeHttpUrl } from "./safe-url.ts";
import type { CaptureResult, ClipSource } from "./types.ts";

export interface ClipPayload {
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title: string;
  readonly mode: "article" | "selection";
  readonly body: string;
  readonly tags: readonly string[];
  readonly capturedAt: number;
  readonly source?: ClipSource;
}

// The gateway's own bounds, copied from `validateClipSource` in
// `packages/gateway/src/clips/clip-ingest.ts` (gateway 2.12.0). They are
// duplicated rather than imported because the two repos share no code, so they
// have to be kept in step by hand — and the reason they exist client-side at
// all is the PREVIEW: 1.3 promises the user sees what lands, and a byline
// shown at 5,000 characters that the gateway stores at 200 would break that
// promise quietly.
const SOURCE_PROSE_MAX = 200;
const SOURCE_LANG_MAX = 20;
const SOURCE_LEAD_IMAGE_MAX = 2048;
const DATE_RANGE_MAX_MS = 8_640_000_000_000_000;

/** Prose is TRUNCATED: a byline cut to 200 characters is still a byline. */
function boundedProse(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") {
    return undefined;
  }
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, max);
}

/** Structured values are DROPPED: half a URL or half a language tag is corrupt
 *  rather than short. */
function boundedExact(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") {
    return undefined;
  }
  const trimmed = v.trim();
  return trimmed === "" || trimmed.length > max ? undefined : trimmed;
}

function epochMs(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > DATE_RANGE_MAX_MS) {
    return undefined;
  }
  return v;
}

/**
 * `leadImage` is the one member whose bound is not the whole story.
 *
 * `page-meta.ts` scheme-checks what IT reads, but this module's input is not
 * that — it is whatever `__nimbusCapture` returned, and a page can overwrite
 * that global and hand back `leadImage: "javascript:…"` directly. A length
 * check alone would pass that straight to the index, where the gateway stores
 * it unvalidated ON PURPOSE and its docblock puts the scheme check on
 * whichever consumer renders it. This client is not going to be the one that
 * poisons that well.
 *
 * No base: by this point the value must already be absolute.
 *
 * The pre-send preview would not execute it either way — `preview-view.ts`
 * writes every value with `textContent`, never `innerHTML` — so this is about
 * what we put in the user's index, not about the extension's own DOM.
 */
function safeLeadImage(v: unknown): string | undefined {
  // Bounded FIRST so a 60 KB string is never handed to the URL parser at all.
  const bounded = boundedExact(v, SOURCE_LEAD_IMAGE_MAX);
  if (bounded === undefined) {
    return undefined;
  }
  const safe = safeHttpUrl(bounded);
  // ...and bounded AGAIN, because `href` is the NORMALISED form and can be far
  // longer than what went in: the parser percent-encodes spaces and non-ASCII,
  // so a raw 2048-character URL full of spaces comes back at over 4000. The
  // gateway bounds what it RECEIVES and DROPS an over-long leadImage rather
  // than truncating it, so measuring only the raw string would send a value
  // the gateway silently discards while the preview showed it — the exact
  // preview-lie these caps exist to prevent.
  return safe === null || safe.length > SOURCE_LEAD_IMAGE_MAX ? undefined : safe;
}

/**
 * The one rung all three cross-boundary guards apply to `source` — the two
 * `isCaptureResult` copies (`messages.ts`, `browser/scripting.ts`) and
 * `isClipPayload` (`queue.ts`).
 *
 * It checks the SHAPE and nothing else, on purpose. Members are not inspected
 * because `buildClipSource` rebuilds the object from the five known fields
 * regardless, so rejecting a malformed byline earlier buys nothing and costs
 * the user a clip — the same trade `validateClipSource` makes upstream. At the
 * queue that reasoning is not merely consistent but load-bearing:
 * `clip-queue-store.ts` reads the queue as `value.filter(isQueuedClip)`, so a
 * rejection there discards the whole clip someone saved offline rather than
 * the offending field.
 *
 * Arrays are refused as well as null, which the modules' own local `isObject`
 * helpers do not do — an array is not a `source`, whatever `typeof` says.
 *
 * Lives here, beside `buildClipSource`, so the rung and the rebuild that
 * justifies it cannot drift apart.
 */
export function isSourceShape(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Builds a NEW `ClipSource` from the five known fields.
 *
 * It must never return the caller's object, spread it, or delete keys from it.
 * `CaptureResult.source` arrives from a script running IN THE PAGE — a hostile
 * page can overwrite `__nimbusCapture` and return anything — and this value
 * goes on to the request body, the offline queue and the pre-send preview. A
 * whitelist, not a blocklist: the shape TypeScript describes and the shape
 * that leaves are the same object, built here. This is the client half of the
 * gateway's I32 rule; see `validateClipSource` upstream.
 *
 * Wrong-typed MEMBERS are dropped rather than throwing, for the same reason
 * the gateway drops them: a malformed byline should not cost the user a clip.
 */
export function buildClipSource(raw: unknown): ClipSource | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const author = boundedProse(o["author"], SOURCE_PROSE_MAX);
  const publishedAt = epochMs(o["publishedAt"]);
  const siteName = boundedProse(o["siteName"], SOURCE_PROSE_MAX);
  const lang = boundedExact(o["lang"], SOURCE_LANG_MAX);
  const leadImage = safeLeadImage(o["leadImage"]);
  const source: ClipSource = {
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(siteName === undefined ? {} : { siteName }),
    ...(lang === undefined ? {} : { lang }),
    ...(leadImage === undefined ? {} : { leadImage }),
  };
  return Object.keys(source).length === 0 ? undefined : source;
}

/** Comma-split, trim, drop empties, dedupe (case-sensitive, multi-word kept). */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const tag = raw.trim();
    if (tag !== "" && !out.includes(tag)) {
      out.push(tag);
    }
  }
  return out;
}

export function buildClipPayload(c: CaptureResult, tags: string[], nowMs: number): ClipPayload {
  const source = buildClipSource(c.source);
  return {
    url: c.url,
    ...(c.canonicalUrl !== undefined ? { canonicalUrl: c.canonicalUrl } : {}),
    title: c.title,
    mode: c.mode,
    body: c.body,
    tags,
    capturedAt: nowMs,
    ...(source === undefined ? {} : { source }),
  };
}
