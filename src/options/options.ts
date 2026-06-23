// Options page entry. Backbone stub: the pairing form (enter the 6-digit code,
// POST it to /v1/clips/pair/confirm, store the returned bearer token) and the
// paired-device list are added during feature work (see docs/ spec + plan).

import { DEFAULT_GATEWAY_ORIGIN } from "../shared/gateway.ts";

function render(statusEl: HTMLElement): void {
  statusEl.textContent = `Gateway: ${DEFAULT_GATEWAY_ORIGIN} (pairing UI coming soon).`;
}

document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("pairing-status");
  if (statusEl !== null) {
    render(statusEl);
  }
});
