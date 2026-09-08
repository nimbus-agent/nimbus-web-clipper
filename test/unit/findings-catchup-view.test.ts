/** @vitest-environment jsdom */
import { describe, expect, test } from "vitest";
import { renderCatchupFindings } from "../../src/panel/findings/catchup-view.ts";
import type { CatchupFindings } from "../../src/shared/findings.ts";

const NOW = 1_800_000_000_000;

function item(over: Record<string, unknown> = {}) {
  return {
    itemId: "github:acme/web#9",
    title: "Cut the release branch",
    modifiedAt: NOW - 3_600_000,
    relevanceScore: 0.7,
    relevanceReasons: ["you own billing-service"],
    ...over,
  };
}

function section(over: Record<string, unknown> = {}) {
  return {
    serviceId: "billing-service",
    totalItemsInWindow: 1,
    items: [item()],
    ...over,
  };
}

function findings(over: Partial<CatchupFindings> = {}): CatchupFindings {
  return {
    kind: "catchup",
    selfPersonId: "person:1",
    involvement: {
      ownedServices: [],
      activeRepos: [],
      incidentServices: [],
      collaboratorPersonIds: [],
    },
    sections: [section()],
    ...over,
  };
}

describe("renderCatchupFindings", () => {
  test("renders no involvement line when every involvement array is empty", () => {
    const el = renderCatchupFindings(document, findings(), NOW);
    expect(el.querySelector(".nimbus-findings__provenance")).toBeNull();
  });

  test("renders an involvement summary line when ownedServices is non-empty", () => {
    const el = renderCatchupFindings(
      document,
      findings({
        involvement: {
          ownedServices: ["billing-service"],
          activeRepos: [],
          incidentServices: [],
          collaboratorPersonIds: [],
        },
      }),
      NOW,
    );
    const note = el.querySelector(".nimbus-findings__provenance");
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain("billing-service");
  });

  test("renders an involvement summary line when activeRepos is non-empty", () => {
    const el = renderCatchupFindings(
      document,
      findings({
        involvement: {
          ownedServices: [],
          activeRepos: ["acme/web"],
          incidentServices: [],
          collaboratorPersonIds: [],
        },
      }),
      NOW,
    );
    const note = el.querySelector(".nimbus-findings__provenance");
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain("acme/web");
  });

  test("renders a collaborator count when collaboratorPersonIds is non-empty", () => {
    const el = renderCatchupFindings(
      document,
      findings({
        involvement: {
          ownedServices: [],
          activeRepos: [],
          incidentServices: [],
          collaboratorPersonIds: ["person:2", "person:3"],
        },
      }),
      NOW,
    );
    const note = el.querySelector(".nimbus-findings__provenance");
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain("2");
  });

  test("renders an involvement summary line when incidentServices is non-empty", () => {
    const el = renderCatchupFindings(
      document,
      findings({
        involvement: {
          ownedServices: [],
          activeRepos: [],
          incidentServices: ["checkout-service"],
          collaboratorPersonIds: [],
        },
      }),
      NOW,
    );
    const note = el.querySelector(".nimbus-findings__provenance");
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain("checkout-service");
  });

  test("renders one group per section, headed by serviceId", () => {
    const el = renderCatchupFindings(document, findings(), NOW);
    const groups = el.querySelectorAll(".nimbus-findings__group");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.textContent).toContain("billing-service");
  });

  test("renders multiple sections as separate groups", () => {
    const el = renderCatchupFindings(
      document,
      findings({
        sections: [
          section({ serviceId: "billing-service" }),
          section({ serviceId: "checkout-service" }),
        ],
      }),
      NOW,
    );
    expect(el.querySelectorAll(".nimbus-findings__group")).toHaveLength(2);
  });

  test("does not show the N-of-M count when items.length equals totalItemsInWindow", () => {
    const el = renderCatchupFindings(
      document,
      findings({ sections: [section({ totalItemsInWindow: 1 })] }),
      NOW,
    );
    const group = el.querySelector(".nimbus-findings__group");
    expect(group?.textContent).not.toMatch(/\d+ of \d+/);
  });

  test("shows the N-of-M count only when items.length differs from totalItemsInWindow", () => {
    const el = renderCatchupFindings(
      document,
      findings({ sections: [section({ totalItemsInWindow: 5 })] }),
      NOW,
    );
    const group = el.querySelector(".nimbus-findings__group");
    expect(group?.textContent).toContain("1 of 5");
  });

  test("renders item title as plain text and the age of modifiedAt", () => {
    const el = renderCatchupFindings(document, findings(), NOW);
    const row = el.querySelector(".nimbus-findings__item");
    expect(row?.textContent).toContain("Cut the release branch");
    expect(row?.querySelector(".nimbus-findings__item-when")?.textContent).toContain("hour");
  });

  test("renders relevanceReasons as the detail line", () => {
    const el = renderCatchupFindings(document, findings(), NOW);
    const detail = el.querySelector(".nimbus-findings__item-detail");
    expect(detail?.textContent).toBe("you own billing-service");
  });

  test("renders no links when no map is given", () => {
    const el = renderCatchupFindings(document, findings(), NOW);
    expect(el.querySelector("a")).toBeNull();
  });

  // Task 4: the link wrap. `findingLink` is the only way a URL becomes an
  // `<a>` — these four pin the map lookup, the no-map fallback, a missing id,
  // and that `safeHttpUrl` is genuinely in the path rather than assumed.
  test("with a map, an item title is a link carrying the mapped href", () => {
    const el = renderCatchupFindings(document, findings(), NOW, {
      "github:acme/web#9": "https://github.com/acme/web/pull/9",
    });
    const link = el.querySelector<HTMLAnchorElement>(".nimbus-findings__item a");
    expect(link).not.toBeNull();
    expect(link?.href).toBe("https://github.com/acme/web/pull/9");
    expect(link?.textContent).toBe("Cut the release branch");
  });

  test("an item id missing from the map renders a span, not a link", () => {
    const el = renderCatchupFindings(document, findings(), NOW, {
      "some:other-item": "https://example.test/other",
    });
    expect(el.querySelector("a")).toBeNull();
    const row = el.querySelector(".nimbus-findings__item");
    expect(row?.querySelector("span")?.textContent).toBe("Cut the release branch");
  });

  test("a mapped value that is not a safe http URL renders a span — safeHttpUrl is genuinely in the path", () => {
    const el = renderCatchupFindings(document, findings(), NOW, {
      "github:acme/web#9": "javascript:alert(1)",
    });
    expect(el.querySelector("a")).toBeNull();
    const row = el.querySelector(".nimbus-findings__item");
    expect(row?.querySelector("span")?.textContent).toBe("Cut the release branch");
  });

  test("renders the empty-state line when sections is empty, never a blank box", () => {
    const el = renderCatchupFindings(document, findings({ sections: [] }), NOW);
    const empty = el.querySelector(".nimbus-findings__empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe("Nothing in your window.");
  });

  test("still shows the involvement line when sections is empty but involvement is not", () => {
    const el = renderCatchupFindings(
      document,
      findings({
        sections: [],
        involvement: {
          ownedServices: ["billing-service"],
          activeRepos: [],
          incidentServices: [],
          collaboratorPersonIds: [],
        },
      }),
      NOW,
    );
    expect(el.querySelector(".nimbus-findings__provenance")).not.toBeNull();
    expect(el.querySelector(".nimbus-findings__empty")?.textContent).toBe(
      "Nothing in your window.",
    );
  });

  test("never parses a title or relevanceReasons entry as markup", () => {
    const el = renderCatchupFindings(
      document,
      findings({
        sections: [
          section({
            items: [
              item({
                title: "<img src=x onerror=1>",
                relevanceReasons: ["<img src=y onerror=2>"],
              }),
            ],
          }),
        ],
      }),
      NOW,
    );
    expect(el.querySelector("img")).toBeNull();
  });
});
