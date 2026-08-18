// What leaves the browser, in the user's words, before it leaves.
//
// Pure and shared so the two previews cannot drift from each other or from the
// requests they describe: both are built from exactly the data the caller is
// about to send, not from a second description of it.
import type { ClipPayload } from "./clip.ts";
import { PASSAGE_SEPARATOR } from "./passage.ts";
import type { FetchTarget } from "./types.ts";

/** How much body text the preview shows. The FULL body is still what is sent. */
export const EXCERPT_CHARS = 300;

export interface PreviewField {
  readonly label: string;
  readonly value: string;
}

export interface ClipPreview {
  readonly fields: readonly PreviewField[];
  readonly excerpt: string;
  /** Length of the WHOLE body, not the excerpt — see buildClipPreview. */
  readonly bodyLength: number;
  readonly truncated: boolean;
}

export interface FetchPreview {
  readonly fields: readonly PreviewField[];
}

/**
 * The clip payload, field by field.
 *
 * FIELDS ARE LISTED EXPLICITLY, never derived by iterating the object's keys.
 * That is the whole defence of this module's one hard invariant — the bearer
 * token must never appear in a preview. A `for (const k of Object.keys(payload))`
 * would faithfully render whatever a future caller happened to pass in, which is
 * exactly how a secret ends up on screen. Adding a field here is deliberate;
 * inheriting one is not possible.
 *
 * `bodyLength` is the length of the WHOLE body even when the excerpt is cut,
 * because the user is agreeing to send the whole body. A preview that quietly
 * described only the part it showed would understate what leaves.
 */
export function buildClipPreview(payload: ClipPayload): ClipPreview {
  const fields: PreviewField[] = [
    { label: "Title", value: payload.title },
    { label: "URL", value: payload.url },
  ];
  if (payload.canonicalUrl !== undefined) {
    fields.push({ label: "Canonical URL", value: payload.canonicalUrl });
  }
  fields.push(
    { label: "Mode", value: payload.mode },
    // The word "none", not an empty string: a blank cell reads as a rendering bug,
    // and the same reasoning already governs the shortcuts readout's "Not set".
    { label: "Tags", value: payload.tags.length === 0 ? "none" : payload.tags.join(", ") },
  );
  const truncated = payload.body.length > EXCERPT_CHARS;
  return {
    fields,
    excerpt: truncated ? payload.body.slice(0, EXCERPT_CHARS) : payload.body,
    bodyLength: payload.body.length,
    truncated,
  };
}

/**
 * What the gateway is being asked to go and get.
 *
 * A targeted fetch is an I13 WRITE — it makes the gateway reach out to a
 * configured provider under the user's stored credential. So this names the
 * target rather than asking "Fetch this item?", which would invite a yes to
 * something the user has not been told.
 */
export function buildFetchPreview(target: FetchTarget): FetchPreview {
  return {
    fields: [
      { label: "Service", value: target.product },
      { label: "Type", value: target.surface },
      { label: "Address", value: target.url },
    ],
  };
}

export interface BriefPreviewSource {
  readonly title: string;
  readonly url: string;
  /**
   * Present ONLY for a passage source, and then the passage texts in collection
   * order. Its presence is the marker that this source is an excerpt set — the
   * renderer needs no second flag.
   */
  readonly passages?: readonly string[];
}

export interface BriefPreview {
  readonly fields: readonly PreviewField[];
  /** One row per source: `label` is the title, `value` the address. */
  readonly sources: readonly PreviewField[];
  /**
   * One row per PASSAGE source: the exact body that source will send.
   *
   * Only a passage source can have one. A page's text is captured during the
   * run, so at preview time it does not exist and claiming otherwise would be
   * an invention; a passage was captured when the user highlighted it, so here —
   * uniquely — the preview can show the bytes rather than describe them.
   */
  readonly bodies: readonly PreviewField[];
  readonly synthesisNotice: string;
}

function sourcesSummary(sources: readonly BriefPreviewSource[]): string {
  const sets = sources.filter((s) => s.passages !== undefined).length;
  const pages = sources.length - sets;
  const pagePart = `${pages} ${pages === 1 ? "page" : "pages"}`;
  const setPart = `${sets} ${sets === 1 ? "set of passages" : "sets of passages"}`;
  if (sets === 0) {
    return pagePart;
  }
  if (pages === 0) {
    return setPart;
  }
  // Both kinds present: lead with the total, because that is the number the cap
  // is about, then break it down so neither kind is implied to be the other.
  return `${sources.length} sources — ${pagePart}, ${setPart}`;
}

/**
 * What the user is told before source text leaves — and it deliberately does not
 * promise local synthesis.
 *
 * The client CANNOT know: `createBriefLlm` resolves `[briefs].prefer_local` and
 * falls back to remote when no local provider is available, `GET /v1/health`
 * reports only liveness, and `/v1/admin/status` needs a token this client does
 * not hold. Saying "stays on your machine" would be a guess presented as a
 * guarantee. The report's `synthesis.remote` is what actually happened, and the
 * page shows it afterwards.
 */
export const SYNTHESIS_NOTICE =
  "Your gateway will read these pages and answer with a local or a remote model, depending on how it is configured. The finished brief names which one it used.";

/**
 * A brief run, source by source.
 *
 * Same construction rule as {@link buildClipPreview}: fields are listed
 * explicitly, never derived by iterating an object, so the bearer token cannot
 * arrive here by inheritance. Every source is named individually rather than
 * summarised as a count alone — a count is not consent to send twenty specific
 * pages.
 *
 * Unlike the clip preview there is no off switch, the same reasoning C4.2
 * applied to the targeted fetch: this is a larger egress than a fetch, not a
 * smaller one.
 *
 * A passage source's body is joined with `PASSAGE_SEPARATOR`, the same constant
 * `stitch` uses, so the text shown is the text sent.
 */
export function buildBriefPreview(input: {
  question: string;
  sources: readonly BriefPreviewSource[];
}): BriefPreview {
  return {
    fields: [
      { label: "Question", value: input.question },
      { label: "Sources", value: sourcesSummary(input.sources) },
    ],
    sources: input.sources.map((s) => ({
      label: s.title,
      value:
        s.passages === undefined
          ? s.url
          : `${s.url} — ${s.passages.length} ${s.passages.length === 1 ? "passage" : "passages"}`,
    })),
    bodies: input.sources
      .filter(
        (s): s is BriefPreviewSource & { passages: readonly string[] } => s.passages !== undefined,
      )
      .map((s) => ({ label: s.title, value: s.passages.join(PASSAGE_SEPARATOR) })),
    synthesisNotice: SYNTHESIS_NOTICE,
  };
}
