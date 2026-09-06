// src/panel/findings/why-view.ts
// "Why does this change exist" as a timeline rather than a paragraph.
//
// This is the lane the structured form buys the most: `WhyFinding` is the only
// findings shape on the browser's seven that carries a real URL, so it is where
// the panel gains its first clickable references. They come from the gateway's
// index, not from parsing model prose — which is the distinction that makes them
// safe to add while a markdown pass still is not.
import type { WhyFindings, WhyLane } from "../../shared/findings.ts";
import { formatAge } from "../../shared/freshness.ts";
import { findingLink, renderEmptyLine } from "./shared-view.ts";

/**
 * Render order, and the heading each lane gets.
 *
 * Declaration order here IS render order, and it is the contract's order rather
 * than whatever sequence the gateway emitted — a timeline that reorders itself
 * per response reads as noise.
 */
const LANE_TITLES: Readonly<Record<WhyLane, string>> = {
  authorship: "Authorship",
  pull_request: "Pull requests",
  ticket: "Tickets",
  discussion: "Discussion",
  driver: "Drivers",
  downstream: "Downstream",
};

const LANE_ORDER: readonly WhyLane[] = [
  "authorship",
  "pull_request",
  "ticket",
  "discussion",
  "driver",
  "downstream",
];

/**
 * The one subject that is present, as a heading. The three are alternatives.
 *
 * Its own class rather than reusing `__group-title`: the subject is not a lane
 * group, and sharing the class would make every `__group-title` assertion in the
 * tests ambiguous about which element it matched.
 */
function renderSubject(doc: Document, findings: WhyFindings): HTMLElement | null {
  const head = doc.createElement("p");
  head.className = "nimbus-findings__subject";
  if (findings.changeSubject !== null) {
    // `WhyChangeSubject.url` is non-nullable, unlike `WhyItemSubject.url`. One
    // null-check cannot span the two arms — the types genuinely differ.
    head.append(findingLink(doc, findings.changeSubject.title, findings.changeSubject.url));
    return head;
  }
  if (findings.itemSubject !== null) {
    head.append(findingLink(doc, findings.itemSubject.title, findings.itemSubject.url));
    return head;
  }
  if (findings.subject !== null) {
    // A local path triple — no URL exists for it, so it is always text.
    head.textContent = findings.subject.filePath;
    return head;
  }
  return null;
}

export function renderWhyFindings(
  doc: Document,
  findings: WhyFindings,
  nowMs: number,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-findings";

  const subject = renderSubject(doc, findings);
  if (subject !== null) {
    box.append(subject);
  }

  if (findings.findings.length === 0) {
    // Deliberately says the lane found nothing, and never implies the question
    // could not be asked — that is what `gaps` is for, and it renders separately.
    box.append(renderEmptyLine(doc, "No history recorded for this."));
    return box;
  }

  for (const lane of LANE_ORDER) {
    const rows = findings.findings.filter((f) => f.lane === lane);
    if (rows.length === 0) {
      continue;
    }
    const group = doc.createElement("div");
    group.className = "nimbus-findings__group";
    const title = doc.createElement("p");
    title.className = "nimbus-findings__group-title";
    title.textContent = LANE_TITLES[lane];
    group.append(title);

    for (const row of rows) {
      const item = doc.createElement("div");
      item.className = "nimbus-findings__item";
      item.append(findingLink(doc, row.title, row.url));
      const detail = doc.createElement("span");
      detail.className = "nimbus-findings__item-detail";
      detail.textContent = row.detail;
      item.append(detail);
      if (row.occurredAt !== null) {
        const when = doc.createElement("span");
        when.className = "nimbus-findings__item-when";
        when.textContent = formatAge(row.occurredAt, nowMs);
        item.append(when);
      }
      group.append(item);
    }
    box.append(group);
  }
  return box;
}
