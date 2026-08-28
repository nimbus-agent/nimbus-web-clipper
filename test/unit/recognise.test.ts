// test/unit/recognise.test.ts
import { describe, expect, it, test } from "vitest";
import { hostPermissionPattern, patternMatchesUrl } from "../../src/shared/origins.ts";
import {
  BUILT_IN_ORIGINS,
  BUILT_IN_SURFACES,
  recognise,
  sameItem,
  surfaceLine,
} from "../../src/shared/recognise/index.ts";
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

describe("sameItem", () => {
  const gh = (path: string) => recognise(`https://github.com${path}`, NONE);

  it("is true across a PR's sub-tabs", () => {
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/web/pull/482/files"))).toBe(true);
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/web/pull/482/commits"))).toBe(true);
  });

  it("is true across query strings and fragments", () => {
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/web/pull/482?diff=split"))).toBe(true);
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/web/pull/482#issuecomment-1"))).toBe(true);
  });

  it("is false for a different number or repo", () => {
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/web/pull/517"))).toBe(false);
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/api/pull/482"))).toBe(false);
  });

  it("is false between a recognised and an unrecognised page", () => {
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/web"))).toBe(false);
    expect(sameItem(gh("/acme/web"), gh("/acme/web/pull/482"))).toBe(false);
  });

  // Both are "no item here". Their `reason` (unknown-host vs unrecognised-path) is
  // a diagnostic about the URL, not a different item — without this rule, wandering
  // between two unrecognised pages under an open panel would re-notify for no
  // user-visible change.
  it("treats any two unrecognised pages as the same non-item", () => {
    expect(sameItem(gh("/acme/web"), gh("/acme/api"))).toBe(true);
    expect(sameItem(gh("/acme/web"), recognise("https://example.com/x", NONE))).toBe(true);
  });

  // The Jira matcher upper-cases the key, so one issue has one identity however
  // the link was typed (recognise.ts's own reasoning).
  it("ignores Jira issue-key case", () => {
    const a = recognise("https://corp.example/jira/browse/abc-12", SELF_HOSTED);
    const b = recognise("https://corp.example/jira/browse/ABC-12", SELF_HOSTED);
    expect(sameItem(a, b)).toBe(true);
  });

  it("distinguishes two products that resolve the same ref shape", () => {
    const jenkins = recognise("https://corp.example/jenkins/job/web/482", SELF_HOSTED);
    expect(sameItem(gh("/acme/web/pull/482"), jenkins)).toBe(false);
  });
});

describe("BUILT_IN_SURFACES", () => {
  test("every built-in origin has a surface row carrying its host pattern", () => {
    for (const entry of BUILT_IN_ORIGINS) {
      const pattern = hostPermissionPattern(entry.origin);
      const row = BUILT_IN_SURFACES.find((s) => s.product === entry.product);
      expect(row).toBeDefined();
      expect(row?.pattern).toBe(pattern);
    }
  });

  test("Jira Cloud is a subdomain wildcard, since tenant hosts are not enumerable", () => {
    const jira = BUILT_IN_SURFACES.find((s) => s.product === "jira");
    expect(jira?.pattern).toBe("https://*.atlassian.net/*");
  });

  test("every surface pattern matches a real page URL on that product", () => {
    const pages: Record<string, string> = {
      bitbucket: "https://bitbucket.org/acme/web/pull-requests/7",
      circleci: "https://app.circleci.com/pipelines/github/acme/web/482",
      confluence: "https://acme.atlassian.net/wiki/spaces/ENG/pages/22970764/Getting+Started",
      github: "https://github.com/acme/web/pull/482",
      gitlab: "https://gitlab.com/acme/web/-/merge_requests/9",
      jira: "https://acme.atlassian.net/browse/ABC-1",
      linear: "https://linear.app/acme/issue/ENG-123/fix-the-thing",
      pagerduty: "https://acmeco.pagerduty.com/incidents/PT4KHLK",
    };
    for (const surface of BUILT_IN_SURFACES) {
      const page = pages[surface.product];
      expect(page).toBeDefined();
      expect(patternMatchesUrl(surface.pattern, page ?? "")).toBe(true);
    }
  });
});

