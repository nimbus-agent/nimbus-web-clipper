import { describe, expect, test, vi } from "vitest";
import { type AmbientDeps, decideAmbient } from "../../src/background/ambient.ts";
import type { ResolveResponse } from "../../src/shared/messages.ts";
import { recognise } from "../../src/shared/recognise.ts";

const PR = "https://github.com/acme/web/pull/482";
const PR_FILES = "https://github.com/acme/web/pull/482/files";
const OTHER_PR = "https://github.com/acme/web/pull/517";
const GITHUB = "https://github.com/*";

const FOUND: ResolveResponse = {
  kind: "resolve",
  ok: true,
  recognition: recognise(PR, []),
  outcome: {
    kind: "found",
    item: {
      id: "gh:acme/web#482",
      service: "github",
      type: "pr",
      title: "Fix the flush",
      url: PR,
      modifiedAt: 1_700_000_000_000,
    },
    matchKind: "exact",
  },
};

function deps(over: Partial<AmbientDeps> = {}): AmbientDeps {
  return {
    enabledHosts: async () => [GITHUB],
    getOrigins: async () => [],
    lastCued: () => undefined,
    resolve: async () => FOUND,
    currentUrl: async () => PR,
    ...over,
  };
}

const NAV = { tabId: 7, url: PR, active: true };

describe("the gate before the gateway call", () => {
  test("a resolved page on an enabled host shows the cue", async () => {
    const d = await decideAmbient(deps(), NAV);
    expect(d).toEqual({
      kind: "show",
      cue: { label: "GitHub PR", ref: "acme/web #482" },
      recognition: recognise(PR, []),
    });
  });

  test("an inactive tab never costs a resolve", async () => {
    const resolve = vi.fn();
    const d = await decideAmbient(deps({ resolve }), { ...NAV, active: false });
    expect(d).toEqual({ kind: "none", why: "inactive-tab" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("a host that is not switched on never costs a resolve", async () => {
    const resolve = vi.fn();
    const d = await decideAmbient(deps({ enabledHosts: async () => [], resolve }), NAV);
    expect(d).toEqual({ kind: "none", why: "not-enabled" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("an unrecognised path on an enabled host never costs a resolve", async () => {
    const resolve = vi.fn();
    const d = await decideAmbient(deps({ resolve }), {
      ...NAV,
      url: "https://github.com/acme/web/issues",
    });
    expect(d).toEqual({ kind: "none", why: "unrecognised" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("a self-hosted instance is recognised from the user's own origins", async () => {
    const d = await decideAmbient(
      deps({
        enabledHosts: async () => ["https://corp.example/*"],
        getOrigins: async () => [{ origin: "https://corp.example/jira", product: "jira" }],
        currentUrl: async () => "https://corp.example/jira/browse/ABC-1",
      }),
      { tabId: 7, url: "https://corp.example/jira/browse/ABC-1", active: true },
    );
    expect(d.kind).toBe("show");
  });
});

describe("the per-tab dedupe", () => {
  test("the same item already cued in this tab is not cued again", async () => {
    const resolve = vi.fn();
    const d = await decideAmbient(deps({ lastCued: () => recognise(PR, []), resolve }), NAV);
    expect(d).toEqual({ kind: "none", why: "already-cued" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("a different sub-tab of the same PR is the same item, not a new one", async () => {
    const d = await decideAmbient(deps({ lastCued: () => recognise(PR, []) }), {
      ...NAV,
      url: PR_FILES,
    });
    expect(d).toEqual({ kind: "none", why: "already-cued" });
  });

  test("a different PR in the same tab is cued", async () => {
    const d = await decideAmbient(
      deps({ lastCued: () => recognise(OTHER_PR, []), currentUrl: async () => PR }),
      NAV,
    );
    expect(d.kind).toBe("show");
  });
});

describe("the resolve outcomes", () => {
  const outcomes: Array<[string, ResolveResponse]> = [
    [
      "not indexed",
      {
        kind: "resolve",
        ok: true,
        recognition: recognise(PR, []),
        outcome: { kind: "not-indexed", fetchable: true },
      },
    ],
    [
      "unresolvable",
      {
        kind: "resolve",
        ok: true,
        recognition: recognise(PR, []),
        outcome: { kind: "unresolvable", fetchable: false },
      },
    ],
    [
      "ambiguous",
      {
        kind: "resolve",
        ok: true,
        recognition: recognise(PR, []),
        outcome: { kind: "ambiguous", fetchable: false, candidates: [], truncated: false },
      },
    ],
    [
      "not paired",
      { kind: "resolve", ok: false, recognition: recognise(PR, []), reason: "not_paired" },
    ],
    [
      "unauthorized",
      { kind: "resolve", ok: false, recognition: recognise(PR, []), reason: "unauthorized" },
    ],
    [
      "insufficient scope",
      { kind: "resolve", ok: false, recognition: recognise(PR, []), reason: "insufficient_scope" },
    ],
    [
      "unsupported",
      { kind: "resolve", ok: false, recognition: recognise(PR, []), reason: "unsupported" },
    ],
    [
      "unreachable",
      { kind: "resolve", ok: false, recognition: recognise(PR, []), reason: "unreachable" },
    ],
    [
      "server error",
      { kind: "resolve", ok: false, recognition: recognise(PR, []), reason: "server_error" },
    ],
  ];

  for (const [name, response] of outcomes) {
    test(`${name} is silence, never a cue and never an error surface`, async () => {
      const d = await decideAmbient(deps({ resolve: async () => response }), NAV);
      expect(d).toEqual({ kind: "none", why: "no-item" });
    });
  }

  test("a resolve that throws is silence too", async () => {
    const d = await decideAmbient(
      deps({
        resolve: async () => {
          throw new Error("storage exploded");
        },
      }),
      NAV,
    );
    expect(d).toEqual({ kind: "none", why: "no-item" });
  });
});

describe("the preconditions re-checked after the resolve", () => {
  test("a tab closed mid-resolve is not cued", async () => {
    const d = await decideAmbient(deps({ currentUrl: async () => null }), NAV);
    expect(d).toEqual({ kind: "none", why: "tab-gone" });
  });

  test("a tab moved to a different item mid-resolve is not cued", async () => {
    const d = await decideAmbient(deps({ currentUrl: async () => OTHER_PR }), NAV);
    expect(d).toEqual({ kind: "none", why: "navigated" });
  });

  test("a move to a different sub-tab of the SAME item still cues", async () => {
    const d = await decideAmbient(deps({ currentUrl: async () => PR_FILES }), NAV);
    expect(d.kind).toBe("show");
  });

  test("a tab that went somewhere unrecognised mid-resolve is not cued", async () => {
    const d = await decideAmbient(deps({ currentUrl: async () => "https://example.com/" }), NAV);
    expect(d).toEqual({ kind: "none", why: "navigated" });
  });

  test("active is NOT re-checked — a cue waiting in a tab you return to is the point", async () => {
    // The tab was active when the navigation fired; whether it still is when the
    // resolve lands is deliberately not consulted.
    const d = await decideAmbient(deps(), NAV);
    expect(d.kind).toBe("show");
  });
});
