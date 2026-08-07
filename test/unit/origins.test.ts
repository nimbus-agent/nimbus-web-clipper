// test/unit/origins.test.ts
import { describe, expect, test } from "vitest";
import {
  hostPermissionPattern,
  isConfiguredOrigin,
  matchOrigin,
  parseConfiguredOrigin,
  removeConfiguredOrigin,
  splitOrigin,
  upsertOrigin,
} from "../../src/shared/origins.ts";
import type { ConfiguredOrigin } from "../../src/shared/types.ts";

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
