// The report a finished brief carries, and the two honesty rules that read it.
//
// Mirrors packages/gateway/src/briefs/brief-types.ts. A report crosses the
// gateway boundary and then the SW→page boundary, so it is `unknown` until a
// guard says otherwise — the same rule every other cross-boundary value here
// follows.

export type BriefCitation = {
  readonly kind: "source" | "clip";
  readonly title: string;
  readonly url?: string;
  /** Present only for a real clip — see the gateway's SourceRef. */
  readonly clipId?: string;
  /** The index item id for any indexed hit, whatever its type. */
  readonly itemId?: string;
  /** The item's type, verbatim. ARBITRARY string — never validated as an enum. */
  readonly itemType?: string;
  readonly quote?: string;
};

export type BriefReportItem = {
  readonly text: string;
  readonly citations: readonly BriefCitation[];
};

export type BriefSynthesis = {
  readonly model: string;
  readonly remote: boolean;
  /** Present iff `remote`. The EXACT string also appended to `gaps` — see `visibleGaps`. */
  readonly disclosure?: string;
};

export type BriefReport = {
  readonly summary: string;
  readonly findings: readonly BriefReportItem[];
  /** Every entry carries >= 2 distinct citations; the gateway's validator enforces it. */
  readonly conflicts: readonly BriefReportItem[];
  readonly gaps: readonly string[];
  readonly synthesis: BriefSynthesis;
};

/**
 * The gap `brief-save.ts` appends when a report exceeds the item metadata
 * ceiling and its supporting quotes are stripped from the SAVED copy. Copied
 * verbatim from upstream: this is matched by equality, so a reworded upstream
 * string must be updated here rather than pattern-matched around.
 */
export const QUOTES_OMITTED_GAP =
  "Supporting quotes were omitted from the saved copy (size limit).";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isCitation(v: unknown): v is BriefCitation {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] !== "source" && v["kind"] !== "clip") {
    return false;
  }
  return (
    typeof v["title"] === "string" &&
    (v["url"] === undefined || typeof v["url"] === "string") &&
    (v["clipId"] === undefined || typeof v["clipId"] === "string") &&
    (v["itemId"] === undefined || typeof v["itemId"] === "string") &&
    (v["itemType"] === undefined || typeof v["itemType"] === "string") &&
    (v["quote"] === undefined || typeof v["quote"] === "string")
  );
}

function isReportItem(v: unknown): v is BriefReportItem {
  return (
    isObject(v) &&
    typeof v["text"] === "string" &&
    Array.isArray(v["citations"]) &&
    v["citations"].every(isCitation)
  );
}

function isSynthesis(v: unknown): v is BriefSynthesis {
  return (
    isObject(v) &&
    typeof v["model"] === "string" &&
    typeof v["remote"] === "boolean" &&
    (v["disclosure"] === undefined || typeof v["disclosure"] === "string")
  );
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

export function isBriefReport(v: unknown): v is BriefReport {
  return (
    isObject(v) &&
    typeof v["summary"] === "string" &&
    Array.isArray(v["findings"]) &&
    v["findings"].every(isReportItem) &&
    Array.isArray(v["conflicts"]) &&
    v["conflicts"].every(isReportItem) &&
    isStringArray(v["gaps"]) &&
    isSynthesis(v["synthesis"])
  );
}

/**
 * `gaps` minus the remote disclosure, which is rendered as its own banner.
 *
 * BY EQUALITY, never by pattern. Upstream's own comment says why: `disclosure`
 * is "the EXACT string also appended to `gaps` … so a live view can suppress the
 * duplicate by equality rather than by pattern-matching prose the gateway might
 * later reword." A regex would pass today and silently double-render the
 * disclosure the first time upstream rewords a sentence.
 */
export function visibleGaps(report: BriefReport): readonly string[] {
  const disclosure = report.synthesis.disclosure;
  if (disclosure === undefined) {
    return report.gaps;
  }
  return report.gaps.filter((g) => g !== disclosure);
}

/** True when a SAVED report came back without its supporting quotes. */
export function quotesWereOmitted(report: BriefReport): boolean {
  return report.gaps.includes(QUOTES_OMITTED_GAP);
}
