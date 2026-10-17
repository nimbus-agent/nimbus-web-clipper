// src/shared/panel-host.ts
// The facts the service worker, the injected panel and (later) the palette must
// agree on to hand an intent between them. Shared rather than duplicated because
// a mismatch fails SILENTLY — the worker's hook lookup would simply miss, the
// panel would never hear about the intent, and the menu entry would look inert.

import type { AgentLane } from "./types.ts";

/** The id of the panel's host element in the page. */
export const PANEL_HOST_ID = "nimbus-related-host";

/**
 * What a context-menu selection hands the panel — the `selection` arm of
 * `PanelIntent`.
 *
 * The worker cannot deliver this by re-injecting `panel.js`: that entry point is
 * a self-toggle, so re-injecting it while the panel is open would CLOSE the
 * panel the user was trying to use. Delivery is therefore a call onto a hook the
 * mounted panel exposes, with injection as the fallback for when no panel is
 * open — see `deliverIntent` in browser/scripting.ts.
 */
export interface PanelSelection {
  /** The raw selection, exactly as `info.selectionText` gave it. Normalising is
   *  the panel's job (shared/term.ts), so the refusal copy renders where the
   *  user is. */
  readonly text: string;
  /**
   * Which menu entry sent it, and therefore what the panel should DO:
   *
   * - `define` — expand the glossary lane and run it now. The user asked a
   *   question; answering it is the whole gesture.
   * - `related` — re-run the related lane against this selection. The glossary
   *   lane still appears, collapsed and unrun: the term is now visible to the
   *   panel, but nobody asked for a definition, and spending an agent run on an
   *   unasked question is how ambient UI earns its reputation for noise.
   */
  readonly intent: "define" | "related";
}

/**
 * Something the panel should DO, handed to it through `PANEL_INTENT_HOOK`.
 *
 * - `selection` — the context menu's two entries, and the palette's glossary
 *   row (which sends `define` with the text it saved at mount).
 * - `lane` — expand a PAGE lane and ask it. Never a term lane: the guard
 *   (`isPanelIntent`, shared/messages.ts) refuses one, because a term lane's
 *   question is the selection, and that arrives as a `selection` intent.
 * - `deploy` — scroll to the deploy-readiness section.
 * - `related` — bring the panel up with Related focused.
 * - `candidates` — open at the ambiguous-resolve picker.
 */
export type PanelIntent =
  | {
      readonly kind: "selection";
      readonly text: PanelSelection["text"];
      readonly intent: PanelSelection["intent"];
    }
  | { readonly kind: "lane"; readonly lane: AgentLane }
  | { readonly kind: "deploy" }
  | { readonly kind: "related" }
  | { readonly kind: "candidates" };

/**
 * What a mounted panel reports about itself through `PANEL_STATE_HOOK`.
 *
 * Not `PanelState`: panel-view.ts already exports one (the shell's render state).
 */
export interface PanelHostState {
  /** The URL the panel's header was resolved for. */
  readonly pinnedUrl: string;
  /** The candidate the user picked out of an ambiguous resolve, if any. */
  readonly chosenId: string | null;
}

/** The hook an open panel exposes on its host element to apply an intent. */
export const PANEL_INTENT_HOOK = "__nimbusIntent";

/** The hook an open panel exposes on its host element to report its state. */
export const PANEL_STATE_HOOK = "__nimbusPanelState";

/**
 * Do two URLs name the same page, for deciding whether a panel's pin is stale?
 *
 * The fragment is ignored on both sides: `#heading`, GitHub's `#diff-…` and
 * `#issuecomment-…` move within a page, and treating them as a navigation would
 * re-read the panel, collapsing its lanes and dropping a candidate pick and
 * the term. One rule for the panel (`applyIntent`) and the palette's read of
 * an open panel. An unparseable URL falls back to plain string equality.
 */
export function samePage(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = "";
    right.hash = "";
    return left.href === right.href;
  } catch {
    return a === b;
  }
}