describe("dashboard (home) surfaces", () => {
  it("recognises each product's dashboard as kind home", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["https://github.com/", "GitHub dashboard"],
      ["https://gitlab.com/dashboard", "GitLab dashboard"],
      ["https://bitbucket.org/dashboard/overview", "Bitbucket dashboard"],
      ["https://acme.atlassian.net/jira/your-work", "Jira dashboard"],
    ];
    for (const [url, label] of cases) {
      const r = recognise(url, []);
      expect(r.ok, url).toBe(true);
      if (!r.ok) continue;
      expect(r.kind, url).toBe("home");
      expect(r.label, url).toBe(label);
      expect(r.ref, url).toBe("");
    }
  });

  it("recognises a self-hosted Jenkins root under a path prefix", () => {
    const origins = [{ origin: "https://corp.example/jenkins", product: "jenkins" as const }];
    const r = recognise("https://corp.example/jenkins/", origins);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("home");
    expect(r.label).toBe("Jenkins dashboard");
  });

  it("recognises a self-hosted Jira Server dashboard", () => {
    const origins = [{ origin: "https://jira.corp.example", product: "jira" as const }];
    const r = recognise("https://jira.corp.example/secure/Dashboard.jspa", origins);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("home");
  });

  it("does not claim near-miss paths as home", () => {
    // Each of these is one segment away from a dashboard and must stay
    // unrecognised rather than becoming a lane-bearing page.
    const misses: readonly string[] = [
      "https://github.com/acme",
      "https://gitlab.com/dashboard-extra",
      "https://bitbucket.org/dashboards",
      "https://acme.atlassian.net/jira/your-work/extra",
      "https://acme.atlassian.net/browse",
    ];
    for (const url of misses) {
      expect(recognise(url, []).ok, url).toBe(false);
    }
  });

  it("still recognises item pages, which win over the home branch", () => {
    const r = recognise("https://github.com/acme/web/pull/482", []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("pr");
    expect(r.ref).toBe("acme/web #482");
  });

  it("treats two self-hosted instances of one product as the same home", () => {
    // Deliberate: `service` is a flat connector id, so `{service:"jenkins"}`
    // spans BOTH instances and there is exactly one answer. Splitting these
    // would store one answer twice and double the agent runs.
    const origins = [
      { origin: "https://jenkins.dev.local", product: "jenkins" as const },
      { origin: "https://jenkins.prod.local", product: "jenkins" as const },
    ];
    const dev = recognise("https://jenkins.dev.local/", origins);
    const prod = recognise("https://jenkins.prod.local/", origins);
    expect(sameItem(dev, prod)).toBe(true);
  });

  it("renders a home surface line as the label alone", () => {
    const r = recognise("https://github.com/", []);
    expect(surfaceLine(r)).toBe("GitHub dashboard");
  });
});
describe("a path that ALMOST matches is a miss, never a guess", () => {
  // Each of these is a real page on the product's own host, one segment away
  // from the shape the matcher wants. A partial match here would send the
  // gateway a `resolveUrl` for an item that does not exist, and the panel would
  // report "not indexed" for a page that was never an item in the first place.
  const cases: ReadonlyArray<readonly [string, string, readonly ConfiguredOrigin[]]> = [
    [
      "GitLab MR with a word where the number goes",
      "https://gitlab.com/a/b/-/merge_requests/new",
      NONE,
    ],
    ["GitLab MR path with no number at all", "https://gitlab.com/a/b/-/merge_requests", NONE],
    [
      "GitLab path whose group is too shallow to split",
      "https://gitlab.com/-/merge_requests/7",
      NONE,
    ],
    [
      "Bitbucket Server repo page, one segment short of a PR",
      "https://stash.corp.example:8443/projects/ACME/repos",
      SELF_HOSTED,
    ],
    [
      "Bitbucket Server commits page, not pull-requests",
      "https://stash.corp.example:8443/projects/ACME/repos/web/commits/abc",
      SELF_HOSTED,
    ],
    [
      "Bitbucket Server PR with a word where the number goes",
      "https://stash.corp.example:8443/projects/ACME/repos/web/pull-requests/new",
      SELF_HOSTED,
    ],
    [
      "Bitbucket Cloud PR with a word where the number goes",
      "https://bitbucket.org/acme/web/pull-requests/new",
      NONE,
    ],
    ["Jenkins /job with no job name after it", "https://corp.example/jenkins/job", SELF_HOSTED],
    ["Jenkins job page with no build number", "https://corp.example/jenkins/job/web", SELF_HOSTED],
    [
      "Jenkins lastBuild alias, which is not a build number",
      "https://corp.example/jenkins/job/web/lastBuild",
      SELF_HOSTED,
    ],
    ["GitHub PR path with no number at all", "https://github.com/acme/web/pull", NONE],
    [
      "Jira browse with a key that is not a Jira key",
      "https://acme.atlassian.net/browse/nope",
      NONE,
    ],
  ];

  it.each(cases)("%s", (_name, url, origins) => {
    expect(recognise(url, origins)).toEqual({ ok: false, reason: "unrecognised-path" });
  });
});

