// test/unit/http-json.test.ts
// The helpers every gateway client shares, tested directly. Each client's own
// suite still drives them through its routes; these pin the helpers' own
// contracts, so a change to one shows up here before it shows up as eight
// routes failing at once.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseScopeGap,
  readJson,
  scopedGet,
  scopedRouteFailure,
  scopeRefusal,
  withLabel,
  withTimeout,
} from "../../src/background/http-json.ts";

const READ_URL = "http://127.0.0.1:7474/v1/egress";
const TOKEN = "tok-abc";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A 200 whose headers arrive at once and whose body never finishes — unless the
 *  request's own signal aborts it, the way a real `fetch` errors the stream. */
function hangingBody(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"rows":'));
      signal?.addEventListener("abort", () => {
        controller.error(new DOMException("aborted", "AbortError"));
      });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("resolves with the exchange's value and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const out = await withTimeout(1_000, async () => "done");
    expect(out).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the signal once the timeout elapses, and not before", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const p = withTimeout(
      1_000,
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          seen = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const settled = p.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(999);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen?.aborted).toBe(true);
    expect(await settled).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when the exchange rejects on its own", async () => {
    vi.useFakeTimers();
    await expect(
      withTimeout(1_000, async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when the exchange throws synchronously", async () => {
    vi.useFakeTimers();
    await expect(
      withTimeout(1_000, () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("readJson", () => {
  it("returns the parsed body", async () => {
    expect(await readJson(jsonResponse(200, { a: 1 }))).toEqual({ a: 1 });
  });

  it("returns null for a body that is not JSON, rather than throwing", async () => {
    expect(await readJson(new Response("<html>proxy error</html>", { status: 502 }))).toBeNull();
  });
});

describe("parseScopeGap", () => {
  it("accepts exactly the gateway's detail", () => {
    expect(parseScopeGap({ required: "egress", granted: ["clip", "briefs"] })).toEqual({
      required: "egress",
      granted: ["clip", "briefs"],
    });
  });

  it.each([
    ["a missing required", { granted: ["clip"] }],
    ["a non-array granted", { required: "egress", granted: "clip" }],
    ["a non-string granted member", { required: "egress", granted: ["clip", 7] }],
    ["null", null],
  ])("refuses %s — a partial gap would build a command that revokes scopes", (_name, body) => {
    expect(parseScopeGap(body)).toBeNull();
  });
});

describe("withLabel", () => {
  it("attaches the device label to the raw gap", () => {
    expect(withLabel("laptop", { required: "egress", granted: ["clip"] })).toEqual({
      label: "laptop",
      required: "egress",
      granted: ["clip"],
    });
  });

  it("leaves an absent gap absent — never a fabricated one", () => {
    expect(withLabel("laptop", undefined)).toBeUndefined();
  });
});

describe("scopeRefusal", () => {
  it("carries the gap when the 403 body is the gateway's detail", async () => {
    const res = jsonResponse(403, {
      error: "insufficient_scope",
      required: "resolve",
      granted: ["clip"],
    });
    expect(await scopeRefusal(res)).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { required: "resolve", granted: ["clip"] },
    });
  });

  it("omits the gap — the key itself, not just its value — for a malformed body", async () => {
    const out = await scopeRefusal(jsonResponse(403, { error: "insufficient_scope" }));
    expect(out).toEqual({ ok: false, reason: "insufficient_scope" });
    expect("scopeGap" in out).toBe(false);
  });

  it("omits the gap for a body that is not JSON", async () => {
    const out = await scopeRefusal(new Response("forbidden", { status: 403 }));
    expect(out).toEqual({ ok: false, reason: "insufficient_scope" });
  });
});

describe("scopedRouteFailure", () => {
  it.each([
    [401, { ok: false, reason: "unauthorized" }],
    [404, { ok: false, reason: "unsupported" }],
    [500, { ok: false, reason: "server_error" }],
    [418, { ok: false, reason: "server_error" }],
    // Not this ladder's to name: a route with its own 429 meaning (an invoke's
    // `busy`, a scoped read's `rate_limited`) checks it before calling here.
    [429, { ok: false, reason: "server_error" }],
  ])("maps %i", async (status, expected) => {
    expect(await scopedRouteFailure(new Response("", { status }))).toEqual(expected);
  });

  it("maps 403 through scopeRefusal, gap and all", async () => {
    const res = jsonResponse(403, { required: "agents", granted: ["clip", "briefs"] });
    expect(await scopedRouteFailure(res)).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { required: "agents", granted: ["clip", "briefs"] },
    });
  });
});

describe("scopedGet", () => {
  const parseCount = (body: unknown): number | null =>
    typeof body === "object" && body !== null && typeof (body as { n?: unknown }).n === "number"
      ? (body as { n: number }).n
      : null;

  it("sends one bearer GET to the URL it is given", async () => {
    const doFetch = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { n: 3 }));
    const out = await scopedGet(READ_URL, TOKEN, 1_000, parseCount, doFetch);
    expect(out).toEqual({ ok: true, value: 3 });
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0] ?? [];
    expect(url).toBe(READ_URL);
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a 200 the parser rejects as server_error, never a default", async () => {
    const out = await scopedGet(READ_URL, TOKEN, 1_000, parseCount, async () =>
      jsonResponse(200, { n: "three" }),
    );
    expect(out).toEqual({ ok: false, reason: "server_error" });
  });

  it("maps a thrown fetch to unreachable", async () => {
    const out = await scopedGet(READ_URL, TOKEN, 1_000, parseCount, async () => {
      throw new TypeError("connection refused");
    });
    expect(out).toEqual({ ok: false, reason: "unreachable" });
  });

  it("maps 429 to rate_limited", async () => {
    const out = await scopedGet(READ_URL, TOKEN, 1_000, parseCount, async () =>
      jsonResponse(429, {}, { "retry-after": "5" }),
    );
    expect(out).toEqual({ ok: false, reason: "rate_limited" });
  });

  it.each([
    [401, { ok: false, reason: "unauthorized" }],
    [404, { ok: false, reason: "unsupported" }],
    [503, { ok: false, reason: "server_error" }],
  ])("falls through to the shared ladder for %i", async (status, expected) => {
    const out = await scopedGet(READ_URL, TOKEN, 1_000, parseCount, async () =>
      jsonResponse(status, {}),
    );
    expect(out).toEqual(expected);
  });

  it("carries the 403's scope gap", async () => {
    const out = await scopedGet(READ_URL, TOKEN, 1_000, parseCount, async () =>
      jsonResponse(403, { required: "egress", granted: ["clip"] }),
    );
    expect(out).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { required: "egress", granted: ["clip"] },
    });
  });

  it("keeps the timer armed across the BODY read: a 200 that hangs its body is cut off", async () => {
    vi.useFakeTimers();
    const p = scopedGet(READ_URL, TOKEN, 1_000, parseCount, async (_url, init) =>
      hangingBody(init?.signal),
    );
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // The aborted body reads as no body, which the parser rejects.
    expect(await p).toEqual({ ok: false, reason: "server_error" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
