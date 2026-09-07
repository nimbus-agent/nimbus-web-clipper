/** @vitest-environment jsdom */
import { describe, expect, test } from "vitest";
import { renderOwnershipFindings } from "../../src/panel/findings/ownership-view.ts";
import type { OwnershipFindings } from "../../src/shared/findings.ts";

const NOW = 1_800_000_000_000;

function owner(over: Record<string, unknown> = {}) {
  return {
    externalId: "person:1",
    label: "Ada Lovelace",
    share: 0.6,
    resolved: true,
    ...over,
  };
}

function target(over: Record<string, unknown> = {}) {
  return {
    kind: "source_file" as const,
    displayPath: "src/index.ts",
    owners: [owner()],
    ownerCount: null,
    ownersAboveFloor: null,
    truncated: null,
    ...over,
  };
}

function coverage(over: Record<string, unknown> = {}) {
  return {
    lastPassAt: NOW - 3_600_000,
    lastDurationMs: 4200,
    rootsTotal: 3,
    rootsCovered: 3,
    rootsWithRemote: 2,
    filesCovered: 120,
    filesExcluded: 4,
    servicesBound: 2,
    ownersEmitted: 9,
    entitiesReaped: 1,
    ...over,
  };
}

function findings(over: Partial<OwnershipFindings> = {}): OwnershipFindings {
  return {
    kind: "ownership",
    target: target(),
    parentDirectory: null,
    coverage: coverage(),
    ...over,
  };
}

describe("renderOwnershipFindings", () => {
  test("renders the target's displayPath as the subject with a kind badge", () => {
    const el = renderOwnershipFindings(document, findings(), NOW);
    const subject = el.querySelector(".nimbus-findings__subject");
    expect(subject?.textContent).toContain("src/index.ts");
    expect(subject?.querySelector(".nimbus-findings__badge")?.textContent).toBe("File");
  });

  test("renders an owner row with the label and share as a percentage", () => {
    const el = renderOwnershipFindings(document, findings(), NOW);
    const row = el.querySelector(".nimbus-findings__item");
    expect(row?.textContent).toContain("Ada Lovelace");
    expect(row?.textContent).toContain("60%");
  });

  test("renders no unresolved badge for a resolved owner", () => {
    const el = renderOwnershipFindings(document, findings(), NOW);
    const row = el.querySelector(".nimbus-findings__item");
    expect(row?.querySelectorAll(".nimbus-findings__badge")).toHaveLength(0);
  });

  test("renders an unresolved badge when resolved is false", () => {
    const el = renderOwnershipFindings(
      document,
      findings({
        target: target({ owners: [owner({ resolved: false, label: "git:jane@example.com" })] }),
      }),
      NOW,
    );
    const row = el.querySelector(".nimbus-findings__item");
    expect(row?.textContent).toContain("git:jane@example.com");
    expect(row?.querySelector(".nimbus-findings__badge")?.textContent).toBe("unresolved");
  });

  test("renders no ownerCount/ownersAboveFloor line when both are null", () => {
    const el = renderOwnershipFindings(document, findings(), NOW);
    expect(el.textContent).not.toMatch(/of \d+ owners/);
  });

  test("renders the ownerCount/ownersAboveFloor line only when both are recorded", () => {
    const el = renderOwnershipFindings(
      document,
      findings({ target: target({ ownerCount: 4, ownersAboveFloor: 2 }) }),
      NOW,
    );
    expect(el.textContent).toContain("2 of 4 owners above the floor");
  });

  test("renders no truncation note when truncated is null", () => {
    const el = renderOwnershipFindings(
      document,
      findings({ target: target({ truncated: null }) }),
      NOW,
    );
    expect(el.textContent).not.toMatch(/truncated/i);
  });

  test("renders no truncation note when truncated is false", () => {
    const el = renderOwnershipFindings(
      document,
      findings({ target: target({ truncated: false }) }),
      NOW,
    );
    expect(el.textContent).not.toMatch(/truncated/i);
  });

  test("renders a truncation note only when truncated is true", () => {
    const el = renderOwnershipFindings(
      document,
      findings({ target: target({ truncated: true }) }),
      NOW,
    );
    expect(el.textContent).toMatch(/truncated/i);
  });

  test("renders parentDirectory as a secondary group when present", () => {
    const el = renderOwnershipFindings(
      document,
      findings({ parentDirectory: target({ kind: "directory", displayPath: "src" }) }),
      NOW,
    );
    const groups = el.querySelectorAll(".nimbus-findings__group");
    expect(groups).toHaveLength(2);
    expect(groups[1]?.textContent).toContain("Parent directory");
    expect(groups[1]?.textContent).toContain("src");
  });

  test("renders no parentDirectory group when it is null", () => {
    const el = renderOwnershipFindings(document, findings(), NOW);
    expect(el.querySelectorAll(".nimbus-findings__group")).toHaveLength(1);
  });

  test("renders a last-pass line from coverage.lastPassAt", () => {
    const el = renderOwnershipFindings(document, findings(), NOW);
    expect(el.textContent).toMatch(/last pass/i);
    expect(el.textContent).toContain("hour");
  });

  test("renders 'no pass recorded' when coverage.lastPassAt is null", () => {
    const el = renderOwnershipFindings(
      document,
      findings({ coverage: coverage({ lastPassAt: null }) }),
      NOW,
    );
    expect(el.textContent).toMatch(/no pass recorded/i);
  });

  test("renders the empty-owners line when owners is empty", () => {
    const el = renderOwnershipFindings(document, findings({ target: target({ owners: [] }) }), NOW);
    const empty = el.querySelector(".nimbus-findings__empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe("No owners recorded for this path.");
  });

  test("renders the empty-state line when both target and parentDirectory are null", () => {
    const el = renderOwnershipFindings(
      document,
      findings({ target: null, parentDirectory: null }),
      NOW,
    );
    const empty = el.querySelector(".nimbus-findings__empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe("No owners recorded for this path.");
    expect(el.querySelectorAll(".nimbus-findings__group")).toHaveLength(0);
  });

  test("still renders parentDirectory when target is null", () => {
    const el = renderOwnershipFindings(
      document,
      findings({
        target: null,
        parentDirectory: target({ kind: "directory", displayPath: "src" }),
      }),
      NOW,
    );
    expect(el.querySelector(".nimbus-findings__empty")).toBeNull();
    const groups = el.querySelectorAll(".nimbus-findings__group");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.textContent).toContain("Parent directory");
  });

  test("renders no links anywhere - this lane carries no item id at all", () => {
    const el = renderOwnershipFindings(document, findings(), NOW);
    expect(el.querySelector("a")).toBeNull();
  });

  test("never renders externalId anywhere - it is a person id, not shown", () => {
    const el = renderOwnershipFindings(document, findings(), NOW);
    expect(el.textContent).not.toContain("person:1");
  });

  test("never parses displayPath or label as markup", () => {
    const el = renderOwnershipFindings(
      document,
      findings({
        target: target({
          displayPath: "<img src=x onerror=1>",
          owners: [owner({ label: "<img src=y onerror=2>" })],
        }),
      }),
      NOW,
    );
    expect(el.querySelector("img")).toBeNull();
  });
});
