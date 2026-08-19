import { describe, expect, it, vi } from "vitest";
import {
  type BriefDeps,
  handleBriefPoll,
  handleBriefSave,
  handleBriefStart,
  handleBriefTabs,
} from "../../src/background/brief-handlers.ts";
import { BRIEF_CAPS } from "../../src/shared/brief.ts";
import type { BriefReport } from "../../src/shared/brief-report.ts";
import { type Passage, removePassage } from "../../src/shared/passage.ts";

const REPORT: BriefReport = {
  summary: "They disagree about retries.",
  findings: [{ text: "A retries; B does not.", citations: [{ kind: "source", title: "A" }] }],
  conflicts: [],
  gaps: [],
  synthesis: { model: "llama3", remote: false },
};

function capture(url: string, title = "T", body = "body text") {
  return {
    ok: true as const,
    capture: { url, title, body, mode: "article" as const, readableFound: true },
  };
}

/** One candidate tab, titled `Tab <id>` unless told otherwise. */
function tab(id: number, url: string, title = `Tab ${id}`) {
  return { id, url, title };
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
    passages: () => Promise.resolve([]),
    forgetPassages: () => Promise.resolve(),
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

const start = {
  kind: "brief-start" as const,
  question: "q",
  picks: [
    { kind: "tab" as const, id: 1 },
    { kind: "tab" as const, id: 2 },
  ],
};

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

describe("handleBriefTabs with a collection", () => {
  it("returns the passage groups beside the tabs, in one answer", async () => {
    const res = await handleBriefTabs(
      deps({
        listTabs: async () => ({
          named: [tab(1, "http://h/a")],
          hiddenCount: 0,
          enumerationFailed: false,
        }),
        passages: async () => [
          { url: "http://h/b", title: "B", text: "one", at: 5 },
          { url: "http://h/b#x", title: "B", text: "two", at: 6 },
        ],
      }),
    );
    expect(res.named).toHaveLength(1);
    expect(res.passages.map((g) => g.url)).toEqual(["http://h/b"]);
    expect(res.passages[0]?.passages).toHaveLength(2);
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
    await handleBriefStart(d, { ...start, picks: [{ kind: "tab", id: 1 }] });
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
    await handleBriefStart(d, { ...start, picks: [{ kind: "tab", id: 1 }] });
    expect(d.log.append).toHaveBeenCalledTimes(1);
    expect(d.log.update).toHaveBeenCalledWith("b1", { failed: true });
  });

  it("patches the log with the model that actually answered", async () => {
    const d = deps();
    await handleBriefStart(d, { ...start, picks: [{ kind: "tab", id: 1 }] });
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
    const state = await handleBriefStart(d, { ...start, picks: [{ kind: "tab", id: 1 }] });
    expect(state).toMatchObject({ kind: "failed", hint: "h" });
    expect(d.log.append).not.toHaveBeenCalled();
    expect(d.client.feedBriefSource).not.toHaveBeenCalled();
  });

  it("fails closed with no connection, without touching the client", async () => {
    const d = deps({ connection: () => Promise.resolve(null) });
    const state = await handleBriefStart(d, { ...start, picks: [{ kind: "tab", id: 1 }] });
    expect(state).toMatchObject({ kind: "failed", reason: "not_paired" });
    expect(d.client.createBrief).not.toHaveBeenCalled();
  });

  it("captures only the tabs asked for, and only ones the tab list named", async () => {
    const cap = vi.fn(() => Promise.resolve(capture("https://example.com/a", "A")));
    const d = deps({ capture: cap as never });
    await handleBriefStart(d, {
      ...start,
      picks: [
        { kind: "tab", id: 1 },
        { kind: "tab", id: 999 },
      ],
    });
    expect(cap).toHaveBeenCalledTimes(1);
    expect(cap).toHaveBeenCalledWith(1, "https://example.com/a");
  });

  it("counts truncated sources into the log entry", async () => {
    const d = deps({
      capture: () => Promise.resolve(capture("https://example.com/a", "A", "y".repeat(300 * 1024))),
    });
    await handleBriefStart(d, { ...start, picks: [{ kind: "tab", id: 1 }] });
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

describe("handleBriefStart with mixed picks", () => {
  it("declares every picked url exactly once, in picks order", async () => {
    const created: unknown[] = [];
    const store = {
      get: vi.fn(() => Promise.resolve(null)),
      put: vi.fn(() => Promise.resolve()),
    } as unknown as BriefDeps["store"];
    await handleBriefStart(
      deps({
        store,
        listTabs: async () => ({
          named: [tab(1, "http://h/a")],
          hiddenCount: 0,
          enumerationFailed: false,
        }),
        passages: async () => [{ url: "http://h/b", title: "B", text: "one", at: 5 }],
        client: {
          ...client(),
          createBrief: async (_o, _t, body) => {
            created.push(body);
            return { ok: true, id: "r1", expected: 2 };
          },
        },
      }),
      {
        kind: "brief-start",
        question: "q",
        picks: [
          { kind: "passages", url: "http://h/b" },
          { kind: "tab", id: 1 },
        ],
      },
    );
    expect(created).toEqual([
      {
        brief: "q",
        sources: [
          { url: "http://h/b", title: "B" },
          { url: "http://h/a", title: "Tab 1" },
        ],
        useIndex: false,
      },
    ]);
    // The STORED run must declare exactly what the gateway was told. Both come
    // from `declare()`, and this is the assertion that keeps them from drifting:
    // the stored `declared` is what a resumed poll reports the run as being about.
    const put = vi.mocked(store.put).mock.calls[0]?.[0];
    expect(put?.declared).toEqual((created[0] as { sources: unknown }).sources);
  });

  it("never captures for a passage source, and feeds its stitched body", async () => {
    const captured: number[] = [];
    const fed: { url: string; body: string; capturedAt: number }[] = [];
    await handleBriefStart(
      deps({
        passages: async () => [
          { url: "http://h/b", title: "B", text: "one", at: 900 },
          { url: "http://h/b", title: "B", text: "two", at: 100 },
        ],
        capture: async (tabId) => {
          captured.push(tabId);
          return { ok: true, capture: capture("http://h/a").capture };
        },
        client: {
          ...client(),
          feedBriefSource: async (_o, _t, _id, body) => {
            fed.push({ url: body.url, body: body.body, capturedAt: body.capturedAt });
            return { ok: true, received: fed.length, expected: 1 };
          },
        },
      }),
      { kind: "brief-start", question: "q", picks: [{ kind: "passages", url: "http://h/b" }] },
    );
    expect(captured).toEqual([]);
    expect(fed).toEqual([{ url: "http://h/b", body: "one\n\n[...]\n\ntwo", capturedAt: 100 }]);
  });

  it("a pick naming a url the collection does not hold is dropped, and the run proceeds", async () => {
    const created: unknown[] = [];
    const state = await handleBriefStart(
      deps({
        listTabs: async () => ({
          named: [tab(1, "http://h/a")],
          hiddenCount: 0,
          enumerationFailed: false,
        }),
        passages: async () => [],
        client: {
          ...client(),
          createBrief: async (_o, _t, body) => {
            created.push(body);
            return { ok: true, id: "r1", expected: 1 };
          },
        },
      }),
      {
        kind: "brief-start",
        question: "q",
        picks: [
          { kind: "passages", url: "http://h/gone" },
          { kind: "tab", id: 1 },
        ],
      },
    );
    expect(state.kind).not.toBe("failed");
    // DROPPED, not silently turned into a source: "did not fail" alone would
    // pass either way.
    expect(created).toEqual([
      { brief: "q", sources: [{ url: "http://h/a", title: "Tab 1" }], useIndex: false },
    ]);
  });

  it("declares one page ONCE when a tab pick and a passage pick both name it", async () => {
    // The composer renders one row per page key, but the composer is UI. The
    // guard checks shape, not uniqueness, so the invariant "a url is declared
    // exactly once, in exactly one mode" is enforced HERE — at the layer that
    // declares.
    const created: unknown[] = [];
    await handleBriefStart(
      deps({
        listTabs: async () => ({
          named: [tab(1, "http://h/a#live")],
          hiddenCount: 0,
          enumerationFailed: false,
        }),
        passages: async () => [{ url: "http://h/a", title: "A", text: "one", at: 5 }],
        client: {
          ...client(),
          createBrief: async (_o, _t, body) => {
            created.push(body);
            return { ok: true, id: "r1", expected: 1 };
          },
        },
      }),
      {
        kind: "brief-start",
        question: "q",
        picks: [
          { kind: "passages", url: "http://h/a" },
          { kind: "tab", id: 1 },
        ],
      },
    );
    // First pick wins — the order the composer displayed is the order it meant.
    expect(created).toEqual([
      { brief: "q", sources: [{ url: "http://h/a", title: "A" }], useIndex: false },
    ]);
  });

  it("two passage picks differing only by fragment are one source", async () => {
    const created: unknown[] = [];
    await handleBriefStart(
      deps({
        listTabs: async () => ({ named: [], hiddenCount: 0, enumerationFailed: false }),
        passages: async () => [{ url: "http://h/a", title: "A", text: "one", at: 5 }],
        client: {
          ...client(),
          createBrief: async (_o, _t, body) => {
            created.push(body);
            return { ok: true, id: "r1", expected: 1 };
          },
        },
      }),
      {
        kind: "brief-start",
        question: "q",
        picks: [
          { kind: "passages", url: "http://h/a" },
          { kind: "passages", url: "http://h/a#x" },
        ],
      },
    );
    expect(created).toEqual([
      { brief: "q", sources: [{ url: "http://h/a", title: "A" }], useIndex: false },
    ]);
  });

  it("two tabs showing the same page declare it once", async () => {
    const created: unknown[] = [];
    await handleBriefStart(
      deps({
        listTabs: async () => ({
          named: [tab(1, "http://h/a#one"), tab(2, "http://h/a#two")],
          hiddenCount: 0,
          enumerationFailed: false,
        }),
        passages: async () => [],
        client: {
          ...client(),
          createBrief: async (_o, _t, body) => {
            created.push(body);
            return { ok: true, id: "r1", expected: 1 };
          },
        },
      }),
      {
        kind: "brief-start",
        question: "q",
        picks: [
          { kind: "tab", id: 1 },
          { kind: "tab", id: 2 },
        ],
      },
    );
    expect(created).toEqual([
      { brief: "q", sources: [{ url: "http://h/a#one", title: "Tab 1" }], useIndex: false },
    ]);
  });

  it("picks that match nothing at all fail as no_sources", async () => {
    const state = await handleBriefStart(
      deps({
        listTabs: async () => ({ named: [], hiddenCount: 0, enumerationFailed: false }),
        passages: async () => [],
      }),
      { kind: "brief-start", question: "q", picks: [{ kind: "passages", url: "http://h/gone" }] },
    );
    expect(state).toEqual({ kind: "failed", reason: "no_sources" });
  });

  it("a fed passage group is forgotten once /run is accepted", async () => {
    const forgotten: string[] = [];
    await handleBriefStart(
      deps({
        passages: async () => [{ url: "http://h/b", title: "B", text: "one", at: 5 }],
        forgetPassages: async (fed) => {
          forgotten.push(...fed.map((f) => f.url));
        },
      }),
      { kind: "brief-start", question: "q", picks: [{ kind: "passages", url: "http://h/b" }] },
    );
    expect(forgotten).toEqual(["http://h/b"]);
  });

  it("a passage collected while the run was feeding survives the clear", async () => {
    // The collection is read ONCE, at the top of handleBriefStart, and the feed
    // that follows can take tens of seconds. Anything collected in that window
    // never reached the gateway, so clearing it would be silent, unrecoverable
    // loss of text the user made by hand — decision 8's refuse-never-evict and
    // decision 9's "clear what left", both at once.
    let all: readonly Passage[] = [{ url: "http://h/b", title: "B", text: "one", at: 5 }];
    const late = { url: "http://h/b", title: "B", text: "two", at: 9 };
    await handleBriefStart(
      deps({
        passages: async () => all,
        // The service worker's wiring, verbatim: remove by identity.
        forgetPassages: async (fed) => {
          for (const { url, ats } of fed) {
            all = ats.reduce((rest, at) => removePassage(rest, url, at), all);
          }
        },
        client: client({
          feedBriefSource: (async () => {
            // The user highlights one more paragraph mid-feed.
            all = [...all, late];
            return { ok: true, received: 1, expected: 1 };
          }) as never,
        }),
      }),
      { kind: "brief-start", question: "q", picks: [{ kind: "passages", url: "http://h/b" }] },
    );
    expect(all).toEqual([late]);
  });

  it("a run that fails before /run forgets nothing", async () => {
    const forgotten: string[] = [];
    await handleBriefStart(
      deps({
        passages: async () => [{ url: "http://h/b", title: "B", text: "one", at: 5 }],
        forgetPassages: async (fed) => {
          forgotten.push(...fed.map((f) => f.url));
        },
        client: client({
          runBrief: (async () => ({ ok: false, reason: "server_error" })) as never,
        }),
      }),
      { kind: "brief-start", question: "q", picks: [{ kind: "passages", url: "http://h/b" }] },
    );
    expect(forgotten).toEqual([]);
  });

  it("a group skipped for run_capacity keeps its passages", async () => {
    const forgotten: string[] = [];
    await handleBriefStart(
      deps({
        passages: async () => [
          { url: "http://h/b", title: "B", text: "one", at: 5 },
          { url: "http://h/c", title: "C", text: "two", at: 6 },
        ],
        forgetPassages: async (fed) => {
          forgotten.push(...fed.map((f) => f.url));
        },
        client: client({
          feedBriefSource: (async (_o: string, _t: string, _id: string, body: { url: string }) =>
            body.url === "http://h/b"
              ? { ok: true, received: 1, expected: 2 }
              : { ok: false, reason: "refused", detail: "run_capacity" }) as never,
        }),
      }),
      {
        kind: "brief-start",
        question: "q",
        picks: [
          { kind: "passages", url: "http://h/b" },
          { kind: "passages", url: "http://h/c" },
        ],
      },
    );
    expect(forgotten).toEqual(["http://h/b"]);
  });

  it("a truncated stitched body keeps the whole group, and still reports the cut", async () => {
    // `buildSourceBody` cuts at the extraction cap. If a stitched body is cut,
    // the trailing passage never reached the gateway — so "clear what left"
    // says keep every one of them. Driven through an OVERSIZED stored group
    // rather than a mocked `buildSourceBody`, because `addPassage` refuses to
    // build one: `isPassage` bounds a stored passage's shape, not its size, so
    // a corrupted, hand-edited or migrated store can still yield this.
    const forgotten: string[] = [];
    const state = await handleBriefStart(
      deps({
        passages: async () => [
          { url: "http://h/b", title: "B", text: "x".repeat(BRIEF_CAPS.extractionCapBytes), at: 5 },
          { url: "http://h/b", title: "B", text: "the tail that never left", at: 6 },
        ],
        forgetPassages: async (fed) => {
          forgotten.push(...fed.map((f) => f.url));
        },
      }),
      { kind: "brief-start", question: "q", picks: [{ kind: "passages", url: "http://h/b" }] },
    );
    expect(forgotten).toEqual([]);
    // Reporting is unchanged: the cut is still named to the user.
    expect(state.kind === "done" && state.truncated).toEqual(["B"]);
  });

  it("a tab picked in whole-page mode keeps that page's passages", async () => {
    // The rule is CLEAR WHAT LEFT. In whole-page mode the page left, not the
    // passages — and whole-page is a choice about one question, not a statement
    // about the collection.
    const forgotten: string[] = [];
    await handleBriefStart(
      deps({
        listTabs: async () => ({
          named: [tab(1, "http://h/b")],
          hiddenCount: 0,
          enumerationFailed: false,
        }),
        passages: async () => [{ url: "http://h/b", title: "B", text: "one", at: 5 }],
        forgetPassages: async (fed) => {
          forgotten.push(...fed.map((f) => f.url));
        },
      }),
      { kind: "brief-start", question: "q", picks: [{ kind: "tab", id: 1 }] },
    );
    expect(forgotten).toEqual([]);
  });
});

describe("handleBriefPoll", () => {
  it("settles a finished run and patches the log with the model", async () => {
    const d = deps();
    await handleBriefStart(d, { ...start, picks: [{ kind: "tab", id: 1 }] });
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
    await handleBriefStart(d, { ...start, picks: [{ kind: "tab", id: 1 }] });
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
    await handleBriefStart(d, { ...start, picks: [{ kind: "tab", id: 1 }] });
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
    await handleBriefStart(d, { ...start, picks: [{ kind: "tab", id: 1 }] });
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
