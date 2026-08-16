// Pure DOM builders for the Options "Recognised surfaces" list. Origin strings
// are user input; every one is written with textContent, never innerHTML.
import { splitOrigin } from "../shared/origins.ts";
import type { Product } from "../shared/types.ts";

export interface SurfaceRow {
  readonly origin: string;
  readonly product: Product;
  /** Whether page access has been granted for this row's HOST. */
  readonly granted: boolean;
  /** Built-in rows are not the user's entries: no Remove button. */
  readonly builtIn: boolean;
  /** Host permission pattern this row's grant and toggle are keyed by. */
  readonly pattern: string | null;
  /** Whether the ambient cue is switched on for this row's host. */
  readonly ambient: boolean;
}

const PRODUCT_NAMES: Record<Product, string> = {
  bitbucket: "Bitbucket",
  github: "GitHub",
  gitlab: "GitLab",
  jenkins: "Jenkins",
  jira: "Jira",
};

function button(doc: Document, action: string, origin: string, text: string): HTMLButtonElement {
  const el = doc.createElement("button");
  el.type = "button";
  el.dataset["action"] = action;
  el.dataset["origin"] = origin;
  el.textContent = text;
  return el;
}

/**
 * The per-host ambient switch. Keyed by PATTERN, not origin: two configured
 * origins can share a host (a /jira and a /jenkins on one box), and the cue —
 * like the grant — is a per-host decision, so both rows drive the same switch.
 *
 * Disabled without page access, because the cue is exactly the capability the
 * grant buys: offering the switch on a host we may not read would be offering
 * something that cannot happen.
 */
function ambientToggle(doc: Document, row: SurfaceRow): HTMLLabelElement {
  const label = doc.createElement("label");
  label.className = "surfaces__ambient";

  const disabled = !row.granted || row.pattern === null;

  const input = doc.createElement("input");
  input.type = "checkbox";
  input.dataset["action"] = "ambient";
  input.dataset["pattern"] = row.pattern ?? "";
  // Ticked means "this is happening", never "this is stored". A disabled tick
  // would be ambiguous exactly when it matters — after page access is revoked,
  // is the cue still on? It is not, so it does not show as on. The stored
  // preference is separately cleared on the revoke path (options.ts), so the two
  // cannot disagree; this rule additionally covers a revoke made from the
  // browser's own extension settings, which never reaches our click handler.
  input.checked = row.ambient && !disabled;
  input.disabled = disabled;

  const text = doc.createElement("span");
  text.textContent = "Surface automatically";

  label.append(input, text);
  return label;
}

export function renderSurfaceList(doc: Document, rows: readonly SurfaceRow[]): HTMLElement {
  if (rows.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "options__status";
    empty.textContent =
      "No self-hosted surfaces added. Bitbucket Cloud, GitHub, GitLab and Jira Cloud are recognised without setup.";
    return empty;
  }
  const list = doc.createElement("ul");
  list.className = "surfaces__list";
  for (const row of rows) {
    const item = doc.createElement("li");
    item.className = "surfaces__row";

    const origin = doc.createElement("span");
    origin.className = "surfaces__origin";
    origin.textContent = row.origin;

    const product = doc.createElement("span");
    product.className = "surfaces__product";
    product.textContent = PRODUCT_NAMES[row.product];

    item.append(
      origin,
      product,
      ambientToggle(doc, row),
      row.granted
        ? button(doc, "revoke", row.origin, "Revoke page access")
        : button(doc, "grant", row.origin, "Grant page access"),
    );
    // Built-in surfaces are recognised without configuration — they are not the
    // user's entries to delete, only to grant or silence.
    if (!row.builtIn) {
      item.append(button(doc, "remove", row.origin, "Remove"));
    }
    list.append(item);
  }
  return list;
}

/**
 * Page access is granted per HOST, so revoking one entry silences every other
 * entry on the same host. Name them rather than surprising the user.
 */
export function sharedHostNote(rows: readonly SurfaceRow[], origin: string): string | null {
  const base = splitOrigin(origin)?.base;
  if (base === undefined) {
    return null;
  }
  const siblings = rows
    .filter((r) => r.origin !== origin && splitOrigin(r.origin)?.base === base)
    .map((r) => r.origin);
  if (siblings.length === 0) {
    return null;
  }
  return `Page access is granted per host, so this also affects: ${siblings.join(", ")}.`;
}
