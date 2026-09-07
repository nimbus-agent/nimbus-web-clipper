// src/panel/findings/impact-view.ts
// "What this change reaches" grouped by kind of downstream, each row carrying
// the reasoning behind it — rather than a paragraph naming a few services.
//
// `hops` and `pathSummary` are the answer to "why is this affected?", the only
// thing distinguishing a direct dependency from a four-hop inference; the
// flattened prose drops both. `affectedItemId` is dropped too, deliberately: it
// is a `graph_entity.id`, not an item id (see `ImpactFindings`'s comment in
// findings.ts), so it is never rendered, labelled, or fed to a resolver.
//
// This lane renders NO result links: nothing on `ImpactFinding` is a URL, and
// unlike `expert`'s `Evidence.itemId`, `affectedItemId` is not even an item
// reference this client could resolve if it had a resolver.
import type { ImpactFinding, ImpactFindings } from "../../shared/findings.ts";
import { renderEmptyLine } from "./shared-view.ts";

/**
 * Render order, and the heading each category gets. Declaration order here IS
 * render order, so the grouping does not reorder itself between responses.
 */
const CATEGORY_TITLES: Readonly<Record<ImpactFinding["category"], string>> = {
  service: "Services",
  pipeline: "Pipelines",
  dashboard: "Dashboards",
  oncall_rotation: "On-call rotations",
  downstream_repo: "Downstream repos",
};

const CATEGORY_ORDER: readonly ImpactFinding["category"][] = [
  "service",
  "pipeline",
  "dashboard",
  "oncall_rotation",
  "downstream_repo",
];

function renderRow(doc: Document, finding: ImpactFinding): HTMLElement {
  const row = doc.createElement("div");
  row.className = "nimbus-findings__item";

  const title = doc.createElement("span");
  title.textContent = finding.affectedTitle;
  row.append(title);

  const service = doc.createElement("span");
  service.className = "nimbus-findings__item-when";
  service.textContent = finding.serviceId;
  row.append(service);

  const hops = doc.createElement("span");
  hops.className = "nimbus-findings__badge";
  hops.textContent = finding.hops === 1 ? "1 hop" : `${finding.hops} hops`;
  row.append(hops);

  const detail = doc.createElement("span");
  detail.className = "nimbus-findings__item-detail";
  detail.textContent = finding.pathSummary;
  row.append(detail);

  return row;
}

function renderCategory(
  doc: Document,
  category: ImpactFinding["category"],
  rows: readonly ImpactFinding[],
): HTMLElement {
  const group = doc.createElement("div");
  group.className = "nimbus-findings__group";
  const title = doc.createElement("p");
  title.className = "nimbus-findings__group-title";
  title.textContent = CATEGORY_TITLES[category];
  group.append(title);
  for (const row of rows) {
    group.append(renderRow(doc, row));
  }
  return group;
}

export function renderImpactFindings(
  doc: Document,
  findings: ImpactFindings,
  _nowMs: number,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-findings";

  if (findings.startEntityId === null) {
    // A real, reportable state, not an empty result: without this line a
    // reader who sees "nothing affected" below draws the wrong conclusion —
    // the graph never found where to start, rather than finding a clean zero.
    const note = doc.createElement("p");
    note.className = "nimbus-findings__provenance";
    note.textContent = "The starting point for this change did not resolve in the index.";
    box.append(note);
  }

  if (findings.affected.length === 0) {
    box.append(renderEmptyLine(doc, "Nothing downstream of this is indexed."));
    return box;
  }

  for (const category of CATEGORY_ORDER) {
    const rows = findings.affected.filter((f) => f.category === category);
    if (rows.length === 0) {
      continue;
    }
    box.append(renderCategory(doc, category, rows));
  }
  return box;
}
