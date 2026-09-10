// @vitest-environment jsdom
// test/unit/deploy-section.test.ts
import { describe, expect, test, vi } from "vitest";
import {
  deployBelongsOnSurface,
  mountDeploySection,
} from "../../src/panel/deploy/deploy-section.ts";

const okEnvelope = {
  service: "web",
  target_ref: "main",
  computed_at: "2026-09-10T00:00:00.000Z",
  verdict: "ok",
  checks: {
    active_p1_incidents: { count: 0, findings: [], gap: null },
    failing_ci_runs: { count: 0, findings: [], gap: null },
    merge_conflicts: { count: 0, findings: [], gap: null },
  },
};

const ctx = { product: "github", scope: "acme/web", kind: "pr", itemId: "i1" } as const;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("deployBelongsOnSurface", () => {
  test("pr and build only", () => {
    expect(deployBelongsOnSurface("pr")).toBe(true);
    expect(deployBelongsOnSurface("build")).toBe(true);
  });
  // home has NO scope at all (homeMatch's ref is ""), so there is nothing to
  // key a binding by. file has both coordinates and is excluded on judgment.
  test("home, file, issue, doc and incident are excluded", () => {
    for (const k of ["home", "file", "issue", "doc", "incident"] as const) {
      expect(deployBelongsOnSurface(k), k).toBe(false);
    }
  });
});

describe("mountDeploySection", () => {
  test("renders the verdict once the worker answers", async () => {
    const host = document.createElement("div");
    const send = vi.fn(async () => ({
      kind: "deploy-preflight",
      ok: true,
      serviceId: "web",
      preflight: okEnvelope,
    }));
    mountDeploySection(host, ctx, send);
    await flush();
    expect(host.textContent).toMatch(/Clear to deploy web/);
  });

  test("an unbound scope shows the bind form seeded with the guess", async () => {
    const host = document.createElement("div");
    const send = vi.fn(async () => ({
      kind: "deploy-preflight",
      ok: false,
      reason: "unbound",
      guessServiceId: "web",
    }));
    mountDeploySection(host, ctx, send);
    await flush();
    const input = host.querySelector("input");
    expect(input?.value).toBe("web");
  });

  test("submitting the form binds, then re-asks without a page refresh", async () => {
    const host = document.createElement("div");
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "deploy-preflight",
        ok: false,
        reason: "unbound",
        guessServiceId: "web",
      })
      .mockResolvedValueOnce({ kind: "service-bind", ok: true })
      .mockResolvedValueOnce({
        kind: "deploy-preflight",
        ok: true,
        serviceId: "web",
        preflight: okEnvelope,
      });
    mountDeploySection(host, ctx, send);
    await flush();
    host.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    await flush();
    expect(send).toHaveBeenNthCalledWith(2, {
      kind: "service-bind",
      binding: { product: "github", scope: "acme/web", serviceId: "web" },
    });
    expect(host.textContent).toMatch(/Clear to deploy web/);
  });

  test("a refused bind names the config block and keeps the form", async () => {
    const host = document.createElement("div");
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "deploy-preflight",
        ok: false,
        reason: "unbound",
        guessServiceId: "nope",
      })
      .mockResolvedValueOnce({ kind: "service-bind", ok: false, reason: "unknown_service" });
    mountDeploySection(host, ctx, send);
    await flush();
    host.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(host.textContent).toContain("[metrics.dora.");
    expect(host.querySelector("form")).not.toBeNull();
  });

  test("an unreachable gateway says so and renders no verdict", async () => {
    const host = document.createElement("div");
    const send = vi.fn(async () => ({
      kind: "deploy-preflight",
      ok: false,
      reason: "unreachable",
    }));
    mountDeploySection(host, ctx, send);
    await flush();
    expect(host.textContent).toMatch(/could not reach/i);
  });

  test("passes the panel's resolved item id through to the worker", async () => {
    const host = document.createElement("div");
    const send = vi.fn(async () => ({
      kind: "deploy-preflight",
      ok: true,
      serviceId: "web",
      preflight: okEnvelope,
    }));
    mountDeploySection(host, ctx, send);
    await flush();
    expect(send).toHaveBeenCalledWith({
      kind: "deploy-preflight",
      product: "github",
      scope: "acme/web",
      itemId: "i1",
    });
  });

  // paint() runs on every ambient tick, related load and lane transition. A
  // section that re-asked on each one would fire redundant requests and, worse,
  // wipe out whatever the user was typing into the bind input.
  test("re-mounting with an unchanged ctx does not re-ask", async () => {
    const host = document.createElement("div");
    const send = vi.fn(async () => ({
      kind: "deploy-preflight",
      ok: true,
      serviceId: "web",
      preflight: okEnvelope,
    }));
    mountDeploySection(host, ctx, send);
    await flush();
    mountDeploySection(host, ctx, send);
    mountDeploySection(host, ctx, send);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("re-mounting with a changed scope DOES re-ask", async () => {
    const host = document.createElement("div");
    const send = vi.fn(async () => ({
      kind: "deploy-preflight",
      ok: true,
      serviceId: "web",
      preflight: okEnvelope,
    }));
    mountDeploySection(host, ctx, send);
    await flush();
    mountDeploySection(host, { ...ctx, scope: "acme/other" }, send);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("a repaint does not clobber half-typed input in the bind form", async () => {
    const host = document.createElement("div");
    const send = vi.fn(async () => ({
      kind: "deploy-preflight",
      ok: false,
      reason: "unbound",
      guessServiceId: "web",
    }));
    mountDeploySection(host, ctx, send);
    await flush();
    const input = host.querySelector("input");
    if (input !== null) input.value = "payments-api";
    mountDeploySection(host, ctx, send);
    await flush();
    expect(host.querySelector("input")?.value).toBe("payments-api");
  });

  test("a response that fails its guard is treated as malformed, not rendered", async () => {
    const host = document.createElement("div");
    const send = vi.fn(async () => ({ kind: "deploy-preflight", ok: true, serviceId: "web" }));
    mountDeploySection(host, ctx, send);
    await flush();
    expect(host.textContent).not.toMatch(/Clear to deploy/);
  });
});
