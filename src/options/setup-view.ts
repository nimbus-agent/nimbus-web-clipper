// Pure stage-state decision for the Options page. No DOM, no chrome.* — this is
// the branching that used to live in options.ts's render functions, lifted out so
// it can be tested without a page.
import type { ConnectionResponse } from "../shared/messages.ts";
import { formatPairedSince } from "./connection-view.ts";

export type StageState = "active" | "done" | "needs-attention" | "locked";

export interface Stages {
  readonly connect: StageState;
  readonly connection: StageState;
  readonly sites: StageState;
  readonly trust: StageState;
}

/**
 * Which stages are open, and which one needs the user.
 *
 * LOCKING IS FOR NEVER-CONFIGURED, NEVER FOR BROKEN. A stale token or an
 * unreachable gateway flags stage 1 and leaves 2 and 3 open, because Unpair lives
 * in stage 2 — re-locking it would hide the only control that fixes the very
 * condition that caused the lock. Revoking page access (stage 3) has to stay
 * reachable for the same reason: a user withdrawing access is most likely to want
 * it when something is wrong.
 *
 * Stage 4 is ALWAYS open. "Where does my data go?" has to be answerable before
 * you commit, or it is answering a question you have already had to decide.
 */
export function stagesFrom(res: ConnectionResponse): Stages {
  if (!res.paired) {
    return { connect: "active", connection: "locked", sites: "locked", trust: "active" };
  }
  const healthy = !res.stale && res.reachable;
  return {
    connect: healthy ? "done" : "needs-attention",
    connection: "active",
    sites: "active",
    trust: "active",
  };
}

/**
 * One line of honest connection state.
 *
 * `stale` is checked BEFORE `reachable` deliberately: a revoked token and a
 * stopped gateway are indistinguishable from the outside, and only one of them
 * has a fix the user can act on. Telling someone to check whether their gateway
 * is running when the real answer is "re-pair" is the silent failure this exists
 * to end.
 */
export function healthLine(res: ConnectionResponse, _nowMs: number): string {
  if (!res.paired) {
    return "Not paired.";
  }
  if (res.stale) {
    // A plain string, not a template literal: there is nothing to interpolate,
    // and Biome's noUnusedTemplateLiteral rejects the backtick form.
    return "Needs re-pairing — Nimbus rejected this browser's token. Run `nimbus clip pair` and pair again.";
  }
  if (!res.reachable) {
    return `Can't reach ${res.origin} — is the gateway running?`;
  }
  const parts = [
    `Connected to ${res.origin} as "${res.label}", since ${formatPairedSince(res.pairedAt)}.`,
  ];
  if (res.lastClipAt !== undefined) {
    parts.push(`Last clip ${formatPairedSince(res.lastClipAt)}.`);
  }
  if (res.queueDepth > 0) {
    parts.push(`${res.queueDepth} waiting to sync.`);
  }
  return parts.join(" ");
}
