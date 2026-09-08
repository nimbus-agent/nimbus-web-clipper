// src/panel/findings/expert-view.ts
// "Who knows this" as a ranked list of people and the evidence behind the
// ranking — rather than a paragraph naming a name.
//
// `personId` and `score` never surface in the flattened markdown at all.
// `confidence` and `score` are the ranking's own reasoning: printing one while
// sorting by the other would be the same defect the `glossary` lane had when
// it showed `docFreq` while printing nothing about `score`, the value the list
// is actually ordered by (spec §4.4) — so both render, as badges. Per-evidence
// `weight` stays unrendered: the renderer orders evidence by the ranking the
// gateway already computed rather than re-deriving it from `weight` for
// display. `personId` also stays unrendered — it is an opaque id with nothing
// for a reader to act on.
//
// `Evidence.itemId` is a genuine `item.id`, resolved (task 3) against
// `/v1/items/resolve-ids` and handed to this renderer as `itemUrls` — a map
// lookup that misses (an unresolved id, or no map at all on an older/
// un-scoped gateway) needs no branch of its own: `findingLink` already falls
// back to plain text. `displayName` stays unrendered as a link — a person has
// no item id to resolve.
import type { Evidence, ExpertFinding, ExpertFindings, ItemUrlMap } from "../../shared/findings.ts";
import { formatAge } from "../../shared/freshness.ts";
import { findingLink, renderEmptyLine } from "./shared-view.ts";

function renderEvidenceRow(
  doc: Document,
  ev: Evidence,
  nowMs: number,
  itemUrls: ItemUrlMap | undefined,
): HTMLElement {
  const row = doc.createElement("div");
  row.className = "nimbus-findings__item";
  const title = findingLink(doc, ev.title, itemUrls?.[ev.itemId]);
  const type = doc.createElement("span");
  type.className = "nimbus-findings__badge";
  type.textContent = ev.type;
  const when = doc.createElement("span");
  when.className = "nimbus-findings__item-when";
  when.textContent = formatAge(ev.modifiedAt, nowMs);
  row.append(title, type, when);
  return row;
}

function renderPerson(
  doc: Document,
  entry: ExpertFinding,
  nowMs: number,
  itemUrls: ItemUrlMap | undefined,
): HTMLElement {
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
  const score = doc.createElement("span");
  score.className = "nimbus-findings__badge";
  score.textContent = `score ${entry.score}`;
  head.append(score);
  box.append(head);

  for (const ev of entry.evidence) {
    box.append(renderEvidenceRow(doc, ev, nowMs, itemUrls));
  }
  return box;
}

export function renderExpertFindings(
  doc: Document,
  findings: ExpertFindings,
  nowMs: number,
  itemUrls?: ItemUrlMap,
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
    box.append(renderPerson(doc, entry, nowMs, itemUrls));
  }
  return box;
}
