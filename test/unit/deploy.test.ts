import { describe, expect, test } from "vitest";
import {
  isUnknownService,
  parseDeployPreflight,
  parseServiceResolution,
  UNRECOGNISED_GAP,
} from "../../src/shared/deploy.ts";
import { MAX_SERVICE_ID_LEN } from "../../src/shared/services.ts";

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

  test.each([
    ["service", { service: 7 }],
    ["target_ref", { target_ref: null }],
    ["computed_at", { computed_at: 1_725_926_400_000 }],
  ])("rejects a non-string %s", (_field, over) => {
    expect(parseDeployPreflight(envelope(over))).toBeNull();
  });

  test("rejects a checks member that is not an object", () => {
    expect(parseDeployPreflight(envelope({ checks: [] }))).toBeNull();
    expect(parseDeployPreflight(envelope({ checks: "all clear" }))).toBeNull();
  });
});

// Each finding parser is exercised the same way: a well-formed finding sits
// beside ONE broken sibling, so a parser that dropped too much (or kept the
// broken one) changes the parsed list — a lone malformed finding would pass
// whether or not the specific clause under test fired.
describe("finding parsers", () => {
  const incident = {
    id: "pd1",
    title: "checkout 5xx",
    status: "acknowledged",
    severity: "P1",
    opened_at_ms: 1_000,
    pagerduty_service_id: "PSVC1",
    url: "https://pd.example/incidents/pd1",
  };
  const ci = {
    id: "c1",
    title: "build #9",
    conclusion: "cancelled",
    modified_at_ms: 2_000,
    branch: "main",
    head_sha: "abc123",
    url: null,
  };
  const pr = {
    id: "pr1",
    title: "Fix checkout",
    number: 482,
    mergeable_state: "dirty",
    modified_at_ms: 3_000,
    url: "https://github.com/acme/web/pull/482",
  };

  const withFindings = (key: string, findings: unknown[]) =>
    parseDeployPreflight(
      envelope({
        verdict: "warn",
        checks: {
          active_p1_incidents: check(),
          failing_ci_runs: check(),
          merge_conflicts: check(),
          [key]: check({ count: findings.length, findings }),
        },
      }),
    );

  test("an incident keeps every field, triggered and acknowledged alike", () => {
    const r = withFindings("active_p1_incidents", [incident, { ...incident, status: "triggered" }]);
    expect(r?.checks.active_p1_incidents.findings).toEqual([
      incident,
      { ...incident, status: "triggered" },
    ]);
  });

  test.each([
    ["a non-object", "nope"],
    ["a resolved status", { ...incident, status: "resolved" }],
    ["a missing id", { ...incident, id: undefined }],
    ["a non-string title", { ...incident, title: 7 }],
    ["a missing severity", { ...incident, severity: undefined }],
    ["a NaN opened_at_ms", { ...incident, opened_at_ms: Number.NaN }],
    ["a non-string service id", { ...incident, pagerduty_service_id: 9 }],
    ["a non-string url", { ...incident, url: 9 }],
  ])("drops an incident with %s and keeps its sibling", (_why, broken) => {
    const r = withFindings("active_p1_incidents", [broken, incident]);
    expect(r?.checks.active_p1_incidents.findings).toEqual([incident]);
    expect(r?.checks.active_p1_incidents.count).toBe(2);
  });

  test("a CI run keeps every field for each of the three failing conclusions", () => {
    const runs = [{ ...ci, conclusion: "failure" }, ci, { ...ci, conclusion: "timed_out" }];
    expect(withFindings("failing_ci_runs", runs)?.checks.failing_ci_runs.findings).toEqual(runs);
  });

  test.each([
    ["a non-object", null],
    ["a success conclusion", { ...ci, conclusion: "success" }],
    ["a missing branch", { ...ci, branch: undefined }],
    ["a non-string head_sha", { ...ci, head_sha: 1 }],
    ["a non-string url", { ...ci, url: {} }],
  ])("drops a CI run with %s and keeps its sibling", (_why, broken) => {
    const r = withFindings("failing_ci_runs", [broken, ci]);
    expect(r?.checks.failing_ci_runs.findings).toEqual([ci]);
  });

  test("a merge conflict keeps every field, with or without a url", () => {
    const prs = [pr, { ...pr, id: "pr2", url: null }];
    expect(withFindings("merge_conflicts", prs)?.checks.merge_conflicts.findings).toEqual(prs);
  });

  test.each([
    ["a non-object", 42],
    ["a missing id", { ...pr, id: undefined }],
    ["a non-string title", { ...pr, title: false }],
    ["a missing mergeable_state", { ...pr, mergeable_state: undefined }],
    ["a negative number", { ...pr, number: -1 }],
    ["a fractional number", { ...pr, number: 4.5 }],
    ["an Infinity modified_at_ms", { ...pr, modified_at_ms: Number.POSITIVE_INFINITY }],
    ["a non-string url", { ...pr, url: 3 }],
  ])("drops a merge conflict with %s and keeps its sibling", (_why, broken) => {
    const r = withFindings("merge_conflicts", [broken, pr]);
    expect(r?.checks.merge_conflicts.findings).toEqual([pr]);
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

describe("parseServiceResolution", () => {
  test("accepts a single claimant", () => {
    expect(
      parseServiceResolution({ service: "checkout", ambiguous: false, candidates: ["checkout"] }),
    ).toEqual({ service: "checkout", ambiguous: false, candidates: ["checkout"] });
  });

  test("accepts an ambiguous answer, whose service is still non-null", () => {
    const out = parseServiceResolution({
      service: "checkout",
      ambiguous: true,
      candidates: ["checkout", "cart"],
    });
    expect(out?.service).toBe("checkout");
    expect(out?.candidates).toEqual(["checkout", "cart"]);
  });

  test("accepts the null answer with empty candidates", () => {
    expect(parseServiceResolution({ service: null, ambiguous: false, candidates: [] })).toEqual({
      service: null,
      ambiguous: false,
      candidates: [],
    });
  });

  test("rejects a body whose ambiguous disagrees with the candidate count", () => {
    expect(parseServiceResolution({ service: "a", ambiguous: true, candidates: ["a"] })).toBeNull();
    expect(
      parseServiceResolution({ service: "a", ambiguous: false, candidates: ["a", "b"] }),
    ).toBeNull();
  });

  test("rejects a nominated service that is not among the candidates", () => {
    expect(
      parseServiceResolution({ service: "foo", ambiguous: true, candidates: ["bar", "baz"] }),
    ).toBeNull();
    expect(
      parseServiceResolution({ service: "foo", ambiguous: false, candidates: ["bar"] }),
    ).toBeNull();
  });

  test("rejects null service alongside a candidate, and vice versa", () => {
    expect(
      parseServiceResolution({ service: null, ambiguous: false, candidates: ["a"] }),
    ).toBeNull();
    expect(parseServiceResolution({ service: "a", ambiguous: false, candidates: [] })).toBeNull();
  });

  test("rejects the WHOLE body when any id is unsendable, rather than filtering", () => {
    const long = "x".repeat(MAX_SERVICE_ID_LEN + 1);
    expect(
      parseServiceResolution({ service: "ok", ambiguous: true, candidates: ["ok", long] }),
    ).toBeNull();
    expect(parseServiceResolution({ service: "", ambiguous: false, candidates: [""] })).toBeNull();
  });

  test("rejects wrong types and non-objects", () => {
    expect(parseServiceResolution(null)).toBeNull();
    expect(parseServiceResolution("nope")).toBeNull();
    expect(parseServiceResolution({ service: 1, ambiguous: false, candidates: [] })).toBeNull();
    expect(parseServiceResolution({ service: null, ambiguous: "no", candidates: [] })).toBeNull();
    expect(parseServiceResolution({ service: null, ambiguous: false, candidates: {} })).toBeNull();
    expect(parseServiceResolution({ service: null, ambiguous: false })).toBeNull();
  });
});
