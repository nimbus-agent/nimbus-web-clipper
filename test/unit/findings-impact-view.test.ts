/** @vitest-environment jsdom */
import { describe, expect, test } from "vitest";
import { renderImpactFindings } from "../../src/panel/findings/impact-view.ts";
import type { ImpactFindings } from "../../src/shared/findings.ts";

function affected(over: Record<string, unknown> = {}) {
  return {
    category: "service" as const,
    affectedItemId: "entity:456",
    affectedTitle: "billing-service",
    serviceId: "billing",
    hops: 1,
    pathSummary: "billing-service depends directly on payments-api",
    ...over,
  };
}

function findings(over: Partial<ImpactFindings> = {}): ImpactFindings {
  return { kind: "impact", startEntityId: "entity:123", affected: [affected()], ...over };
}

describe("renderImpactFindings", () => {
  test("renders one group per category, titled by the category", () => {
    const el = renderImpactFindings(document, findings(), 0);
    const groups = el.querySelectorAll(".nimbus-findings__group");
    expect(groups).toHaveLength(1);
    expect(el.textContent).toContain("billing-service");
  });

  test("groups distinct categories into separate group boxes", () => {
    const el = renderImpactFindings(
      document,
      findings({
        affected: [
          affected({ category: "service", affectedTitle: "billing-service" }),
          affected({ category: "pipeline", affectedTitle: "deploy-billing" }),
        ],
      }),
      0,
    );
    expect(el.querySelectorAll(".nimbus-findings__group")).toHaveLength(2);
  });

  test("groups multiple findings sharing a category into one group box", () => {
    const el = renderImpactFindings(
      document,
      findings({
        affected: [
          affected({ affectedTitle: "billing-service" }),
          affected({ affectedTitle: "payments-service" }),
        ],
      }),
      0,
    );
    const groups = el.querySelectorAll(".nimbus-findings__group");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.querySelectorAll(".nimbus-findings__item")).toHaveLength(2);
  });

  test("renders affectedTitle, serviceId and a hops badge on the row", () => {
    const el = renderImpactFindings(document, findings(), 0);
    const item = el.querySelector(".nimbus-findings__item");
    expect(item?.textContent).toContain("billing-service");
    expect(item?.textContent).toContain("billing");
    const badge = item?.querySelector(".nimbus-findings__badge");
    expect(badge?.textContent).toBe("1 hop");
  });

  test("pluralizes the hops badge for more than one hop", () => {
    const el = renderImpactFindings(document, findings({ affected: [affected({ hops: 3 })] }), 0);
    const badge = el.querySelector(".nimbus-findings__badge");
    expect(badge?.textContent).toBe("3 hops");
  });

  test("renders pathSummary as the detail line", () => {
    const el = renderImpactFindings(document, findings(), 0);
    const detail = el.querySelector(".nimbus-findings__item-detail");
    expect(detail?.textContent).toBe("billing-service depends directly on payments-api");
  });

  test("never renders affectedItemId anywhere - it is not an item id", () => {
    const el = renderImpactFindings(document, findings(), 0);
    expect(el.textContent).not.toContain("entity:456");
  });

  test("renders no links anywhere - this lane is link-less", () => {
    const el = renderImpactFindings(document, findings(), 0);
    expect(el.querySelector("a")).toBeNull();
  });

  test("renders the empty-state line when affected is empty, never a blank box", () => {
    const el = renderImpactFindings(document, findings({ affected: [] }), 0);
    const empty = el.querySelector(".nimbus-findings__empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe("Nothing downstream of this is indexed.");
  });

  test("says the start did not resolve when startEntityId is null, distinct from empty", () => {
    const el = renderImpactFindings(document, findings({ startEntityId: null, affected: [] }), 0);
    expect(el.textContent).toMatch(/did not resolve/i);
    // Still says nothing was found - the two facts are both true and both shown.
    const empty = el.querySelector(".nimbus-findings__empty");
    expect(empty?.textContent).toBe("Nothing downstream of this is indexed.");
  });

  test("reports the unresolved start even when affected is non-empty", () => {
    const el = renderImpactFindings(document, findings({ startEntityId: null }), 0);
    expect(el.textContent).toMatch(/did not resolve/i);
    expect(el.querySelectorAll(".nimbus-findings__group")).toHaveLength(1);
  });

  test("never parses affectedTitle or pathSummary as markup", () => {
    const el = renderImpactFindings(
      document,
      findings({
        affected: [
          affected({
            affectedTitle: "<img src=x onerror=1>",
            pathSummary: "<img src=y onerror=2>",
          }),
        ],
      }),
      0,
    );
    expect(el.querySelector("img")).toBeNull();
  });
});
