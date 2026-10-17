import { describe, expect, it } from "vitest";
import {
  enterAction,
  filterRows,
  type PaletteInput,
  type PaletteRow,
  type PaletteState,
  paletteRows,
  reducePalette,
} from "../../src/palette/palette-view.ts";
import type { LaneContext } from "../../src/panel/lane-input.ts";
import { termStateFrom } from "../../src/panel/lane-input.ts";
import type { HeaderState } from "../../src/panel/panel-view.ts";
import type { Recognition, SurfaceKind } from "../../src/shared/types.ts";

function rec(kind: SurfaceKind, extra: { scope?: string; origin?: string } = {}): Recognition {
  return {
    ok: true,
    product: "github",
    kind,
    label: "x",
    ref: "r",
    resolveUrl: "https://example.test/x",
    ...extra,
  } as Recognition;
}
const PR = rec("pr", { scope: "acme/web", origin: "https://github.com" });
const BUILD = rec("build", { scope: "acme/web", origin: "https://ci.test" });
const HOME = rec("home");
const ISSUE = rec("issue");
const NONE: Recognition = { ok: false, reason: "unknown-host" };

function ctx(over: Partial<LaneContext> = {}): LaneContext {
  return {
    surfaceKind: "pr",
    pageSubject: true,
    pickedItemId: null,
    term: { kind: "none" },
    offered: null,
    connectorHealthy: true,
    ...over,
  };
}
const CAND = { id: "i1", service: "github", type: "pr", title: "t", url: null };
const AMBIG: HeaderState = {
  kind: "ambiguous",
  surface: "PR",
  candidates: [CAND],
  truncated: false,
} as HeaderState;
const TRUNC: HeaderState = { ...AMBIG, candidates: [], truncated: true } as HeaderState;
const NOT_INDEXED = {
  kind: "not-indexed",
  surface: "PR",
  product: "github",
  fetchable: true,
} as HeaderState;
const OK_HEADER = { kind: "loading" } as HeaderState;

function input(
  recognition: Recognition,
  resolved: PaletteInput["resolved"],
  selectionText = "",
): PaletteInput {
  return { recognition, selectionText, resolved };
}
const ids = (rows: readonly PaletteRow[]) => rows.map((r) => r.id);
const pending = { kind: "pending" } as const;
const done = (c: LaneContext, header: HeaderState = OK_HEADER) =>
  ({ kind: "done", ctx: c, header }) as const;

describe("paletteRows ordering and instant rows", () => {
  it("pr under pending", () => {
    expect(ids(paletteRows(input(PR, pending)))).toEqual([
      "status",
      "deploy",
      "related",
      "clip-page",
      "clip-selection",
    ]);
    expect(paletteRows(input(PR, pending))[0]?.title).toBe("Looking up this page…");
  });
  it("build has deploy; home has no related and no deploy; issue and unrecognised have related only", () => {
    expect(ids(paletteRows(input(BUILD, pending)))).toContain("deploy");
    expect(ids(paletteRows(input(HOME, pending)))).toEqual([
      "status",
      "clip-page",
      "clip-selection",
    ]);
    expect(ids(paletteRows(input(ISSUE, pending)))).toEqual([
      "status",
      "related",
      "clip-page",
      "clip-selection",
    ]);
    expect(ids(paletteRows(input(NONE, pending)))).toEqual([
      "status",
      "related",
      "clip-page",
      "clip-selection",
    ]);
  });
  it("deploy needs scope and origin", () => {
    expect(ids(paletteRows(input(rec("pr"), pending)))).not.toContain("deploy");
  });
  it("clip selection is disabled with a hint when nothing is selected, enabled otherwise", () => {
    const off = paletteRows(input(PR, pending)).find((r) => r.id === "clip-selection");
    expect(off).toMatchObject({ enabled: false, hint: "Select some text first", action: null });
    const on = paletteRows(input(PR, pending, "hi")).find((r) => r.id === "clip-selection");
    expect(on).toMatchObject({
      enabled: true,
      action: { kind: "quick-clip", mode: "selection" },
    });
  });
  it("lane rows come before deploy and keep AGENT_LANES order", () => {
    const rows = paletteRows(input(PR, done(ctx())));
    const order = ids(rows);
    expect(order.slice(0, -4).every((i) => i.startsWith("lane:"))).toBe(true);
    expect(order.slice(-4)).toEqual(["deploy", "related", "clip-page", "clip-selection"]);
    expect(rows.find((r) => r.id === "lane:expert")?.action).toEqual({
      kind: "intent",
      intent: { kind: "lane", lane: "expert" },
    });
  });
});

