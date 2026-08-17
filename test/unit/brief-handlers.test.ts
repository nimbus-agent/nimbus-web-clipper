import { describe, expect, it, vi } from "vitest";
import {
  type BriefDeps,
  handleBriefPoll,
  handleBriefSave,
  handleBriefStart,
  handleBriefTabs,
} from "../../src/background/brief-handlers.ts";
import type { BriefReport } from "../../src/shared/brief-report.ts";

const REPORT: BriefReport = {
  summary: "They disagree about retries.",
  findings: [{ text: "A retries; B does not.", citations: [{ kind: "source", title: "A" }] }],
  conflicts: [],
  gaps: [],
  synthesis: { model: "llama3", remote: false },
};

function capture(url: string, title: string, body = "body text") {
  return {
    ok: true as const,
    capture: { url, title, body, mode: "article" as const, readableFound: true },
  };
}

function client(over: Partial<BriefDeps["client"]> = {}): BriefDeps["client"] {
  return {
    createBrief: vi.fn(() => Promise.resolve({ ok: true, id: "b1", expected: 2 })),
    feedBriefSource: vi.fn(() => Promise.resolve({ ok: true, received: 1, expected: 2 })),
    runBrief: vi.fn(() => Promise.resolve({ ok: true })),
    getBrief: vi.fn(() => Promise.resolve({ ok: true, status: "done", report: REPORT })),
    saveBrief: vi.fn(() => Promise.resolve({ ok: true, itemId: "i1" })),
    ...over,
  } as unknown as BriefDeps["client"];
}

function deps(over: Partial<BriefDeps> = {}): BriefDeps {
  const stored = new Map<string, unknown>();
  return {
    now: () => 1000,
    listTabs: () =>
      Promise.resolve({
        named: [
          { id: 1, url: "https://example.com/a", title: "A" },
          { id: 2, url: "https://example.com/b", title: "B" },
        ],
        hiddenCount: 0,
        enumerationFailed: false,
      }),
    origins: () => Promise.resolve([]),
    capture: (tabId: number) =>
      Promise.resolve(
        capture(`https://example.com/${tabId === 1 ? "a" : "b"}`, tabId === 1 ? "A" : "B"),
      ),
    connection: () => Promise.resolve({ origin: "http://127.0.0.1:7474", token: "t" }),
    client: client(),
    store: {
      get: vi.fn((id: string) => Promise.resolve((stored.get(id) ?? null) as never)),
      put: vi.fn((run: { id: string }) => {
        stored.set(run.id, run);
        return Promise.resolve();
      }),
    },
    log: { append: vi.fn(() => Promise.resolve()), update: vi.fn(() => Promise.resolve()) },
    onState: vi.fn(),
    ...over,
  } as unknown as BriefDeps;
}

const start = { kind: "brief-start" as const, question: "q", tabIds: [1, 2] };

describe("handleBriefTabs", () => {
  it("returns the named tabs, the hidden count and scaffolded questions", async () => {
    const out = await handleBriefTabs(deps());
    expect(out.named).toHaveLength(2);
    expect(out.hiddenCount).toBe(0);
    expect(out.questions.length).toBeGreaterThan(0);
    expect(out.enumerationFailed).toBe(false);
  });

  it("passes a failed enumeration through rather than reporting an empty tab set", async () => {
    const out = await handleBriefTabs(
      deps({
        listTabs: () => Promise.resolve({ named: [], hiddenCount: 0, enumerationFailed: true }),
      }),
    );
    expect(out.enumerationFailed).toBe(true);
  });
});

