// test/unit/deploy-handlers.test.ts
import { describe, expect, test, vi } from "vitest";
import type { DeployDeps } from "../../src/background/deploy-handlers.ts";
import {
  handleDeployPreflight,
  handleServiceBind,
  handleServiceUnbind,
} from "../../src/background/deploy-handlers.ts";
import type { ServiceBinding } from "../../src/shared/services.ts";

const envelope = (over: Record<string, unknown> = {}) => ({
  service: "web",
  target_ref: "main",
  computed_at: "2026-09-10T00:00:00.000Z",
  verdict: "ok",
  checks: {
    active_p1_incidents: { count: 0, findings: [], gap: null },
    failing_ci_runs: { count: 0, findings: [], gap: null },
    merge_conflicts: { count: 0, findings: [], gap: null },
  },
  ...over,
});

const unknownEnvelope = envelope({
  verdict: "warn",
  checks: {
    active_p1_incidents: { count: 0, findings: [], gap: "unknown_service" },
    failing_ci_runs: { count: 0, findings: [], gap: "unknown_service" },
    merge_conflicts: { count: 0, findings: [], gap: "unknown_service" },
  },
});

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const deps = (over: Partial<DeployDeps> = {}): DeployDeps => ({
  getOrigin: async () => "http://127.0.0.1:7474",
  getBindings: async () => [] as ServiceBinding[],
  putBinding: vi.fn(async () => undefined),
  dropBinding: vi.fn(async () => undefined),
  doFetch: (async () => jsonRes(envelope())) as unknown as typeof fetch,
  ...over,
});

const req = { kind: "deploy-preflight", product: "github", scope: "acme/web" } as const;

describe("handleDeployPreflight", () => {
  test("an unbound scope refuses with the slug guess as the seed", async () => {
    const r = await handleDeployPreflight(req, deps());
    expect(r).toEqual({
      kind: "deploy-preflight",
      ok: false,
      reason: "unbound",
      guessServiceId: "web",
    });
  });

  test("no paired gateway origin is unreachable, not unbound", async () => {
    const r = await handleDeployPreflight(req, deps({ getOrigin: async () => null }));
    expect(r).toEqual({ kind: "deploy-preflight", ok: false, reason: "unreachable" });
  });

  test("a bound scope sends the resolved item's branch as target_ref", async () => {
    const doFetch = vi.fn(async (url: string) =>
      url.includes("/v1/items/")
        ? jsonRes({ data: { id: "i1", metadata: { branch: "feat/x" } } })
        : jsonRes(envelope()),
    );
    const r = await handleDeployPreflight(
      { ...req, itemId: "i1" },
      deps({
        getBindings: async () => [{ product: "github", scope: "acme/web", serviceId: "web" }],
        doFetch: doFetch as unknown as typeof fetch,
      }),
    );
    expect(r.ok).toBe(true);
    const preflightCall = doFetch.mock.calls
      .map((c) => c[0] as string)
      .find((u) => u.includes("/v1/preflight/deploy"));
    expect(preflightCall).toContain("target_ref=feat%2Fx");
  });

  test("falls back to defaultBranch when the item carries no branch", async () => {
    const doFetch = vi.fn(async (url: string) =>
      url.includes("/v1/items/")
        ? jsonRes({ data: { id: "i1", metadata: {} } })
        : jsonRes(envelope()),
    );
    await handleDeployPreflight(
      { ...req, itemId: "i1" },
      deps({
        getBindings: async () => [
          { product: "github", scope: "acme/web", serviceId: "web", defaultBranch: "release" },
        ],
        doFetch: doFetch as unknown as typeof fetch,
      }),
    );
    const preflightCall = doFetch.mock.calls
      .map((c) => c[0] as string)
      .find((u) => u.includes("/v1/preflight/deploy"));
    expect(preflightCall).toContain("target_ref=release");
  });

  test("with neither branch nor defaultBranch it still asks — two checks answer regardless", async () => {
    const doFetch = vi.fn(async () => jsonRes(envelope()));
    const r = await handleDeployPreflight(
      req,
      deps({
        getBindings: async () => [{ product: "github", scope: "acme/web", serviceId: "web" }],
        doFetch: doFetch as unknown as typeof fetch,
      }),
    );
    expect(r.ok).toBe(true);
    expect(doFetch).toHaveBeenCalled();
  });

  test("the item read failing does not fail the whole answer", async () => {
    const doFetch = vi.fn(async (url: string) =>
      url.includes("/v1/items/") ? new Response("", { status: 500 }) : jsonRes(envelope()),
    );
    const r = await handleDeployPreflight(
      { ...req, itemId: "i1" },
      deps({
        getBindings: async () => [{ product: "github", scope: "acme/web", serviceId: "web" }],
        doFetch: doFetch as unknown as typeof fetch,
      }),
    );
    expect(r.ok).toBe(true);
  });

  // The regression this case exists to prevent: with no itemId on the request,
  // rung 1 is unreachable, and the ladder must not pretend it ran. No
  // /v1/items read may be attempted at all.
  test("no itemId means no item read — the ladder starts at defaultBranch", async () => {
    const doFetch = vi.fn(async (_url: string) => jsonRes(envelope()));
    await handleDeployPreflight(
      req,
      deps({
        getBindings: async () => [
          { product: "github", scope: "acme/web", serviceId: "web", defaultBranch: "release" },
        ],
        doFetch: doFetch as unknown as typeof fetch,
      }),
    );
    const urls = doFetch.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/v1/items/"))).toBe(false);
    expect(urls.find((u) => u.includes("/v1/preflight/deploy"))).toContain("target_ref=release");
  });
});