describe("only-grow", () => {
  const fixtures: PaletteInput["resolved"][] = [
    done(ctx()),
    done(ctx({ pageSubject: false }), AMBIG),
    done(ctx({ pageSubject: false }), TRUNC),
    done(ctx({ pageSubject: false }), NOT_INDEXED),
    { kind: "failed" },
  ];
  for (const [name, r] of [
    ["pr", PR],
    ["build", BUILD],
    ["home", HOME],
    ["issue", ISSUE],
    ["none", NONE],
  ] as const) {
    it(`${name}: every instant row survives every resolve outcome`, () => {
      const instant = ids(paletteRows(input(r, pending))).filter((i) => i !== "status");
      for (const f of fixtures) {
        const after = ids(paletteRows(input(r, f, "word")));
        for (const i of instant) {
          expect(after).toContain(i);
        }
        expect(after.filter((i) => i === "status").length).toBeLessThanOrEqual(1);
      }
    });
  }
});

describe("the resolve-state table", () => {
  it("ambiguous with a pick gets a candidates row", () => {
    const row = paletteRows(input(PR, done(ctx({ pageSubject: false }), AMBIG))).find(
      (r) => r.id === "candidates",
    );
    expect(row).toMatchObject({
      title: "Pick the item in the panel",
      enabled: true,
      action: { kind: "intent", intent: { kind: "candidates" } },
    });
  });
  it("truncated ambiguous: no pick row, a disabled Too many matches row", () => {
    const rows = paletteRows(input(PR, done(ctx({ pageSubject: false }), TRUNC)));
    expect(ids(rows)).not.toContain("candidates");
    const s = rows.find((r) => r.id === "status");
    expect(s?.enabled).toBe(false);
    expect(s?.title).toMatch(/^Too many matches/);
  });
  it("not-indexed gives a disabled Not indexed. row", () => {
    const s = paletteRows(input(PR, done(ctx({ pageSubject: false }), NOT_INDEXED))).find(
      (r) => r.id === "status",
    );
    expect(s).toMatchObject({ title: "Not indexed.", enabled: false, action: null });
  });
  it("file miss shows the banner; file without a banner shows nothing", () => {
    const miss = { kind: "file", surface: "F", banner: "Not in your checkout." } as HeaderState;
    const rows = paletteRows(input(PR, done(ctx({ pageSubject: false }), miss)));
    expect(rows.find((r) => r.id === "status")?.title).toBe("Not in your checkout.");
    const quiet = { kind: "file", surface: "F" } as HeaderState;
    expect(ids(paletteRows(input(PR, done(ctx({ pageSubject: false }), quiet))))).not.toContain(
      "status",
    );
  });
  it("error and needs-scope give their sentence", () => {
    const err = { kind: "error", surface: null, message: "Gateway down." } as HeaderState;
    expect(
      paletteRows(input(PR, done(ctx({ pageSubject: false }), err))).find((r) => r.id === "status")
        ?.title,
    ).toBe("Gateway down.");
    const scope = { kind: "needs-scope", surface: "PR", scopeGap: null } as HeaderState;
    expect(
      paletteRows(input(PR, done(ctx({ pageSubject: false }), scope))).find(
        (r) => r.id === "status",
      )?.title,
    ).toBe("This pairing can't resolve pages yet.");
  });
  it("resolved gives no extra row; failed gives the connect sentence", () => {
    expect(ids(paletteRows(input(PR, done(ctx()))))).not.toContain("status");
    const failed = paletteRows(input(PR, { kind: "failed" }));
    expect(failed[0]).toMatchObject({
      id: "status",
      title: "Couldn't connect to Nimbus.",
      enabled: false,
    });
  });
  it("home with an unhealthy connector shows no lanes", () => {
    const rows = paletteRows(
      input(HOME, done(ctx({ surfaceKind: "home", connectorHealthy: false }))),
    );
    expect(ids(rows).some((i) => i.startsWith("lane:"))).toBe(false);
  });
});

describe("glossary", () => {
  it("is a selection/define intent carrying the selection text", () => {
    const rows = paletteRows(
      input(
        NONE,
        done(ctx({ surfaceKind: null, pageSubject: false, term: termStateFrom("zk") }), OK_HEADER),
        "zk",
      ),
    );
    const g = rows.find((r) => r.id === "lane:glossary");
    expect(g?.action).toEqual({
      kind: "intent",
      intent: { kind: "selection", text: "zk", intent: "define" },
    });
  });
  it("a too-long term is disabled with the refusal as its hint", () => {
    const long = "word ".repeat(60);
    const rows = paletteRows(
      input(
        NONE,
        done(ctx({ surfaceKind: null, pageSubject: false, term: termStateFrom(long) })),
        long,
      ),
    );
    const g = rows.find((r) => r.id === "lane:glossary");
    expect(g).toMatchObject({ enabled: false, action: null });
    expect(g?.hint).toMatch(/passage, not a term/);
  });
});

