// The guards that replace a human's diligence now that six tables are one.
import { describe, expect, it } from "vitest";
import { BUILT_IN_ORIGINS, BUILT_IN_SURFACES } from "../../src/shared/recognise/index.ts";
import {
  PRODUCT_RULES,
  PRODUCT_SERVICE_ID,
  productName,
  RULE_BY_PRODUCT,
  SELF_HOSTABLE_PRODUCTS,
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
      { origin: "https://app.circleci.com", product: "circleci" },
      { origin: "https://github.com", product: "github" },
      { origin: "https://gitlab.com", product: "gitlab" },
    ]);
  });

  it("lists exactly these built-in surfaces rows", () => {
    // Asserted as literal values, NOT by re-running the derivation
    // (`hostPermissionPattern`) — a test that recomputes what it is checking
    // passes for any implementation, including a wrong one.
    expect([...BUILT_IN_SURFACES]).toEqual([
      { label: "bitbucket.org", product: "bitbucket", pattern: "https://bitbucket.org/*" },
      { label: "app.circleci.com", product: "circleci", pattern: "https://app.circleci.com/*" },
      { label: "github.com", product: "github", pattern: "https://github.com/*" },
      { label: "gitlab.com", product: "gitlab", pattern: "https://gitlab.com/*" },
      { label: "*.atlassian.net", product: "jira", pattern: "https://*.atlassian.net/*" },
    ]);
  });

  it("gives every built-in surface a distinct label", () => {
    // options.ts's onSurfaceClick routes a grant/revoke click by
    // `BUILT_IN_SURFACES.find((s) => s.label === origin)` — two products
    // declaring the same host would silently route one product's button to the
    // other's pattern.
    const labels = BUILT_IN_SURFACES.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
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

  it("derives exactly five rows — no product invents one", () => {
    // Jenkins has no built-in host, so six products yield five rows. A derivation
    // that mapped over products instead of over their hosts would produce six.
    expect(BUILT_IN_SURFACES).toHaveLength(5);
  });
});

describe("productName", () => {
  it("names every declared product from the registry", () => {
    expect(productName("circleci")).toBe("CircleCI");
    expect(productName("github")).toBe("GitHub");
    expect(productName("gitlab")).toBe("GitLab");
    expect(productName("bitbucket")).toBe("Bitbucket");
    expect(productName("jenkins")).toBe("Jenkins");
    expect(productName("jira")).toBe("Jira");
  });
});

describe("PRODUCT_SERVICE_ID", () => {
  it("is each rule's own service id", () => {
    // Asserted as a literal value, NOT by re-deriving it from `PRODUCT_RULES` —
    // a test that recomputes the map from the same rules it is checking cannot
    // fail, and it pins nothing about what each service id actually is.
    expect(PRODUCT_SERVICE_ID).toEqual({
      bitbucket: "bitbucket",
      circleci: "circleci",
      github: "github",
      gitlab: "gitlab",
      jenkins: "jenkins",
      jira: "jira",
    });
  });
});

describe("the self-hosted product picker is derived, not hand-written", () => {
  it("offers exactly the products that have a self-hosted edition", () => {
    // Asserted as literal ids, not by re-running the filter: a test that
    // recomputes the derivation passes for any implementation, including a
    // wrong one.
    expect(SELF_HOSTABLE_PRODUCTS.map((r) => r.product)).toEqual([
      "bitbucket",
      "circleci",
      "github",
      "gitlab",
      "jenkins",
      "jira",
    ]);
  });

  it("gives every product a corpus noun", () => {
    for (const rule of PRODUCT_RULES) {
      expect(rule.corpus).not.toBe("");
    }
  });
});
