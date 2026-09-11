// Pure DOM builder for the Options "Service bindings" table (C10). A binding's
// `scope` is a registry-supplied repo-level key, not gateway-attested — every
// field here is written with textContent, never innerHTML.
import { productName } from "../shared/recognise/registry.ts";
import type { ServiceBinding } from "../shared/services.ts";

function cell(text: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

/**
 * One row per binding. The Unbind button's handler closes over the BINDING
 * ITSELF, not its product/origin/scope read back off a dataset attribute — so
 * `onUnbind` always receives the same object identity the row was built from,
 * never a value reconstructed (and possibly mismatched) from markup.
 */
function row(
  binding: ServiceBinding,
  onUnbind: (binding: ServiceBinding) => void,
): HTMLTableRowElement {
  const tr = document.createElement("tr");

  const scope = cell(binding.scope);
  scope.className = "bindings__scope";

  const unbind = document.createElement("button");
  unbind.type = "button";
  unbind.textContent = "Unbind";
  // Every row's visible text is the same "Unbind" — a screen-reader user
  // navigating between controls otherwise cannot tell which binding a given
  // button belongs to. The origin is what makes the name unique even between
  // two rows that differ only by origin (two self-hosted instances of one
  // product with the same scope) — the exact case the binding identity fix
  // (C10 review) exists to keep apart.
  unbind.setAttribute(
    "aria-label",
    `Unbind ${productName(binding.product)} ${binding.scope} (${binding.origin})`,
  );
  unbind.addEventListener("click", () => onUnbind(binding));
  const action = document.createElement("td");
  action.append(unbind);

  tr.append(
    scope,
    cell(binding.origin),
    cell(productName(binding.product)),
    cell(binding.serviceId),
    cell(binding.defaultBranch ?? ""),
    action,
  );
  return tr;
}

/** Renders the bindings table, or — when there are none — says so rather than
 *  showing a headed empty table (an empty table with column headers reads as
 *  "still loading", not "there is nothing here"). */
export function renderBindingsTable(
  bindings: readonly ServiceBinding[],
  onUnbind: (binding: ServiceBinding) => void,
): HTMLElement {
  if (bindings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "options__status";
    empty.textContent =
      "No service bindings yet. Bind a repository to a Nimbus service from the panel.";
    return empty;
  }

  const table = document.createElement("table");
  table.className = "bindings__table";

  const thead = document.createElement("thead");
  const head = document.createElement("tr");
  for (const label of ["Scope", "Origin", "Product", "Service", "Default branch", ""]) {
    const th = document.createElement("th");
    th.textContent = label;
    head.append(th);
  }
  thead.append(head);

  const tbody = document.createElement("tbody");
  for (const binding of bindings) {
    tbody.append(row(binding, onUnbind));
  }

  table.append(thead, tbody);
  return table;
}

/**
 * The `ok: false` arm of `ServiceBindingsListResponse` — a failed storage read,
 * NOT "you have no bindings". Rendering it as an empty table (or as
 * `renderBindingsTable([], ...)`) would tell a user who already bound a
 * repository that they have not, and invite a rebind that reintroduces the very
 * lost-update the worker's write-chain lock exists to prevent.
 */
export function renderBindingsError(): HTMLElement {
  const el = document.createElement("p");
  el.className = "options__status";
  el.textContent = "Could not read your service bindings. Reload this page to try again.";
  return el;
}
