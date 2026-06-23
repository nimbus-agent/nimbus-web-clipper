// Popup entry. Backbone stub: probe the service worker and report liveness.
// The Clip / Clip selection buttons and the related-items panel are added during
// feature work (see docs/ spec + plan).

import type { PingResponse } from "../shared/messages.ts";

function isPingResponse(value: unknown): value is PingResponse {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true;
}

async function probeWorker(): Promise<boolean> {
  const response: unknown = await chrome.runtime.sendMessage({ kind: "ping" });
  return isPingResponse(response);
}

function render(statusEl: HTMLElement, alive: boolean): void {
  statusEl.textContent = alive
    ? "Ready. Pair a device in Options to start clipping."
    : "Service worker unreachable — try reopening the popup.";
}

document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");
  if (statusEl === null) {
    return;
  }
  probeWorker()
    .then((alive) => render(statusEl, alive))
    .catch(() => render(statusEl, false));
});
