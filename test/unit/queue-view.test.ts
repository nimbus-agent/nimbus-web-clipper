// @vitest-environment jsdom
// test/unit/queue-view.test.ts
import { describe, expect, test } from "vitest";
import { formatAge, hostOf, renderQueueItem, renderQueueList } from "../../src/popup/queue-view.ts";
import type { QueuedClipView } from "../../src/shared/queue.ts";

const base: QueuedClipView = { url: "https://ex.com/p", title: "Doc", queuedAt: 0, attempts: 0 };

describe("hostOf", () => {
  test("returns the host for a valid URL; echoes a bad one", () => {
    expect(hostOf("https://ex.com/a/b")).toBe("ex.com");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("formatAge", () => {
  test("buckets seconds/minutes/hours/days", () => {
    expect(formatAge(30_000, 0)).toBe("just now");
    expect(formatAge(120_000, 0)).toBe("2m ago");
    expect(formatAge(3 * 3_600_000, 0)).toBe("3h ago");
    expect(formatAge(2 * 86_400_000, 0)).toBe("2d ago");
  });
});

describe("renderQueueItem", () => {
  test("renders title, host·age, and Retry/Remove buttons carrying the url", () => {
    const el = renderQueueItem(document, base, 120_000);
    expect(el.querySelector(".queue__item-title")?.textContent).toBe("Doc");
    expect(el.querySelector(".queue__item-meta")?.textContent).toBe("ex.com · 2m ago");
    expect(el.querySelector(".queue__retry")?.getAttribute("data-url")).toBe("https://ex.com/p");
    expect(el.querySelector(".queue__remove")?.getAttribute("data-url")).toBe("https://ex.com/p");
    // renders no anchor — the manager never navigates (no javascript: href surface)
    expect(el.querySelector("a")).toBeNull();
  });
  test("shows a status line with the reason + attempt count when attempted", () => {
    const el = renderQueueItem(document, { ...base, attempts: 3, lastReason: "unreachable" }, 0);
    expect(el.querySelector(".queue__item-status")?.textContent).toBe(
      "Can't reach Nimbus · 3 tries",
    );
  });
  test("XSS backstop — markup in the title is inert text", () => {
    const el = renderQueueItem(document, { ...base, title: "<img src=x onerror=alert(1)>" }, 0);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".queue__item-title")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });
});

describe("renderQueueList", () => {
  test("renders one item per entry", () => {
    const list = renderQueueList(document, [base, { ...base, url: "https://ex.com/q" }], 0);
    expect(list.querySelectorAll(".queue__item").length).toBe(2);
  });
});
