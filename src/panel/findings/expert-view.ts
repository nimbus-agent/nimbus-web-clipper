// src/panel/findings/expert-view.ts
// "Who knows this" as a ranked list of people and the evidence behind the
// ranking — rather than a paragraph naming a name.
//
// `personId` and `score` never surface in the flattened markdown at all, and
// `confidence` and per-evidence `weight` are the ranking's own reasoning:
// without them the order is unexplained, the same defect the `glossary` lane
// had when it showed `docFreq` while sorting on `score`. `weight` itself is
// still not rendered — the renderer orders by the ranking the gateway already
// computed and shows `confidence` as the reader-facing signal, the same way
// `glossary` shows `score` but not every corpus diagnostic behind it.
//
// This lane renders NO result links: `Evidence.itemId` is a genuine `item.id`,
// but this client has no id→URL resolver, so both `displayName` and evidence
// `title` are always plain text.
import type { Evidence, ExpertFinding, ExpertFindings } from "../../shared/findings.ts";
import { formatAge } from "../../shared/freshness.ts";
import { renderEmptyLine } from "./shared-view.ts";

function renderEvidenceRow(doc: Document, ev: Evidence, nowMs: number): HTMLElement {
  const row = doc.createElement("div");
  row.className = "nimbus-findings__item";
  const title = doc.createElement("span");
  title.textContent = ev.title;
  const type = doc.createElement("span");
  type.className = "nimbus-findings__badge";
  type.textContent = ev.type;
  const when = doc.createElement("span");
  when.className = "nimbus-findings__item-when";
  when.textContent = formatAge(ev.modifiedAt, nowMs);
  row.append(title, type, when);
  return row;
}

function renderPerson(doc: Document, entry: ExpertFinding, nowMs: number): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-findings__group";

  const head = doc.createElement("p");
  head.className = "nimbus-findings__subject";
  const name = doc.createElement("span");
  name.textContent = entry.displayName;
  head.append(name);
  const confidence = doc.createElement("span");
  confidence.className = "nimbus-findings__badge";
  confidence.textContent = entry.confidence;
  head.append(confidence);
  box.append(head);

  for (const ev of entry.evidence) {
    box.append(renderEvidenceRow(doc, ev, nowMs));
  }
  return box;
}

export function renderExpertFindings(
  doc: Document,
  findings: ExpertFindings,
  nowMs: number,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-findings";

  if (findings.ranked.length === 0) {
    // Deliberately says nobody was found, and never implies the question
    // could not be asked — that is what `gaps` is for, and it renders separately.
    box.append(renderEmptyLine(doc, "No one in the index has worked on this."));
    return box;
  }

  for (const entry of findings.ranked) {
    box.append(renderPerson(doc, entry, nowMs));
  }
  return box;
}