describe("an instance root is a home surface on every product", () => {
  // The bare root is the page a user lands on before navigating anywhere, and
  // it is what the ambient cue keys on to say "this instance is connected". A
  // product whose root falls through to `unrecognised-path` shows nothing there.
  it("GitLab's bare root", () => {
    const r = recognise("https://gitlab.com/", NONE);
    expect(r.ok && { product: r.product, kind: r.kind, ref: r.ref }).toEqual({
      product: "gitlab",
      kind: "home",
      ref: "",
    });
  });

  it("a self-hosted Jenkins root, after its path prefix is stripped", () => {
    const r = recognise("https://corp.example/jenkins", SELF_HOSTED);
    expect(r.ok && { product: r.product, kind: r.kind, ref: r.ref }).toEqual({
      product: "jenkins",
      kind: "home",
      ref: "",
    });
  });
});

describe("self-hosted origins stay siloed by product", () => {
  const TWO_ON_ONE_HOST: readonly ConfiguredOrigin[] = [
    { origin: "https://internal.corp/jira", product: "jira" },
    { origin: "https://internal.corp/jenkins", product: "jenkins" },
  ];

  it("resolves each prefix to its own product", () => {
    expectItem("https://internal.corp/jira/browse/ENG-1", TWO_ON_ONE_HOST, {
      product: "jira",
      kind: "issue",
      ref: "ENG-1",
      resolveUrl: "https://internal.corp/jira/browse/ENG-1",
    });
    expectItem("https://internal.corp/jenkins/job/web/482", TWO_ON_ONE_HOST, {
      product: "jenkins",
      kind: "build",
      ref: "web #482",
      resolveUrl: "https://internal.corp/jenkins/job/web/482",
    });
  });

  it("does not run one product's matcher under the other's prefix", () => {
    // A Jenkins-shaped path under the Jira entry must be unrecognised, not a
    // build. `matchOrigin` selects the `/jira` entry (the longer, more specific
    // prefix) and the Jira matcher declines the Jenkins-shaped segments — so the
    // miss must be `unrecognised-path`, not `unknown-host` (which would also
    // pass if the origin had stopped matching at all, the opposite of what this
    // test exists to catch).
    expect(recognise("https://internal.corp/jira/job/web/482", TWO_ON_ONE_HOST)).toEqual({
      ok: false,
      reason: "unrecognised-path",
    });
  });
});