describe("handleBriefStart", () => {
  it("declares every picked tab at create, then feeds each", async () => {
    const d = deps();
    await handleBriefStart(d, start);
    const create = (d.client.createBrief as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = create?.[2] as { sources: unknown[] } | undefined;
    expect(body?.sources).toHaveLength(2);
    expect((d.client.feedBriefSource as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(d.client.runBrief).toHaveBeenCalledTimes(1);
  });

  it("still runs when one tab fails to capture — a partial brief is a real answer", async () => {
    const d = deps({
      capture: (tabId: number) =>
        tabId === 2
          ? Promise.resolve({ ok: false as const, reason: "url-changed" as const })
          : Promise.resolve(capture("https://example.com/a", "A")),
    });
    const state = await handleBriefStart(d, start);
    expect((d.client.feedBriefSource as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(d.client.runBrief).toHaveBeenCalledTimes(1);
    expect(state.kind).toBe("done");
  });

  it("names the pages it could not read, and why", async () => {
    const d = deps({
      capture: (tabId: number) =>
        tabId === 2
          ? Promise.resolve({ ok: false as const, reason: "restricted" as const })
          : Promise.resolve(capture("https://example.com/a", "A")),
    });
    const state = await handleBriefStart(d, start);
    expect(state.kind === "done" && state.skipped).toEqual([{ title: "B", reason: "restricted" }]);
  });

  it("refuses to run when NO source captured — there is nothing to answer from", async () => {
    const d = deps({
      capture: () => Promise.resolve({ ok: false as const, reason: "restricted" as const }),
    });
    const state = await handleBriefStart(d, start);
    expect(d.client.runBrief).not.toHaveBeenCalled();
    expect(state.kind).toBe("failed");
  });

  it("STOPS feeding on run_capacity but still runs what was accepted", async () => {
    const feed = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, received: 1, expected: 2 })
      .mockResolvedValueOnce({ ok: false, reason: "refused", detail: "run_capacity" });
    const d = deps({ client: client({ feedBriefSource: feed as never }) });
    await handleBriefStart(d, start);
    expect(feed).toHaveBeenCalledTimes(2);
    expect(d.client.runBrief).toHaveBeenCalledTimes(1);
  });

  it("writes the log entry when /run is ACCEPTED, before the report arrives", async () => {
    const d = deps();
    await handleBriefStart(d, { ...start, tabIds: [1] });
    const append = d.log.append as ReturnType<typeof vi.fn>;
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toMatchObject({ runId: "b1", sourceCount: 1 });
  });

  it("logs a run that FAILS during synthesis — the source text still left", async () => {
    const d = deps({
      client: client({
        getBrief: vi.fn(() =>
          Promise.resolve({ ok: true, status: "failed", failureReason: "x" }),
        ) as never,
      }),
    });
    await handleBriefStart(d, { ...start, tabIds: [1] });
    expect(d.log.append).toHaveBeenCalledTimes(1);
    expect(d.log.update).toHaveBeenCalledWith("b1", { failed: true });
  });

  it("patches the log with the model that actually answered", async () => {
    const d = deps();
    await handleBriefStart(d, { ...start, tabIds: [1] });
    expect(d.log.update).toHaveBeenCalledWith("b1", { model: "llama3", remote: false });
  });

  it("does not log or feed when create is refused", async () => {
    const d = deps({
      client: client({
        createBrief: vi.fn(() =>
          Promise.resolve({ ok: false, reason: "disabled", hint: "h" }),
        ) as never,
      }),
    });
    const state = await handleBriefStart(d, { ...start, tabIds: [1] });
    expect(state).toMatchObject({ kind: "failed", hint: "h" });
    expect(d.log.append).not.toHaveBeenCalled();
    expect(d.client.feedBriefSource).not.toHaveBeenCalled();
  });

  it("fails closed with no connection, without touching the client", async () => {
    const d = deps({ connection: () => Promise.resolve(null) });
    const state = await handleBriefStart(d, { ...start, tabIds: [1] });
    expect(state).toMatchObject({ kind: "failed", reason: "not_paired" });
    expect(d.client.createBrief).not.toHaveBeenCalled();
  });

  it("captures only the tabs asked for, and only ones the tab list named", async () => {
    const cap = vi.fn(() => Promise.resolve(capture("https://example.com/a", "A")));
    const d = deps({ capture: cap as never });
    await handleBriefStart(d, { ...start, tabIds: [1, 999] });
    expect(cap).toHaveBeenCalledTimes(1);
    expect(cap).toHaveBeenCalledWith(1, "https://example.com/a");
  });

  it("counts truncated sources into the log entry", async () => {
    const d = deps({
      capture: () => Promise.resolve(capture("https://example.com/a", "A", "y".repeat(300 * 1024))),
    });
    await handleBriefStart(d, { ...start, tabIds: [1] });
    const append = d.log.append as ReturnType<typeof vi.fn>;
    expect(append.mock.calls[0]?.[0]).toMatchObject({ truncatedCount: 1 });
  });

  it("never puts a source body into the run store", async () => {
    const d = deps();
    await handleBriefStart(d, start);
    const put = d.store.put as ReturnType<typeof vi.fn>;
    const written = JSON.stringify(put.mock.calls.map((c) => c[0]));
    expect(written.toLowerCase()).not.toContain("body text");
  });
});

describe("handleBriefPoll", () => {
  it("settles a finished run and patches the log with the model", async () => {
    const d = deps();
    await handleBriefStart(d, { ...start, tabIds: [1] });
    (d.log.update as ReturnType<typeof vi.fn>).mockClear();
    const state = await handleBriefPoll(d, "b1");
    expect(state.kind).toBe("done");
    expect(d.log.update).toHaveBeenCalledWith("b1", { model: "llama3", remote: false });
  });

  it("stays running while the gateway is still working", async () => {
    const d = deps({
      client: client({
        getBrief: vi.fn(() => Promise.resolve({ ok: true, status: "running" })) as never,
      }),
    });
    await handleBriefStart(d, { ...start, tabIds: [1] });
    expect(await handleBriefPoll(d, "b1")).toEqual({ kind: "running", id: "b1" });
  });

  it("is idle for a run that is gone, rather than broadcasting a failure over the page", async () => {
    const d = deps();
    expect(await handleBriefPoll(d, "vanished")).toEqual({ kind: "idle" });
  });

  it("fails closed when unpaired, without polling", async () => {
    const d = deps({ connection: () => Promise.resolve(null) });
    const state = await handleBriefPoll(d, "b1");
    expect(state).toEqual({ kind: "failed", id: "b1", reason: "not_paired" });
    expect(d.client.getBrief).not.toHaveBeenCalled();
  });
});

describe("handleBriefSave", () => {
  it("returns done with the item id and patches the log", async () => {
    const d = deps();
    await handleBriefStart(d, { ...start, tabIds: [1] });
    const state = await handleBriefSave(d, "b1");
    expect(state).toMatchObject({ kind: "done", savedItemId: "i1" });
    expect(d.log.update).toHaveBeenCalledWith("b1", { savedItemId: "i1" });
  });

  it("A FAILED SAVE IS save-failed, NEVER failed — the report must survive it", async () => {
    const d = deps({
      client: client({
        saveBrief: vi.fn(() => Promise.resolve({ ok: false, reason: "expired" })) as never,
      }),
    });
    await handleBriefStart(d, { ...start, tabIds: [1] });
    const state = await handleBriefSave(d, "b1");
    expect(state).toEqual({ kind: "save-failed", id: "b1", reason: "expired" });
  });

  it("reports save-failed when the run is no longer stored", async () => {
    const d = deps();
    const state = await handleBriefSave(d, "gone");
    expect(state).toEqual({ kind: "save-failed", id: "gone", reason: "expired" });
    expect(d.client.saveBrief).not.toHaveBeenCalled();
  });

  it("reports save-failed rather than failed when unpaired", async () => {
    const d = deps({ connection: () => Promise.resolve(null) });
    const state = await handleBriefSave(d, "b1");
    expect(state).toEqual({ kind: "save-failed", id: "b1", reason: "not_paired" });
  });
});
