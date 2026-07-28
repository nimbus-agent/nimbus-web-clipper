import { describe, expect, test, vi } from "vitest";
import { type FeedbackDeps, showFeedback } from "../../src/background/feedback.ts";

function deps(over: Partial<FeedbackDeps> = {}): FeedbackDeps {
  return {
    showToast: vi.fn(async (): Promise<void> => undefined),
    setBadgeText: vi.fn(async (): Promise<void> => undefined),
    restoreBadge: vi.fn(async (): Promise<void> => undefined),
    ...over,
  };
}

describe("showFeedback", () => {
  test("shows the toast on a normal page", async () => {
    const d = deps();
    await showFeedback(d, 1, { variant: "success", text: "ok" });
    expect(d.showToast).toHaveBeenCalledWith(1, { variant: "success", text: "ok" });
    expect(d.setBadgeText).not.toHaveBeenCalled();
  });

  test("restricted → badge flash, no toast attempt", async () => {
    vi.useFakeTimers();
    const d = deps();
    await showFeedback(d, 1, { variant: "error", text: "x" }, true);
    expect(d.showToast).not.toHaveBeenCalled();
    expect(d.setBadgeText).toHaveBeenCalledWith("!");
    vi.advanceTimersByTime(1500);
    expect(d.restoreBadge).toHaveBeenCalled();
    vi.useRealTimers();
  });

  test("toast injection failure → badge fallback", async () => {
    vi.useFakeTimers();
    const d = deps({
      showToast: vi.fn(async () => {
        throw new Error("blocked");
      }),
    });
    await showFeedback(d, 1, { variant: "success", text: "x" });
    expect(d.setBadgeText).toHaveBeenCalledWith("✓");
    vi.advanceTimersByTime(1500);
    expect(d.restoreBadge).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
