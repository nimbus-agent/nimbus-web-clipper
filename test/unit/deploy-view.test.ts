// @vitest-environment jsdom
// test/unit/deploy-view.test.ts
import { describe, expect, test } from "vitest";
import {
  DEPLOY_SECTION_TITLE,
  GAP_NOTE,
  renderBindForm,
  renderDeployBody,
  renderSectionFrame,
  verdictLine,
} from "../../src/panel/deploy/deploy-view.ts";
import type { DeployPreflightResult } from "../../src/shared/deploy.ts";
import { PREFLIGHT_GAPS, UNRECOGNISED_GAP } from "../../src/shared/deploy.ts";

const result = (over: Partial<DeployPreflightResult> = {}): DeployPreflightResult =>
  ({
    service: "web",
    target_ref: "main",
    computed_at: "2026-09-10T00:00:00.000Z",
    verdict: "ok",
    checks: {
      active_p1_incidents: { count: 0, findings: [], gap: null },
      failing_ci_runs: { count: 0, findings: [], gap: null },
      merge_conflicts: { count: 0, findings: [], gap: null },
    },
    ...over,
  }) as DeployPreflightResult;

describe("GAP_NOTE", () => {
  // This is the test that proves the Record is exhaustive. Deleting an arm from
  // GAP_NOTE makes the build red; this makes a BLANK arm red too.
  test("every gap member has a non-empty sentence", () => {
    // The client-only member is in this loop too: a check the gateway gapped
    // for a reason we don't know still has to say something, or it renders as
    // a bare label under a zero — the "all clear" §4.4 forbids.
    for (const gap of [...PREFLIGHT_GAPS, UNRECOGNISED_GAP] as const) {
      expect(GAP_NOTE[gap], `gap ${gap}`).toBeTruthy();
    }
  });
});

describe("renderSectionFrame", () => {
  // The section is a sibling of the shell, so nothing above it labels it. The
  // spec's §2 naming rule is the UI string, and Options and development.md both
  // tell the user to look for it.
  test("names the section, and hands back a separate body to repaint", () => {
    const { title, body } = renderSectionFrame(document);
    expect(title.textContent).toBe(DEPLOY_SECTION_TITLE);
    expect(DEPLOY_SECTION_TITLE).toBe("Deploy readiness");
    expect(title.className).toBe("nimbus-deploy__title");
    // Separate elements: the controller replaces the body's children on every
    // state change and the heading must survive all of them.
    expect(body).not.toBe(title);
    expect(body.className).toBe("nimbus-deploy__body");
  });
});

describe("verdictLine", () => {
  test("a clean verdict reads as clear", () => {
    expect(verdictLine(result())).toMatch(/clear/i);
  });

  // The rule that matters: warn + count 0 + unknown_service is "could not
  // evaluate", NOT "all clear" and NOT "problems found".
  test("an unknown service says it could not evaluate, never all-clear", () => {
    const line = verdictLine(
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: "unknown_service" },
          failing_ci_runs: { count: 0, findings: [], gap: "unknown_service" },
          merge_conflicts: { count: 0, findings: [], gap: "unknown_service" },
        },
      }),
    );
    expect(line).toMatch(/could not/i);
    expect(line).not.toMatch(/clear/i);
    expect(line).not.toMatch(/\b0 problem/i);
  });

  test("a real warning names the count", () => {
    const line = verdictLine(
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: null },
          failing_ci_runs: { count: 2, findings: [], gap: null },
          merge_conflicts: { count: 1, findings: [], gap: null },
        },
      }),
    );
    expect(line).toMatch(/3/);
  });
});

