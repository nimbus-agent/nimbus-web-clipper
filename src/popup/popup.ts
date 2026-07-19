import { sendMessage } from "../browser/runtime.ts";
import { injectPanel, runCapture } from "../browser/scripting.ts";
import { activeTab } from "../browser/tabs.ts";
import { parseTags } from "../shared/clip.ts";
import { type ClipResponse, isQueueResponse } from "../shared/messages.ts";
import { renderQueueList } from "./queue-view.ts";

const RATE_LIMITED_MESSAGE = "Nimbus is busy — queued, will retry shortly.";

const CLIP_MESSAGES: Record<string, string> = {
  not_paired: "Pair a browser first (Options).",
  unauthorized: "Pairing expired — re-pair in Options.",
  invalid_request: "Couldn't save this page.",
  payload_too_large: "Too large for Nimbus to save.",
  rate_limited: RATE_LIMITED_MESSAGE,
  unreachable: "Can't reach Nimbus — is the gateway running?",
  server_error: "Nimbus had an error saving this.",
};

function isClipResponse(v: unknown): v is ClipResponse {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "clip";
}

function setStatus(text: string): void {
  const el = document.getElementById("status");
  if (el !== null) {
    el.textContent = text;
  }
}

async function clip(mode: "article" | "selection"): Promise<void> {
  setStatus("Clipping…");
  const tagsInput = document.getElementById("tags");
  const tags = tagsInput instanceof HTMLInputElement ? parseTags(tagsInput.value) : [];
  let capture: Awaited<ReturnType<typeof runCapture>>;
  try {
    const tab = await activeTab();
    capture = await runCapture(tab.id, mode);
  } catch {
    setStatus("Nimbus can't clip browser system or store pages.");
    return;
  }
  if (mode === "selection" && capture.body === "") {
    setStatus("Select some text first.");
    return;
  }
  const res = await sendMessage({ kind: "clip", capture, tags });
  if (!isClipResponse(res)) {
    setStatus("Unexpected response.");
    return;
  }
  if (res.ok) {
    let savedMessage: string;
    if (res.bookmarked) {
      savedMessage = "Saved as a bookmark.";
    } else if (res.status === "updated") {
      savedMessage = "Updated in Nimbus.";
    } else {
      savedMessage = "Saved to Nimbus.";
    }
    setStatus(savedMessage);
  } else {
    // rate_limited is queued too, but it must not read as "Nimbus is down" — so it
    // is checked BEFORE the generic queued wording.
    let message: string;
    if (res.reason === "rate_limited") {
      message = RATE_LIMITED_MESSAGE;
    } else if (res.queued === true) {
      message = "Saved offline — will sync when Nimbus is back.";
    } else {
      message = CLIP_MESSAGES[res.reason] ?? "Couldn't save this page.";
    }
    setStatus(message);
    await refreshQueue();
  }
}

async function showRelated(): Promise<void> {
  try {
    const tab = await activeTab();
    await injectPanel(tab.id);
    window.close();
  } catch {
    setStatus("Nimbus can't show related on browser system pages.");
  }
}

function renderQueue(res: unknown): void {
  const section = document.getElementById("queue");
  const list = document.getElementById("queue-list");
  const count = document.getElementById("queue-count");
  if (!(section instanceof HTMLElement) || list === null || count === null) {
    return;
  }
  if (!isQueueResponse(res) || res.items.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  count.textContent = String(res.items.length);
  list.replaceChildren(renderQueueList(document, res.items, Date.now()));
}

async function refreshQueue(): Promise<void> {
  renderQueue(await sendMessage({ kind: "queue-list" }));
}

async function onQueueClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const url = target.dataset["url"];
  if (url === undefined) {
    return;
  }
  if (target.classList.contains("queue__retry")) {
    renderQueue(await sendMessage({ kind: "queue-retry", url }));
  } else if (target.classList.contains("queue__remove")) {
    renderQueue(await sendMessage({ kind: "queue-remove", url }));
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("clip-page")?.addEventListener("click", () => void clip("article"));
  document
    .getElementById("clip-selection")
    ?.addEventListener("click", () => void clip("selection"));
  document.getElementById("show-related")?.addEventListener("click", () => void showRelated());
  document.getElementById("queue-list")?.addEventListener("click", (event) => {
    if (event instanceof MouseEvent) {
      void onQueueClick(event);
    }
  });
  document.getElementById("queue-retry-all")?.addEventListener("click", () => {
    void (async () => renderQueue(await sendMessage({ kind: "queue-retry" })))();
  });
  void refreshQueue();
});
