import type { ToastState } from "../shared/types.ts";

const BADGE_MS = 1500;
const BADGE: Record<ToastState["variant"], string> = { success: "✓", offline: "…", error: "!" };

export interface FeedbackDeps {
  readonly showToast: (tabId: number, state: ToastState) => Promise<void>;
  readonly setBadgeText: (text: string) => Promise<void>;
  /** Repaint the normal (queue-count) badge after the flash. */
  readonly restoreBadge: () => Promise<void>;
}

/**
 * Confirm a quick-clip. Normally an in-page toast; when the page can't host a
 * script (restricted, or injection throws), flash the toolbar badge instead and
 * restore the queue-count badge shortly after (best-effort — the SW is alive
 * right after the clip).
 */
export async function showFeedback(
  deps: FeedbackDeps,
  tabId: number,
  state: ToastState,
  restricted = false,
): Promise<void> {
  if (!restricted) {
    try {
      await deps.showToast(tabId, state);
      return;
    } catch {
      // fall through to the badge fallback
    }
  }
  await deps.setBadgeText(BADGE[state.variant]);
  setTimeout(() => {
    deps.restoreBadge().catch(() => undefined);
  }, BADGE_MS);
}