describe("CircleCI", () => {
  it("recognises a pipeline", () => {
    expectItem("https://app.circleci.com/pipelines/github/acme/web/482", NONE, {
      product: "circleci",
      kind: "build",
      ref: "acme/web #482",
      resolveUrl: "https://app.circleci.com/pipelines/github/acme/web/482",
    });
  });

  it("recognises both dashboards", () => {
    for (const url of ["https://app.circleci.com/pipelines", "https://app.circleci.com/home"]) {
      const r = recognise(url, NONE);
      expect(r.ok && r.kind).toBe("home");
    }
  });

  it("declines paths it does not model", () => {
    // A wrong header is worse than no header: settings, insights and a
    // non-numeric pipeline id are all misses, not guesses. Asserted with
    // `reason`, not just `.ok` (Linear's equivalent test already does this) —
    // a bare `.ok === false` cannot tell an unknown host apart from a
    // recognised host with an unmodelled path, so it would still pass even if
    // the CircleCI host rule vanished entirely.
    for (const url of [
      "https://app.circleci.com/settings/organization",
      "https://app.circleci.com/insights/github/acme/web",
      "https://app.circleci.com/pipelines/github/acme/web/not-a-number",
    ]) {
      expect(recognise(url, NONE)).toEqual({ ok: false, reason: "unrecognised-path" });
    }
    // Not `app.circleci.com` — this host is not built in at all.
    expect(recognise("https://circleci.com/pipelines/github/acme/web/482", NONE)).toEqual({
      ok: false,
      reason: "unknown-host",
    });
  });

  it("declines the org- and repo-scoped pipeline lists — they are not the connector's scope", () => {
    // These ARE dashboards in CircleCI's UI, and they are deliberately NOT `home`
    // here. `home` means a page whose scope is the WHOLE connector: `LANE_RULES`
    // gives `catchup`/`decisions`/`ownership` to `home` precisely because they
    // answer about an entire service, and the header claims "Nimbus can answer
    // across all indexed CircleCI pipelines". On a page scoped to one org or one
    // repo that sentence is false, and the three lanes would repeat the same
    // service-wide answer on every repo the user visits — the exact failure the
    // `LANE_RULES` comment cites for item pages.
    for (const url of [
      "https://app.circleci.com/pipelines/github/acme",
      "https://app.circleci.com/pipelines/github/acme/web",
    ]) {
      expect(recognise(url, NONE).ok).toBe(false);
    }
  });
});

describe("Linear", () => {
  it("recognises an issue", () => {
    expectItem("https://linear.app/acme/issue/ENG-123/fix-the-thing", NONE, {
      product: "linear",
      kind: "issue",
      ref: "ENG-123",
      resolveUrl: "https://linear.app/acme/issue/ENG-123/fix-the-thing",
    });
  });

  it("normalises the issue key so one issue has one resolveUrl", () => {
    // Same rule Jira's matcher follows: the ladder upstream is case-sensitive.
    const r = recognise("https://linear.app/acme/issue/eng-123/fix-the-thing", NONE);
    expect(r.ok && r.ref).toBe("ENG-123");
  });

  it("recognises both dashboards", () => {
    for (const url of ["https://linear.app/acme/inbox", "https://linear.app/acme/my-issues"]) {
      const r = recognise(url, NONE);
      expect(r.ok && r.kind).toBe("home");
    }
  });

  it("declines paths it does not model", () => {
    // Asserted with `reason`, not just `.ok`, so this test can tell an unknown
    // host apart from a known host with an unmodelled path — a bare `linear.app`
    // root and a `/settings/members` path fail for different reasons, and a test
    // that could not tell them apart would pass even if the host rule vanished.
    expect(recognise("https://linear.app/acme/settings/members", NONE)).toEqual({
      ok: false,
      reason: "unrecognised-path",
    });
    expect(recognise("https://linear.app/acme/team/ENG/all", NONE)).toEqual({
      ok: false,
      reason: "unrecognised-path",
    });
    expect(recognise("https://linear.app/acme/issue/not-a-key/slug", NONE)).toEqual({
      ok: false,
      reason: "unrecognised-path",
    });
    // The bare root has no workspace segment — the segment is what makes a
    // Linear URL a workspace's, and the marketing root is not a dashboard. The
    // host still matches (linear.app is built in), so this is a path miss too.
    expect(recognise("https://linear.app", NONE)).toEqual({
      ok: false,
      reason: "unrecognised-path",
    });
  });

  it("does not claim Linear's own docs pages as a workspace dashboard", () => {
    // `/docs/inbox` and `/docs/my-issues` are real, currently-published Linear
    // documentation pages — "docs" sits exactly where a workspace slug goes,
    // and the second segment ("inbox" / "my-issues") is a real dashboard slug.
    // The existing `/acme/settings/members` miss above does NOT pin this: its
    // SECOND segment ("settings") is not a dashboard slug at all, so it would
    // decline even without this rule. This case needs the second segment to be
    // one of the modelled dashboard slugs for the collision to be live.
    for (const url of ["https://linear.app/docs/inbox", "https://linear.app/docs/my-issues"]) {
      expect(recognise(url, NONE)).toEqual({ ok: false, reason: "unrecognised-path" });
    }
  });

  it("still recognises a genuine workspace dashboard", () => {
    // Pins that the reserved-segment fix declines only the reserved slugs
    // above, not workspace slugs in general.
    const r = recognise("https://linear.app/acme/inbox", NONE);
    expect(r.ok && r.kind).toBe("home");
  });
});

