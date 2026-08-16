// src/shared/panel-host.ts
// The two facts the service worker and the injected panel must agree on to hand
// a selection between them. Shared rather than duplicated because a mismatch
// fails SILENTLY — the worker's hook lookup would simply miss, the panel would
// never hear about the selection, and the menu entry would look inert.

/** The id of the panel's host element in the page. */
export const PANEL_HOST_ID = "nimbus-related-host";

/**
 * What the context menu hands an ALREADY-OPEN panel.
 *
 * The worker cannot deliver this by re-injecting `panel.js`: that entry point is
 * a self-toggle, so re-injecting it while the panel is open would CLOSE the
 * panel the user was trying to use. Delivery is therefore a call onto a hook the
 * mounted panel exposes, with injection as the fallback for when no panel is
 * open — see `deliverSelection` in browser/scripting.ts.
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

/** The hook an open panel exposes on its host element. */
export const PANEL_SELECTION_HOOK = "__nimbusSelection";
