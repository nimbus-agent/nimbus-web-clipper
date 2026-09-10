// @vitest-environment jsdom
// test/unit/bindings-view.test.ts
import { describe, expect, test, vi } from "vitest";
import { renderBindingsError, renderBindingsTable } from "../../src/options/bindings-view.ts";
import type { ServiceBinding } from "../../src/shared/services.ts";

const list: ServiceBinding[] = [
  { product: "github", scope: "acme/web", serviceId: "web" },
  { product: "jenkins", scope: "platform/api", serviceId: "api", defaultBranch: "release" },
];

describe("renderBindingsTable", () => {
  test("empty says so rather than rendering a headed empty table", () => {
    const el = renderBindingsTable([], () => undefined);
    expect(el.querySelector("tbody")).toBeNull();
    expect(el.textContent).toMatch(/no service bindings/i);
  });

  test("one row per binding, showing scope and service", () => {
    const el = renderBindingsTable(list, () => undefined);
    expect(el.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(el.textContent).toContain("acme/web");
    expect(el.textContent).toContain("platform/api");
    expect(el.textContent).toContain("release");
  });

  test("unbind hands back the whole binding, not a rebuilt key", () => {
    const onUnbind = vi.fn();
    const el = renderBindingsTable(list, onUnbind);
    el.querySelectorAll("button")[0]?.click();
    expect(onUnbind).toHaveBeenCalledWith(list[0]);
  });

  test("a scope is written with textContent, never as markup", () => {
    const el = renderBindingsTable(
      [{ product: "github", scope: "<img src=x onerror=alert(1)>", serviceId: "s" }],
      () => undefined,
    );
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("renderBindingsError", () => {
  // The `ok: false` arm is a failed READ, distinct from "you have no
  // bindings" — it must never look like the empty-list state above, or a user
  // whose storage read failed would be told (and might act on) the wrong thing.
  test("says the read failed, not that there is nothing to show", () => {
    const el = renderBindingsError();
    expect(el.querySelector("table")).toBeNull();
    expect(el.textContent).not.toMatch(/no service bindings/i);
    expect(el.textContent).toMatch(/could not read/i);
  });
});
