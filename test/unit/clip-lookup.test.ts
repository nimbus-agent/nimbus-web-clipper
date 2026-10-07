// test/unit/clip-lookup.test.ts
//
// Never-clip-twice (roadmap 1.1): the worker's one-read lookup behind the
// popup's "You clipped this …" line. Every failure is `none` — the line is a
// hint, never an error and never a reason to block a clip.
import { describe, expect, test, vi } from "vitest";
import { handleClipLookup } from "../../src/background/handlers.ts";
import type { ResolveOutcome } from "../../src/shared/types.ts";

const conn = { origin: "http://127.0.0.1:8765", token: "secret", label: "Test", pairedAt: 1 };
const PAGE = "https://blog.example.com/posts/readability";

function item(service: string, modifiedAt = 1_760_000_000_000) {
  return { id: "i1", service, type: "web_clip", title: "T", url: PAGE, modifiedAt };
}

function deps(
  answer:
    | { ok: true; outcome: ResolveOutcome }
    | { ok: false; reason: "insufficient_scope" | "unsupported" | "unreachable" },
  connected = true,
) {
  const resolveItem = vi.fn(async () => answer);
  return { getConnection: async () => (connected ? conn : null), resolveItem };
}

const lookup = (pageUrl = PAGE) => ({ kind: "clip-lookup" as const, pageUrl });

describe("handleClipLookup", () => {
  test("a clip of this page is `clipped`, with when it was saved", async () => {
    const d = deps({
      ok: true,
      outcome: { kind: "found", item: item("nimbus", 42), matchKind: "exact" },
    });
    expect(await handleClipLookup(d, lookup())).toEqual({
      kind: "clip-lookup",
      state: "clipped",
      modifiedAt: 42,
    });
    expect(d.resolveItem).toHaveBeenCalledWith(conn.origin, conn.token, PAGE);
  });

  test("an item a connector indexed is `indexed`, naming its service", async () => {
    const d = deps({
      ok: true,
      outcome: { kind: "found", item: item("github", 7), matchKind: "exact" },
    });
    expect(await handleClipLookup(d, lookup())).toEqual({
      kind: "clip-lookup",
      state: "indexed",
      service: "github",
      modifiedAt: 7,
    });
  });

  test.each([
    ["a miss", { ok: true, outcome: { kind: "not-indexed", fetchable: false } }],
    [
      "an ambiguous match",
      {
        ok: true,
        outcome: { kind: "ambiguous", fetchable: false, candidates: [], truncated: true },
      },
    ],
    ["a token without the resolve scope", { ok: false, reason: "insufficient_scope" }],
    ["a gateway without the route", { ok: false, reason: "unsupported" }],
    ["an unreachable gateway", { ok: false, reason: "unreachable" }],
  ] as const)("%s is `none`", async (_name, answer) => {
    expect(await handleClipLookup(deps(answer), lookup())).toEqual({
      kind: "clip-lookup",
      state: "none",
    });
  });

  test("an unpaired browser asks nothing", async () => {
    const d = deps({ ok: false, reason: "unreachable" }, false);
    expect(await handleClipLookup(d, lookup())).toEqual({ kind: "clip-lookup", state: "none" });
    expect(d.resolveItem).not.toHaveBeenCalled();
  });

  test("a page that is not http(s) asks nothing", async () => {
    const d = deps({ ok: false, reason: "unreachable" });
    for (const url of [
      "chrome://extensions/",
      "about:blank",
      "file:///C:/notes.html",
      "not a url",
    ]) {
      expect(await handleClipLookup(d, lookup(url))).toEqual({
        kind: "clip-lookup",
        state: "none",
      });
    }
    expect(d.resolveItem).not.toHaveBeenCalled();
  });

  test("a resolve that throws is `none`, never a rejection", async () => {
    const d = {
      getConnection: async () => conn,
      resolveItem: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    expect(await handleClipLookup(d, lookup())).toEqual({ kind: "clip-lookup", state: "none" });
  });
});
