// Injected as dist/<target>/toast.js. Defines globalThis.__nimbusToast(state); the
// SW calls it after injecting this file (two-step, like capture.js). A single
// shadow-DOM host lives at HOST_ID: a repeat call replaces its content and resets
// the auto-dismiss timer. Re-injecting this file just re-assigns __nimbusToast — no
// duplicate hosts or listeners.
import type { ToastState } from "../shared/types.ts";
import { renderToast } from "./toast-view.ts";

const HOST_ID = "nimbus-toast-host";
const DISMISS_MS = 2500;

const STYLES = `
:host { all: initial; }
.nimbus-toast {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2147483647;
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
.nimbus-toast__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

interface ToastHost extends HTMLElement {
  __nimbusTimer?: ReturnType<typeof setTimeout>;
}

function show(state: ToastState): void {
  let host = document.getElementById(HOST_ID) as ToastHost | null;
  let root: ShadowRoot;
  if (host === null) {
    host = document.createElement("div") as ToastHost;
    host.id = HOST_ID;
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    root.append(style);
    document.documentElement.append(host);
  } else {
    root = host.shadowRoot as ShadowRoot;
    root.querySelector(".nimbus-toast")?.remove();
    if (host.__nimbusTimer !== undefined) {
      clearTimeout(host.__nimbusTimer);
    }
  }
  root.append(renderToast(document, state));
  const current = host;
  current.__nimbusTimer = setTimeout(() => current.remove(), DISMISS_MS);
}

(globalThis as unknown as { __nimbusToast?: (s: ToastState) => void }).__nimbusToast = show;
