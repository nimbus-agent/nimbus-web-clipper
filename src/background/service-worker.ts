// MV3 background service worker (Chrome) / event page (Firefox).
//
// Backbone stub: it answers a liveness ping so the popup can confirm the worker
// is alive, and nothing else yet. The clip-ingest, pairing, and related-items
// flows are added during feature work (see docs/ spec + plan). The token store,
// fetch calls to the gateway, and message routing will live here — this file is
// the single place that holds the bearer token and talks to the gateway.

import { isPingMessage, type PingResponse } from "../shared/messages.ts";

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: PingResponse) => void): boolean => {
    if (isPingMessage(message)) {
      sendResponse({ ok: true });
      return true; // keep the message channel open for the (synchronous) response
    }
    return false;
  },
);
