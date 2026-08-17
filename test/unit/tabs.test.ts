import { beforeEach, describe, expect, it, vi } from "vitest";
import { listCandidateTabs } from "../../src/browser/tabs.ts";

type FakeTab = { id?: number; url?: string | undefined; title?: string | undefined };

function installTabs(tabs: FakeTab[]): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { query: vi.fn(() => Promise.resolve(tabs)) },
  };
}

describe("listCandidateTabs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("names the tabs whose url is visible", async () => {
    installTabs([
      { id: 1, url: "https://github.com/acme/web/pull/1", title: "PR 1" },
      { id: 2, url: "https://github.com/acme/web/pull/2", title: "PR 2" },
    ]);
    const out = await listCandidateTabs();
    expect(out.named).toHaveLength(2);
    expect(out.named[0]).toEqual({
      id: 1,
      url: "https://github.com/acme/web/pull/1",
      title: "PR 1",
    });
    expect(out.hiddenCount).toBe(0);
  });

  it("COUNTS but does not name a tab whose url is withheld", async () => {
    // No host permission => chrome strips `url`/`title`. We can say how many
    // there are; we cannot say what they are, and must not guess.
    installTabs([
      { id: 1, url: "https://github.com/acme/web/pull/1", title: "PR 1" },
      { id: 2 },
      { id: 3, title: undefined },
    ]);
    const out = await listCandidateTabs();
    expect(out.named).toHaveLength(1);
    expect(out.hiddenCount).toBe(2);
  });

  it("excludes restricted-scheme tabs from BOTH counts", async () => {
    // chrome://extensions is visible but uninjectable, so offering it as a
    // source would promise a capture that always fails; counting it as
    // "ungranted" would send the user to Options to grant something no grant
    // can fix.
    installTabs([
      { id: 1, url: "https://example.com/a", title: "A" },
      { id: 2, url: "chrome://extensions", title: "Extensions" },
      { id: 3, url: "about:debugging", title: "Debug" },
    ]);
    const out = await listCandidateTabs();
    expect(out.named).toHaveLength(1);
    expect(out.hiddenCount).toBe(0);
  });

  it("skips tabs with no id, which cannot be injected into", async () => {
    installTabs([{ url: "https://example.com/a", title: "A" }]);
    const out = await listCandidateTabs();
    expect(out.named).toHaveLength(0);
    expect(out.hiddenCount).toBe(0);
  });

  it("falls back to the url when a granted tab has no title", async () => {
    installTabs([{ id: 1, url: "https://example.com/a" }]);
    const out = await listCandidateTabs();
    expect(out.named[0]?.title).toBe("https://example.com/a");
  });

  it("DISTINGUISHES a failed query from an empty one, rather than throwing", async () => {
    // "You have no eligible tabs" and "we couldn't read your tabs" are different
    // facts and must not render the same. `noConsole` is an error inside `src/`,
    // and this extension ships no telemetry, so the failure is surfaced to the
    // USER rather than to a log they will never see.
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: { query: vi.fn(() => Promise.reject(new Error("no"))) },
    };
    const out = await listCandidateTabs();
    expect(out).toEqual({ named: [], hiddenCount: 0, enumerationFailed: true });
  });

  it("reports enumerationFailed false on a genuinely empty tab set", async () => {
    installTabs([]);
    const out = await listCandidateTabs();
    expect(out).toEqual({ named: [], hiddenCount: 0, enumerationFailed: false });
  });
});
