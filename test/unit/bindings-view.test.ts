// @vitest-environment jsdom
// test/unit/bindings-view.test.ts
import { describe, expect, test, vi } from "vitest";
import { renderBindingsError, renderBindingsTable } from "../../src/options/bindings-view.ts";
import type { ServiceBinding } from "../../src/shared/services.ts";

const list: ServiceBinding[] = [
  { product: "github", origin: "https://github.com", scope: "acme/web", serviceId: "web" },
  {
    product: "jenkins",
    origin: "https://jenkins.prod.local",
    scope: "platform/api",
    serviceId: "api",
    defaultBranch: "release",
  },
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
      [
        {
          product: "github",
          origin: "https://github.com",
          scope: "<img src=x onerror=alert(1)>",
          serviceId: "s",
        },
      ],
      () => undefined,
    );
    expect(el.querySelector("img")).toBeNull();
  });

  test("shows the origin so two rows differing only by origin stay distinguishable", () => {
    const two: ServiceBinding[] = [
      {
        product: "jenkins",
        origin: "https://jenkins.dev.local",
        scope: "platform/web",
        serviceId: "web-dev",
      },
      {
        product: "jenkins",
        origin: "https://jenkins.prod.local",
        scope: "platform/web",
        serviceId: "web-prod",
      },
    ];
    const el = renderBindingsTable(two, () => undefined);
    expect(el.textContent).toContain("https://jenkins.dev.local");
    expect(el.textContent).toContain("https://jenkins.prod.local");
  });

  // The same scope on two origins produced identical "Unbind" accessible names
  // before this field existed — a screen-reader user could not tell the rows
  // apart. The label must be unique across exactly that pair.
  test("the Unbind button's accessible name is unique across rows differing only by origin", () => {
    const two: ServiceBinding[] = [
      {
        product: "jenkins",
        origin: "https://jenkins.dev.local",
        scope: "platform/web",
        serviceId: "web-dev",
      },
      {
        product: "jenkins",
        origin: "https://jenkins.prod.local",
        scope: "platform/web",
        serviceId: "web-prod",
      },
    ];
    const el = renderBindingsTable(two, () => undefined);
    const buttons = [...el.querySelectorAll("button")];
    const labels = buttons.map((btn) => btn.getAttribute("aria-label"));
    expect(labels.every((l) => l !== null && l !== "")).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    // The visible text stays the plain "Unbind" — only the accessible name
    // carries the disambiguating detail.
    for (const btn of buttons) {
      expect(btn.textContent).toBe("Unbind");
    }
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
