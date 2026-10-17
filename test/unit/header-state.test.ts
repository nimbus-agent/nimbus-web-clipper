// test/unit/header-state.test.ts
import { describe, expect, it } from "vitest";
import { headerFrom, withPick } from "../../src/panel/header-state.ts";
import type { HeaderState } from "../../src/panel/panel-view.ts";
import {
  CLIP_SERVICE,
  CLIP_TYPE,
  type FileResolution,
  type Recognition,
  type ResolvedItem,
} from "../../src/shared/types.ts";

const NOW = 1_700_000_000_000;

const PR: Recognition = {
  ok: true,
  product: "github",
  kind: "pr",
  label: "GitHub PR",
  ref: "a/b #1",
  resolveUrl: "https://github.com/a/b/pull/1",
};
const HOME: Recognition = {
  ok: true,
  product: "github",
  kind: "home",
  label: "GitHub dashboard",
  ref: "",
  resolveUrl: "https://github.com/",
};
const FILE: Recognition = {
  ok: true,
  product: "github",
  kind: "file",
  label: "GitHub file",
  ref: "a/b src/x.ts",
  resolveUrl: "https://github.com/a/b/blob/main/src/x.ts",
};

const ITEM: ResolvedItem = {
  id: "i1",
  service: "github",
  type: "pr",
  title: "A PR",
  url: "https://github.com/a/b/pull/1",
  modifiedAt: NOW - 60_000,
};

const INERT = { kind: "not-indexed", fetchable: false };

function ok(recognition: Recognition, outcome: unknown, extra: object = {}): unknown {
  return { kind: "resolve", ok: true, recognition, outcome, ...extra };
}

function refused(reason: string, extra: object = {}): unknown {
  return { kind: "resolve", ok: false, reason, recognition: PR, ...extra };
}

