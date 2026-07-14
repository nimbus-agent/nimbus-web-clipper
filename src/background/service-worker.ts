// MV3 background service worker / Firefox event page. Owns the bearer token and all
// gateway I/O; the popup, options page, and injected panel reach it via messages. It
// also owns the offline retry queue: it drains on a chrome.alarms tick (the alarm is
// live only while the queue is non-empty), on startup, and on popup retries, and it
// keeps the toolbar badge in sync with the pending count.
import { setBadgeBackground, setBadgeCount } from "../browser/action.ts";
import { addAlarmListener, clearAlarm, ensureAlarm } from "../browser/alarms.ts";
import { addCommandListener, addMessageListener } from "../browser/runtime.ts";
import { injectPanel } from "../browser/scripting.ts";
import { activeTab } from "../browser/tabs.ts";
import {
  isClipRequest,
  isPairRequest,
  isQueueListRequest,
  isQueueRemoveRequest,
  isQueueRetryRequest,
  isRelatedRequest,
} from "../shared/messages.ts";
import { getQueue, updateQueue } from "./clip-queue-store.ts";
import { getConnection, setConnection } from "./connection-store.ts";
import { confirmPair, postClip, postRelated } from "./gateway-client.ts";
import {
  handleClip,
  handlePair,
  handleQueueList,
  handleQueueRemove,
  handleQueueRetry,
  handleRelated,
} from "./handlers.ts";
import { flushQueue } from "./queue-flush.ts";
import { singleFlight } from "./single-flight.ts";

const FLUSH_ALARM = "flush-clip-queue";
const flushDeps = { getConnection, getQueue, updateQueue, postClip };

// Background drains (the periodic alarm and the cold-start drain) can fire together on
// a fresh wake; coalescing them through one in-flight guard stops the same clips being
// POSTed twice. The popup retry path stays direct — it is user-initiated and may carry
// a specific url / manual flag, and its writes are already serialized by updateQueue.
const backgroundFlush = singleFlight(() => flushQueue(flushDeps).then(syncQueueState));

// Reconcile the toolbar badge and the flush alarm with the current queue length:
// the alarm exists only while there is work to do (no idle wakeups).
async function syncQueueState(): Promise<void> {
  const n = (await getQueue()).length;
  await setBadgeCount(n);
  if (n > 0) {
    ensureAlarm(FLUSH_ALARM, 1);
  } else {
    await clearAlarm(FLUSH_ALARM);
  }
}

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
      .then(async (res) => {
        await syncQueueState();
        respond(res);
      })
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
  if (isQueueListRequest(message)) {
    handleQueueList({ getQueue })
      .then(respond)
      .catch(() => {
        respond({ kind: "queue", items: [] });
      });
    return true;
  }
  if (isQueueRetryRequest(message)) {
    handleQueueRetry(
      { flush: (opts) => flushQueue(flushDeps, opts).then(() => undefined), getQueue },
      message,
    )
      .then(async (res) => {
        await syncQueueState();
        respond(res);
      })
      .catch(() => {
        respond({ kind: "queue", items: [] });
      });
    return true;
  }
  if (isQueueRemoveRequest(message)) {
    handleQueueRemove({ updateQueue }, message)
      .then(async (res) => {
        await syncQueueState();
        respond(res);
      })
      .catch(() => {
        respond({ kind: "queue", items: [] });
      });
    return true;
  }
  return false;
});

// The hotkey injects the related panel into the active tab. activeTab is granted on
// the command gesture; a restricted page rejects injection — fail closed silently.
addCommandListener((command) => {
  if (command === "show_related") {
    activeTab()
      .then((tab) => injectPanel(tab.id))
      .catch(() => undefined);
  }
});

// The periodic alarm drains the queue, then reconciles the badge + alarm lifecycle.
addAlarmListener((name) => {
  if (name === FLUSH_ALARM) {
    backgroundFlush().catch(() => undefined);
  }
});

// On startup, run the sequence deterministically (awaited, not three concurrent
// top-level promises): set the badge color, paint the persisted backlog immediately,
// then attempt a drain and reconcile once more. Sequencing avoids a race where the
// initial badge paint could resolve after the post-drain one and show a stale count.
void (async () => {
  await setBadgeBackground("#5b6470").catch(() => undefined);
  await syncQueueState().catch(() => undefined);
  await backgroundFlush().catch(() => undefined);
})();