describe("filterRows", () => {
  const rows = paletteRows(input(PR, done(ctx())));
  it("trims and ignores case", () => {
    expect(ids(filterRows(rows, "  WHO "))).toContain("lane:expert");
  });
  it("a miss leaves one disabled No matching actions row", () => {
    const out = filterRows(rows, "zzz");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "No matching actions", enabled: false });
  });
  it("an empty filter keeps everything", () => {
    expect(filterRows(rows, "   ")).toBe(rows);
  });
});

describe("reducePalette", () => {
  const rows = paletteRows(input(PR, done(ctx())));
  const first = rows.find((r) => r.enabled)?.id ?? null;
  const fresh: PaletteState = { filter: "", activeId: null, touched: false };

  it("rows-changed lands on the first enabled row", () => {
    expect(reducePalette(fresh, { kind: "rows-changed" }, rows).activeId).toBe(first);
  });
  it("an untouched active row moves to the first lane when lanes arrive", () => {
    const early = paletteRows(input(PR, pending));
    const s = reducePalette(fresh, { kind: "rows-changed" }, early);
    expect(s.activeId).toBe("deploy");
    expect(reducePalette(s, { kind: "rows-changed" }, rows).activeId).toBe(first);
  });
  it("a touched active row stays", () => {
    const early = paletteRows(input(PR, pending));
    const s = reducePalette(
      reducePalette(fresh, { kind: "rows-changed" }, early),
      { kind: "move", delta: 1 },
      early,
    );
    expect(s.touched).toBe(true);
    expect(reducePalette(s, { kind: "rows-changed" }, rows).activeId).toBe(s.activeId);
  });
  it("move wraps and skips disabled rows", () => {
    const small = paletteRows(input(HOME, pending));
    // enabled: clip-page only
    const s0 = reducePalette(fresh, { kind: "rows-changed" }, small);
    expect(s0.activeId).toBe("clip-page");
    expect(reducePalette(s0, { kind: "move", delta: 1 }, small).activeId).toBe("clip-page");
    const wide = paletteRows(input(HOME, pending, "x"));
    const a = reducePalette(s0, { kind: "move", delta: 1 }, wide);
    expect(a.activeId).toBe("clip-selection");
    expect(reducePalette(a, { kind: "move", delta: 1 }, wide).activeId).toBe("clip-page");
    expect(reducePalette(s0, { kind: "move", delta: -1 }, wide).activeId).toBe("clip-selection");
  });
  it("move skips rows the filter hides", () => {
    const s = reducePalette(
      { filter: "clip", activeId: "clip-page", touched: true },
      { kind: "move", delta: 1 },
      paletteRows(input(PR, pending, "x")),
    );
    expect(s.activeId).toBe("clip-selection");
  });
  it("typing who with deploy active lands on the expert lane, and Enter runs it", () => {
    const s = reducePalette(
      { filter: "", activeId: "deploy", touched: false },
      { kind: "type", filter: "who" },
      rows,
    );
    expect(s.activeId).toBe("lane:expert");
    expect(enterAction(s, rows, false)).toEqual({
      kind: "intent",
      intent: { kind: "lane", lane: "expert" },
    });
  });
  it("typing keeps the active row when it still matches", () => {
    const s = reducePalette(
      { filter: "", activeId: "lane:expert", touched: true },
      { kind: "type", filter: "who" },
      rows,
    );
    expect(s.activeId).toBe("lane:expert");
  });
  it("a zero-match filter clears the active row", () => {
    const s = reducePalette(
      { filter: "", activeId: "deploy", touched: false },
      { kind: "type", filter: "zzz" },
      rows,
    );
    expect(s).toMatchObject({ activeId: null, touched: true });
    expect(enterAction(s, rows, false)).toBeNull();
  });
});

describe("enterAction", () => {
  const rows = paletteRows(input(PR, done(ctx()), ""));
  it("is null while composing", () => {
    expect(enterAction({ filter: "", activeId: "deploy", touched: true }, rows, true)).toBeNull();
  });
  it("is null with no active row or a disabled one", () => {
    expect(enterAction({ filter: "", activeId: null, touched: false }, rows, false)).toBeNull();
    expect(
      enterAction({ filter: "", activeId: "clip-selection", touched: true }, rows, false),
    ).toBeNull();
  });
  it("runs an enabled row", () => {
    expect(enterAction({ filter: "", activeId: "clip-page", touched: true }, rows, false)).toEqual({
      kind: "quick-clip",
      mode: "article",
    });
  });
});
