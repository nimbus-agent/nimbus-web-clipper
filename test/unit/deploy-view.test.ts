// @vitest-environment jsdom
// test/unit/deploy-view.test.ts
import { describe, expect, test } from "vitest";
import { GAP_NOTE, renderDeployBody, verdictLine } from "../../src/panel/deploy/deploy-view.ts";
import type { DeployPreflightResult } from "../../src/shared/deploy.ts";
import { PREFLIGHT_GAPS } from "../../src/shared/deploy.ts";

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
    for (const gap of PREFLIGHT_GAPS) {
      expect(GAP_NOTE[gap], `gap ${gap}`).toBeTruthy();
    }
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
