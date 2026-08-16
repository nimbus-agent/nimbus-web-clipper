import { describe, expect, test } from "vitest";
import { captureTab } from "../../src/background/capture-tab.ts";
import type { CaptureResult } from "../../src/shared/types.ts";

const PAGE = "https://wiki.example.com/runbook";
function result(url = PAGE): CaptureResult {
  return { url, title: "Runbook", mode: "article", body: "text", readableFound: true };
}

describe("captureTab", () => {
  test("captures when the tab url matches the expected url", async () => {
    const out = await captureTab(
      { tabUrl: async () => PAGE, runCapture: async () => result() },
      7,
      "article",
      PAGE,
    );
    expect(out).toEqual({ ok: true, capture: result() });
  });

  test("refuses a restricted scheme WITHOUT injecting", async () => {
    let injected = false;
    const out = await captureTab(
      {
        tabUrl: async () => "chrome://extensions",
        runCapture: async () => {
          injected = true;
          return result();
        },
      },
      7,
      "article",
    );
    expect(out).toEqual({ ok: false, reason: "restricted" });
    expect(injected).toBe(false);
  });

  test("refuses when the tab moved off the expected url, WITHOUT injecting", async () => {
    let injected = false;
    const out = await captureTab(
      {
        tabUrl: async () => "https://wiki.example.com/other",
        runCapture: async () => {
          injected = true;
          return result();
        },
      },
      7,
      "article",
      PAGE,
    );
    expect(out).toEqual({ ok: false, reason: "url-changed" });
    expect(injected).toBe(false);
  });

  test("no expectedUrl means no url check (the hotkey path)", async () => {
    const out = await captureTab(
      { tabUrl: async () => PAGE, runCapture: async () => result() },
      7,
      "article",
    );
    expect(out.ok).toBe(true);
  });

  test("an unknown tab url is refused as restricted, not assumed safe", async () => {
    const out = await captureTab(
      { tabUrl: async () => null, runCapture: async () => result() },
      7,
      "article",
    );
    expect(out).toEqual({ ok: false, reason: "restricted" });
  });

  test("refuses when the page navigated DURING the capture", async () => {
    // The pre-check passes (the tab is still on PAGE when we look), but the
    // capture comes back describing a different page — an SPA route change
    // inside the injection round-trip. Filing that content under PAGE would be
    // a corrupt index entry, so this must refuse.
    const out = await captureTab(
      {
        tabUrl: async () => PAGE,
        runCapture: async () => result("https://wiki.example.com/other"),
      },
      7,
      "article",
      PAGE,
    );
    expect(out).toEqual({ ok: false, reason: "url-changed" });
  });

  test("a mid-capture navigation is ignored when there is no expectedUrl", async () => {
    // The hotkey path has no pinned page to be wrong about, so a differing
    // capture.url is not an error there — it is just the page it captured.
    const out = await captureTab(
      {
        tabUrl: async () => PAGE,
        runCapture: async () => result("https://wiki.example.com/other"),
      },
      7,
      "article",
    );
    expect(out.ok).toBe(true);
  });

  test("a throwing injection becomes injection-failed", async () => {
    const out = await captureTab(
      {
        tabUrl: async () => PAGE,
        runCapture: async () => {
          throw new Error("no");
        },
      },
      7,
      "article",
    );
    expect(out).toEqual({ ok: false, reason: "injection-failed" });
  });

  test("an empty body becomes empty", async () => {
    const out = await captureTab(
      { tabUrl: async () => PAGE, runCapture: async () => ({ ...result(), body: "" }) },
      7,
      "article",
    );
    expect(out).toEqual({ ok: false, reason: "empty" });
  });
});
