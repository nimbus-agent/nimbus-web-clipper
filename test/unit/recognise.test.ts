// test/unit/recognise.test.ts
import { describe, expect, it, test } from "vitest";
import { recognise, surfaceLine } from "../../src/shared/recognise.ts";
import type { ConfiguredOrigin } from "../../src/shared/types.ts";

const NONE: readonly ConfiguredOrigin[] = [];
const SELF_HOSTED: readonly ConfiguredOrigin[] = [
  { origin: "https://corp.example/jira", product: "jira" },
  { origin: "https://corp.example/jenkins", product: "jenkins" },
  { origin: "https://stash.corp.example:8443", product: "bitbucket" },
];

/** Assert the happy path compactly: product, kind, ref and the exact resolveUrl. */
function expectItem(
  url: string,
  origins: readonly ConfiguredOrigin[],
  want: { product: string; kind: string; ref: string; resolveUrl: string },
): void {
  const r = recognise(url, origins);
  expect(r.ok).toBe(true);
  if (!r.ok) {
    return;
  }
  expect({ product: r.product, kind: r.kind, ref: r.ref, resolveUrl: r.resolveUrl }).toEqual(want);
}

describe("built-in SaaS hosts", () => {
  test("GitHub PR", () => {
    expectItem("https://github.com/acme/web/pull/482", NONE, {
      product: "github",
      kind: "pr",
      ref: "acme/web #482",
      resolveUrl: "https://github.com/acme/web/pull/482",
    });
  });
  test("GitHub PR sub-tab is preserved onto the resolveUrl — the gateway trims it", () => {
    expectItem("https://github.com/acme/web/pull/482/files", NONE, {
      product: "github",
      kind: "pr",
      ref: "acme/web #482",
      resolveUrl: "https://github.com/acme/web/pull/482/files",
    });
  });
  test("GitLab MR under a nested group", () => {
    expectItem("https://gitlab.com/acme/team/web/-/merge_requests/7/diffs", NONE, {
      product: "gitlab",
      kind: "pr",
      ref: "acme/team/web !7",
      resolveUrl: "https://gitlab.com/acme/team/web/-/merge_requests/7/diffs",
    });
  });
  test("Bitbucket Cloud PR", () => {
    expectItem("https://bitbucket.org/acme/web/pull-requests/12/diff", NONE, {
      product: "bitbucket",
      kind: "pr",
      ref: "acme/web #12",
      resolveUrl: "https://bitbucket.org/acme/web/pull-requests/12/diff",
    });
  });
  test("Jira Cloud issue on any *.atlassian.net host", () => {
    expectItem("https://acme.atlassian.net/browse/PLAT-91", NONE, {
      product: "jira",
      kind: "issue",
      ref: "PLAT-91",
      resolveUrl: "https://acme.atlassian.net/browse/PLAT-91",
    });
  });
});

describe("self-hosted instances", () => {
  test("Jira behind a /jira prefix keeps the prefix in resolveUrl", () => {
    expectItem("https://corp.example/jira/browse/PLAT-91", SELF_HOSTED, {
      product: "jira",
      kind: "issue",
      ref: "PLAT-91",
      resolveUrl: "https://corp.example/jira/browse/PLAT-91",
    });
  });
  test("Jenkins build under nested folders", () => {
    expectItem("https://corp.example/jenkins/job/web/job/deploy/42/console", SELF_HOSTED, {
      product: "jenkins",
      kind: "build",
      ref: "web/deploy #42",
      resolveUrl: "https://corp.example/jenkins/job/web/job/deploy/42/console",
    });
  });
  test("Bitbucket Server PR on a non-default port", () => {
    expectItem(
      "https://stash.corp.example:8443/projects/PLAT/repos/web/pull-requests/9/overview",
      SELF_HOSTED,
      {
        product: "bitbucket",
        kind: "pr",
        ref: "PLAT/web #9",
        resolveUrl:
          "https://stash.corp.example:8443/projects/PLAT/repos/web/pull-requests/9/overview",
      },
    );
  });
  test("a sibling path on a prefixed host is NOT the configured product", () => {
    const r = recognise("https://corp.example/wiki/Home", SELF_HOSTED);
    expect(r).toEqual({ ok: false, reason: "unknown-host" });
  });
});

