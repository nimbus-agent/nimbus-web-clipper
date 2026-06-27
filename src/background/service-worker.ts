// MV3 background service worker / Firefox event page. Owns the bearer token and all
// gateway I/O; the popup, options page, and injected panel reach it via messages.
import { addCommandListener, addMessageListener } from "../browser/runtime.ts";
import { injectPanel } from "../browser/scripting.ts";
import { activeTab } from "../browser/tabs.ts";
import { isClipRequest, isPairRequest, isRelatedRequest } from "../shared/messages.ts";
import { updateQueue } from "./clip-queue-store.ts";
import { getConnection, setConnection } from "./connection-store.ts";
import { confirmPair, postClip, postRelated } from "./gateway-client.ts";
import { handleClip, handlePair, handleRelated } from "./handlers.ts";

addMessageListener((message, respond) => {
  if (isPairRequest(message)) {
    handlePair({ confirmPair, setConnection, nowMs: () => Date.now() }, message)
      .then(respond)
      .catch(() => {
        respond({ kind: "pair", ok: false, reason: "server_error" });
      });
    return true;
  }
  if (isClipRequest(message)) {
    handleClip({ getConnection, postClip, updateQueue, nowMs: () => Date.now() }, message)
      .then(respond)
      .catch(() => {
        respond({ kind: "clip", ok: false, reason: "server_error" });
      });
    return true;
  }
  if (isRelatedRequest(message)) {
    handleRelated({ getConnection, postRelated }, message)
      .then(respond)
      .catch(() => {
        respond({ kind: "related", ok: false, reason: "server_error" });
      });
    return true;
  }
  return false;
});

// The hotkey injects the panel into the active tab. activeTab is granted on the
// command gesture. A restricted page (chrome://, store) rejects injection — there
// is no page surface to report on, so fail closed silently.
addCommandListener((command) => {
  if (command === "show_related") {
    activeTab()
      .then((tab) => injectPanel(tab.id))
      .catch(() => undefined);
  }
});
