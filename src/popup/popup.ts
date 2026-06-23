import { sendMessage } from "../browser/runtime.ts";
import { injectPanel, runCapture } from "../browser/scripting.ts";
import { activeTab } from "../browser/tabs.ts";
import { parseTags } from "../shared/clip.ts";
import type { ClipResponse } from "../shared/messages.ts";

const CLIP_MESSAGES: Record<string, string> = {
  not_paired: "Pair a browser first (Options).",
  unauthorized: "Pairing expired — re-pair in Options.",
  invalid_request: "Couldn't save this page.",
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
    setStatus(
      res.bookmarked
        ? "Saved as a bookmark."
        : res.status === "updated"
          ? "Updated in Nimbus."
          : "Saved to Nimbus.",
    );
  } else {
    setStatus(CLIP_MESSAGES[res.reason] ?? "Couldn't save this page.");
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

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("clip-page")?.addEventListener("click", () => void clip("article"));
  document
    .getElementById("clip-selection")
    ?.addEventListener("click", () => void clip("selection"));
  document.getElementById("show-related")?.addEventListener("click", () => void showRelated());
});
