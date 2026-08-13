// Injected as dist/<target>/cue.js. Defines globalThis.__nimbusCue(state); the
// SW calls it after injecting this file (two-step, like toast.js and capture.js).
//
// Host trust, same rule as toast-in-page.ts: a hostile page can pre-plant a
// <div id="nimbus-cue-host">, with no shadow root or with its own open one, so we
// only ever reuse a host THIS module created. Anything else found there is
// removed and replaced.
import { sendMessage } from "../browser/runtime.ts";
import type { CueState } from "../shared/types.ts";
import { renderCue } from "./cue-view.ts";

const HOST_ID = "nimbus-cue-host";
/** The panel's own host. If it is mounted, the cue has nothing to add. */
const PANEL_HOST_ID = "nimbus-related-host";
/** How often the mounted cue checks whether the tab moved on. Matches the
 *  panel's NAV_CHECK_MS: SPA navigations fire no load event, and a cue left
 *  naming the page you just left is the defect the panel-page-context slice
 *  (2026-08-11) existed to fix. */
const NAV_CHECK_MS = 500;

const STYLES = `
/* The host sits in the page's flow; only the cue inside it is interactive, so
   the page underneath stays clickable everywhere the cue is not. */
:host { all: initial; pointer-events: none; }
.nimbus-cue {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2147483647;
  pointer-events: auto;
  display: flex;
  align-items: stretch;
  max-width: 320px;
  border-radius: 10px;
  overflow: hidden;
  font-family: system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.3;
  color: #ffffff;
  background: #275fd4;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
}
.nimbus-cue__open,
.nimbus-cue__dismiss {
  appearance: none;
  border: 0;
  margin: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.nimbus-cue__open {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  padding: 9px 12px;
  text-align: left;
  min-width: 0;
}
.nimbus-cue__label { opacity: 0.85; font-size: 12px; }
.nimbus-cue__ref { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
.nimbus-cue__dismiss { padding: 0 12px; opacity: 0.8; }
.nimbus-cue__dismiss:hover { opacity: 1; }
`;

interface CueHost extends HTMLElement {
  __nimbusNavTimer?: ReturnType<typeof setInterval>;
}

// The one host this module created (module scope — unreachable from the page).
let ownHost: CueHost | null = null;

function teardown(): void {
  if (ownHost === null) {
    return;
  }
  if (ownHost.__nimbusNavTimer !== undefined) {
    clearInterval(ownHost.__nimbusNavTimer);
  }
  ownHost.remove();
  ownHost = null;
}

function show(state: CueState): void {
  // The panel is the fuller answer to the same question. If it is already open,
  // a cue pointing at it is noise.
  if (document.getElementById(PANEL_HOST_ID) !== null) {
    return;
  }
  teardown();
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement("div") as CueHost;
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  root.append(style);

  const el = renderCue(document, state);
  el.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const action = target.closest("[data-action]");
    if (!(action instanceof HTMLElement)) {
      return;
    }
    if (action.dataset["action"] === "open") {
      // Fire-and-forget: the worker injects the panel, and a rejection here has
      // nowhere to be reported (noConsole, and this is someone else's page).
      void sendMessage({ kind: "cue-open" }).catch(() => undefined);
    }
    // Both actions retire the cue. Dismissal needs no message: the worker
    // already recorded this item as cued for this tab when it mounted, which is
    // exactly the suppression the design asks for — "quiet for this item, in
    // this tab, until you navigate to a different item".
    teardown();
  });
  root.append(el);

  document.documentElement.append(host);
  ownHost = host;

  const mountedAt = window.location.href;
  host.__nimbusNavTimer = setInterval(() => {
    // Two ways the cue stops being the right thing on screen. The page moved on
    // — a cue naming the page you just left is the 2026-08-11 defect. Or the
    // panel opened without us: the hotkey, the popup button and the context menu
    // all inject it directly, and the mount-time check above cannot see a panel
    // that arrives later. Leaving both up would be two surfaces answering the
    // same question, one of them redundantly.
    if (window.location.href !== mountedAt || document.getElementById(PANEL_HOST_ID) !== null) {
      teardown();
    }
  }, NAV_CHECK_MS);
}

(globalThis as unknown as { __nimbusCue?: (s: CueState) => void }).__nimbusCue = show;