describe("canonicalisation moved to the gateway", () => {
  test("preserves query parameters, fragment and trailing slash — the gateway strips those", () => {
    expectItem("https://github.com/acme/web/pull/482/?utm_source=slack#note-3", NONE, {
      product: "github",
      kind: "pr",
      ref: "acme/web #482",
      resolveUrl: "https://github.com/acme/web/pull/482/?utm_source=slack#note-3",
    });
  });
  test("is idempotent — recognising a resolveUrl reproduces it exactly", () => {
    const first = recognise("https://github.com/acme/web/pull/482/commits", NONE);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = recognise(first.resolveUrl, NONE);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.resolveUrl).toBe(first.resolveUrl);
  });
  test("a Jira key is upper-cased, so one issue has one resolveUrl", () => {
    expectItem("https://acme.atlassian.net/browse/plat-91", NONE, {
      product: "jira",
      kind: "issue",
      ref: "PLAT-91",
      resolveUrl: "https://acme.atlassian.net/browse/PLAT-91",
    });
  });
});

describe("misses", () => {
  test("an unconfigured host is unknown-host", () => {
    expect(recognise("https://example.com/acme/web/pull/1", NONE)).toEqual({
      ok: false,
      reason: "unknown-host",
    });
  });
  test("a known host with a non-item path is unrecognised-path", () => {
    expect(recognise("https://github.com/acme/web/issues", NONE)).toEqual({
      ok: false,
      reason: "unrecognised-path",
    });
  });
  test("a PR number that is not a number does not match", () => {
    expect(recognise("https://github.com/acme/web/pull/new", NONE).ok).toBe(false);
  });
  test("a non-http scheme is unknown-host", () => {
    expect(recognise("file:///tmp/x.html", NONE)).toEqual({ ok: false, reason: "unknown-host" });
    expect(recognise("chrome://extensions", NONE)).toEqual({ ok: false, reason: "unknown-host" });
  });
  test("unparseable input is unknown-host, not a throw", () => {
    expect(recognise("not a url", NONE)).toEqual({ ok: false, reason: "unknown-host" });
  });
});

describe("resolveUrl keeps identity, not canonicalisation", () => {
  const origins = [{ origin: "https://github.com", product: "github" as const }];

  it("preserves the query string — the gateway's ladder strips it, not us", () => {
    const r = recognise("https://github.com/a/b/pull/1?w=1&diff=split", origins);
    expect(r.ok && r.resolveUrl).toBe("https://github.com/a/b/pull/1?w=1&diff=split");
  });

  it("preserves a sub-tab path segment — rung 3 trims it upstream", () => {
    const r = recognise("https://github.com/a/b/pull/1/files", origins);
    expect(r.ok && r.resolveUrl).toBe("https://github.com/a/b/pull/1/files");
    // The header still reads off the matched ref, not the full path.
    expect(r.ok && r.ref).toBe("a/b #1");
  });

  it("still uppercases a Jira key — that is identity, not canonicalisation", () => {
    const jira = [{ origin: "https://acme.atlassian.net", product: "jira" as const }];
    const r = recognise("https://acme.atlassian.net/browse/abc-1?filter=42", jira);
    expect(r.ok && r.resolveUrl).toBe("https://acme.atlassian.net/browse/ABC-1?filter=42");
  });

  it("preserves a configured path prefix on a self-hosted instance", () => {
    const jenkins = [{ origin: "https://corp.example/jenkins", product: "jenkins" as const }];
    const r = recognise("https://corp.example/jenkins/job/build/42/console", jenkins);
    expect(r.ok && r.resolveUrl).toBe("https://corp.example/jenkins/job/build/42/console");
  });

  // Pins the defensive `: url` fallback (recognise.ts) for real: when the raw
  // input string does not literally start with the rebuilt matched prefix — here
  // because `URL` lower-cases the host but the original string is mixed-case —
  // the function returns the caller's own input verbatim rather than fabricating
  // a destination. That also means identity normalisation (the Jira upper-case)
  // is skipped: the returned string is byte-for-byte the input.
  it("falls back to the raw input, skipping Jira normalisation, when the host case doesn't match the rebuilt prefix", () => {
    const r = recognise("https://ACME.atlassian.net/browse/abc-1", NONE);
    expect(r.ok && r.resolveUrl).toBe("https://ACME.atlassian.net/browse/abc-1");
  });
});

describe("surfaceLine", () => {
  test("joins the label and the ref", () => {
    expect(surfaceLine(recognise("https://github.com/acme/web/pull/482", NONE))).toBe(
      "GitHub PR · acme/web #482",
    );
  });
  test("GitLab reads MR, not PR", () => {
    expect(surfaceLine(recognise("https://gitlab.com/acme/web/-/merge_requests/7", NONE))).toBe(
      "GitLab MR · acme/web !7",
    );
  });
  test("an unrecognised page has no surface line", () => {
    expect(surfaceLine({ ok: false, reason: "unknown-host" })).toBeNull();
  });
});
