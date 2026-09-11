// test/unit/services.test.ts
import { describe, expect, test } from "vitest";
import type { ServiceBinding } from "../../src/shared/services.ts";
import {
  bindingKey,
  findBinding,
  guessServiceId,
  isServiceBinding,
  MAX_SCOPE_LEN,
  removeBinding,
  upsertBinding,
} from "../../src/shared/services.ts";

const ORIGIN = "https://github.com";

const b = (
  scope: string,
  serviceId: string,
  origin: string = ORIGIN,
  product: ServiceBinding["product"] = "github",
): ServiceBinding => ({
  product,
  origin,
  scope,
  serviceId,
});

describe("isServiceBinding", () => {
  test("accepts a minimal binding", () => {
    expect(
      isServiceBinding({ product: "github", origin: ORIGIN, scope: "acme/web", serviceId: "web" }),
    ).toBe(true);
  });
  test("accepts an optional defaultBranch", () => {
    expect(
      isServiceBinding({
        product: "github",
        origin: ORIGIN,
        scope: "acme/web",
        serviceId: "web",
        defaultBranch: "main",
      }),
    ).toBe(true);
  });
  test("rejects an unknown product", () => {
    expect(isServiceBinding({ product: "nope", origin: ORIGIN, scope: "a", serviceId: "b" })).toBe(
      false,
    );
  });
  test("rejects a missing origin", () => {
    expect(isServiceBinding({ product: "github", scope: "a", serviceId: "b" })).toBe(false);
  });
  test("rejects an empty origin", () => {
    expect(isServiceBinding({ product: "github", origin: "", scope: "a", serviceId: "b" })).toBe(
      false,
    );
  });
  // Bounded exactly like `scope`, for the same storage-quota reason — see
  // `isServiceBinding`'s doc comment.
  test("rejects an origin past MAX_SCOPE_LEN", () => {
    expect(
      isServiceBinding({
        product: "github",
        origin: `https://${"x".repeat(MAX_SCOPE_LEN)}`,
        scope: "a",
        serviceId: "b",
      }),
    ).toBe(false);
  });
  test("rejects an empty scope", () => {
    expect(isServiceBinding({ product: "github", origin: ORIGIN, scope: "", serviceId: "b" })).toBe(
      false,
    );
  });
  // `chrome.storage.local` is one quota shared with the clip queue and the
  // connection record. `scope` is the one field a page-supplied message carries
  // into it, so it is bounded here even though the gateway never sees it.
  test("rejects a scope past MAX_SCOPE_LEN", () => {
    expect(
      isServiceBinding({
        product: "github",
        origin: ORIGIN,
        scope: "x".repeat(MAX_SCOPE_LEN + 1),
        serviceId: "b",
      }),
    ).toBe(false);
    expect(
      isServiceBinding({
        product: "github",
        origin: ORIGIN,
        scope: "x".repeat(MAX_SCOPE_LEN),
        serviceId: "b",
      }),
    ).toBe(true);
  });
  test("rejects a serviceId past the route's 64-char bound", () => {
    expect(
      isServiceBinding({
        product: "github",
        origin: ORIGIN,
        scope: "a",
        serviceId: "x".repeat(65),
      }),
    ).toBe(false);
  });
  test("rejects a non-string defaultBranch rather than dropping it", () => {
    expect(
      isServiceBinding({
        product: "github",
        origin: ORIGIN,
        scope: "a",
        serviceId: "b",
        defaultBranch: 7,
      }),
    ).toBe(false);
  });
  // An EMPTY defaultBranch is worse than an absent one: `"" ?? "HEAD"` is `""`,
  // which fails the route's 1-char lower bound and turns every ask into a
  // malformed refusal. Absent must be the only way to say "no branch".
  test("rejects an empty defaultBranch", () => {
    expect(
      isServiceBinding({
        product: "github",
        origin: ORIGIN,
        scope: "a",
        serviceId: "b",
        defaultBranch: "",
      }),
    ).toBe(false);
  });
  test("rejects a defaultBranch past the route's 255-char bound", () => {
    expect(
      isServiceBinding({
        product: "github",
        origin: ORIGIN,
        scope: "a",
        serviceId: "b",
        defaultBranch: "x".repeat(256),
      }),
    ).toBe(false);
  });
  test("rejects a non-object", () => {
    expect(isServiceBinding(null)).toBe(false);
  });
});

