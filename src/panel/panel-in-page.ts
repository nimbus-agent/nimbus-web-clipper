// src/panel/panel-in-page.ts
// Injected as dist/<target>/panel.js. Self-toggling: re-injection closes an open
// panel. Mounts a Shadow-DOM overlay (inlined styles — no web_accessible_resources),
// reads the page context, asks the SW for related items, and renders them.
import { sendMessage } from "../browser/runtime.ts";
import { isRelatedResponse } from "../shared/messages.ts";
import { renderError, renderHits } from "./panel-view.ts";

const HOST_ID = "nimbus-related-host";

const RELATED_MESSAGES: Record<string, string> = {
  not_paired: "Pair a browser first (Options).",
  unauthorized: "Pairing expired — re-pair in Options.",
  unreachable: "Can't reach Nimbus — is the gateway running?",
  server_error: "Nimbus had an error fetching related items.",
};

// Inlined so the panel is fully self-contained. `:host { all: initial }` drops
// inherited page styles; only our own --nimbus-* tokens are referenced, with a
// dark set behind prefers-color-scheme (custom props survive `all: initial`).
const STYLES = `
:host {
  all: initial;
  --nimbus-bg: #ffffff;
  --nimbus-fg: #1a1a1a;
  --nimbus-muted: #666666;
  --nimbus-border: rgba(0, 0, 0, 0.12);
  --nimbus-accent: #2d6cdf;
}
@media (prefers-color-scheme: dark) {
  :host {
    --nimbus-bg: #1e1e1e;
    --nimbus-fg: #eaeaea;
    --nimbus-muted: #a0a0a0;
    --nimbus-border: rgba(255, 255, 255, 0.16);
    --nimbus-accent: #6ea8ff;
  }
}
.nimbus-related {
  position: fixed;
  top: 0;
  right: 0;
  width: 340px;
  height: 100vh;
  box-sizing: border-box;
  background: var(--nimbus-bg);
  color: var(--nimbus-fg);
  font-family: system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.4;
  border-left: 1px solid var(--nimbus-border);
  box-shadow: -2px 0 12px rgba(0, 0, 0, 0.18);
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
}
.nimbus-related__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--nimbus-border);
}
.nimbus-related__heading { margin: 0; font-size: 14px; font-weight: 600; }
.nimbus-related__close {
  all: unset;
  cursor: pointer;
  padding: 2px 8px;
  font-size: 16px;
  color: var(--nimbus-muted);
}
.nimbus-related__body { overflow-y: auto; padding: 8px 0; }
.nimbus-related__list { list-style: none; margin: 0; padding: 0; }
.nimbus-related__item { padding: 10px 16px; border-bottom: 1px solid var(--nimbus-border); }
.nimbus-related__title { display: block; font-weight: 600; color: var(--nimbus-accent); text-decoration: none; }
.nimbus-related__badge {
  display: inline-block;
  margin: 4px 0;
  padding: 1px 6px;
  font-size: 11px;
  border-radius: 4px;
  background: var(--nimbus-border);
  color: var(--nimbus-muted);
}
.nimbus-related__snippet { margin: 4px 0 0; color: var(--nimbus-muted); }
.nimbus-related__status { padding: 16px; color: var(--nimbus-muted); }
`;

interface NimbusHost extends HTMLElement {
  __nimbusClose?: () => void;
}

function readContext(): { title: string; canonicalUrl?: string; selection: string } {
  const canonical =
    document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? undefined;
  const selection = window.getSelection()?.toString() ?? "";
  return {
    title: document.title,
    ...(canonical !== undefined && canonical !== "" ? { canonicalUrl: canonical } : {}),
    selection,
  };
}

async function query(body: HTMLElement): Promise<void> {
  let res: unknown;
  try {
    res = await sendMessage({ kind: "related", ...readContext() });
  } catch {
    body.replaceChildren();
    body.append(renderError(document, "Couldn't connect to Nimbus."));
    return;
  }
  body.replaceChildren();
  if (!isRelatedResponse(res)) {
    body.append(renderError(document, "Unexpected response."));
    return;
  }
  if (res.ok) {
    body.append(renderHits(document, res.items));
  } else {
    body.append(
      renderError(document, RELATED_MESSAGES[res.reason] ?? "Couldn't fetch related items."),
    );
  }
}

function mount(): void {
  const host = document.createElement("div") as NimbusHost;
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;

  const panel = document.createElement("section");
  panel.className = "nimbus-related";
  // A non-modal landmark, NOT role="dialog": the user reads the page alongside the
  // panel, so focus is intentionally not trapped (a trap would fight that).
  panel.setAttribute("role", "complementary");
  panel.setAttribute("aria-label", "Related items in Nimbus");

  const header = document.createElement("header");
  header.className = "nimbus-related__header";
  const heading = document.createElement("h1");
  heading.className = "nimbus-related__heading";
  heading.textContent = "Related in Nimbus";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "nimbus-related__close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Close");
  header.append(heading, close);

  const body = document.createElement("div");
  body.className = "nimbus-related__body";
  body.append(renderError(document, "Loading…"));

  panel.append(header, body);
  root.append(style, panel);
  document.documentElement.append(host);

  // One AbortController detaches every listener on teardown — no orphans on toggle.
  const controller = new AbortController();
  const { signal } = controller;
  const teardown = (): void => {
    controller.abort();
    host.remove();
  };
  host.__nimbusClose = teardown;
  close.addEventListener("click", teardown, { signal });
  // Capture phase + stopPropagation so host apps (Docs/Jira/GitHub) don't also act on Esc.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        teardown();
      }
    },
    { signal, capture: true },
  );

  // Land keyboard/screen-reader users inside the panel (focus only — no trap).
  close.focus();
  void query(body);
}

// Self-toggle entry: an existing panel closes via its own teardown (aborting its
// listeners); otherwise mount a fresh one.
const existing = document.getElementById(HOST_ID) as NimbusHost | null;
if (existing !== null) {
  if (existing.__nimbusClose !== undefined) {
    existing.__nimbusClose();
  } else {
    existing.remove();
  }
} else {
  mount();
}
