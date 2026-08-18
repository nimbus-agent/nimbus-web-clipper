// Pure decisions for a research brief: the caps, which questions a tab set
// deserves, and the two request bodies.
//
// The extraction cap is the load-bearing constant here and it is NOT the
// gateway's per-source ceiling. `MAX_RUN_BYTES / MAX_SOURCE_BYTES` is exactly
// 16, so a client cutting at 256 KB fits sixteen sources into a run whose
// declared limit is twenty — the seventeenth feed is refused, every time.
// Upstream sized the run budget against a 200 KB client cap and says so:
// "256 KB against the client's 200 KB extraction cap" (brief-constants.ts).
import type { Recognition } from "./types.ts";

export const BRIEF_CAPS = {
  /** Gateway `MAX_SOURCES_PER_RUN`. */
  maxSources: 20,
  /** THIS CLIENT's extraction cap — see the module comment. */
  extractionCapBytes: 200 * 1024,
  /** Gateway `MAX_RUN_BYTES`. Held here so the budget is asserted, not assumed. */
  maxRunBytes: 4 * 1024 * 1024,
  /** Gateway `MAX_BRIEF_CHARS`. */
  maxQuestionChars: 4000,
} as const;

const ENCODER = new TextEncoder();

export function utf8Bytes(s: string): number {
  return ENCODER.encode(s).length;
}

/**
 * Cut `s` to at most `maxBytes` UTF-8 bytes without splitting a character.
 *
 * Byte-based, never `slice(0, n)` on code units: a body of astral-plane text is
 * four bytes per character, so a character-count cut would send four times the
 * cap. Walks back off a partial character rather than emitting U+FFFD, because a
 * replacement character in a source body would be quoted back to the user as if
 * the page had contained it.
 */
function cutToBytes(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) {
    return s;
  }
  let out = "";
  let used = 0;
  for (const ch of s) {
    const size = utf8Bytes(ch);
    if (used + size > maxBytes) {
      break;
    }
    out += ch;
    used += size;
  }
  return out;
}

const Q_PR_DISAGREE = "What do these changes disagree about?";
const Q_PR_BREAK = "What breaks if all of these land?";
const Q_ISSUE_THREAD = "What is the common thread?";
const Q_CONTRADICT = "Where do these contradict each other?";
const Q_RELATE = "How do these relate?";
const Q_AGREE = "What do these agree on?";

/**
 * The questions a tab set earns, from the SHAPE of what was recognised.
 *
 * This is what keeps the feature on the right side of the roadmap's "not a
 * generic ask box" non-goal: the surface leads with what it already knows about
 * the tabs, and free text is a collapsed control beside these, not the entry
 * point. Adding a question is one row.
 *
 * Never returns an empty list — a set of entirely unrecognised tabs is still a
 * set of documents, and "where do these contradict each other" is answerable
 * about any of them.
 */
export function suggestQuestions(recognitions: readonly Recognition[]): readonly string[] {
  const kinds = recognitions.filter((r) => r.ok).map((r) => r.kind);
  const prs = kinds.filter((k) => k === "pr").length;
  const issues = kinds.filter((k) => k === "issue").length;
  const out: string[] = [];
  if (prs >= 2) {
    out.push(Q_PR_DISAGREE, Q_PR_BREAK);
  }
  if (issues >= 2) {
    out.push(Q_ISSUE_THREAD, Q_CONTRADICT);
  }
  if (out.length === 0 && kinds.length >= 2) {
    out.push(Q_RELATE, Q_CONTRADICT);
  }
  if (out.length === 0) {
    out.push(Q_CONTRADICT, Q_AGREE);
  }
  return [...new Set(out)];
}

export type BriefSourceDecl = {
  readonly url: string;
  readonly title: string;
};

/**
 * The create body. Every picked tab is DECLARED here even though some may fail
 * to capture: `BriefRun.declared` is fixed at create and never grows, and the
 * gateway reports the shortfall in the report's `gaps` ("2 of 3"). Declaring
 * only the survivors would hide it.
 */
export function buildCreateBody(
  question: string,
  sources: readonly BriefSourceDecl[],
): { brief: string; sources: BriefSourceDecl[]; useIndex: false } {
  return {
    brief: question.slice(0, BRIEF_CAPS.maxQuestionChars),
    sources: sources.slice(0, BRIEF_CAPS.maxSources).map((s) => ({ url: s.url, title: s.title })),
    useIndex: false,
  };
}

export type BriefSourceBody = {
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly capturedAt: number;
  readonly truncated: boolean;
};

/**
 * One fed source.
 *
 * Truncate-and-DECLARE, the opposite of this repo's clip path. `POST /v1/clips`
 * has no way to say a body was cut, so a truncated clip would be a silent lie
 * (the defect Nimbus#1005 actually was). `BriefSource.truncated` is a contract
 * field, so here the honest move is to cut and say so.
 */
export function buildSourceBody(src: {
  url: string;
  title: string;
  body: string;
  capturedAt: number;
}): BriefSourceBody {
  const body = cutToBytes(src.body, BRIEF_CAPS.extractionCapBytes);
  return {
    url: src.url,
    title: src.title,
    body,
    capturedAt: src.capturedAt,
    truncated: body.length !== src.body.length,
  };
}
