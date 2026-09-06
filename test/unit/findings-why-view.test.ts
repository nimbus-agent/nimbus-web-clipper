/** @vitest-environment jsdom */
import { describe, expect, test } from "vitest";
import { renderWhyFindings } from "../../src/panel/findings/why-view.ts";
import type { WhyFindings } from "../../src/shared/findings.ts";

const NOW = 1_800_000_000_000;

function findings(over: Partial<WhyFindings> = {}): WhyFindings {
  return {
    kind: "why",
    findings: [],
    subject: null,
    changeSubject: null,
    itemSubject: null,
    ...over,
  };
}

describe("renderWhyFindings", () => {
  test("groups findings by lane, in the contract's order", () => {
    const el = renderWhyFindings(
      document,
      findings({
        findings: [
          {
            lane: "ticket",
            title: "T1",
            detail: "D1",
            url: null,
            occurredAt: null,
            entityId: null,
          },
          {
            lane: "authorship",
            title: "A1",
            detail: "D2",
            url: null,
            occurredAt: null,
            entityId: null,
          },
        ],
      }),
      NOW,
    );
    const titles = [...el.querySelectorAll(".nimbus-findings__group-title")].map(
      (n) => n.textContent,
    );
    // `authorship` precedes `ticket` in WhyLane, and the renderer follows that
    // rather than the order the gateway happened to emit.
    expect(titles[0]?.toLowerCase()).toContain("author");
  });

  test("links a finding whose url is safe", () => {
    const el = renderWhyFindings(
      document,
      findings({
        findings: [
          {
            lane: "pull_request",
            title: "PR",
            detail: "d",
            url: "https://x.test/1",
            occurredAt: null,
            entityId: null,
          },
        ],
      }),
      NOW,
    );
    const a = el.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://x.test/1");
    expect(a?.textContent).toBe("PR");
  });

  test("renders a javascript: url as text with no anchor", () => {
    const el = renderWhyFindings(
      document,
      findings({
        findings: [
          {
            lane: "driver",
            title: "X",
            detail: "d",
            url: "javascript:alert(1)",
            occurredAt: null,
            entityId: null,
          },
        ],
      }),
      NOW,
    );
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("X");
  });

  test("renders a relative age when occurredAt is present and nothing when it is null", () => {
    const withDate = renderWhyFindings(
      document,
      findings({
        findings: [
          {
            lane: "ticket",
            title: "T",
            detail: "d",
            url: null,
            occurredAt: NOW - 86_400_000,
            entityId: null,
          },
        ],
      }),
      NOW,
    );
    expect(withDate.querySelector(".nimbus-findings__item-when")).not.toBeNull();

    const without = renderWhyFindings(
      document,
      findings({
        findings: [
          { lane: "ticket", title: "T", detail: "d", url: null, occurredAt: null, entityId: null },
        ],
      }),
      NOW,
    );
    expect(without.querySelector(".nimbus-findings__item-when")).toBeNull();
  });

  test("renders the change subject as a link and the item subject's null url as text", () => {
    const change = renderWhyFindings(
      document,
      findings({
        changeSubject: {
          itemId: "github:a/b#1",
          entityId: "e",
          repo: "a/b",
          number: 1,
          url: "https://x.test/pr/1",
          title: "The PR",
          modifiedAt: null,
        },
      }),
      NOW,
    );
    expect(change.querySelector("a")?.getAttribute("href")).toBe("https://x.test/pr/1");

    const item = renderWhyFindings(
      document,
      findings({
        itemSubject: {
          itemId: "jira:X-1",
          entityId: "e",
          number: null,
          url: null,
          title: "The issue",
          modifiedAt: null,
          service: "jira",
          type: "issue",
        },
      }),
      NOW,
    );
    expect(item.querySelector("a")).toBeNull();
    expect(item.textContent).toContain("The issue");
  });

  test("renders an empty line when there are no findings", () => {
    const el = renderWhyFindings(document, findings(), NOW);
    expect(el.querySelector(".nimbus-findings__empty")).not.toBeNull();
  });

  test("never parses a title as markup", () => {
    const el = renderWhyFindings(
      document,
      findings({
        findings: [
          {
            lane: "ticket",
            title: "<img src=x onerror=1>",
            detail: "d",
            url: null,
            occurredAt: null,
            entityId: null,
          },
        ],
      }),
      NOW,
    );
    expect(el.querySelector("img")).toBeNull();
  });
});