describe("renderDeployBody", () => {
  test("renders a gap sentence rather than a bare zero", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: "no_pagerduty_mapping" },
          failing_ci_runs: { count: 0, findings: [], gap: null },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
    );
    expect(el.textContent).toContain(GAP_NOTE.no_pagerduty_mapping);
  });

  // A count with nothing under it is the same dishonesty as a bare zero: every
  // finding here was malformed and dropped, and the label alone would read as
  // one the user can go and look at.
  test("says so when a count arrives with no findings to show", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: null },
          failing_ci_runs: { count: 1, findings: [], gap: null },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
    );
    const note = el.querySelector(".nimbus-deploy__more");
    expect(note?.textContent).toMatch(/no details/i);
    expect(note?.textContent).not.toMatch(/showing 0/i);
  });

  test("a capped list still reads as a cap, not as missing details", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: null },
          failing_ci_runs: {
            count: 12,
            findings: [
              {
                id: "c1",
                title: "build #9",
                conclusion: "failure",
                modified_at_ms: 1,
                branch: "main",
                head_sha: null,
                url: null,
              },
            ],
            gap: null,
          },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
    );
    expect(el.querySelector(".nimbus-deploy__more")?.textContent).toBe("Showing 1 of 12.");
  });

  test("renders the client-only sentence for a gap this version doesn't know", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: UNRECOGNISED_GAP },
          failing_ci_runs: { count: 0, findings: [], gap: null },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
    );
    expect(el.textContent).toContain(GAP_NOTE[UNRECOGNISED_GAP]);
  });

  test("links a finding that carries an http url", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: null },
          failing_ci_runs: {
            count: 1,
            findings: [
              {
                id: "c1",
                title: "build #9",
                conclusion: "failure",
                modified_at_ms: 1,
                branch: "main",
                head_sha: null,
                url: "https://ci.example/9",
              },
            ],
            gap: null,
          },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
    );
    const a = el.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://ci.example/9");
    expect(a?.textContent).toBe("build #9");
  });

  test("renders a javascript: url as plain text, never a link", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: null },
          failing_ci_runs: {
            count: 1,
            findings: [
              {
                id: "c1",
                title: "hostile",
                conclusion: "failure",
                modified_at_ms: 1,
                branch: "main",
                head_sha: null,
                url: "javascript:alert(1)",
              },
            ],
            gap: null,
          },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
    );
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("hostile");
  });

  test("a title is written with textContent, never as markup", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: null },
          failing_ci_runs: {
            count: 1,
            findings: [
              {
                id: "c1",
                title: "<img src=x onerror=alert(1)>",
                conclusion: "failure",
                modified_at_ms: 1,
                branch: "main",
                head_sha: null,
                url: null,
              },
            ],
            gap: null,
          },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("renderBindForm", () => {
  test("a resolved outcome seeds the gateway's id and says so", () => {
    const form = renderBindForm(document, "web", { kind: "resolved", serviceId: "checkout" });
    expect(form.querySelector("input")?.value).toBe("checkout");
    expect(form.textContent).toMatch(/checkout/);
  });

  test("an unclaimed outcome keeps the guess and never says 'not configured'", () => {
    const form = renderBindForm(document, "web", { kind: "unclaimed" });
    expect(form.querySelector("input")?.value).toBe("web");
    const text = form.textContent ?? "";
    expect(text).toMatch(/names this repository/i);
    expect(text).not.toMatch(/not configured|isn't configured|set up DORA/i);
  });

  test("ambiguous renders one real button per candidate, and clicking rewrites the input", () => {
    const form = renderBindForm(document, "web", {
      kind: "ambiguous",
      serviceId: "checkout",
      candidates: ["checkout", "cart"],
    });
    const input = form.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("checkout");

    const group = form.querySelector('[role="group"]') as HTMLElement;
    expect(group.getAttribute("aria-label")).toBeTruthy();
    const chips = Array.from(group.querySelectorAll("button"));
    expect(chips.map((b) => b.textContent)).toEqual(["checkout", "cart"]);
    // Native buttons: focusable and Enter/Space-activated without help.
    expect(chips.every((b) => b.type === "button")).toBe(true);
    expect(chips.some((b) => b.hasAttribute("tabindex"))).toBe(false);

    chips[1]?.click();
    expect(input.value).toBe("cart");
  });

  test("forbidden names the scope fix and renders a pasteable command", () => {
    const form = renderBindForm(document, "web", {
      kind: "forbidden",
      scopeGap: { label: "laptop", required: "resolve", granted: ["clip", "briefs"] },
    });
    expect(form.querySelector("input")?.value).toBe("web");
    expect(form.textContent).toMatch(/nimbus clip scopes/);
  });

  test("silent adds no note at all", () => {
    const form = renderBindForm(document, "web", { kind: "silent" });
    expect(form.querySelector("input")?.value).toBe("web");
    expect(form.querySelector(".nimbus-deploy__resolution")).toBeNull();
  });

  test("a refusal note replaces the resolution note but keeps the candidates", () => {
    const form = renderBindForm(
      document,
      "checkout",
      { kind: "ambiguous", serviceId: "checkout", candidates: ["checkout", "cart"] },
      "Nimbus has no [metrics.dora.checkout] block configured for that id.",
    );
    const text = form.textContent ?? "";
    expect(text).toMatch(/no \[metrics\.dora\.checkout\] block/);
    // Never both: the mapping sentence above the refusal reads as a contradiction.
    expect(text).not.toMatch(/Nimbus maps this repository/);
    expect(form.querySelectorAll('[role="group"] button').length).toBe(2);
  });
});
