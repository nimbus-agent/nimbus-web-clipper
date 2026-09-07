// src/panel/findings/glossary-view.ts
// "Define in Nimbus" as an entry you can follow, rather than a paragraph.
//
// This lane has the widest reach of any in the product: its `LANE_RULES` entry
// is `{input: "term"}` with no surface restriction, so it renders on ANY page,
// including one the recogniser rejects outright. Every other lane needs a
// recognised, resolved item. It is also one of the only two REMAINING lanes
// whose findings carry a real URL (`topSources[].url`) — `why` (C8.1) already
// carries three of its own.
import type { GlossaryEntry, GlossaryFindings, GlossaryMatchedVia } from "../../shared/findings.ts";
import { formatAge } from "../../shared/freshness.ts";
import { findingLink, renderEmptyLine } from "./shared-view.ts";

/**
 * A term's own heading: the term, where its definition came from, and — when
 * the term was matched via a synonym rather than exactly — a badge saying so.
 * A synonym match is a fact worth surfacing: it tells the reader the word
 * they selected is not the canonical one. `"exact"` and `null` add nothing.
 */
function renderTermHead(
  doc: Document,
  entry: GlossaryEntry,
  matchedVia: GlossaryMatchedVia,
): HTMLElement {
  const head = doc.createElement("p");
  head.className = "nimbus-findings__subject";
  const term = doc.createElement("span");
  term.textContent = entry.term;
  head.append(term);
  if (entry.definitionSource !== null) {
    const src = doc.createElement("span");
    src.className = "nimbus-findings__badge";
    // `manual` means a human authored it in `[glossary.terms]`; the other two
    // are derived. Worth distinguishing — an authored definition is the only
    // one nobody has to second-guess.
    src.textContent = entry.definitionSource === "manual" ? "authored" : entry.definitionSource;
    head.append(src);
  }
  if (matchedVia === "synonym") {
    const via = doc.createElement("span");
    via.className = "nimbus-findings__badge";
    via.textContent = "matched via synonym";
    head.append(via);
  }
  return head;
}

/** The corpus signals under a term. `score` is the value the list is ordered by. */
function renderTermMeta(doc: Document, entry: GlossaryEntry, nowMs: number): HTMLElement {
  const meta = doc.createElement("p");
  meta.className = "nimbus-findings__item-when";
  const mentions = entry.docFreq === 1 ? "1 mention" : `${entry.docFreq} mentions`;
  const services = entry.serviceSpread === 1 ? "1 service" : `${entry.serviceSpread} services`;
  meta.textContent = `${mentions} across ${services} · score ${entry.score} · last seen ${formatAge(entry.lastSeenAt, nowMs)}`;
  return meta;
}

/** A comma-joined list of bare terms — synonyms, near misses, suggestions. */
function renderTermList(
  doc: Document,
  label: string,
  terms: readonly string[],
): HTMLElement | null {
  if (terms.length === 0) {
    return null;
  }
  const row = doc.createElement("p");
  row.className = "nimbus-findings__item-detail";
  row.textContent = `${label}: ${terms.join(", ")}`;
  return row;
}

function renderEntry(
  doc: Document,
  entry: GlossaryEntry,
  nowMs: number,
  matchedVia: GlossaryMatchedVia,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-findings__group";
  box.append(renderTermHead(doc, entry, matchedVia));

  const definition = doc.createElement("p");
  definition.className = "nimbus-findings__item-detail";
  // A term with no definition is a real state, not an error: it was seen often
  // enough to be a term but nothing has defined it yet. Saying so beats a blank.
  definition.textContent = entry.definition ?? "No definition recorded for this term yet.";
  box.append(definition);

  box.append(renderTermMeta(doc, entry, nowMs));

  for (const [label, terms] of [
    ["Also called", entry.synonyms],
    ["Not to be confused with", entry.nearMisses],
  ] as const) {
    const row = renderTermList(doc, label, terms);
    if (row !== null) {
      box.append(row);
    }
  }

  for (const source of entry.topSources) {
    const row = doc.createElement("div");
    row.className = "nimbus-findings__item";
    row.append(findingLink(doc, source.title, source.url));
    const where = doc.createElement("span");
    where.className = "nimbus-findings__item-when";
    where.textContent = `${source.service} · ${formatAge(source.modifiedAt, nowMs)}`;
    row.append(where);
    box.append(row);
  }
  return box;
}

export function renderGlossaryFindings(
  doc: Document,
  findings: GlossaryFindings,
  nowMs: number,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-findings";

  if (findings.entries.length === 0) {
    // A miss with suggestions is the useful case: the term is unknown, but the
    // index holds near neighbours worth offering.
    const suggestions = renderTermList(doc, "Did you mean", findings.suggestions);
    box.append(suggestions ?? renderEmptyLine(doc, "Nothing in your index defines this term yet."));
    return box;
  }

  for (const entry of findings.entries) {
    box.append(renderEntry(doc, entry, nowMs, findings.matchedVia));
  }
  return box;
}
