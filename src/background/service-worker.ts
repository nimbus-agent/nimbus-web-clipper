// MV3 background service worker / Firefox event page. Owns the bearer token and all
// gateway I/O; the popup and options page reach it only via runtime messages.
import { addMessageListener } from "../browser/runtime.ts";
import { isClipRequest, isPairRequest } from "../shared/messages.ts";
import { getConnection, setConnection } from "./connection-store.ts";
import { confirmPair, postClip } from "./gateway-client.ts";
import { handleClip, handlePair } from "./handlers.ts";

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
    handleClip({ getConnection, postClip, nowMs: () => Date.now() }, message)
      .then(respond)
      .catch(() => {
        respond({ kind: "clip", ok: false, reason: "server_error" });
      });
    return true;
  }
  return false;
});
