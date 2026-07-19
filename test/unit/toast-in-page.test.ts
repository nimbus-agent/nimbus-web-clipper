// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToastState } from "../../src/shared/types.ts";

const HOST_ID = "nimbus-toast-host";

function toast(): (s: ToastState) => void {
  return (globalThis as unknown as { __nimbusToast: (s: ToastState) => void }).__nimbusToast;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.innerHTML = "<head></head><body></body>";
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("toast-in-page (__nimbusToast)", () => {
  test("mounts one shadow host, renders the text, and auto-dismisses", async () => {
    await import("../../src/capture/toast-in-page.ts");
    toast()({ variant: "success", text: "Clipped to Nimbus." });

    const host = document.getElementById(HOST_ID);
    expect(host).not.toBeNull();
    expect(host?.shadowRoot?.querySelector(".nimbus-toast__text")?.textContent).toBe(
      "Clipped to Nimbus.",
    );

    vi.advanceTimersByTime(2500);
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  test("a repeat call replaces content + resets the timer (single host)", async () => {
    await import("../../src/capture/toast-in-page.ts");
    toast()({ variant: "success", text: "first" });
    vi.advanceTimersByTime(2000);
    toast()({ variant: "offline", text: "second" });

    const hosts = document.querySelectorAll(`#${HOST_ID}`);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.shadowRoot?.querySelector(".nimbus-toast__text")?.textContent).toBe("second");

    // timer was reset: 2000+1000 = 3000 elapsed since first, but only 1000 since reset → still up
    vi.advanceTimersByTime(1000);
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    vi.advanceTimersByTime(1500);
    expect(document.getElementById(HOST_ID)).toBeNull();
  });
});
