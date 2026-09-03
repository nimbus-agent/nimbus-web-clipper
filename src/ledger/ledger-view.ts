// src/ledger/ledger-view.ts
// The Activity page's renderer. Pure: a model in, DOM out, no messaging and no
// clock of its own — `nowMs` arrives on the model so the age strings are
// testable.
//
// Every node is built with createElement + textContent. Nothing here parses
// text as markup: `destination`, `method` and the gateway's `reason` are all
// gateway-supplied strings, and one of them reaching innerHTML is the whole
// difference between a list and an injection.

import {
  type ActionClass,
  actionClass,
  type EgressPartition,
  type EgressRow,
  type EgressVerdict,
  type LedgerOutcome,
} from "../shared/egress.ts";
import { formatAge } from "../shared/freshness.ts";
import type { EgressFailure } from "../shared/messages.ts";
import { scopeCommand } from "../shared/scope-command.ts";
import type { ScopeGap } from "../shared/types.ts";

export type LedgerScope = "ours" | "all";

export type LedgerModel =
  | {
      readonly state: "loaded";
      readonly scope: LedgerScope;
      readonly partition: EgressPartition;
      /** This browser's own device label, so the All scope can name the OTHER
       *  clients rather than only marking rows as attributed. */
      readonly ourLabel: string | null;
      /**
       * How each action ended, keyed by that action's own `rowHash`.
       *
       * A missing key renders as "not recorded", NEVER as in-flight: a gateway
       * older than the outcome marker writes rows indistinguishable from ones
       * whose marker was lost, and an action whose marker sits on another page
       * is the same from this page's evidence.
       */
      readonly outcomes: ReadonlyMap<string, LedgerOutcome>;
      readonly rowsTotal: number;
      readonly rowsTruncated: boolean;
      readonly verdict: EgressVerdict | null;
      readonly nowMs: number;
      /** True once the reader has paged back. The first page IS the most recent
       *  one; a later page is not, and must not claim to be. */
      readonly paged?: boolean;
    }
  | {
      readonly state: "error";
      readonly reason: EgressFailure;
      readonly scopeGap?: ScopeGap;
    };

const ACTION_LABELS: Record<ActionClass, string> = {
  "targeted-fetch": "Targeted fetch",
  "agent-run": "Agent run",
  "background-sync": "Background sync",
  other: "Other",
};

/**
 * Why a read did not answer, in the user's terms.
 *
 * `insufficient_scope` is handled separately because it is the only one with a
 * remedy the page can hand over, and that remedy must be BUILT (see
 * `scope-command.ts`), never written out here.
 */
const FAILURE_MESSAGES: Record<EgressFailure, string> = {
  unreachable: "Could not reach your gateway.",
  unauthorized: "Your pairing is no longer accepted. Pair again.",
  insufficient_scope: "This browser is not granted the activity scope.",
  unsupported: "Your gateway does not offer the activity ledger yet.",
  rate_limited: "Your gateway is rate-limiting this read. Try again shortly.",
  server_error: "Your gateway could not answer that.",
  not_paired: "Pair with your gateway first.",
};

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** The rows the current scope shows, newest first as the gateway returned them. */
function visibleRows(partition: EgressPartition, scope: LedgerScope): readonly EgressRow[] {
  if (scope === "ours") {
    return partition.ours;
  }
  return [...partition.ours, ...partition.others, ...partition.unattributable].sort(
    (a, b) => b.id - a.id,
  );
}

const OUTCOME_LABELS: Record<LedgerOutcome["status"], string> = {
  indexed: "Indexed",
  not_found: "Not found",
  rate_limited: "Rate-limited",
};

/** The outcome cell: what the gateway recorded, or that it recorded nothing. */
function renderOutcome(outcome: LedgerOutcome | undefined): HTMLElement {
  if (outcome === undefined) {
    return el("span", "ledger__outcome ledger__outcome--absent", "Outcome not recorded");
  }
  // itemId wins over reason when both are present: an id names the thing that
  // happened, a reason only describes it.
  const detail = outcome.itemId ?? outcome.reason;
  const text =
    detail === undefined
      ? OUTCOME_LABELS[outcome.status]
      : `${OUTCOME_LABELS[outcome.status]} — ${detail}`;
  return el("span", `ledger__outcome ledger__outcome--${outcome.status}`, text);
}

