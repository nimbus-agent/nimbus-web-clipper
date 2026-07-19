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

const ERROR_TEXT: Record<string, string> = {
  not_paired: "Pair a browser first (Options).",
  unauthorized: "Pairing expired — re-pair in Options.",
  invalid_request: "Couldn't clip this page.",
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
      text: res.status === "updated" ? "Updated in Nimbus." : "Clipped to Nimbus.",
    };
  }
  if (res.queued === true) {
    return { variant: "offline", text: "Offline — saved to retry queue." };
  }
  return { variant: "error", text: ERROR_TEXT[res.reason] ?? "Couldn't clip this page." };
}

export interface QuickClipDeps {
  readonly activeTab: () => Promise<{ id: number; url: string; title: string }>;
  readonly runCapture: (tabId: number, mode: "article" | "selection") => Promise<CaptureResult>;
  readonly clip: (req: ClipRequest) => Promise<ClipResponse>;
  /** Restricted = injection is known to be impossible → go straight to the badge. */
  readonly showFeedback: (tabId: number, state: ToastState, restricted?: boolean) => Promise<void>;
}

const CANT_CLIP: ToastState = { variant: "error", text: "Nimbus can't clip this page." };

export async function quickClip(deps: QuickClipDeps, mode: "article" | "selection"): Promise<void> {
  let tab: { id: number; url: string; title: string };
  try {
    tab = await deps.activeTab();
  } catch {
    return; // no active tab (e.g. no focused window) — nothing to clip
  }
  if (isRestrictedUrl(tab.url)) {
    await deps.showFeedback(tab.id, CANT_CLIP, true);
    return;
  }
  let capture: CaptureResult;
  try {
    capture = await deps.runCapture(tab.id, mode);
  } catch {
    await deps.showFeedback(tab.id, CANT_CLIP, true);
    return;
  }
  if (mode === "selection" && capture.body === "") {
    await deps.showFeedback(tab.id, { variant: "error", text: "Select some text first." });
    return;
  }
  const res = await deps.clip({ kind: "clip", capture, tags: [] });
  await deps.showFeedback(tab.id, toToastState(res));
}
