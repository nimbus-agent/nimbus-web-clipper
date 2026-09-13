// Pure DOM builder for the Options "Service bindings" table (C10, C10.3 slice
// 2). A binding's `scope` is a registry-supplied repo-level key, not
// gateway-attested — every field here is written with textContent, never
// innerHTML.
import type { BindingCheckStatus } from "../shared/messages.ts";
import { productName } from "../shared/recognise/registry.ts";
import { bindingKey, type ServiceBinding } from "../shared/services.ts";

function cell(text: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

/**
 * The `service-bindings-check` verdict for one row, as DOM. `unchecked` NEVER
 * says the binding is wrong — a 403 or a rate limit is a fact about this
 * browser's token or this moment, not about the binding, and the bindings
 * table it decorates was already read successfully. The `unclaimed` wording is
 * the panel's §5.2 wording again, verbatim: upstream's match against
 * `nimbus.toml` is an EXACT string comparison, so a null answer also covers a
 * repo configured under different casing or a different coordinate form —
 * never "not configured", never an invitation to add a service.
 */
function statusCell(
  binding: ServiceBinding,
  status: BindingCheckStatus,
  onUpdate: ((binding: ServiceBinding, proposedServiceId: string) => void) | undefined,
): HTMLTableCellElement {
  const td = document.createElement("td");
  switch (status.state) {
    case "agrees":
      td.textContent = "Matches Nimbus";
      break;
    case "disagrees": {
      const { proposedServiceId } = status;
      const span = document.createElement("span");
      span.textContent = `Nimbus now maps this to “${proposedServiceId}”`;
      const use = document.createElement("button");
      use.type = "button";
      use.textContent = `Use “${proposedServiceId}”`;
      use.dataset["proposed"] = proposedServiceId;
      use.addEventListener("click", () => onUpdate?.(binding, proposedServiceId));
      td.append(span, use);
      break;
    }
    case "unclaimed":
      td.textContent = "No Nimbus service names this repository by this coordinate";
      break;
    case "ambiguous":
      td.textContent = `${status.candidates.length} services name this repository`;
      break;
    case "unchecked":
      td.textContent = "Could not check";
      break;
  }
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
  status: BindingCheckStatus | undefined,
  onUpdate: ((binding: ServiceBinding, proposedServiceId: string) => void) | undefined,
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
  );
  if (status !== undefined) {
    tr.append(statusCell(binding, status, onUpdate));
  }
  tr.append(action);
  return tr;
}

/**
 * Renders the bindings table, or — when there are none — says so rather than
 * showing a headed empty table (an empty table with column headers reads as
 * "still loading", not "there is nothing here").
 *
 * `statuses` and `onUpdate` are both optional and both absent by default
 * (C10.3 slice 2): with no `statuses` map the table renders exactly as it did
 * before this feature existed — no "Status" column, no correction button — so
 * every pre-existing caller keeps its original shape. The map is keyed by
 * `bindingKey(origin, product, scope)`, the one structural encoding this
 * codebase already uses for binding identity everywhere else; see that
 * function's doc comment in `src/shared/services.ts` for why a delimiter-joined
 * key is never a substitute.
 */
export function renderBindingsTable(
  bindings: readonly ServiceBinding[],
  onUnbind: (binding: ServiceBinding) => void,
  statuses?: ReadonlyMap<string, BindingCheckStatus>,
  onUpdate?: (binding: ServiceBinding, proposedServiceId: string) => void,
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
  const labels = ["Scope", "Origin", "Product", "Service", "Default branch"];
  if (statuses !== undefined) {
    labels.push("Status");
  }
  labels.push("");
  for (const label of labels) {
    const th = document.createElement("th");
    th.textContent = label;
    head.append(th);
  }
  thead.append(head);

  const tbody = document.createElement("tbody");
  for (const binding of bindings) {
    const status = statuses?.get(bindingKey(binding.origin, binding.product, binding.scope));
    tbody.append(row(binding, onUnbind, status, onUpdate));
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