describe("guessServiceId", () => {
  test("takes the last path segment of a forge scope", () => {
    expect(guessServiceId("acme/payments-api")).toBe("payments-api");
  });
  test("takes the last segment of a nested gitlab project", () => {
    expect(guessServiceId("acme/team/web")).toBe("web");
  });
  test("takes the last segment of a jenkins job path", () => {
    expect(guessServiceId("platform/web")).toBe("web");
  });
  test("returns a scope with no separator unchanged", () => {
    expect(guessServiceId("web")).toBe("web");
  });
  test("truncates to the route's bound so the guess is always sendable", () => {
    expect(guessServiceId("x".repeat(100))).toHaveLength(64);
  });
});

describe("the binding list", () => {
  test("bindingKey joins origin, product and scope", () => {
    expect(bindingKey(ORIGIN, "github", "acme/web")).toBe(`${ORIGIN}:github:acme/web`);
  });
  test("findBinding matches on origin AND product AND scope", () => {
    const list = [b("acme/web", "web")];
    expect(findBinding(list, ORIGIN, "github", "acme/web")?.serviceId).toBe("web");
    expect(findBinding(list, ORIGIN, "gitlab", "acme/web")).toBeNull();
    expect(findBinding(list, ORIGIN, "github", "acme/other")).toBeNull();
    expect(findBinding(list, "https://corp.example/jenkins", "github", "acme/web")).toBeNull();
  });
  // The bug this fix exists for: two self-hosted instances of one product
  // (`upsertOrigin` dedupes by origin, not by product, so both are a supported
  // configuration) must never share a binding just because they carry the same
  // scope. Both `findBinding` and `bindingKey` must tell them apart.
  test("findBinding distinguishes two bindings that differ only by origin", () => {
    const jenkinsA = "https://jenkins.dev.local";
    const jenkinsB = "https://jenkins.prod.local";
    const list = [
      { product: "jenkins", origin: jenkinsA, scope: "platform/web", serviceId: "web-dev" },
      { product: "jenkins", origin: jenkinsB, scope: "platform/web", serviceId: "web-prod" },
    ] as const;
    expect(findBinding(list, jenkinsA, "jenkins", "platform/web")?.serviceId).toBe("web-dev");
    expect(findBinding(list, jenkinsB, "jenkins", "platform/web")?.serviceId).toBe("web-prod");
    expect(bindingKey(jenkinsA, "jenkins", "platform/web")).not.toBe(
      bindingKey(jenkinsB, "jenkins", "platform/web"),
    );
  });
  test("upsertBinding replaces by key rather than appending a duplicate", () => {
    const list = upsertBinding([b("acme/web", "web")], b("acme/web", "payments"));
    expect(list).toHaveLength(1);
    expect(list[0]?.serviceId).toBe("payments");
  });
  test("upsertBinding keeps two bindings that differ only by origin, both", () => {
    const list = upsertBinding(
      [b("platform/web", "web-dev", "https://jenkins.dev.local")],
      b("platform/web", "web-prod", "https://jenkins.prod.local"),
    );
    expect(list).toHaveLength(2);
  });
  test("removeBinding drops only the matching key", () => {
    const list = removeBinding(
      [b("acme/web", "web"), b("acme/api", "api")],
      ORIGIN,
      "github",
      "acme/web",
    );
    expect(list.map((x) => x.scope)).toEqual(["acme/api"]);
  });
  test("removeBinding leaves the other instance's binding alone", () => {
    const jenkinsA = "https://jenkins.dev.local";
    const jenkinsB = "https://jenkins.prod.local";
    const list = removeBinding(
      [
        b("platform/web", "web-dev", jenkinsA, "jenkins"),
        b("platform/web", "web-prod", jenkinsB, "jenkins"),
      ],
      jenkinsA,
      "jenkins",
      "platform/web",
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.origin).toBe(jenkinsB);
  });
});
