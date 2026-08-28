// test/unit/origins.test.ts
import { describe, expect, it, test } from "vitest";
import {
  hostPermissionPattern,
  isConfiguredOrigin,
  isProduct,
  matchOrigin,
  parseConfiguredOrigin,
  patternMatchesUrl,
  removeConfiguredOrigin,
  splitOrigin,
  upsertOrigin,
} from "../../src/shared/origins.ts";
import type { ConfiguredOrigin } from "../../src/shared/types.ts";
import { PRODUCT_IDS } from "../../src/shared/types.ts";

describe("parseConfiguredOrigin", () => {
  test("normalises case, drops the trailing slash, keeps the port", () => {
    expect(parseConfiguredOrigin("HTTPS://Corp.Example:8443/", "jira")).toEqual({
      origin: "https://corp.example:8443",
      product: "jira",
    });
  });
  test("keeps a path prefix and strips its trailing slash", () => {
    expect(parseConfiguredOrigin("https://corp.example/jenkins/", "jenkins")).toEqual({
      origin: "https://corp.example/jenkins",
      product: "jenkins",
    });
  });
  test("drops query and fragment", () => {
    expect(parseConfiguredOrigin("https://corp.example/jira?a=1#top", "jira")?.origin).toBe(
      "https://corp.example/jira",
    );
  });
  test("lowercases the host but PRESERVES path case", () => {
    expect(parseConfiguredOrigin("https://Corp.Example/Jenkins", "jenkins")?.origin).toBe(
      "https://corp.example/Jenkins",
    );
  });
  test("collapses repeated trailing slashes to one canonical entry", () => {
    // Otherwise "/jira//" and "/jira" become two entries dedupe can't reconcile,
    // and which one wins a match depends on insertion order.
    expect(parseConfiguredOrigin("https://corp.example/jira//", "jira")?.origin).toBe(
      "https://corp.example/jira",
    );
    expect(parseConfiguredOrigin("https://corp.example///", "jira")?.origin).toBe(
      "https://corp.example",
    );
  });
  test("rejects a non-http(s) scheme", () => {
    expect(parseConfiguredOrigin("ftp://corp.example", "jira")).toBeNull();
  });
  test("rejects input with no scheme (the UI must ask for a full URL)", () => {
    expect(parseConfiguredOrigin("corp.example/jira", "jira")).toBeNull();
  });
});

describe("splitOrigin", () => {
  test("a bare host has an empty prefix", () => {
    expect(splitOrigin("https://github.com")).toEqual({ base: "https://github.com", prefix: "" });
  });
  test("a default port is dropped by the URL parser", () => {
    expect(splitOrigin("https://corp.example:443/jira")).toEqual({
      base: "https://corp.example",
      prefix: "/jira",
    });
  });
  test("strips every trailing slash, not just one", () => {
    expect(splitOrigin("https://corp.example/jira//")).toEqual({
      base: "https://corp.example",
      prefix: "/jira",
    });
  });
  test("keeps interior slashes and a path that is only slashes collapses to empty", () => {
    expect(splitOrigin("https://corp.example/a//b/")?.prefix).toBe("/a//b");
    expect(splitOrigin("https://corp.example///")?.prefix).toBe("");
  });
  test("stays linear on a long slash run that does not reach the end", () => {
    // The shape that made the old `replace(/\/+$/, "")` quadratic: the engine
    // matched the run, failed `$`, gave a character back, failed again, then
    // restarted the whole walk from the next position in the run. 20 000 slashes
    // took 90 ms and 40 000 took 363 ms — 2x input for 4x time.
    //
    // This is user-reachable: the string comes from `new URL()` over whatever is
    // pasted into the options page. It is also re-paid on every use rather than
    // once at entry, because a stored origin is re-split on every page recognition
    // and once per row when the surfaces list renders.
    const origin = `https://corp.example/${"/".repeat(40_000)}a`;
    const started = performance.now();
    const split = splitOrigin(origin);
    expect(performance.now() - started).toBeLessThan(50);
    // Correctness alongside the bound: no trailing slash to strip here, so the
    // path is returned intact rather than truncated by the scan.
    expect(split?.prefix.endsWith("a")).toBe(true);
  });
});

describe("upsertOrigin / removeConfiguredOrigin", () => {
  const jira: ConfiguredOrigin = { origin: "https://corp.example/jira", product: "jira" };
  const jenkins: ConfiguredOrigin = { origin: "https://corp.example/jenkins", product: "jenkins" };

  test("two prefixed entries coexist on one host", () => {
    const list = upsertOrigin(upsertOrigin([], jira), jenkins);
    expect(list).toHaveLength(2);
  });
  test("re-adding the same origin+prefix replaces its product", () => {
    const list = upsertOrigin(upsertOrigin([], jira), {
      origin: "https://corp.example/jira",
      product: "jenkins",
    });
    expect(list).toEqual([{ origin: "https://corp.example/jira", product: "jenkins" }]);
  });
  test("remove drops only the matching entry", () => {
    const list = removeConfiguredOrigin([jira, jenkins], "https://corp.example/jira");
    expect(list).toEqual([jenkins]);
  });
});

