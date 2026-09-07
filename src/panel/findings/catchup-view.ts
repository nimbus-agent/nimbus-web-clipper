// src/panel/findings/catchup-view.ts
// "What happened while you were away" grouped by service, each item scored
// against why it matters TO YOU — rather than a paragraph naming a few items
// with the filtering behind it invisible.
//
// `involvement` never surfaces in the flattened markdown at all: it is the
// entire basis on which the window was filtered down to this reader, and
// without it the list reads as arbitrary. `totalItemsInWindow` alongside
// `items.length` is the truncation fact the prose also drops — without it a
// reader cannot tell a quiet window from a truncated one, and those call for
// opposite reactions.
//
// This lane renders NO result links: `CatchupItem.itemId` IS a genuine
// `item.id`, unlike `impact`'s `affectedItemId`, but this client still has no
// id→URL resolver, so `title` is always plain text.
import type { CatchupFindings, CatchupSection } from "../../shared/findings.ts";
import { formatAge } from "../../shared/freshness.ts";
import { renderEmptyLine } from "./shared-view.ts";

/**
 * The involvement summary line, or `null` when every array is empty — an
 * ordinary state (nothing links this reader to the window yet), not an error,
 * so it renders nothing rather than an empty caveat.
 *
 * All four `involvement` arrays are surfaced here, `incidentServices`
 * included: this line exists to answer "what filtered this window down to
 * me", and `incidentServices` is one of the four filters that did — dropping
 * it would make the line answer the question incompletely.
 */
function renderInvolvement(
  doc: Document,
  involvement: CatchupFindings["involvement"],
): HTMLElement | null {
  const { ownedServices, activeRepos, incidentServices, collaboratorPersonIds } = involvement;
  if (
    ownedServices.length === 0 &&
    activeRepos.length === 0 &&
    incidentServices.length === 0 &&
    collaboratorPersonIds.length === 0
  ) {
    return null;
  }
  const parts: string[] = [];
  if (ownedServices.length > 0) {
    parts.push(`you own ${ownedServices.join(", ")}`);
  }
  if (activeRepos.length > 0) {
    parts.push(`active in ${activeRepos.join(", ")}`);
  }
  if (incidentServices.length > 0) {
    parts.push(`incidents in ${incidentServices.join(", ")}`);
  }
  if (collaboratorPersonIds.length > 0) {
    const n = collaboratorPersonIds.length;
    parts.push(n === 1 ? "1 collaborator" : `${n} collaborators`);
  }
  const note = doc.createElement("p");
  note.className = "nimbus-findings__provenance";
  note.textContent = `This window was filtered to you — ${parts.join(" · ")}.`;
  return note;
}

function renderItem(
  doc: Document,
  item: CatchupSection["items"][number],
  nowMs: number,
): HTMLElement {
  const row = doc.createElement("div");
  row.className = "nimbus-findings__item";

  const title = doc.createElement("span");
  title.textContent = item.title;
  row.append(title);

  const when = doc.createElement("span");
  when.className = "nimbus-findings__item-when";
  when.textContent = formatAge(item.modifiedAt, nowMs);
  row.append(when);

  if (item.relevanceReasons.length > 0) {
    const detail = doc.createElement("span");
    detail.className = "nimbus-findings__item-detail";
    detail.textContent = item.relevanceReasons.join(", ");
    row.append(detail);
  }

  return row;
}

function renderSection(doc: Document, section: CatchupSection, nowMs: number): HTMLElement {
  const group = doc.createElement("div");
  group.className = "nimbus-findings__group";

  const title = doc.createElement("p");
  title.className = "nimbus-findings__group-title";
  // Only rendered when they differ - showing "3 of 3" every time would bury
  // the one case a reader actually needs: a window that was cut short.
  title.textContent =
    section.items.length === section.totalItemsInWindow
      ? section.serviceId
      : `${section.serviceId} — ${section.items.length} of ${section.totalItemsInWindow}`;
  group.append(title);

  for (const item of section.items) {
    group.append(renderItem(doc, item, nowMs));
  }
  return group;
}

export function renderCatchupFindings(
  doc: Document,
  findings: CatchupFindings,
  nowMs: number,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-findings";

  const involvementNote = renderInvolvement(doc, findings.involvement);
  if (involvementNote !== null) {
    box.append(involvementNote);
  }

  if (findings.sections.length === 0) {
    // Deliberately says nothing was found, and never implies the question
    // could not be asked - that is what `gaps` is for, and it renders
    // separately. Rendered even when the involvement line above is present:
    // a quiet week is a real answer, not the absence of one.
    box.append(renderEmptyLine(doc, "Nothing in your window."));
    return box;
  }

  for (const section of findings.sections) {
    box.append(renderSection(doc, section, nowMs));
  }
  return box;
}
