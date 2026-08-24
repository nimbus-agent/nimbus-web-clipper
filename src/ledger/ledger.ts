// src/ledger/ledger.ts
// The Activity page. Sends messages, renders what comes back.
//
// It never calls the gateway: the service worker owns the token and the reads.
// It also never stores a row — the whole point of C4.1 is that this page shows
// the gateway's record rather than a copy of its own that could quietly
// disagree with `nimbus prove`.
//
// Every send goes through the browser seam's `sendMessage`, typed as
// `ExtensionRequest`, for the reason brief.ts records: a raw
// `chrome.runtime.sendMessage` takes `unknown`, which is how a breaking change
// to a request shape once got past the compiler.

import { sendMessage } from "../browser/runtime.ts";
import type {
  EgressPartition,
  EgressProof,
  EgressVerdict,
  LedgerOutcome,
} from "../shared/egress.ts";
import type {
  EgressProveResponse,
  EgressVerifyResponse,
  EgressWindowResponse,
} from "../shared/messages.ts";
import { type LedgerModel, type LedgerScope, renderLedger } from "./ledger-view.ts";

const body = document.getElementById("ledger-body");
const oursButton = document.getElementById("scope-ours");
const allButton = document.getElementById("scope-all");
const verifyButton = document.getElementById("verify");
const proveButton = document.getElementById("prove");
const olderButton = document.getElementById("older");

/**
 * The last window the gateway answered with, and the verdict for the chain.
 *
 * The verdict is deliberately NOT cleared by a scope toggle or by paging:
 * `verifyEgressChain` walks the WHOLE chain upstream, so a verdict is a claim
 * about the ledger, not about the rows currently on screen.
 */
let partition: EgressPartition = { ours: [], others: [], unattributable: [] };
let rowsTotal = 0;
let rowsTruncated = false;
let verdict: EgressVerdict | null = null;
let ourLabel: string | null = null;
/**
 * Outcomes ACCUMULATE across pages; the row list does not.
 *
 * A marker carries a higher id than the action it describes, so newest-first
 * paging hands the marker over on one page and its action on the NEXT. Replacing
 * this map per page would therefore discard a marker just before the action it
 * belongs to arrives, and render "Outcome not recorded" for an outcome the
 * gateway had already told us. Remembering it within the open page is not a
 * private log — nothing is persisted, and every value here came from a read in
 * this session.
 */
const outcomes = new Map<string, LedgerOutcome>();
let paged = false;
let scope: LedgerScope = "ours";
let failure: Extract<LedgerModel, { state: "error" }> | null = null;

function render(): void {
  if (body === null) {
    return;
  }
  renderLedger(
    body,
    failure ?? {
      state: "loaded",
      scope,
      partition,
      ourLabel,
      outcomes,
      rowsTotal,
      rowsTruncated,
      verdict,
      paged,
      nowMs: Date.now(),
    },
  );
  oursButton?.setAttribute("aria-pressed", String(scope === "ours"));
  allButton?.setAttribute("aria-pressed", String(scope === "all"));
  if (olderButton !== null) {
    olderButton.hidden = failure !== null || !rowsTruncated;
  }
}

/** The oldest row currently shown — the cursor for the next page back. */
function oldestShownId(): number | undefined {
  const all = [...partition.ours, ...partition.others, ...partition.unattributable];
  if (all.length === 0) {
    return undefined;
  }
  return all.reduce((min, row) => Math.min(min, row.id), all[0]?.id ?? 0);
}

/**
 * Is this a reply to the request we actually made?
 *
 * `sendMessage` is typed `unknown` at the seam. A null, a stale reply, or a
 * response for a DIFFERENT request must not be read as one of ours: `res.ok`
 * would throw on null, and a mismatched shape would reach the renderer.
 */
function isReplyFor<K extends string>(res: unknown, kind: K): res is { kind: K; ok: boolean } {
  return typeof res === "object" && res !== null && (res as { kind?: unknown }).kind === kind;
}

async function loadWindow(before?: number): Promise<void> {
  const raw = await sendMessage(
    before === undefined ? { kind: "egress-window" } : { kind: "egress-window", before },
  );
  if (!isReplyFor(raw, "egress-window")) {
    failure = { state: "error", reason: "server_error" };
    render();
    return;
  }
  const res = raw as EgressWindowResponse;
  if (!res.ok) {
    failure =
      res.scopeGap === undefined
        ? { state: "error", reason: res.reason }
        : { state: "error", reason: res.reason, scopeGap: res.scopeGap };
    render();
    return;
  }
  failure = null;
  paged = before !== undefined;
  ourLabel = res.ourLabel;
  // Merged, never replaced — see the declaration. The response carries a plain
  // object across the message boundary; the view wants lookup, not iteration.
  for (const [hash, outcome] of Object.entries(res.outcomes)) {
    outcomes.set(hash, outcome);
  }
  // Replace, never append: each response carries its own totals, and a list
  // spanning several responses would be described by only the newest one's.
  partition = res.partition;
  rowsTotal = res.rowsTotal;
  rowsTruncated = res.rowsTruncated;
  render();
}

async function runVerify(): Promise<void> {
  const raw = await sendMessage({ kind: "egress-verify" });
  const res = isReplyFor(raw, "egress-verify") ? (raw as EgressVerifyResponse) : undefined;
  if (!res?.ok) {
    // A failed CHECK is not a broken chain. Saying "did not verify" here would
    // claim evidence we do not have.
    failure =
      res?.scopeGap !== undefined
        ? { state: "error", reason: res.reason, scopeGap: res.scopeGap }
        : { state: "error", reason: res?.ok === false ? res.reason : "server_error" };
    render();
    return;
  }
  // A previous failure must not survive a successful retry: `render()` would
  // otherwise keep drawing the old error over a verdict that just arrived.
  failure = null;
  verdict = res.verdict;
  render();
}

function downloadProof(proof: EgressProof): void {
  const blob = new Blob([JSON.stringify(proof, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "nimbus-egress-proof.json";
  link.click();
  // Revoked on the next tick, not synchronously: revoking straight after
  // `click()` can abort the download before the browser has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

async function runProve(): Promise<void> {
  const raw = await sendMessage({ kind: "egress-prove" });
  const res = isReplyFor(raw, "egress-prove") ? (raw as EgressProveResponse) : undefined;
  if (!res?.ok) {
    failure =
      res?.scopeGap !== undefined
        ? { state: "error", reason: res.reason, scopeGap: res.scopeGap }
        : { state: "error", reason: res?.ok === false ? res.reason : "server_error" };
    render();
    return;
  }
  downloadProof(res.proof);
}

function setScope(next: LedgerScope): void {
  // A toggle re-renders the response already in hand. Re-reading would show a
  // different window than the one just verified, and would spend a gateway read
  // to display rows already on the page.
  scope = next;
  render();
}

oursButton?.addEventListener("click", () => setScope("ours"));
allButton?.addEventListener("click", () => setScope("all"));
verifyButton?.addEventListener("click", () => void runVerify());
// Only ever on an explicit gesture: prove signs with the gateway's Vault key and
// carries its own tight rate limit, so it must never fire on mount.
proveButton?.addEventListener("click", () => void runProve());
olderButton?.addEventListener("click", () => void loadWindow(oldestShownId()));

void loadWindow();