function renderRow(
  row: EgressRow,
  nowMs: number,
  ourLabel: string | null,
  outcome: LedgerOutcome | undefined,
): HTMLElement {
  const item = el("li", "ledger__row");
  item.append(el("span", "ledger__when", formatAge(row.timestamp, nowMs)));
  item.append(el("span", "ledger__service", row.destination));
  item.append(el("span", "ledger__action", ACTION_LABELS[actionClass(row)]));
  if (row.resultStatus === "blocked") {
    item.append(el("span", "ledger__blocked", "Blocked"));
  }
  // Only a fetch has an outcome to report. An agent run or a background sync has
  // no equivalent record, and printing "not recorded" against them would invent a
  // gap the ledger never claimed.
  if (actionClass(row) === "targeted-fetch") {
    item.append(renderOutcome(outcome));
  }
  if (row.sourceId === null) {
    // Labelled, never guessed. An unlabelled row means the gateway could not say
    // who asked — not that nobody did.
    item.append(el("span", "ledger__unattributed", "Not attributable"));
  } else if (ourLabel !== null && row.sourceId !== ourLabel) {
    // In the All scope, "yours" and "another client's" rendered identically, so
    // the view showed WHETHER a row was attributed without ever saying to WHOM.
    // The label is gateway-supplied text, so it goes in via textContent like
    // every other field.
    item.append(el("span", "ledger__client", row.sourceId));
  }
  return item;
}

/**
 * The honesty notice for the default scope.
 *
 * On a gateway older than caller attribution (Nimbus#1322) every targeted fetch
 * is unlabelled, so leading with "yours" would render a silently short list.
 * `method` still tells us these were asked for by SOMEONE, which is exactly as
 * much as can be said without guessing.
 */
function unattributedFetchNotice(partition: EgressPartition): string | null {
  const n = partition.unattributable.filter((r) => actionClass(r) === "targeted-fetch").length;
  if (n === 0) {
    return null;
  }
  const noun = n === 1 ? "targeted fetch" : "targeted fetches";
  return `${n} ${noun} in this window cannot be attributed to a client on this gateway. See All.`;
}

function renderVerdict(verdict: EgressVerdict): HTMLElement {
  if (verdict.intact) {
    return el("p", "ledger__verdict ledger__verdict--ok", "Chain verified.");
  }
  const where = verdict.brokenAt === null ? "" : ` — first break at row ${verdict.brokenAt}`;
  return el(
    "p",
    "ledger__verdict ledger__verdict--broken",
    `The chain did not verify${where}. That means tampering, database corruption, or a pruned window missing its tombstone. Export proof for diagnosis.`,
  );
}

function renderError(root: HTMLElement, model: Extract<LedgerModel, { state: "error" }>): void {
  root.append(el("p", "ledger__error", FAILURE_MESSAGES[model.reason]));
  if (model.reason !== "insufficient_scope") {
    return;
  }
  // Built, never templated: `--set` REPLACES the scope set, so the command must
  // name every scope the token should end up with, and the label and scope names
  // are gateway-supplied strings `scopeCommand` refuses to embed unless they are
  // shell-safe. Re-pairing is NOT the remedy and is never suggested.
  const command = model.scopeGap === undefined ? null : scopeCommand(model.scopeGap);
  root.append(
    command === null
      ? el(
          "p",
          "ledger__remedy",
          "Run nimbus clip status on your gateway to find this device, then grant it the scope.",
        )
      : el("code", "ledger__command", command),
  );
}

export function renderLedger(root: HTMLElement, model: LedgerModel): void {
  root.replaceChildren();
  if (model.state === "error") {
    renderError(root, model);
    return;
  }

  if (model.verdict !== null) {
    root.append(renderVerdict(model.verdict));
  }

  if (model.scope === "ours") {
    const notice = unattributedFetchNotice(model.partition);
    if (notice !== null) {
      root.append(el("p", "ledger__notice", notice));
    }
  }

  const rows = visibleRows(model.partition, model.scope);
  if (rows.length === 0) {
    root.append(el("p", "ledger__empty", "Nothing recorded in this window."));
  } else {
    const list = el("ul", "ledger__rows");
    for (const row of rows) {
      list.append(renderRow(row, model.nowMs, model.ourLabel, model.outcomes.get(row.rowHash)));
    }
    root.append(list);
  }

  if (model.rowsTruncated) {
    root.append(
      el(
        "p",
        "ledger__truncated",
        model.paged === true
          ? `Showing a page of ${model.rowsTotal} recorded actions.`
          : `Showing the most recent page of ${model.rowsTotal} recorded actions.`,
      ),
    );
  }
}
