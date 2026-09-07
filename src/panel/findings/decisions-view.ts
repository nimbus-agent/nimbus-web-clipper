// src/panel/findings/decisions-view.ts
// "What got decided" as the decisions themselves, each with the evidence it was
// extracted from — rather than a paragraph summarising them.
//
// This is a service-scoped lane: `LANE_RULES.decisions` is
// `{input: "page", surfaces: {home: "service"}}`, so it answers about a whole
// connector from that product's dashboard. Its evidence rows are one of only
// two places in the browser's seven lanes where findings carry a real URL.
import type { DecisionEvidence, DecisionsEntry, DecisionsFindings } from "../../shared/findings.ts";
import { formatAge } from "../../shared/freshness.ts";
import { findingLink, renderEmptyLine } from "./shared-view.ts";

/** Human labels for the evidence kinds, so a row reads as prose not as an enum. */
const EVIDENCE_LABELS: Readonly<Record<DecisionEvidence["kind"], string>> = {
  source: "Source",
  pr: "Pull request",
  commit: "Commit",
  migration: "Migration",
  iac: "Infrastructure",
  adr: "ADR",
};

function renderEvidenceRow(doc: Document, ev: DecisionEvidence, nowMs: number): HTMLElement {
  const row = doc.createElement("div");
  row.className = "nimbus-findings__item";
  const kind = doc.createElement("span");
  kind.className = "nimbus-findings__badge";
  kind.textContent = EVIDENCE_LABELS[ev.kind];
  row.append(kind, findingLink(doc, ev.label, ev.url));
  if (ev.occurredAt !== null) {
    const when = doc.createElement("span");
    when.className = "nimbus-findings__item-when";
    when.textContent = formatAge(ev.occurredAt, nowMs);
    row.append(when);
  }
  return row;
}

/** The statement line: what was decided, when, and whether an ADR records it. */
function renderStatement(doc: Document, entry: DecisionsEntry, nowMs: number): HTMLElement {
  const head = doc.createElement("p");
  head.className = "nimbus-findings__subject";
  const statement = doc.createElement("span");
  statement.textContent = entry.statement;
  head.append(statement);
  if (entry.hasAdr) {
    // An ADR is a deliberate, written record — quite different from a decision
    // inferred from a commit message, and worth marking as such.
    const adr = doc.createElement("span");
    adr.className = "nimbus-findings__badge";
    adr.textContent = "ADR";
    head.append(adr);
  }
  const when = doc.createElement("span");
  when.className = "nimbus-findings__item-when";
  when.textContent = formatAge(entry.decidedAt, nowMs);
  head.append(when);
  return head;
}

function renderEntry(doc: Document, entry: DecisionsEntry, nowMs: number): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-findings__group";
  box.append(renderStatement(doc, entry, nowMs));

  // Both are genuinely optional: a decision extracted from a commit often has
  // no recorded rationale and no alternatives. An empty line for either would
  // imply the information was looked for and found to be nothing.
  if (entry.rationale !== null) {
    const why = doc.createElement("p");
    why.className = "nimbus-findings__item-detail";
    why.textContent = entry.rationale;
    box.append(why);
  }
  if (entry.alternatives.length > 0) {
    const alts = doc.createElement("p");
    alts.className = "nimbus-findings__item-detail";
    alts.textContent = `Considered instead: ${entry.alternatives.join(", ")}`;
    box.append(alts);
  }
  for (const ev of entry.evidence) {
    box.append(renderEvidenceRow(doc, ev, nowMs));
  }
  return box;
}

export function renderDecisionsFindings(
  doc: Document,
  findings: DecisionsFindings,
  nowMs: number,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-findings";

  if (findings.entries.length === 0) {
    box.append(renderEmptyLine(doc, "No decisions recorded for this service yet."));
    return box;
  }

  for (const entry of findings.entries) {
    box.append(renderEntry(doc, entry, nowMs));
  }

  if (findings.truncatedSources > 0) {
    // Upstream replaced a blanket "512-character cap" caveat with this precise
    // per-brief count; render it, because a decision extracted from a cut body
    // may be partial and the reader cannot tell from the statement alone.
    const caveat = doc.createElement("p");
    caveat.className = "nimbus-findings__provenance";
    const n = findings.truncatedSources;
    caveat.textContent =
      n === 1
        ? "1 source in this window was indexed with a truncated body."
        : `${n} sources in this window were indexed with truncated bodies.`;
    box.append(caveat);
  }
  return box;
}