describe("handleServiceBind", () => {
  const bindReq = {
    kind: "service-bind",
    binding: { product: "github", scope: "acme/web", serviceId: "web" },
  } as const;

  test("saves a binding the gateway recognises", async () => {
    const putBinding = vi.fn(async () => undefined);
    const r = await handleServiceBind(bindReq, deps({ putBinding }));
    expect(r).toEqual({ kind: "service-bind", ok: true });
    expect(putBinding).toHaveBeenCalledWith(bindReq.binding);
  });

  test("refuses — and does NOT save — an id the gateway has never heard of", async () => {
    const putBinding = vi.fn(async () => undefined);
    const r = await handleServiceBind(
      bindReq,
      deps({
        putBinding,
        doFetch: (async () => jsonRes(unknownEnvelope)) as unknown as typeof fetch,
      }),
    );
    expect(r).toEqual({ kind: "service-bind", ok: false, reason: "unknown_service" });
    expect(putBinding).not.toHaveBeenCalled();
  });

  test("SAVES a service that exists but has no repos bound — a different problem", async () => {
    const putBinding = vi.fn(async () => undefined);
    const noRepos = envelope({
      verdict: "warn",
      checks: {
        active_p1_incidents: { count: 0, findings: [], gap: "no_pagerduty_mapping" },
        failing_ci_runs: { count: 0, findings: [], gap: "no_repos" },
        merge_conflicts: { count: 0, findings: [], gap: "no_repos" },
      },
    });
    const r = await handleServiceBind(
      bindReq,
      deps({ putBinding, doFetch: (async () => jsonRes(noRepos)) as unknown as typeof fetch }),
    );
    expect(r).toEqual({ kind: "service-bind", ok: true });
    expect(putBinding).toHaveBeenCalled();
  });

  test("an unreachable gateway does not save a binding it could not check", async () => {
    const putBinding = vi.fn(async () => undefined);
    const r = await handleServiceBind(
      bindReq,
      deps({
        putBinding,
        doFetch: (async () => {
          throw new TypeError("failed to fetch");
        }) as unknown as typeof fetch,
      }),
    );
    expect(r).toEqual({ kind: "service-bind", ok: false, reason: "unreachable" });
    expect(putBinding).not.toHaveBeenCalled();
  });
});

describe("handleServiceUnbind", () => {
  test("drops the named binding", async () => {
    const dropBinding = vi.fn(async () => undefined);
    const r = await handleServiceUnbind(
      { kind: "service-unbind", product: "github", scope: "acme/web" },
      deps({ dropBinding }),
    );
    expect(r).toEqual({ kind: "service-bind", ok: true });
    expect(dropBinding).toHaveBeenCalledWith("github", "acme/web");
  });
});