describe("Confluence", () => {
  it("recognises a page", () => {
    // The shape verified live on 2026-08-28 against
    // lf-toip.atlassian.net/wiki/spaces/HOME/pages/22970764/Getting+Started+with+Confluence+Wiki
    expectItem("https://acme.atlassian.net/wiki/spaces/ENG/pages/22970764/Getting+Started", NONE, {
      product: "confluence",
      kind: "doc",
      ref: "ENG/22970764",
      resolveUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/22970764/Getting+Started",
    });
  });

  it("gives a page one identity whether or not the title segment is present", () => {
    // Confluence serves the same page with and without the trailing title, and
    // rewrites the title when the page is renamed. `sameItem` keys on the ref,
    // so both must produce the same one or the panel would announce a change
    // the user cannot see.
    const withTitle = recognise(
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/22970764/Getting+Started",
      NONE,
    );
    const without = recognise("https://acme.atlassian.net/wiki/spaces/ENG/pages/22970764", NONE);
    expect(sameItem(withTitle, without)).toBe(true);
  });

  it("recognises a personal space, whose key is an account id", () => {
    // Personal spaces are `~<accountId>`. The space key is accepted as any
    // non-empty segment rather than pattern-matched: the `spaces/<x>/pages/<digits>`
    // structure is already specific, and a key pattern would only add false
    // negatives on a shape Atlassian chose, not ours.
    expectItem("https://acme.atlassian.net/wiki/spaces/~712020abc/pages/551/Notes", NONE, {
      product: "confluence",
      kind: "doc",
      ref: "~712020abc/551",
      resolveUrl: "https://acme.atlassian.net/wiki/spaces/~712020abc/pages/551/Notes",
    });
  });

  it("recognises all three dashboards", () => {
    // `/wiki/home` verified live (rtulv.atlassian.net/wiki/home);
    // `/wiki/dashboard.action` is documented in Atlassian Support's
    // "Change the landing page". The bare `/wiki` is the product root.
    for (const url of [
      "https://acme.atlassian.net/wiki",
      "https://acme.atlassian.net/wiki/",
      "https://acme.atlassian.net/wiki/home",
      "https://acme.atlassian.net/wiki/dashboard.action",
    ]) {
      const r = recognise(url, NONE);
      expect(r.ok && r.kind, url).toBe("home");
      expect(r.ok && r.product, url).toBe("confluence");
    }
  });

  it("labels a page a doc and offers it no lane", () => {
    const r = recognise("https://acme.atlassian.net/wiki/spaces/ENG/pages/1/T", NONE);
    expect(r.ok && r.label).toBe("Confluence doc");
  });

  it("declines paths it does not model", () => {
    // A space overview and a blog post are real Confluence pages that this
    // matcher deliberately does not claim; a non-numeric page id is a guess it
    // refuses. All three are misses, asserted with `reason` so the test cannot
    // pass by the host rule vanishing.
    for (const url of [
      // The bare spaces LIST, with no key at all: the one URL for which
      // `spaceKey !== undefined` is the deciding condition — every other shape
      // here is settled by `pages === "pages"` before it is reached.
      "https://acme.atlassian.net/wiki/spaces",
      "https://acme.atlassian.net/wiki/spaces/ENG",
      "https://acme.atlassian.net/wiki/spaces/ENG/overview",
      "https://acme.atlassian.net/wiki/spaces/ENG/blog/2020/01/01/551/Post",
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/not-a-number/T",
      "https://acme.atlassian.net/wiki/people/712020abc",
    ]) {
      expect(recognise(url, NONE), url).toEqual({ ok: false, reason: "unrecognised-path" });
    }
  });

  it("does not let the /wiki prefix bleed into a neighbouring path", () => {
    // matchOrigin's `${prefix}/` boundary check. `/wikifoo` is Jira's, not
    // Confluence's — and Jira does not model it either, so it is a miss on
    // Jira's matcher rather than a Confluence page.
    expect(recognise("https://acme.atlassian.net/wikifoo/spaces/ENG/pages/1/T", NONE)).toEqual({
      ok: false,
      reason: "unrecognised-path",
    });
  });
});

