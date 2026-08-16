// Pure DOM builder for the ambient cue. No chrome.*, no listeners, no innerHTML —
// panel-in-page.ts's sibling for a much smaller surface, and the same rule as
// capture/toast-view.ts: build the shell here, attach behaviour at the caller.
import type { CueState } from "../shared/types.ts";

export function renderCue(doc: Document, state: CueState): HTMLElement {
  const el = doc.createElement("div");
  el.className = "nimbus-cue";
  // Polite, so a screen reader mentions it at the next opportunity rather than
  // interrupting — an ambient cue that grabs the announcement queue is no longer
  // ambient.
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");

  const open = doc.createElement("button");
  open.type = "button";
  open.className = "nimbus-cue__open";
  open.dataset["action"] = "open";
  open.setAttribute("aria-label", `Open Nimbus for ${state.label} ${state.ref}`);

  const label = doc.createElement("span");
  label.className = "nimbus-cue__label";
  label.textContent = state.label;

  const ref = doc.createElement("span");
  ref.className = "nimbus-cue__ref";
  ref.textContent = state.ref;

  open.append(label, ref);

  const dismiss = doc.createElement("button");
  dismiss.type = "button";
  dismiss.className = "nimbus-cue__dismiss";
  dismiss.dataset["action"] = "dismiss";
  dismiss.textContent = "✕";
  dismiss.setAttribute("aria-label", "Dismiss");

  el.append(open, dismiss);
  return el;
}
