// MV3 background service worker / Firefox event page. Owns the bearer token and all
// gateway I/O; the popup, options page, and injected panel reach it via messages. It
// also owns the offline retry queue: it drains on a chrome.alarms tick (the alarm is
// live only while the queue is non-empty), on startup, and on popup retries, and it
// keeps the toolbar badge in sync with the pending count.
import { setBadgeBackground, setBadgeCount, setBadgeText } from "../browser/action.ts";
import { addAlarmListener, clearAlarm, ensureAlarm, rearmAlarm } from "../browser/alarms.ts";
import { addMenuClickListener, createMenu, removeAllMenus } from "../browser/context-menus.ts";
import {
  addCommandListener,
  addInstalledListener,
  addMessageListener,
} from "../browser/runtime.ts";
import { injectPanel, runCapture, showToast } from "../browser/scripting.ts";
import { activeTab } from "../browser/tabs.ts";
import {
  isClipRequest,
  isConnectionStatusRequest,
  isPairRequest,
  isQueueListRequest,
  isQueueRemoveRequest,
  isQueueRetryRequest,
  isRelatedRequest,
  isUnpairRequest,
} from "../shared/messages.ts";
import { getQueue, updateQueue } from "./clip-queue-store.ts";
import { clearConnection, getConnection, setConnection } from "./connection-store.ts";
import { showFeedback } from "./feedback.ts";
import { confirmPair, postClip, postRelated } from "./gateway-client.ts";
import {
  handleClip,
  handleConnectionStatus,
  handlePair,
  handleQueueList,
  handleQueueRemove,
  handleQueueRetry,
  handleRelated,
  handleUnpair,
} from "./handlers.ts";
import { type FlushDeps, flushQueue } from "./queue-flush.ts";
import { type QuickClipDeps, quickClip } from "./quick-clip.ts";
import { clearPause, getPauseUntil, setPauseUntil } from "./rate-limit-pause.ts";
import { singleFlight } from "./single-flight.ts";

const FLUSH_ALARM = "flush-clip-queue";

// The one place the rate-limit pause is written. Wrapping the seam — rather than
// threading a dependency through handleClip and flushQueue — keeps both of those
// pure and means a 429 from EITHER path (interactive clip or queue drain) paces the
// next drain. A storage failure here must never fail the clip itself.
const postClipPaced: FlushDeps["postClip"] = async (origin, token, payload) => {
  const r = await postClip(origin, token, payload);
  if (r.ok) {
    await endPause().catch(() => undefined);
  } else if (r.reason === "rate_limited") {
    await setPauseUntil(Date.now() + (r.retryAfterMs ?? 60_000)).catch(() => undefined);
  }
  return r;
};

// Clearing the stored pause is not enough on its own: the flush alarm is still on
// the delayed schedule armed for that pause, and ensureAlarm deliberately won't
// touch an alarm that already exists. Drop it on the transition so the next
// syncQueueState re-creates the plain periodic one.
async function endPause(): Promise<void> {
  if (await clearPause()) {
    await clearAlarm(FLUSH_ALARM);
  }
}

const flushDeps = {
  getConnection,
  getQueue,
  updateQueue,
  postClip: postClipPaced,
  pausedUntilMs: getPauseUntil,
  nowMs: () => Date.now(),
};

// Background drains (the periodic alarm and the cold-start drain) can fire together on
// a fresh wake; coalescing them through one in-flight guard stops the same clips being
// POSTed twice. The popup retry path stays direct — it is user-initiated and may carry
// a specific url / manual flag, and its writes are already serialized by updateQueue.
const backgroundFlush = singleFlight(() => flushQueue(flushDeps).then(syncQueueState));

