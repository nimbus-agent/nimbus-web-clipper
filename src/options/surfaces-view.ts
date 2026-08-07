// Pure DOM builders for the Options "Recognised surfaces" list. Origin strings
// are user input; every one is written with textContent, never innerHTML.
import { splitOrigin } from "../shared/origins.ts";
import type { Product } from "../shared/types.ts";

export interface SurfaceRow {
  readonly origin: string;
  readonly product: Product;
  /** Whether page access has been granted for this row's HOST. */
  readonly granted: boolean;
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
      row.granted
        ? button(doc, "revoke", row.origin, "Revoke page access")
        : button(doc, "grant", row.origin, "Grant page access"),
      button(doc, "remove", row.origin, "Remove"),
    );
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
