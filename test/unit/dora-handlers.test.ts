import { describe, expect, test, vi } from "vitest";
import { handleDoraMetrics, handleMetricsStats } from "../../src/background/dora-handlers.ts";
import { DAY_MS } from "../../src/shared/dora.ts";

const conn = { origin: "http://127.0.0.1:8765", token: "secret", label: "Test", pairedAt: 1 };

function deps(status: number, body: unknown) {
  const doFetch = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
  );
  return {
    getConnection: async () => conn,
    doFetch: doFetch as unknown as typeof fetch,
    doFetchMock: doFetch,
  };
}

describe("handleDoraMetrics", () => {
  test("no pairing is not_paired — the remedy is pairing, not checking the gateway", async () => {
    const d = { getConnection: async () => null, doFetch: fetch };
    expect(
      await handleDoraMetrics({ kind: "dora-metrics", serviceId: "web", range: "13w" }, d),
    ).toEqual({ kind: "dora-metrics", ok: false, reason: "not_paired" });
    expect(
      await handleMetricsStats(
        { kind: "metrics-stats", serviceId: "web", range: "13w", metric: "mttr" },
        d,
      ),
    ).toEqual({ kind: "metrics-stats", ok: false, reason: "not_paired" });
  });

  test("never sends the bearer token on the public route", async () => {
    const d = deps(500, {});
    await handleDoraMetrics({ kind: "dora-metrics", serviceId: "web", range: "13w" }, d);
    const init = d.doFetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.stringify(init?.headers ?? {})).not.toContain("secret");
  });
});

describe("handleMetricsStats", () => {
  test("carries the series through on success", async () => {
    const body = {
      metric: "pr-merges",
      service: "web",
      window: { since_ms: 0, until_ms: 91 * DAY_MS },
      bucket_ms: 7 * DAY_MS,
      points: [],
    };
    const res = await handleMetricsStats(
      { kind: "metrics-stats", serviceId: "web", range: "13w", metric: "pr-merges" },
      deps(200, body),
    );
    expect(res).toMatchObject({ kind: "metrics-stats", ok: true, series: { metric: "pr-merges" } });
  });

  test("a 404 is unsupported", async () => {
    const res = await handleMetricsStats(
      { kind: "metrics-stats", serviceId: "web", range: "13w", metric: "mttr" },
      deps(404, {}),
    );
    expect(res).toEqual({ kind: "metrics-stats", ok: false, reason: "unsupported" });
  });
});
