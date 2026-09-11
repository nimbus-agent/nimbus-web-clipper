import { describe, expect, test } from "vitest";
import {
  isUnknownService,
  parseDeployPreflight,
  UNRECOGNISED_GAP,
} from "../../src/shared/deploy.ts";

const check = (over: Record<string, unknown> = {}) => ({
  count: 0,
  findings: [],
  gap: null,
  ...over,
});

const envelope = (over: Record<string, unknown> = {}) => ({
  service: "web",
  target_ref: "main",
  computed_at: "2026-09-10T00:00:00.000Z",
  verdict: "ok",
  checks: {
    active_p1_incidents: check(),
    failing_ci_runs: check(),
    merge_conflicts: check(),
  },
  ...over,
});

describe("parseDeployPreflight", () => {
  test("parses a clean envelope", () => {
    const r = parseDeployPreflight(envelope());
    expect(r?.verdict).toBe("ok");
    expect(r?.checks.failing_ci_runs.count).toBe(0);
  });

  test("parses a warn envelope carrying a CI finding", () => {
    const r = parseDeployPreflight(
      envelope({
        verdict: "warn",
        checks: {
          active_p1_incidents: check(),
          failing_ci_runs: check({
            count: 1,
            findings: [
              {
                id: "i1",
                title: "build #9",
                conclusion: "failure",
                modified_at_ms: 1,
                branch: "main",
                head_sha: null,
                url: "https://ci.example/9",
              },
            ],
          }),
          merge_conflicts: check(),
        },
      }),
    );
    expect(r?.checks.failing_ci_runs.findings[0]?.conclusion).toBe("failure");
    expect(r?.checks.failing_ci_runs.findings[0]?.url).toBe("https://ci.example/9");
  });

  test("accepts every member of the gap union", () => {
    for (const gap of [
      null,
      "unknown_service",
      "no_pagerduty_mapping",
      "no_repos",
      "unknown_mergeable_state",
      "pagerduty_urgency_without_priority",
    ]) {
      const r = parseDeployPreflight(
        envelope({
          checks: {
            active_p1_incidents: check({ gap }),
            failing_ci_runs: check(),
            merge_conflicts: check(),
          },
        }),
      );
      expect(r, `gap ${String(gap)} should parse`).not.toBeNull();
    }
  });

  // The day the gateway adds a seventh gap member, the user must not lose the
  // whole verdict — including the two checks that answered perfectly well.
  test("an unknown gap string degrades ONE check and keeps the envelope", () => {
    const r = parseDeployPreflight(
      envelope({
        verdict: "warn",
        checks: {
          active_p1_incidents: check({ gap: "gap_from_the_future" }),
          failing_ci_runs: check({ count: 2 }),
          merge_conflicts: check({ gap: "no_repos" }),
        },
      }),
    );
    expect(r).not.toBeNull();
    expect(r?.checks.active_p1_incidents.gap).toBe(UNRECOGNISED_GAP);
    // Distinct from "no gap": the other two checks are untouched, and neither
    // of them is reported as unevaluated.
    expect(r?.checks.failing_ci_runs.gap).toBeNull();
    expect(r?.checks.failing_ci_runs.count).toBe(2);
    expect(r?.checks.merge_conflicts.gap).toBe("no_repos");
  });

  // A gap of the wrong TYPE is a shape violation, not a newer vocabulary, and
  // still rejects — the distinction `parseGap` exists to hold.
  test("rejects a non-string gap rather than calling it unrecognised", () => {
    for (const gap of [7, {}, [], true]) {
      expect(
        parseDeployPreflight(
          envelope({
            checks: {
              active_p1_incidents: check({ gap }),
              failing_ci_runs: check(),
              merge_conflicts: check(),
            },
          }),
        ),
        `gap ${JSON.stringify(gap)}`,
      ).toBeNull();
    }
  });

  // `unrecognised_gap` is OURS. A gateway that sent that literal string would
  // be sending a value that is not on the contract — it parses to the same
  // client-only member, which is the honest reading either way.
  test("an all-unknown-gap envelope is not mistaken for unknown_service", () => {
    const r = parseDeployPreflight(
      envelope({
        verdict: "warn",
        checks: {
          active_p1_incidents: check({ gap: "gap_from_the_future" }),
          failing_ci_runs: check({ gap: "gap_from_the_future" }),
          merge_conflicts: check({ gap: "gap_from_the_future" }),
        },
      }),
    );
    expect(r).not.toBeNull();
    expect(r !== null && isUnknownService(r)).toBe(false);
  });

  test("rejects a verdict outside the union — there is no third value", () => {
    expect(parseDeployPreflight(envelope({ verdict: "pass" }))).toBeNull();
  });

  test("rejects a missing check rather than defaulting it to empty", () => {
    expect(
      parseDeployPreflight(
        envelope({ checks: { active_p1_incidents: check(), failing_ci_runs: check() } }),
      ),
    ).toBeNull();
  });

  test("rejects a non-object", () => {
    expect(parseDeployPreflight(null)).toBeNull();
    expect(parseDeployPreflight("nope")).toBeNull();
  });

  // typeof NaN === "number", so the naive check would let these through.
  test("rejects NaN and Infinity in a numeric field", () => {
    expect(
      parseDeployPreflight(
        envelope({
          checks: {
            active_p1_incidents: check({ count: Number.NaN }),
            failing_ci_runs: check(),
            merge_conflicts: check(),
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseDeployPreflight(
        envelope({
          checks: {
            active_p1_incidents: check({ count: Number.POSITIVE_INFINITY }),
            failing_ci_runs: check(),
            merge_conflicts: check(),
          },
        }),
      ),
    ).toBeNull();
  });

  test("drops a finding whose timestamp is NaN", () => {
    const r = parseDeployPreflight(
      envelope({
        checks: {
          active_p1_incidents: check(),
          failing_ci_runs: check({
            count: 1,
            findings: [
              {
                id: "c1",
                title: "t",
                conclusion: "failure",
                modified_at_ms: Number.NaN,
                branch: "main",
                head_sha: null,
                url: null,
              },
            ],
          }),
          merge_conflicts: check(),
        },
      }),
    );
    expect(r?.checks.failing_ci_runs.findings).toHaveLength(0);
  });

  test("drops a malformed finding rather than the whole envelope", () => {
    const r = parseDeployPreflight(
      envelope({
        checks: {
          active_p1_incidents: check({ count: 2, findings: [{ id: "x" }] }),
          failing_ci_runs: check(),
          merge_conflicts: check(),
        },
      }),
    );
    expect(r).not.toBeNull();
    expect(r?.checks.active_p1_incidents.findings).toHaveLength(0);
    // The COUNT is the gateway's, not the length of what we could parse.
    expect(r?.checks.active_p1_incidents.count).toBe(2);
  });
});

describe("isUnknownService", () => {
  test("true only when every check reports unknown_service", () => {
    const all = parseDeployPreflight(
      envelope({
        verdict: "warn",
        checks: {
          active_p1_incidents: check({ gap: "unknown_service" }),
          failing_ci_runs: check({ gap: "unknown_service" }),
          merge_conflicts: check({ gap: "unknown_service" }),
        },
      }),
    );
    expect(isUnknownService(all!)).toBe(true);
  });

  test("false when the service exists but has no repos bound", () => {
    const some = parseDeployPreflight(
      envelope({
        verdict: "warn",
        checks: {
          active_p1_incidents: check({ gap: "no_pagerduty_mapping" }),
          failing_ci_runs: check({ gap: "no_repos" }),
          merge_conflicts: check({ gap: "no_repos" }),
        },
      }),
    );
    expect(isUnknownService(some!)).toBe(false);
  });
});
