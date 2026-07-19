import type { ToastState } from "../shared/types.ts";

const ICONS: Record<ToastState["variant"], string> = {
  success: "✓",
  offline: "⏳",
  error: "⚠",
};

/** Build the toast element with textContent only (no innerHTML/anchors). */
export function renderToast(doc: Document, state: ToastState): HTMLElement {
  const el = doc.createElement("div");
  el.className = `nimbus-toast nimbus-toast--${state.variant}`;
  // A polite live region so screen readers announce the result without stealing focus.
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");

  const icon = doc.createElement("span");
  icon.className = "nimbus-toast__icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = ICONS[state.variant];

  const text = doc.createElement("span");
  text.className = "nimbus-toast__text";
  text.textContent = state.text;

  el.append(icon, text);
  return el;
}