describe("matchOrigin", () => {
  const bare: ConfiguredOrigin = { origin: "https://corp.example", product: "github" };
  const jira: ConfiguredOrigin = { origin: "https://corp.example/jira", product: "jira" };
  const jenkins: ConfiguredOrigin = { origin: "https://corp.example/jenkins", product: "jenkins" };

  test("longest prefix wins over a bare host entry", () => {
    const m = matchOrigin([bare, jira], new URL("https://corp.example/jira/browse/ABC-1"));
    expect(m?.product).toBe("jira");
  });
  test("picks the right product among sibling prefixes on one host", () => {
    const m = matchOrigin([jira, jenkins], new URL("https://corp.example/jenkins/job/web/42"));
    expect(m?.product).toBe("jenkins");
  });
  test("a prefix does not match a lookalike sibling path", () => {
    expect(matchOrigin([jira], new URL("https://corp.example/jiraffe/browse/ABC-1"))).toBeNull();
  });
  test("the prefix itself matches with no trailing path", () => {
    expect(matchOrigin([jira], new URL("https://corp.example/jira"))?.product).toBe("jira");
  });
  test("a different port is a different origin", () => {
    expect(matchOrigin([bare], new URL("https://corp.example:8443/x"))).toBeNull();
  });
  test("path prefixes are case-SENSITIVE — /Jenkins is not /jenkins", () => {
    const upper: ConfiguredOrigin = { origin: "https://corp.example/Jenkins", product: "jenkins" };
    expect(matchOrigin([upper], new URL("https://corp.example/jenkins/job/web/1"))).toBeNull();
    expect(matchOrigin([upper], new URL("https://corp.example/Jenkins/job/web/1"))).not.toBeNull();
  });
});

describe("hostPermissionPattern", () => {
  test("the grant is host-scoped even when the origin carries a prefix", () => {
    expect(hostPermissionPattern("https://corp.example/jira")).toBe("https://corp.example/*");
  });
  test("drops the port — a match pattern's host may not contain one", () => {
    // Self-hosted Bitbucket Server / Jenkins on :8443 / :8080 is the normal case
    // here. A pattern carrying the port is invalid and permissions.request fails.
    expect(hostPermissionPattern("https://stash.corp.example:8443")).toBe(
      "https://stash.corp.example/*",
    );
    expect(hostPermissionPattern("http://jenkins.corp.example:8080/jenkins")).toBe(
      "http://jenkins.corp.example/*",
    );
  });
  test("invalid input has no pattern", () => {
    expect(hostPermissionPattern("not a url")).toBeNull();
  });
});

describe("isConfiguredOrigin", () => {
  test("accepts a valid entry", () => {
    expect(isConfiguredOrigin({ origin: "https://github.com", product: "github" })).toBe(true);
  });
  test("rejects an unknown product", () => {
    expect(isConfiguredOrigin({ origin: "https://github.com", product: "svn" })).toBe(false);
  });
  test("rejects a non-object", () => {
    expect(isConfiguredOrigin("https://github.com")).toBe(false);
  });
});

describe("patternMatchesUrl", () => {
  test("exact host pattern matches its own host, any port and any path", () => {
    expect(patternMatchesUrl("https://github.com/*", "https://github.com/acme/web/pull/1")).toBe(
      true,
    );
    expect(
      patternMatchesUrl("http://corp.example/*", "http://corp.example:8080/jenkins/job/x"),
    ).toBe(true);
  });

  test("exact host pattern does not match a subdomain", () => {
    expect(patternMatchesUrl("https://github.com/*", "https://gist.github.com/x")).toBe(false);
  });

  test("scheme must match", () => {
    expect(patternMatchesUrl("https://github.com/*", "http://github.com/x")).toBe(false);
  });

  test("subdomain wildcard matches any tenant and the bare host", () => {
    expect(
      patternMatchesUrl("https://*.atlassian.net/*", "https://acme.atlassian.net/browse/ABC-1"),
    ).toBe(true);
    expect(patternMatchesUrl("https://*.atlassian.net/*", "https://atlassian.net/x")).toBe(true);
  });

  test("subdomain wildcard does not match a lookalike suffix", () => {
    expect(patternMatchesUrl("https://*.atlassian.net/*", "https://evilatlassian.net/x")).toBe(
      false,
    );
  });

  test("host comparison is case-insensitive", () => {
    expect(patternMatchesUrl("https://github.com/*", "https://GitHub.com/x")).toBe(true);
  });

  test("rejects anything that is not a plain host pattern", () => {
    expect(patternMatchesUrl("<all_urls>", "https://github.com/x")).toBe(false);
    expect(patternMatchesUrl("*://github.com/*", "https://github.com/x")).toBe(false);
    expect(patternMatchesUrl("https://github.com/acme/*", "https://github.com/acme/x")).toBe(false);
  });

  test("a non-URL never matches", () => {
    expect(patternMatchesUrl("https://github.com/*", "not a url")).toBe(false);
  });
});

describe("isProduct is derived from the declared product ids", () => {
  it("accepts every declared id", () => {
    for (const id of PRODUCT_IDS) {
      expect(isProduct(id)).toBe(true);
    }
  });

  it("rejects a product this client does not recognise yet", () => {
    // "slack" is a real bundled gateway connector (see
    // Nimbus/packages/gateway/src/connectors/bundled-connector-registry.ts) but
    // no roadmap slice plans a Slack recogniser — not for want of a URL to
    // recognise: slack-sync.ts stores `<team>.slack.com/archives/<C…>/p<ts>` as
    // each message's canonicalUrl, structurally the same tenant-suffix shape as
    // PagerDuty's. It is simply not planned, which makes it the right subject
    // here: "confluence" and "pagerduty" were this same placeholder in earlier
    // slices until each got a rule. It must be false TODAY — otherwise the guard
    // is accepting arbitrary strings and the stored-origin validation it backs
    // is decorative.
    expect(isProduct("slack")).toBe(false);
    expect(isProduct("")).toBe(false);
    expect(isProduct(undefined)).toBe(false);
  });
});