describe("Confluence and Jira share one tenant host", () => {
  it("gives /wiki to Confluence and everything else to Jira", () => {
    expectItem("https://acme.atlassian.net/wiki/spaces/ENG/pages/1/T", NONE, {
      product: "confluence",
      kind: "doc",
      ref: "ENG/1",
      resolveUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/1/T",
    });
    expectItem("https://acme.atlassian.net/browse/ENG-1", NONE, {
      product: "jira",
      kind: "issue",
      ref: "ENG-1",
      resolveUrl: "https://acme.atlassian.net/browse/ENG-1",
    });
    const jiraHome = recognise("https://acme.atlassian.net/jira/your-work", NONE);
    expect(jiraHome.ok && jiraHome.product).toBe("jira");
  });

  it("is decided by the longest path prefix, not by registry order", () => {
    // The ordering assertion the registry's doc comment asked for when this
    // slice landed. It must hold regardless of RULE_BY_PRODUCT's key order, so
    // it asserts the OUTCOME on both sides of the split rather than the order of
    // the table — a test that read the table would pass for a wrong table.
    const wiki = recognise("https://acme.atlassian.net/wiki/home", NONE);
    const jira = recognise("https://acme.atlassian.net/secure/Dashboard.jspa", NONE);
    expect(wiki.ok && wiki.product).toBe("confluence");
    expect(jira.ok && jira.product).toBe("jira");
  });

  it("keeps a user's Jira Server entry from claiming Confluence-shaped paths", () => {
    // The registry's `hosts` list governs BUILT-IN hosts only; it never widens
    // what a user's own entry matches. A Confluence-shaped path under a
    // Jira-only entry stays unrecognised rather than becoming a Confluence page.
    const jiraOnly: readonly ConfiguredOrigin[] = [
      { origin: "https://corp.example/jira", product: "jira" },
    ];
    expect(recognise("https://corp.example/jira/wiki/spaces/ENG/pages/1/T", jiraOnly)).toEqual({
      ok: false,
      reason: "unrecognised-path",
    });
  });

  it("keeps two self-hosted products on one host siloed", () => {
    // matchOrigin's longest-prefix rule, pinned from the recogniser's side.
    const both: readonly ConfiguredOrigin[] = [
      { origin: "https://internal.corp/jira", product: "jira" },
      { origin: "https://internal.corp/wiki", product: "confluence" },
    ];
    expectItem("https://internal.corp/jira/browse/ENG-1", both, {
      product: "jira",
      kind: "issue",
      ref: "ENG-1",
      resolveUrl: "https://internal.corp/jira/browse/ENG-1",
    });
    expectItem("https://internal.corp/wiki/spaces/ENG/pages/1/T", both, {
      product: "confluence",
      kind: "doc",
      ref: "ENG/1",
      resolveUrl: "https://internal.corp/wiki/spaces/ENG/pages/1/T",
    });
    // Neither matches the other's paths.
    expect(recognise("https://internal.corp/jira/spaces/ENG/pages/1/T", both).ok).toBe(false);
    expect(recognise("https://internal.corp/wiki/browse/ENG-1", both).ok).toBe(false);
  });
});

