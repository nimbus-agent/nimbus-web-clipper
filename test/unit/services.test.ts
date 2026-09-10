// test/unit/services.test.ts
import { describe, expect, test } from "vitest";
import type { ServiceBinding } from "../../src/shared/services.ts";
import {
  bindingKey,
  findBinding,
  guessServiceId,
  isServiceBinding,
  removeBinding,
  upsertBinding,
} from "../../src/shared/services.ts";

const b = (scope: string, serviceId: string): ServiceBinding => ({
  product: "github",
  scope,
  serviceId,
});

describe("isServiceBinding", () => {
  test("accepts a minimal binding", () => {
    expect(isServiceBinding({ product: "github", scope: "acme/web", serviceId: "web" })).toBe(true);
  });
  test("accepts an optional defaultBranch", () => {
    expect(
      isServiceBinding({
        product: "github",
        scope: "acme/web",
        serviceId: "web",
        defaultBranch: "main",
      }),
    ).toBe(true);
  });
  test("rejects an unknown product", () => {
    expect(isServiceBinding({ product: "nope", scope: "a", serviceId: "b" })).toBe(false);
  });
  test("rejects an empty scope", () => {
    expect(isServiceBinding({ product: "github", scope: "", serviceId: "b" })).toBe(false);
  });
  test("rejects a serviceId past the route's 64-char bound", () => {
    expect(isServiceBinding({ product: "github", scope: "a", serviceId: "x".repeat(65) })).toBe(
      false,
    );
  });
  test("rejects a non-string defaultBranch rather than dropping it", () => {
    expect(
      isServiceBinding({ product: "github", scope: "a", serviceId: "b", defaultBranch: 7 }),
    ).toBe(false);
  });
  // An EMPTY defaultBranch is worse than an absent one: `"" ?? "HEAD"` is `""`,
  // which fails the route's 1-char lower bound and turns every ask into a
  // malformed refusal. Absent must be the only way to say "no branch".
  test("rejects an empty defaultBranch", () => {
    expect(
      isServiceBinding({ product: "github", scope: "a", serviceId: "b", defaultBranch: "" }),
    ).toBe(false);
  });
  test("rejects a defaultBranch past the route's 255-char bound", () => {
    expect(
      isServiceBinding({
        product: "github",
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
  test("bindingKey joins product and scope", () => {
    expect(bindingKey("github", "acme/web")).toBe("github:acme/web");
  });
  test("findBinding matches on product AND scope", () => {
    const list = [b("acme/web", "web")];
    expect(findBinding(list, "github", "acme/web")?.serviceId).toBe("web");
    expect(findBinding(list, "gitlab", "acme/web")).toBeNull();
    expect(findBinding(list, "github", "acme/other")).toBeNull();
  });
  test("upsertBinding replaces by key rather than appending a duplicate", () => {
    const list = upsertBinding([b("acme/web", "web")], b("acme/web", "payments"));
    expect(list).toHaveLength(1);
    expect(list[0]?.serviceId).toBe("payments");
  });
  test("removeBinding drops only the matching key", () => {
    const list = removeBinding([b("acme/web", "web"), b("acme/api", "api")], "github", "acme/web");
    expect(list.map((x) => x.scope)).toEqual(["acme/api"]);
  });
});
