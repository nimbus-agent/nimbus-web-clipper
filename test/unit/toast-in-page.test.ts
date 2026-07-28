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
    toast()({ variant: "success", text: "Saved to Nimbus." });

    const host = document.getElementById(HOST_ID);
    expect(host).not.toBeNull();
    expect(host?.shadowRoot?.querySelector(".nimbus-toast__text")?.textContent).toBe(
      "Saved to Nimbus.",
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

  test("a page-planted host WITHOUT a shadow root is replaced, not written into", async () => {
    const planted = document.createElement("div");
    planted.id = HOST_ID;
    document.body.append(planted);

    await import("../../src/capture/toast-in-page.ts");
    expect(() => toast()({ variant: "success", text: "Saved to Nimbus." })).not.toThrow();

    const hosts = document.querySelectorAll(`#${HOST_ID}`);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).not.toBe(planted);
    expect(planted.isConnected).toBe(false);
    expect(hosts[0]?.shadowRoot?.querySelector(".nimbus-toast__text")?.textContent).toBe(
      "Saved to Nimbus.",
    );
  });

  test("a page-planted host WITH its own open shadow root never receives our content", async () => {
    const planted = document.createElement("div");
    planted.id = HOST_ID;
    const hostileRoot = planted.attachShadow({ mode: "open" });
    document.body.append(planted);

    await import("../../src/capture/toast-in-page.ts");
    toast()({ variant: "error", text: "Pair a browser first (Options)." });

    // The hostile root learns nothing: no toast node, so nothing to read or restyle.
    expect(hostileRoot.querySelector(".nimbus-toast")).toBeNull();
    expect(hostileRoot.textContent).toBe("");
    expect(planted.isConnected).toBe(false);

    const hosts = document.querySelectorAll(`#${HOST_ID}`);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).not.toBe(planted);
    expect(hosts[0]?.shadowRoot?.querySelector(".nimbus-toast__text")?.textContent).toBe(
      "Pair a browser first (Options).",
    );
  });

  test("a host planted BETWEEN two toasts does not capture the second one", async () => {
    await import("../../src/capture/toast-in-page.ts");
    toast()({ variant: "success", text: "first" });
    document.getElementById(HOST_ID)?.remove();

    const planted = document.createElement("div");
    planted.id = HOST_ID;
    const hostileRoot = planted.attachShadow({ mode: "open" });
    document.body.append(planted);

    toast()({ variant: "success", text: "second" });

    expect(hostileRoot.textContent).toBe("");
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
    expect(
      document.getElementById(HOST_ID)?.shadowRoot?.querySelector(".nimbus-toast__text")
        ?.textContent,
    ).toBe("second");
  });
});
