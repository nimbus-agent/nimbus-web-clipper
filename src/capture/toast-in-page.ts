// Injected as dist/<target>/toast.js. Defines globalThis.__nimbusToast(state); the
// SW calls it after injecting this file (two-step, like capture.js). A single
// shadow-DOM host lives at HOST_ID: a repeat call replaces its content and resets
// the auto-dismiss timer. Re-injecting this file just re-assigns __nimbusToast — no
// duplicate hosts or listeners.
//
// Host trust: a hostile page can pre-plant <div id="nimbus-toast-host">, with no
// shadow root (so `host.shadowRoot` is null) or with its OWN open one (so it could
// hide, restyle, or read the clip outcome). We therefore only ever reuse a host this
// module created itself; anything else found at HOST_ID is removed and replaced.
import type { ToastState } from "../shared/types.ts";
import { renderToast, setToastText } from "./toast-view.ts";

const HOST_ID = "nimbus-toast-host";
const DISMISS_MS = 2500;

const STYLES = `
:host { all: initial; }
.nimbus-toast {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2147483647;
  /* Purely informational: never swallow clicks on the page underneath it. */
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 320px;
  padding: 10px 14px;
  border-radius: 10px;
  font-family: system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.3;
  color: #ffffff;
  background: #275fd4;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
}
.nimbus-toast--offline { background: #6b5b16; }
.nimbus-toast--error { background: #a03434; }
.nimbus-toast__icon { font-size: 15px; }
.nimbus-toast__text { overflow: hidden; text-overflow: ellipsis; }
`;

interface ToastHost extends HTMLElement {
  __nimbusTimer?: ReturnType<typeof setTimeout>;
}

// The one host this module created (module scope — unreachable from the page).
// Identity, not the DOM, is what makes a host reusable.
let ownHost: ToastHost | null = null;

function show(state: ToastState): void {
  const found = document.getElementById(HOST_ID) as ToastHost | null;
  let host: ToastHost;
  let root: ShadowRoot;
  const ourRoot = found !== null && found === ownHost ? found.shadowRoot : null;
  if (found !== null && ourRoot !== null) {
    host = found;
    root = ourRoot;
    root.querySelector(".nimbus-toast")?.remove();
    if (host.__nimbusTimer !== undefined) {
      clearTimeout(host.__nimbusTimer);
    }
  } else {
    // Not ours (or ours but shadow-less): drop it rather than write into a root the
    // page may control, then mount a fresh host.
    found?.remove();
    host = document.createElement("div") as ToastHost;
    host.id = HOST_ID;
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    root.append(style);
    document.documentElement.append(host);
    ownHost = host;
  }
  // Mount the (empty) live region first, then set the text — see toast-view.ts.
  const el = renderToast(document, state.variant);
  root.append(el);
  setToastText(el, state.text);
  const current = host;
  current.__nimbusTimer = setTimeout(() => current.remove(), DISMISS_MS);
}

(globalThis as unknown as { __nimbusToast?: (s: ToastState) => void }).__nimbusToast = show;