describe("PagerDuty", () => {
  it("recognises an incident", () => {
    expectItem("https://acmeco.pagerduty.com/incidents/PT4KHLK", NONE, {
      product: "pagerduty",
      kind: "incident",
      ref: "PT4KHLK",
      resolveUrl: "https://acmeco.pagerduty.com/incidents/PT4KHLK",
    });
  });

  it("recognises an EU-region tenant", () => {
    // EU accounts are `<sub>.eu.pagerduty.com` (PagerDuty Support, "Service
    // Regions"). The suffix covers them and the leftmost label is still the
    // tenant, so nothing special is needed — but it is pinned because a future
    // tightening of the host rule could quietly drop a whole region.
    expectItem("https://acmeco.eu.pagerduty.com/incidents/PT4KHLK", NONE, {
      product: "pagerduty",
      kind: "incident",
      ref: "PT4KHLK",
      resolveUrl: "https://acmeco.eu.pagerduty.com/incidents/PT4KHLK",
    });
  });

  it("recognises the incidents dashboard", () => {
    const r = recognise("https://acmeco.pagerduty.com/incidents", NONE);
    expect(r.ok && r.kind).toBe("home");
    expect(r.ok && r.product).toBe("pagerduty");
  });

  it("labels an incident an incident and offers it no lane", () => {
    const r = recognise("https://acmeco.pagerduty.com/incidents/PT4KHLK", NONE);
    expect(r.ok && r.label).toBe("PagerDuty incident");
  });

  it("does not claim PagerDuty's own status page — the slice-3 defect in suffix form", () => {
    // Each of these is a host PagerDuty publishes for ITSELF, and each matches
    // the `.pagerduty.com` suffix, so a specific path is necessary and NOT
    // sufficient — the host has to be constrained too. This is the exact shape of
    // the linear.app/docs/inbox defect: a host being right does not make the page
    // the product's own.
    //
    // What this pins is the HOST-RESOLUTION refusal, which is the whole defence:
    // the reason is `unknown-host`, not `unrecognised-path`, because
    // `excludedLabels` (and `minTenantLabelLength`, which is what refuses `www`)
    // is checked in `suffixEntry` before any matcher sees the path. So one entry
    // covers the item arm and the dashboard arm at once, rather than each matcher
    // having to remember it — and nothing downstream re-checks it, so an id shape
    // is not a backstop here.
    //
    // `status.pagerduty.com` is PagerDuty's own status-page product, NOT an
    // Atlassian Statuspage (`/api/v2/summary.json` is a 404 there) and its
    // incident routes are `/incident_details/:id`; every path on it answers 200
    // from one SPA shell, so a fetch against it proves nothing either way. The
    // `/incidents/<id>` URL below is kept as an adversarial input rather than as
    // a claim that the page exists.
    for (const url of [
      "https://status.pagerduty.com/incidents",
      "https://status.pagerduty.com/incidents/hbjm8pfyzs7q",
      "https://status.pagerduty.com/",
      "https://www.pagerduty.com/incidents",
      "https://support.pagerduty.com/incidents",
      "https://developer.pagerduty.com/incidents",
      "https://community.pagerduty.com/incidents",
      "https://response.pagerduty.com/incidents",
    ]) {
      expect(recognise(url, NONE), url).toEqual({ ok: false, reason: "unknown-host" });
    }
  });

  it("declines a lower-case id even on a genuine tenant host", () => {
    // NOT a backstop for the denylist — PagerDuty's own status page mints
    // upper-case `P`-prefixed ids (`PV31RQ5`), the same shape as a tenant's, so
    // the id pattern would let a missed vendor host straight through. What it
    // buys is narrowness on a host that IS a tenant: a segment under
    // `/incidents/` that is not an id shape at all must not become an incident
    // header. Every documented PagerDuty id is upper-case alphanumeric.
    expect(recognise("https://acmeco.pagerduty.com/incidents/hbjm8pfyzs7q", NONE)).toEqual({
      ok: false,
      reason: "unrecognised-path",
    });
  });

  it("refuses a label too short to be an account, without it being listed", () => {
    // PagerDuty Support's "Account Subdomains": "There is a minimum of five
    // characters for PagerDuty subdomains." `app.pagerduty.com` is PagerDuty's
    // DOCUMENTED login host and `go.pagerduty.com` a live first-party redirector;
    // neither appears in `excludedLabels`, and neither has to, because
    // `minTenantLabelLength` refuses every leftmost label under five characters.
    // That is the half of the guard that covers hosts nobody has enumerated.
    //
    // `unknown-host` again, for the same reason as the denylist above: the check
    // is at host resolution, before the matcher.
    for (const url of [
      "https://app.pagerduty.com/incidents",
      "https://app.pagerduty.com/incidents/PT4KHLK",
      "https://go.pagerduty.com/incidents",
      "https://api.pagerduty.com/incidents",
      "https://help.pagerduty.com/incidents",
    ]) {
      expect(recognise(url, NONE), url).toEqual({ ok: false, reason: "unknown-host" });
    }
  });

  it("still recognises a tenant of exactly the documented minimum length", () => {
    // The floor is five, so a five-character account is a real customer and must
    // survive the rule that removes `app` and `go`. Pinned because an off-by-one
    // here silences every shortest-possible tenant with no other symptom.
    expectItem("https://acmes.pagerduty.com/incidents/PT4KHLK", NONE, {
      product: "pagerduty",
      kind: "incident",
      ref: "PT4KHLK",
      resolveUrl: "https://acmes.pagerduty.com/incidents/PT4KHLK",
    });
  });

  it("declines paths it does not model, and the apex", () => {
    for (const url of [
      "https://acmeco.pagerduty.com/service-directory",
      "https://acmeco.pagerduty.com/incidents/new",
      "https://acmeco.pagerduty.com/",
    ]) {
      expect(recognise(url, NONE), url).toEqual({ ok: false, reason: "unrecognised-path" });
    }
    // The apex is not a tenant. `endsWith(".pagerduty.com")` is false for it.
    expect(recognise("https://pagerduty.com/incidents/PT4KHLK", NONE)).toEqual({
      ok: false,
      reason: "unknown-host",
    });
  });
});