describe("headerFrom", () => {
  it("reads a non-response as an error without a surface", () => {
    expect(headerFrom("nope", NOW, false)).toEqual({
      kind: "error",
      surface: null,
      message: "Couldn't read Nimbus's answer.",
    });
  });

  it("maps found to resolved", () => {
    const h = headerFrom(ok(PR, { kind: "found", item: ITEM, matchKind: "exact" }), NOW, false);
    expect(h).toMatchObject({ kind: "resolved", item: ITEM, matchKind: "exact", nowMs: NOW });
  });

  it("maps a saved copy to captured, not resolved", () => {
    const copy = { ...ITEM, service: CLIP_SERVICE, type: CLIP_TYPE };
    const h = headerFrom(ok(PR, { kind: "found", item: copy, matchKind: "exact" }), NOW, false);
    expect(h).toMatchObject({ kind: "captured", item: copy, ageNowMs: NOW });
  });

  it("maps not-indexed, fetchable true and false", () => {
    const yes = headerFrom(ok(PR, { kind: "not-indexed", fetchable: true }), NOW, false);
    expect(yes).toMatchObject({ kind: "not-indexed", fetchable: true, product: "github" });
    const no = headerFrom(ok(PR, INERT), NOW, false);
    expect(no).toMatchObject({ kind: "not-indexed", fetchable: false });
  });

  it("forces fetchable false once a fetch has been sent", () => {
    const h = headerFrom(ok(PR, { kind: "not-indexed", fetchable: true }), NOW, true);
    expect(h).toMatchObject({ kind: "not-indexed", fetchable: false });
  });

  it("folds unresolvable into not-indexed", () => {
    const h = headerFrom(ok(PR, { kind: "unresolvable", fetchable: false }), NOW, false);
    expect(h.kind).toBe("not-indexed");
  });

  it("carries ambiguous candidates and the truncation flag", () => {
    const candidates = [{ id: "a", service: "jira", type: "issue", title: "One", url: null }];
    const list = { kind: "ambiguous", fetchable: false, candidates, truncated: false };
    expect(headerFrom(ok(PR, list), NOW, false)).toMatchObject({
      kind: "ambiguous",
      candidates,
      truncated: false,
    });
    const cut = { kind: "ambiguous", fetchable: false, candidates: [], truncated: true };
    expect(headerFrom(ok(PR, cut), NOW, false)).toMatchObject({
      kind: "ambiguous",
      truncated: true,
    });
  });

  it("maps an unrecognised page", () => {
    const h = headerFrom(ok({ ok: false, reason: "unknown-host" }, INERT), NOW, false);
    expect(h).toEqual({ kind: "unrecognised" });
  });

  it("maps a refusal to an error with the reason's sentence", () => {
    expect(headerFrom(refused("unreachable"), NOW, false)).toMatchObject({
      kind: "error",
      message: "Couldn't connect to Nimbus.",
    });
    expect(headerFrom(refused("not_paired"), NOW, false)).toMatchObject({
      kind: "error",
      message: "Pair with Nimbus in Options to see what it knows about this page.",
    });
  });

  it("falls back to the generic sentence for an unknown reason", () => {
    expect(headerFrom(refused("weird"), NOW, false)).toMatchObject({
      message: "Couldn't resolve this page.",
    });
  });

  it("maps insufficient_scope to needs-scope with the gap", () => {
    const scopeGap = { label: "chrome", required: "resolve", granted: ["clip"] };
    expect(headerFrom(refused("insufficient_scope", { scopeGap }), NOW, false)).toMatchObject({
      kind: "needs-scope",
      scopeGap,
    });
  });

  it("maps a home page to service, defaulting the connector to unknown", () => {
    expect(headerFrom(ok(HOME, INERT), NOW, false)).toMatchObject({
      kind: "service",
      connector: { state: "unknown" },
    });
    const withConnector = ok(HOME, INERT, { connector: { state: "healthy" } });
    expect(headerFrom(withConnector, NOW, false)).toMatchObject({
      kind: "service",
      connector: { state: "healthy" },
    });
  });

  it("maps a file hit, an older gateway and unsupported to a bannerless file header", () => {
    const found: FileResolution = { kind: "found", path: "/x" };
    for (const extra of [{ file: found }, {}, { file: { kind: "unsupported" } }]) {
      const h = headerFrom(ok(FILE, INERT, extra), NOW, false);
      expect(h.kind).toBe("file");
      expect(h).not.toHaveProperty("banner");
    }
  });

  it("maps a file miss to a banner naming the repo", () => {
    const miss = (reason: string): unknown =>
      ok(FILE, INERT, { file: { kind: "miss", reason, repo: "a/b" } });
    expect(headerFrom(miss("remote_not_tracked"), NOW, false)).toMatchObject({
      kind: "file",
      banner: "Nimbus has no local checkout of `a/b`, so it cannot answer about its files.",
    });
    expect(headerFrom(miss("file_not_indexed"), NOW, false)).toMatchObject({
      banner: "Nimbus has a checkout of `a/b`, but this file is not in its index.",
    });
  });
});

describe("withPick", () => {
  const candidates = [
    { id: "a", service: "jira", type: "issue", title: "One", url: null },
    { id: "b", service: "jira", type: "issue", title: "Two", url: null },
  ];
  const ambiguous: HeaderState = { kind: "ambiguous", surface: "s", candidates, truncated: false };

  it("turns ambiguous plus a matching id into chosen", () => {
    expect(withPick(ambiguous, "b")).toEqual({
      kind: "chosen",
      surface: "s",
      candidate: candidates[1],
    });
  });

  it("leaves ambiguous alone for an unknown or null id", () => {
    expect(withPick(ambiguous, "zzz")).toBe(ambiguous);
    expect(withPick(ambiguous, null)).toBe(ambiguous);
  });

  it("leaves every other arm alone", () => {
    const resolved: HeaderState = {
      kind: "resolved",
      surface: "s",
      item: ITEM,
      matchKind: "exact",
      nowMs: NOW,
    };
    expect(withPick(resolved, "a")).toBe(resolved);
  });
});