// Reconcile the toolbar badge and the flush alarm with the current queue length:
// the alarm exists only while there is work to do (no idle wakeups). While a
// rate-limit pause is active the alarm is re-armed to fire at the gateway's own
// reset time instead of an arbitrary point in the fixed one-minute cadence.
//
// Invariant: the pause gate in flushQueue is the AUTHORITY; this alarm is only a
// wakeup hint. Concurrent callers can therefore race here harmlessly — an alarm
// armed from slightly stale state at worst fires early, and the gate no-ops it.
// (While paused, the re-armed delay also shrinks monotonically, so repeated calls
// cannot push the alarm out indefinitely.)
async function syncQueueState(): Promise<void> {
  const n = (await getQueue()).length;
  await setBadgeCount(n);
  if (n === 0) {
    await clearAlarm(FLUSH_ALARM);
    return;
  }
  const remainingMs = (await getPauseUntil()) - Date.now();
  if (remainingMs > 0) {
    // Chrome honours a 30s floor (values under 0.5 are ignored and warn), so a
    // shorter Retry-After rounds up. An early or late tick is harmless — the pause
    // gate in flushQueue no-ops it.
    rearmAlarm(FLUSH_ALARM, Math.max(0.5, remainingMs / 60_000), 1);
    return;
  }
  await ensureAlarm(FLUSH_ALARM, 1);
}

// One clip pipeline for both entry points: the popup's `clip` message and the
// quick-clip (context menu / hotkey) route go through the same handler deps.
const clipDeps = { getConnection, postClip: postClipPaced, updateQueue, nowMs: () => Date.now() };

const quickClipDeps: QuickClipDeps = {
  activeTab,
  runCapture,
  // The badge sync runs AFTER the response is settled, never gating it: the clip may
  // have enqueued (keep the count fresh), but a storage failure while syncing must
  // not turn a successful clip into a silent no-toast. It is still awaited (a
  // returned thenable settles `finally`) so the queue count repaints BEFORE any
  // badge flash — otherwise a late sync would erase the flash.
  clip: (req) =>
    handleClip(clipDeps, req).finally(async () => {
      await syncQueueState().catch(() => undefined);
    }),
  showFeedback: (tabId, state, restricted) =>
    showFeedback(
      { showToast, setBadgeText, restoreBadge: syncQueueState },
      tabId,
      state,
      restricted,
    ),
};

// Menus are re-registered from scratch (removeAll first) so a reload/upgrade can't
// leave a duplicate id behind — chrome.contextMenus.create throws on a duplicate.
// Single-flighted because on a fresh install the startup sequence and onInstalled
// both register: interleaved removeAll/create pairs could otherwise hit a duplicate
// id and surface an unchecked runtime.lastError.
const registerContextMenus = singleFlight(async (): Promise<void> => {
  await removeAllMenus();
  createMenu({ id: "clip-page", title: "Clip page to Nimbus", contexts: ["page"] });
  createMenu({ id: "clip-selection", title: "Clip selection to Nimbus", contexts: ["selection"] });
});

// Both quick-clip routes fail closed like every other listener: the user-visible
// result is the toast/badge, and a rejection here has nowhere to be reported.
addInstalledListener(() => {
  registerContextMenus().catch(() => undefined);
});

addMenuClickListener((menuItemId, tabId) => {
  // Clip the tab that was RIGHT-CLICKED (it may not be the active tab of the focused
  // window, and the activeTab grant belongs to it).
  quickClip(quickClipDeps, menuItemId === "clip-selection" ? "selection" : "article", tabId).catch(
    () => undefined,
  );
});

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
    handleClip(clipDeps, message)
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
  if (isConnectionStatusRequest(message)) {
    handleConnectionStatus({ getConnection })
      .then(respond)
      .catch(() => {
        respond({ kind: "connection", paired: false });
      });
    return true;
  }
  if (isUnpairRequest(message)) {
    handleUnpair({ clearConnection })
      .then(respond)
      .catch(() => {
        respond({ kind: "connection", paired: false });
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
    return;
  }
  if (command === "clip-page") {
    quickClip(quickClipDeps, "article").catch(() => undefined);
    return;
  }
  if (command === "clip-selection") {
    quickClip(quickClipDeps, "selection").catch(() => undefined);
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
async function runStartupSequence(): Promise<void> {
  await setBadgeBackground("#5b6470").catch(() => undefined);
  await registerContextMenus().catch(() => undefined);
  await syncQueueState().catch(() => undefined);
  await backgroundFlush().catch(() => undefined);
}

void runStartupSequence();
