// src/panel/findings/ownership-view.ts
// "Who owns this" as the target's own owners, ranked by share, plus how
// confidently the index knows any of that — rather than a paragraph naming a
// name.
//
// This is the last of C8.3's four link-less lanes, and the only one with no
// item id anywhere on the brief to begin with: `OwnershipOwner.externalId` is
// a PERSON id and `OwnershipTargetView.displayPath` is a PATH, so there is no
// URL this lane could ever render, resolver or not.
//
// Two nullability facts drive most of this file. `ownerCount`,
// `ownersAboveFloor` and `truncated` being `null` means NOT RECORDED — never
// zero, never "not truncated" — so each renders only when it is recorded, and
// says nothing at all otherwise; a line reading "0 owners" or a truncation
// note's silent absence would both misreport an unrecorded value as a known
// one. And `resolved: false` means `externalId` is a `git:<email>` fallback
// with no matched person row, so `label` is an email address, not a person the
// index actually knows — the "unresolved" badge is what tells the two apart.
import type {
  OwnershipCoverage,
  OwnershipFindings,
  OwnershipOwner,
  OwnershipTargetView,
} from "../../shared/findings.ts";
import { formatAge } from "../../shared/freshness.ts";
import { renderEmptyLine } from "./shared-view.ts";

const TARGET_KIND_LABELS: Readonly<Record<OwnershipTargetView["kind"], string>> = {
  source_file: "File",
  directory: "Directory",
  service: "Service",
};

function renderOwnerRow(doc: Document, owner: OwnershipOwner): HTMLElement {
  const row = doc.createElement("div");
  row.className = "nimbus-findings__item";

  const label = doc.createElement("span");
  label.textContent = owner.label;
  row.append(label);

  // Reuses the "when" style for a small, muted, inline trailer — the class
  // name says "time" but the styling (size, opacity, spacing) is what this
  // row needs, and a fifth CSS rule for one more inline number is not worth
  // adding.
  const share = doc.createElement("span");
  share.className = "nimbus-findings__item-when";
  share.textContent = `${Math.round(owner.share * 100)}%`;
  row.append(share);

  if (!owner.resolved) {
    const badge = doc.createElement("span");
    badge.className = "nimbus-findings__badge";
    badge.textContent = "unresolved";
    row.append(badge);
  }

  return row;
}

/**
 * One target (the requested path, or its parent directory) as a group: its
 * subject line, its owner rows or the "no owners" line, the recorded
 * count/floor note, and a truncation note — each of the last two present only
 * when its underlying field is recorded, per this file's header.
 */
function renderTargetGroup(
  doc: Document,
  target: OwnershipTargetView,
  groupTitle: string | null,
): HTMLElement {
  const group = doc.createElement("div");
  group.className = "nimbus-findings__group";

  if (groupTitle !== null) {
    const title = doc.createElement("p");
    title.className = "nimbus-findings__group-title";
    title.textContent = groupTitle;
    group.append(title);
  }

  const subject = doc.createElement("p");
  subject.className = "nimbus-findings__subject";
  const path = doc.createElement("span");
  path.textContent = target.displayPath;
  subject.append(path);
  const kind = doc.createElement("span");
  kind.className = "nimbus-findings__badge";
  kind.textContent = TARGET_KIND_LABELS[target.kind];
  subject.append(kind);
  group.append(subject);

  if (target.owners.length === 0) {
    group.append(renderEmptyLine(doc, "No owners recorded for this path."));
  } else {
    for (const owner of target.owners) {
      group.append(renderOwnerRow(doc, owner));
    }
  }

  // `null` means not recorded, not zero — say nothing rather than guess.
  if (target.ownerCount !== null && target.ownersAboveFloor !== null) {
    const count = doc.createElement("p");
    count.className = "nimbus-findings__item-detail";
    count.textContent = `${target.ownersAboveFloor} of ${target.ownerCount} owners above the floor.`;
    group.append(count);
  }

  // `null` means not recorded, not "not truncated" — only the `true` arm
  // renders anything.
  if (target.truncated === true) {
    const note = doc.createElement("p");
    note.className = "nimbus-findings__provenance";
    note.textContent = "This owner list was truncated.";
    group.append(note);
  }

  return group;
}

function renderCoverageLine(
  doc: Document,
  coverage: OwnershipCoverage,
  nowMs: number,
): HTMLElement {
  const note = doc.createElement("p");
  note.className = "nimbus-findings__provenance";
  note.textContent =
    coverage.lastPassAt === null
      ? "No pass recorded."
      : `Last pass ${formatAge(coverage.lastPassAt, nowMs)}.`;
  return note;
}

export function renderOwnershipFindings(
  doc: Document,
  findings: OwnershipFindings,
  nowMs: number,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-findings";

  if (findings.target === null && findings.parentDirectory === null) {
    // Both null is the fully empty state: summary mode, or a path (and its
    // parent) that resolved to no graph entity. Nothing else on this brief
    // has anything to show.
    box.append(renderEmptyLine(doc, "No owners recorded for this path."));
    return box;
  }

  if (findings.target !== null) {
    box.append(renderTargetGroup(doc, findings.target, null));
  }

  if (findings.parentDirectory !== null) {
    box.append(renderTargetGroup(doc, findings.parentDirectory, "Parent directory"));
  }

  box.append(renderCoverageLine(doc, findings.coverage, nowMs));

  return box;
}
