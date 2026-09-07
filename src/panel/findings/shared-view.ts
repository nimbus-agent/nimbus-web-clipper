// src/panel/findings/shared-view.ts
// The pieces every findings renderer needs, in one place.
//
// Factored out rather than repeated per lane because two of them encode rules
// that must not be forgotten in one renderer out of seven: a URL is only ever an
// href after `safeHttpUrl` accepts it, and every string from the gateway is set
// with `textContent`.
import type { GapNote, SynthesisProvenance } from "../../shared/findings.ts";
import { safeHttpUrl } from "../../shared/safe-url.ts";

/**
 * A reference the reader can follow, or the same text plainly when they cannot.
 *
 * `safeHttpUrl` is the only thing between a gateway-supplied string and
 * `javascript:` executing on click. Its own contract says to render the raw
 * string as TEXT when it refuses, rather than hide it: the user should still see
 * what was claimed. No `base` argument — these URLs are absolute.
 */
export function findingLink(
  doc: Document,
  text: string,
  // `undefined` as well as `null`: several URL fields on the C8.2/C8.3 briefs are
  // OPTIONAL KEYS (`ExpertBrief.query.itemUrl?: string | null`), and accepting
  // both here saves every future caller a `?? null` that adds nothing.
  rawUrl: string | null | undefined,
): HTMLElement {
  const safe = rawUrl === null || rawUrl === undefined ? null : safeHttpUrl(rawUrl);
  if (safe === null) {
    const span = doc.createElement("span");
    span.textContent = text;
    return span;
  }
  const link = doc.createElement("a");
  link.href = safe;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = text;
  return link;
}

/**
 * Why a lane may be empty, and what to do about it.
 *
 * `gaps` rides every agent's brief and has never been rendered. It matters most
 * exactly where the lane's own results are empty — the case that reads as "there
 * is nothing" when the truth is "this cannot be asked".
 */
export function renderGaps(doc: Document, gaps: readonly GapNote[]): HTMLElement | null {
  if (gaps.length === 0) {
    return null;
  }
  const box = doc.createElement("div");
  box.className = "nimbus-findings__gaps";
  for (const gap of gaps) {
    const row = doc.createElement("p");
    row.className = "nimbus-findings__gap";
    const detail = doc.createElement("span");
    detail.textContent = gap.detail;
    row.append(detail);
    if (gap.remediation !== undefined) {
      const fix = doc.createElement("span");
      fix.className = "nimbus-findings__gap-fix";
      fix.textContent = gap.remediation;
      row.append(fix);
    }
    box.append(row);
  }
  return box;
}

/**
 * Whether a model wrote this answer, and whether it stayed on this machine.
 *
 * `remote` exists only on the `used: true` arm — that is the local/remote bit.
 * On both other arms the text the reader sees is deterministic output, so the
 * honest line is that no model wrote it; the discard REASON is not surfaced,
 * because it is a gateway-operations detail the reader cannot act on.
 */
export function renderProvenance(doc: Document, synthesis: SynthesisProvenance): HTMLElement {
  const note = doc.createElement("p");
  note.className = "nimbus-findings__provenance";
  if (synthesis.attempted && synthesis.used) {
    note.textContent = synthesis.remote
      ? `Written by ${synthesis.model}, a remote model.`
      : `Written by ${synthesis.model}, a local model.`;
    return note;
  }
  note.textContent = "Assembled by Nimbus — no model wrote this.";
  return note;
}

/** A lane found nothing, and had no gap to explain it. */
export function renderEmptyLine(doc: Document, text: string): HTMLElement {
  const line = doc.createElement("p");
  line.className = "nimbus-findings__empty";
  line.textContent = text;
  return line;
}
