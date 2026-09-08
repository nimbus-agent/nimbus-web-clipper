// test/unit/item-urls.test.ts
import { describe, expect, it } from "vitest";
import { RESOLVE_IDS_MAX_BATCH, type ResolvedIdRow } from "../../src/background/gateway-client.ts";
import {
  chunkIds,
  QUERY_BYTES_BUDGET,
  type ResolveItemIdsFn,
  resolveItemUrls,
} from "../../src/background/item-urls.ts";

type Call = { readonly ids: readonly string[] };
type Reply =
  | { readonly ok: true; readonly items: readonly ResolvedIdRow[] }
  | { readonly ok: false; readonly reason: "unsupported" | "forbidden" | "failed" };

/** Records every call it receives and answers from `replies`, in order — one
 *  reply per call, reused for any call past the end of the list. */
function fakeResolver(replies: readonly Reply[]): {
  readonly resolveItemIds: ResolveItemIdsFn;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const resolveItemIds: ResolveItemIdsFn = async (_origin, _token, ids) => {
    calls.push({ ids });
    const reply = replies[calls.length - 1] ?? replies[replies.length - 1];
    if (reply === undefined) {
      return { ok: true, items: [] };
    }
    return reply;
  };
  return { resolveItemIds, calls };
}

const DEPS_BASE = { origin: "http://127.0.0.1:7474", token: "tok" };

function row(id: string, url: string | null): ResolvedIdRow {
  return { id, url };
}

describe("chunkIds", () => {
  it("splits 250 unique short ids into 3 chunks of 100/100/50", () => {
    const ids = Array.from({ length: 250 }, (_, i) => `i${i}`);
    const chunks = chunkIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it("never exceeds the route's own count bound in a single chunk", () => {
    const ids = Array.from({ length: 340 }, (_, i) => `i${i}`);
    for (const chunk of chunkIds(ids)) {
      expect(chunk.length).toBeLessThanOrEqual(RESOLVE_IDS_MAX_BATCH);
    }
  });

  it("splits into MORE chunks than the count bound alone would when ids are long — the byte budget binds first", () => {
    // 30-char alphanumeric ids: no percent-encoding, so each contributes
    // exactly "id=" + 30 = 33 bytes, plus one separator byte per join. A
    // count-only chunker would still fit 100 per request (3 chunks for 250
    // ids); the byte budget must bind well before that.
    const ids = Array.from(
      { length: 250 },
      (_, i) => `${String(i).padStart(4, "0")}${"x".repeat(26)}`,
    );
    const chunks = chunkIds(ids);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(RESOLVE_IDS_MAX_BATCH);
    }
  });

  it("attempts a single id whose own bytes bust the budget ALONE, in its own chunk, rather than dropping it", () => {
    const hugeId = "z".repeat(QUERY_BYTES_BUDGET + 500);
    const ids = ["short-1", hugeId, "short-2"];
    const chunks = chunkIds(ids);
    // The oversized id gets a chunk of its own; it is never silently missing.
    expect(chunks.some((c) => c.length === 1 && c[0] === hugeId)).toBe(true);
    expect(chunks.flat()).toEqual(ids);
  });

  it("returns nothing for an empty list", () => {
    expect(chunkIds([])).toEqual([]);
  });
});

describe("resolveItemUrls", () => {
  it("de-duplicates before chunking: repeats collapse into one request", async () => {
    const { resolveItemIds, calls } = fakeResolver([{ ok: true, items: [] }]);
    await resolveItemUrls({ ...DEPS_BASE, resolveItemIds }, ["a", "b", "a", "c", "b"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ids).toEqual(["a", "b", "c"]);
  });

  it("issues one request per chunk and merges every chunk's ok rows into one map", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `i${i}`);
    const { resolveItemIds, calls } = fakeResolver([
      { ok: true, items: [row("i0", "https://x/0")] },
      { ok: true, items: [row("i100", "https://x/100")] },
      { ok: true, items: [row("i200", "https://x/200")] },
    ]);
    const map = await resolveItemUrls({ ...DEPS_BASE, resolveItemIds }, ids);
    expect(calls).toHaveLength(3);
    expect(map).toEqual({
      i0: "https://x/0",
      i100: "https://x/100",
      i200: "https://x/200",
    });
  });

  it("a row with url: null produces no key", async () => {
    const { resolveItemIds } = fakeResolver([{ ok: true, items: [row("i1", null)] }]);
    const map = await resolveItemUrls({ ...DEPS_BASE, resolveItemIds }, ["i1"]);
    expect(map).toEqual({});
  });

  it("an id absent from the response produces no key", async () => {
    const { resolveItemIds } = fakeResolver([{ ok: true, items: [row("i1", "https://x/1")] }]);
    const map = await resolveItemUrls({ ...DEPS_BASE, resolveItemIds }, ["i1", "i2"]);
    expect(map).toEqual({ i1: "https://x/1" });
  });

  it("a 404-derived unsupported on the first chunk short-circuits: no further requests, empty map", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `i${i}`); // 3 chunks worth
    const { resolveItemIds, calls } = fakeResolver([{ ok: false, reason: "unsupported" }]);
    const map = await resolveItemUrls({ ...DEPS_BASE, resolveItemIds }, ids);
    expect(calls).toHaveLength(1); // never touched chunks 2 or 3
    expect(map).toEqual({});
  });

  it("forbidden on the first chunk short-circuits too — permanent for this token, same as unsupported", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `i${i}`);
    const { resolveItemIds, calls } = fakeResolver([{ ok: false, reason: "forbidden" }]);
    const map = await resolveItemUrls({ ...DEPS_BASE, resolveItemIds }, ids);
    expect(calls).toHaveLength(1);
    expect(map).toEqual({});
  });

  it("a failed second chunk keeps the first chunk's results AND still tries the third", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `i${i}`); // 100/100/50
    const { resolveItemIds, calls } = fakeResolver([
      { ok: true, items: [row("i0", "https://x/0")] },
      { ok: false, reason: "failed" },
      { ok: true, items: [row("i200", "https://x/200")] },
    ]);
    const map = await resolveItemUrls({ ...DEPS_BASE, resolveItemIds }, ids);
    expect(calls).toHaveLength(3); // failed chunk did not stop the loop
    expect(map).toEqual({
      i0: "https://x/0",
      i200: "https://x/200",
    });
  });

  it("an empty input never issues a request", async () => {
    const { resolveItemIds, calls } = fakeResolver([{ ok: true, items: [] }]);
    const map = await resolveItemUrls({ ...DEPS_BASE, resolveItemIds }, []);
    expect(calls).toHaveLength(0);
    expect(map).toEqual({});
  });
});
