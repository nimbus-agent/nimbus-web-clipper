import { describe, expect, test, vi } from "vitest";
import {
  isRestrictedUrl,
  type QuickClipDeps,
  quickClip,
  toToastState,
} from "../../src/background/quick-clip.ts";
import type { ClipResponse } from "../../src/shared/messages.ts";
import type { CaptureResult } from "../../src/shared/types.ts";

const CAPTURE: CaptureResult = {
  url: "https://ex.com/a",
  title: "An Article",
  mode: "article",
  body: "text",
  readableFound: true,
};

function deps(over: Partial<QuickClipDeps> = {}): {
  d: QuickClipDeps;
  clip: ReturnType<typeof vi.fn>;
  feedback: ReturnType<typeof vi.fn>;
} {
  const clip = vi.fn(
    async (): Promise<ClipResponse> => ({
      kind: "clip",
      ok: true,
      status: "created",
      bookmarked: false,
    }),
  );
  const feedback = vi.fn(async (): Promise<void> => undefined);
  const d: QuickClipDeps = {
    activeTab: vi.fn(async () => ({ id: 1, url: "https://ex.com/a", title: "An Article" })),
    runCapture: vi.fn(async () => CAPTURE),
    clip,
    showFeedback: feedback,
    ...over,
  };
  return { d, clip, feedback };
}

describe("isRestrictedUrl", () => {
  test("flags non-injectable schemes", () => {
    expect(isRestrictedUrl("chrome://extensions")).toBe(true);
    expect(isRestrictedUrl("about:debugging")).toBe(true);
    expect(isRestrictedUrl("view-source:https://x")).toBe(true);
    expect(isRestrictedUrl("https://example.com/a")).toBe(false);
    expect(isRestrictedUrl("not a url")).toBe(true);
  });
});

describe("toToastState", () => {
  test("maps clip responses to toast states", () => {
    expect(
      toToastState({ kind: "clip", ok: true, status: "created", bookmarked: false }).text,
    ).toBe("Clipped to Nimbus.");
    expect(
      toToastState({ kind: "clip", ok: true, status: "updated", bookmarked: false }).text,
    ).toBe("Updated in Nimbus.");
    expect(toToastState({ kind: "clip", ok: true, status: "created", bookmarked: true }).text).toBe(
      "Saved as a bookmark.",
    );
    expect(toToastState({ kind: "clip", ok: false, reason: "unreachable", queued: true })).toEqual({
      variant: "offline",
      text: "Offline — saved to retry queue.",
    });
    expect(toToastState({ kind: "clip", ok: false, reason: "not_paired" })).toEqual({
      variant: "error",
      text: "Pair a browser first (Options).",
    });
  });
});

describe("quickClip", () => {
  test("captures, clips, and shows the success toast", async () => {
    const { d, clip, feedback } = deps();
    await quickClip(d, "article");
    expect(clip).toHaveBeenCalledWith({ kind: "clip", capture: CAPTURE, tags: [] });
    expect(feedback).toHaveBeenCalledWith(1, { variant: "success", text: "Clipped to Nimbus." });
  });

  test("restricted page → error feedback, no capture", async () => {
    const runCapture = vi.fn();
    const { d, clip, feedback } = deps({
      activeTab: vi.fn(async () => ({ id: 2, url: "chrome://extensions", title: "" })),
      runCapture,
    });
    await quickClip(d, "article");
    expect(runCapture).not.toHaveBeenCalled();
    expect(clip).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenCalledWith(2, expect.objectContaining({ variant: "error" }), true);
  });

  test("empty selection → prompt, no clip", async () => {
    const { d, clip, feedback } = deps({
      runCapture: vi.fn(
        async (): Promise<CaptureResult> => ({ ...CAPTURE, mode: "selection", body: "" }),
      ),
    });
    await quickClip(d, "selection");
    expect(clip).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenCalledWith(1, { variant: "error", text: "Select some text first." });
  });

  test("runCapture throws → error feedback (badge)", async () => {
    const { d, clip, feedback } = deps({
      runCapture: vi.fn(async () => {
        throw new Error("no");
      }),
    });
    await quickClip(d, "article");
    expect(clip).not.toHaveBeenCalled();
    expect(feedback).toHaveBeenCalledWith(1, expect.objectContaining({ variant: "error" }), true);
  });

  test("offline clip → offline toast", async () => {
    const { d, feedback } = deps({
      clip: vi.fn(
        async (): Promise<ClipResponse> => ({
          kind: "clip",
          ok: false,
          reason: "unreachable",
          queued: true,
        }),
      ),
    });
    await quickClip(d, "article");
    expect(feedback).toHaveBeenCalledWith(1, {
      variant: "offline",
      text: "Offline — saved to retry queue.",
    });
  });
});
