// src/options/ledger-summary-view.ts
// The trust panel's second half: "and what did it go and get?".
//
// Pure, and deliberately smaller than the Activity page's renderer. It states
// counts and points at the page; it never claims verification, because
// verification is an explicit action and its result belongs where the action is.
//
// Both this and ledger-view.ts consume the same `partitionRows` output, so the
// summary and the page cannot disagree about what counts as ours — the
// discipline shared/preview.ts already enforces for the clip and fetch previews.

import type { EgressFailure } from "../shared/messages.ts";
import { scopeCommand } from "../shared/scope-command.ts";
import type { ScopeGap } from "../shared/types.ts";

export type LedgerSummaryModel =
  | {
      readonly state: "loaded";
      readonly rowsTotal: number;
      readonly oursCount: number;
      readonly rowsTruncated: boolean;
    }
  | {
      readonly state: "error";
      readonly reason: EgressFailure;
      readonly scopeGap?: ScopeGap;
    };

const FAILURE_MESSAGES: Record<EgressFailure, string> = {
  unreachable: "Could not read your gateway's activity record.",
  unauthorized: "Could not read your gateway's activity record.",
  insufficient_scope: "This browser is not granted the activity scope.",
  unsupported: "Your gateway does not offer the activity ledger yet.",
  rate_limited: "Could not read your gateway's activity record.",
  server_error: "Could not read your gateway's activity record.",
  not_paired: "Pair with your gateway to see what it did for you.",
};

function el(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * The counts, phrased to match how much is actually known.
 *
 * `rowsTotal` is counted in SQL by the gateway over the whole window;
 * `oursCount` can only be counted from the page it returned. When the page is
 * the whole window both are facts. When it is not, the split becomes a floor —
 * stating it as exact would under-report, which is the failure the route's
 * totals exist to prevent.
 */
function loadedText(rowsTotal: number, oursCount: number, truncated: boolean): string {
  return truncated
    ? `${rowsTotal} outbound actions recorded — at least ${oursCount} from this browser in the most recent page.`
    : `${rowsTotal} outbound actions recorded, ${oursCount} of them from this browser.`;
}

export function renderLedgerSummary(root: HTMLElement, model: LedgerSummaryModel): void {
  root.replaceChildren();
  if (model.state === "loaded") {
    root.append(
      el(
        "span",
        "trust-ledger__counts",
        loadedText(model.rowsTotal, model.oursCount, model.rowsTruncated),
      ),
    );
    return;
  }

  root.append(el("span", "trust-ledger__error", FAILURE_MESSAGES[model.reason]));
  if (model.reason !== "insufficient_scope") {
    return;
  }
  // Built by scopeCommand, never written out here: `--set` replaces the scope
  // set, and the label and scope names are gateway-supplied strings it refuses
  // to embed unless they are shell-safe. Re-pairing is not the remedy.
  const command = model.scopeGap === undefined ? null : scopeCommand(model.scopeGap);
  // A text node, so the command does not butt against the sentence before it
  // ("...activity scope.nimbus clip scopes ...").
  root.append(document.createTextNode(" "));
  root.append(
    command === null
      ? el("span", "trust-ledger__remedy", " Run nimbus clip status on your gateway to grant it.")
      : el("code", "trust-ledger__command", command),
  );
}
