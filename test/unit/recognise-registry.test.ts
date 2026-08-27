// The guards that replace a human's diligence now that six tables are one.
import { describe, expect, it } from "vitest";
import { hostPermissionPattern } from "../../src/shared/origins.ts";
import { BUILT_IN_ORIGINS, BUILT_IN_SURFACES } from "../../src/shared/recognise/index.ts";
import {
  PRODUCT_RULES,
  productName,
  RULE_BY_PRODUCT,
} from "../../src/shared/recognise/registry.ts";
import { PRODUCT_IDS } from "../../src/shared/types.ts";

describe("the registry covers exactly the declared products", () => {
  it("has one rule per declared id, keyed by its own product", () => {
    expect(Object.keys(RULE_BY_PRODUCT).sort()).toEqual([...PRODUCT_IDS].sort());
    for (const [key, rule] of Object.entries(RULE_BY_PRODUCT)) {
      // A copy-paste rule under the wrong key typechecks: `github: gitlabRule`
      // is a valid `Record<Product, ProductRule>` and would ask the wrong
      // connector on every GitHub page.
      expect(rule.product).toBe(key);
    }
  });

  it("gives every rule a non-empty service id and display name", () => {
    for (const rule of PRODUCT_RULES) {
      expect(rule.serviceId).not.toBe("");
      expect(rule.name).not.toBe("");
    }
  });

  it("declares every suffix host as a dotted, multi-label suffix", () => {
    // The leading dot is a compile error to omit (`.${string}`); the label count
    // is not, and `suffix: ".net"` would claim every .net host on the internet.
    for (const rule of PRODUCT_RULES) {
      for (const host of rule.hosts) {
        if (host.kind !== "suffix") continue;
        expect(host.suffix.startsWith(".")).toBe(true);
        expect(host.suffix.slice(1).split(".").length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("maps every product to a distinct service id", () => {
    const ids = PRODUCT_RULES.map((r) => r.serviceId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the built-in tables are derived, not copied", () => {
  it("lists exactly the origin host rules as built-in origins", () => {
    // Asserted as literal values, NOT by re-running the derivation — a test that
    // recomputes what it is checking passes for any implementation, including a
    // wrong one.
    expect([...BUILT_IN_ORIGINS]).toEqual([
      { origin: "https://bitbucket.org", product: "bitbucket" },
      { origin: "https://github.com", product: "github" },
      { origin: "https://gitlab.com", product: "gitlab" },
    ]);
  });

  it("gives every built-in host a surfaces row carrying its exact pattern", () => {
    for (const entry of BUILT_IN_ORIGINS) {
      const row = BUILT_IN_SURFACES.find((s) => s.product === entry.product);
      expect(row).toBeDefined();
      expect(row?.pattern).toBe(hostPermissionPattern(entry.origin));
    }
  });

  it("carries a row for a suffix host too, which has no origin to derive from", () => {
    const jira = BUILT_IN_SURFACES.find((s) => s.product === "jira");
    expect(jira?.label).toBe("*.atlassian.net");
    expect(jira?.pattern).toBe("https://*.atlassian.net/*");
  });

  it("lists no row for a product with no built-in host", () => {
    // Jenkins is self-hosted only: it must not appear in Options' built-in list,
    // where a row the user cannot act on is worse than no row.
    expect(BUILT_IN_SURFACES.find((s) => s.product === "jenkins")).toBeUndefined();
  });

  it("derives exactly four rows — no product invents one", () => {
    // Jenkins has no built-in host, so five products yield four rows. A derivation
    // that mapped over products instead of over their hosts would produce five.
    expect(BUILT_IN_SURFACES).toHaveLength(4);
  });
});

describe("productName", () => {
  it("names every declared product from the registry", () => {
    expect(productName("github")).toBe("GitHub");
    expect(productName("gitlab")).toBe("GitLab");
    expect(productName("bitbucket")).toBe("Bitbucket");
    expect(productName("jenkins")).toBe("Jenkins");
    expect(productName("jira")).toBe("Jira");
  });
});
