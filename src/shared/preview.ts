// What leaves the browser, in the user's words, before it leaves.
//
// Pure and shared so the two previews cannot drift from each other or from the
// requests they describe: both are built from exactly the data the caller is
// about to send, not from a second description of it.
import type { CanonicalRejection } from "./canonical.ts";
import type { ClipPayload } from "./clip.ts";
import { joinPassages } from "./passage.ts";
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
 * One sentence per rejection reason. A single generic string cannot describe
 * four different situations without being wrong in three of them.
 *
 * A `Record` keyed by the union is the exhaustiveness check: adding a reason to
 * `CanonicalRejection` without adding a sentence here is a type error. That is
 * deliberately NOT a `satisfies never` backstop in a switch — a backstop is two
 * permanently-uncovered lines against the coverage gate.
 *
 * "the address above" refers to the URL row, which is always rendered directly
 * before this one and IS the identity the clip will take once the declared
 * canonical is refused. Naming it rather than repeating its value keeps the
 * preview from showing the same URL twice.
 */
const CANONICAL_NOTICE: Record<CanonicalRejection, string> = {
  credentials:
    "This page's canonical address carried a username and password; Nimbus ignored it and used the address above.",
  "cross-origin":
    "This page asked to be saved under another site's address; Nimbus ignored that and used the address above.",
  downgrade:
    "This page asked to be saved under an insecure version of its own address; Nimbus ignored that and used the address above.",
  "root-collapse":
    "This page asked to be saved as the site's homepage, which would overwrite your other clips from it; Nimbus used the address above instead.",
  unparseable: "This page's canonical address wasn't a usable URL; Nimbus used the address above.",
  "bad-scheme":
    "This page's canonical address wasn't a web address; Nimbus used the address above.",
};

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
export function buildClipPreview(
  payload: ClipPayload,
  canonicalRejected?: CanonicalRejection,
): ClipPreview {
  const fields: PreviewField[] = [
    { label: "Title", value: payload.title },
    { label: "URL", value: payload.url },
  ];
  if (payload.canonicalUrl !== undefined) {
    fields.push({ label: "Canonical URL", value: payload.canonicalUrl });
  }
  // Guarded on `canonicalUrl` being absent, not just on a rejection being
  // passed: every `CANONICAL_NOTICE` sentence ends with "used the address
  // above", which is only true while this row sits directly beneath `URL`
  // with nothing in between. Callers today never pass both a canonicalUrl and
  // a rejection, but that is a fact about the callers — this keeps the
  // function correct even if that stopped holding.
  if (canonicalRejected !== undefined && payload.canonicalUrl === undefined) {
    fields.push({ label: "Note", value: CANONICAL_NOTICE[canonicalRejected] });
  }
  fields.push(
    { label: "Mode", value: payload.mode },
    // The word "none", not an empty string: a blank cell reads as a rendering bug,
    // and the same reasoning already governs the shortcuts readout's "Not set".
    { label: "Tags", value: payload.tags.length === 0 ? "none" : payload.tags.join(", ") },
  );
  // Appended AFTER Tags, never between URL and Note: every CANONICAL_NOTICE
  // sentence ends "used the address above", which is only true while the Note
  // row sits directly beneath URL.
  //
  // These rows are NOT optional. 1.3's promise is that nothing leaves without
  // the user seeing it, and `source` is new on the wire — Language included,
  // which the design's row list forgot. A field on the request with no row
  // here voids the promise.
  //
  // Listed one by one, like every other field in this function: see the
  // docblock. Iterating `Object.keys(source)` would render whatever a future
  // caller happened to put there.
  const source = payload.source;
  if (source !== undefined) {
    if (source.author !== undefined) {
      fields.push({ label: "Author", value: source.author });
    }
    if (source.publishedAt !== undefined) {
      // A calendar day, not a relative age: `formatAge` would render an
      // ordinary archive article as "2,000 days ago", which answers a question
      // nobody asked of a publication date. Locale-free, so what a test asserts
      // is what every reader sees.
      fields.push({
        label: "Published",
        value: new Date(source.publishedAt).toISOString().slice(0, 10),
      });
    }
    if (source.siteName !== undefined) {
      fields.push({ label: "Site", value: source.siteName });
    }
    if (source.lang !== undefined) {
      fields.push({ label: "Language", value: source.lang });
    }
    if (source.leadImage !== undefined) {
      fields.push({ label: "Lead image", value: source.leadImage });
    }
  }
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
  /**
   * Present ONLY when the run will search the index. Its presence is the marker
   * that this preview covers a wider reach than the sources listed above it —
   * the renderer needs no second flag.
   */
  readonly indexNotice?: string;
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
 * What the user is told when a brief will also search the gateway's index.
 *
 * Three true statements, and no fourth. The client CANNOT name the items in
 * advance — the search runs gateway-side, during the run, over a corpus this
 * extension has no read access to — so it names the BOUND and says plainly that
 * the members cannot be listed, rather than showing a guess that the finished
 * report would then contradict.
 *
 * The last sentence is the one that costs something to admit. Clips are embedded
 * locally, but the search QUERY goes through the gateway's ordinary embedding
 * configuration, which may be remote. So the corpus can stay put while the
 * question does not, and a disclosure that mentioned only the corpus would be
 * true and still misleading.
 *
 * The noun was deliberately narrow — "your saved clips" — while the gateway's
 * brief search was still scoped to `itemType: "web_clip"`, because `publish.yml`
 * ships this string to two public store listings off a `v*` tag with no manual
 * gate in between. That filter is gone (Nimbus#1253), so the noun widened here
 * to match what the gateway actually searches. Only the noun moved: the bound of
 * 8, the cannot-be-listed statement and the question-egress statement are the
 * same words they have always been.
 *
 * The rule that produced the narrow phase still stands, and is the one to apply
 * next time: this string states what is true of the SHIPPED gateway, never what
 * is true of a branch.
 */
export const INDEX_NOTICE =
  "Your gateway will also search what it has indexed and may draw on up to 8 items. Which ones cannot be listed before the run — the finished brief names every one it used. Your question is the text that gets searched, and searching may send it to whichever embedding provider your gateway is configured to use.";

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
 * A passage source's body is joined by `joinPassages` — the SAME function
 * `stitch` calls to build the body that is sent — so the text shown is the text
 * sent, and cannot drift from it.
 */
export function buildBriefPreview(input: {
  question: string;
  sources: readonly BriefPreviewSource[];
  useIndex: boolean;
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
      .map((s) => ({ label: s.title, value: joinPassages(s.passages) })),
    ...(input.useIndex ? { indexNotice: INDEX_NOTICE } : {}),
    synthesisNotice: SYNTHESIS_NOTICE,
  };
}
