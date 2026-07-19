import type { ClipRequest, ClipResponse } from "../shared/messages.ts";
import type { CaptureResult, ToastState } from "../shared/types.ts";

const RESTRICTED_SCHEMES = new Set([
  "chrome:",
  "chrome-extension:",
  "moz-extension:",
  "about:",
  "edge:",
  "view-source:",
]);

/** True for pages a content script can't be injected into (also un-capturable). */
export function isRestrictedUrl(url: string): boolean {
  try {
    return RESTRICTED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return true;
  }
}

// Deliberately the popup's vocabulary (src/popup/popup.ts CLIP_MESSAGES): the quick
// clip is the same operation from a different entry point, so it must not invent a
// second set of words for the same outcomes.
const ERROR_TEXT: Record<string, string> = {
  not_paired: "Pair a browser first (Options).",
  unauthorized: "Pairing expired — re-pair in Options.",
  invalid_request: "Couldn't save this page.",
  // handleClip queues `unreachable` / `server_error`, so those normally surface as
  // the offline toast below. They are kept as a defensive fallback: quickClip also
  // synthesises a bare (un-queued) server_error when the clip call itself rejects,
  // and a future handleClip that stops queuing would otherwise fall to the generic
  // text with no hint of what went wrong.
  server_error: "Nimbus had an error saving this.",
  unreachable: "Can't reach Nimbus — is the gateway running?",
};

/** Map a clip response to the toast to show. */
export function toToastState(res: ClipResponse): ToastState {
  if (res.ok) {
    if (res.bookmarked === true) {
      return { variant: "success", text: "Saved as a bookmark." };
    }
    return {
      variant: "success",
      text: res.status === "updated" ? "Updated in Nimbus." : "Saved to Nimbus.",
    };
  }
  if (res.queued === true) {
    return { variant: "offline", text: "Saved offline — will sync when Nimbus is back." };
  }
  return { variant: "error", text: ERROR_TEXT[res.reason] ?? "Couldn't save this page." };
}

export interface QuickClipDeps {
  readonly activeTab: () => Promise<{ id: number; url: string; title: string }>;
  readonly runCapture: (tabId: number, mode: "article" | "selection") => Promise<CaptureResult>;
  readonly clip: (req: ClipRequest) => Promise<ClipResponse>;
  /** Restricted = injection is known to be impossible → go straight to the badge. */
  readonly showFeedback: (tabId: number, state: ToastState, restricted?: boolean) => Promise<void>;
}

const CANT_CLIP: ToastState = {
  variant: "error",
  text: "Nimbus can't clip browser system or store pages.",
};

/**
 * Clip a tab without the popup. `clickedTabId`, when given (a context-menu click),
 * wins over the active tab: a right-click in a non-focused window targets a
 * different tab than `tabs.query({active, currentWindow})`, and the `activeTab`
 * grant belongs to the CLICKED tab, so injecting anywhere else would fail.
 */
export async function quickClip(
  deps: QuickClipDeps,
  mode: "article" | "selection",
  clickedTabId?: number,
): Promise<void> {
  let active: { id: number; url: string; title: string } | null = null;
  try {
    active = await deps.activeTab();
  } catch {
    active = null; // no active tab (e.g. no focused window)
  }
  const tabId = clickedTabId ?? active?.id;
  if (tabId === undefined) {
    return; // nothing to clip
  }
  // The URL is only known for the tab `activeTab()` reported. For a click on some
  // other tab we skip the pre-check and let capture fail into the badge path.
  const url = active !== null && active.id === tabId ? active.url : null;
  if (url !== null && isRestrictedUrl(url)) {
    await deps.showFeedback(tabId, CANT_CLIP, true);
    return;
  }
  let capture: CaptureResult;
  try {
    capture = await deps.runCapture(tabId, mode);
  } catch {
    await deps.showFeedback(tabId, CANT_CLIP, true);
    return;
  }
  if (mode === "selection" && capture.body === "") {
    await deps.showFeedback(tabId, { variant: "error", text: "Select some text first." });
    return;
  }
  // Fail closed with a visible outcome: a rejecting clip (a storage failure in the
  // SW's wrapper, say) must still produce a toast — the hotkey has no other channel.
  let res: ClipResponse;
  try {
    res = await deps.clip({ kind: "clip", capture, tags: [] });
  } catch {
    res = { kind: "clip", ok: false, reason: "server_error" };
  }
  await deps.showFeedback(tabId, toToastState(res));
}
