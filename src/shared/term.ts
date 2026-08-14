// src/shared/term.ts
// The one place a user-selected term is cleaned up and judged. Pure, so both
// sides of the message boundary can use it: the panel normalises a raw selection
// before it sends one (and renders the refusal itself, where the copy belongs),
// and `messages.ts`'s guard rejects anything that did not arrive in exactly that
// form.

/**
 * The longest term this client will ask about.
 *
 * The bound is NOT about the wire — the term travels in the JSON body of
 * `POST /v1/agents/{agent}`, so no header limit is in play. It matters because
 * the term becomes part of the run cache key (`makeKey` in
 * `agent-run-store.ts`), so an unbounded term writes an unbounded key into
 * extension storage; and because a paragraph is not a glossary lookup that any
 * agent run could usefully answer.
 */
export const MAX_TERM_LENGTH = 128;

export type TermCheck =
  | { readonly ok: true; readonly term: string }
  | { readonly ok: false; readonly reason: "empty" | "too_long" };

/**
 * Control characters become a SPACE rather than being deleted: a selection
 * spanning two lines is "blast radius", not "blastradius". Deleting them would
 * silently weld two words into one that the user never selected — the same class
 * of quiet corruption that truncation would be.
 *
 * Written as an explicit code-point walk rather than a regex because Biome's
 * `noControlCharactersInRegex` bans the escape ranges that would express this,
 * and it is right to: a literal control character in a pattern is unreadable and
 * easy to get wrong. This is the readable version of the same intent.
 */
function stripControl(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    out += isControl ? " " : ch;
  }
  return out;
}

/**
 * Clean a raw selection into the term this client will send, or say why it will
 * not send one.
 *
 * An over-long selection is REFUSED, never truncated. Silently cutting a
 * 3,000-character selection down to its first 128 produces a query the user
 * never asked and an answer about a term they never selected — which looks
 * exactly like the feature working. Refusing says what happened.
 *
 * Idempotent: `normaliseTerm(normaliseTerm(x).term)` returns the same term, which
 * is what lets the message guard demand already-normalised input instead of
 * quietly rewriting a message it was only supposed to validate.
 */
export function normaliseTerm(raw: string): TermCheck {
  const cleaned = stripControl(raw).replace(/\s+/g, " ").trim();
  if (cleaned === "") {
    return { ok: false, reason: "empty" };
  }
  if (cleaned.length > MAX_TERM_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  return { ok: true, term: cleaned };
}

/** Is this value a term already in the form `normaliseTerm` produces? The
 *  message guard's question — a predicate cannot transform, and a boundary that
 *  quietly rewrote its input would be validating nothing. */
export function isNormalisedTerm(v: unknown): v is string {
  if (typeof v !== "string") {
    return false;
  }
  const checked = normaliseTerm(v);
  return checked.ok && checked.term === v;
}