describe("a built-in suffix host is matched by suffix, not by origin", () => {
  it("recognises any Jira Cloud tenant", () => {
    expectItem("https://acme.atlassian.net/browse/ABC-1", NONE, {
      product: "jira",
      kind: "issue",
      ref: "ABC-1",
      resolveUrl: "https://acme.atlassian.net/browse/ABC-1",
    });
  });

  it("does not recognise a lookalike host that merely contains the suffix", () => {
    expect(recognise("https://atlassian.net.evil.example/browse/ABC-1", NONE).ok).toBe(false);
    // The dotless-suffix trap, pinned from the outside: if a future rule declared
    // `"atlassian.net"` instead of `".atlassian.net"`, this host would match.
    expect(recognise("https://evilatlassian.net/browse/ABC-1", NONE).ok).toBe(false);
  });

  it("does not recognise the apex domain as a tenant", () => {
    // `atlassian.net` itself is not somebody's Jira. Subdomains only.
    expect(recognise("https://atlassian.net/browse/ABC-1", NONE).ok).toBe(false);
  });

  it("does not treat `www` on a tenant host as a vendor subdomain", () => {
    // Verified 2026-08-28: www.atlassian.net is a REAL Jira Cloud site — it 302s
    // to id.atlassian.com carrying a live site ARI. It is the reason
    // `excludedLabels` lives on the rule that needs it instead of being one
    // shared list applied to every suffix host: a shared list containing "www"
    // would make Jira stop recognising a real customer.
    expectItem("https://www.atlassian.net/browse/ENG-1", NONE, {
      product: "jira",
      kind: "issue",
      ref: "ENG-1",
      resolveUrl: "https://www.atlassian.net/browse/ENG-1",
    });
  });
});
