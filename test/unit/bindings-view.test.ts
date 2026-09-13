// @vitest-environment jsdom
// test/unit/bindings-view.test.ts
import { describe, expect, test, vi } from "vitest";
import { renderBindingsError, renderBindingsTable } from "../../src/options/bindings-view.ts";
import type { ServiceBinding } from "../../src/shared/services.ts";
import { bindingKey } from "../../src/shared/services.ts";

const NOOP = (): void => undefined;

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

describe("renderBindingsTable status (C10.3 slice 2)", () => {
  test("renders a status cell per row, and a correction only for disagrees", () => {
    const bindings = [
      { product: "github" as const, origin: "https://github.com", scope: "acme/a", serviceId: "a" },
      {
        product: "github" as const,
        origin: "https://github.com",
        scope: "acme/b",
        serviceId: "old",
      },
    ];
    const statuses = new Map([
      [bindingKey("https://github.com", "github", "acme/a"), { state: "agrees" } as const],
      [
        bindingKey("https://github.com", "github", "acme/b"),
        { state: "disagrees", proposedServiceId: "new" } as const,
      ],
    ]);
    const table = renderBindingsTable(bindings, NOOP, statuses, NOOP);
    const text = table.textContent ?? "";
    expect(text).toMatch(/new/);
    expect(table.querySelectorAll("button[data-proposed]").length).toBe(1);
  });

  test("the correction button reports the binding and the proposed id", () => {
    const binding = {
      product: "github" as const,
      origin: "https://github.com",
      scope: "acme/b",
      serviceId: "old",
    };
    const statuses = new Map([
      [
        bindingKey(binding.origin, binding.product, binding.scope),
        { state: "disagrees", proposedServiceId: "new" } as const,
      ],
    ]);
    const seen: Array<[string, string]> = [];
    const table = renderBindingsTable([binding], NOOP, statuses, (b, id) => {
      seen.push([b.scope, id]);
    });
    (table.querySelector("button[data-proposed]") as HTMLButtonElement).click();
    expect(seen).toEqual([["acme/b", "new"]]);
  });

  test("unchecked says could not check, never that the binding is wrong", () => {
    const bindings = [
      { product: "github" as const, origin: "https://github.com", scope: "acme/a", serviceId: "a" },
    ];
    const statuses = new Map([
      [
        bindingKey("https://github.com", "github", "acme/a"),
        { state: "unchecked", reason: "insufficient_scope" } as const,
      ],
    ]);
    const text = renderBindingsTable(bindings, NOOP, statuses, NOOP).textContent ?? "";
    expect(text).toMatch(/could not check|resolve. scope/i);
    expect(text).not.toMatch(/wrong|incorrect|invalid/i);
  });

  test("with no statuses the table renders exactly as before", () => {
    const bindings = [
      { product: "github" as const, origin: "https://github.com", scope: "acme/a", serviceId: "a" },
    ];
    const table = renderBindingsTable(bindings, NOOP);
    expect(table.querySelectorAll("button[data-proposed]").length).toBe(0);
    // Not just "no correction button" — no Status COLUMN at all. A regression
    // that always rendered the header (with empty, button-less cells) would
    // still pass the assertion above, so the header itself has to be checked.
    expect(table.textContent).not.toMatch(/Status/);
    expect(table.querySelectorAll("thead th")).toHaveLength(6);
  });
});
