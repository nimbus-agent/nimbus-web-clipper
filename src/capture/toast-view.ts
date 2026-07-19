import type { ToastState } from "../shared/types.ts";

const ICONS: Record<ToastState["variant"], string> = {
  success: "✓",
  offline: "⏳",
  error: "⚠",
};

/**
 * Build the toast SHELL — icon plus an empty text node — with textContent only (no
 * innerHTML/anchors). The message is set afterwards via `setToastText`, once the
 * shell is in the document: screen readers commonly skip a live region that is
 * inserted with its content already present, so the announcement has to come from a
 * mutation inside an already-live region.
 */
export function renderToast(doc: Document, variant: ToastState["variant"]): HTMLElement {
  const el = doc.createElement("div");
  el.className = `nimbus-toast nimbus-toast--${variant}`;
  // A polite live region so screen readers announce the result without stealing focus.
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");

  const icon = doc.createElement("span");
  icon.className = "nimbus-toast__icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = ICONS[variant];

  const text = doc.createElement("span");
  text.className = "nimbus-toast__text";

  el.append(icon, text);
  return el;
}

/** Fill in the toast's message (textContent only). Call AFTER the shell is mounted. */
export function setToastText(el: HTMLElement, text: string): void {
  const target = el.querySelector(".nimbus-toast__text");
  if (target !== null) {
    target.textContent = text;
  }
}
