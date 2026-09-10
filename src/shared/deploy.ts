// The `GET /v1/preflight/deploy` wire shape, transcribed from
// packages/gateway/src/preflight/preflight.ts (upstream repo `Nimbus`).
//
// NOT `agents.preflight`. That agent is on EXTERNAL_EXCLUDED_AGENT_METHODS and
// is never exposed on any external surface; this is a side-effect-free read on
// the public read-only table. See the C10 design, §2.
//
// Duplicated here rather than imported: the gateway is a SEPARATE repository and
// this extension ships with no node_modules.

/** Two values. There is no "pass" and no third verdict. */
export type PreflightVerdict = "ok" | "warn";

/**
 * Single-sourced as an array so the parser reads THIS rather than declaring its
 * own literal list — the drift class `RESOLVE_MATCH_KINDS` exists to prevent.
 */
export const PREFLIGHT_GAPS = [
  "unknown_service",
  "no_pagerduty_mapping",
  "no_repos",
  "unknown_mergeable_state",
  "pagerduty_urgency_without_priority",
] as const;

export type PreflightGap = (typeof PREFLIGHT_GAPS)[number] | null;

export interface IncidentFinding {
  readonly id: string;
  readonly title: string;
  readonly status: "triggered" | "acknowledged";
  readonly severity: string;
  readonly opened_at_ms: number;
  readonly pagerduty_service_id: string;
  readonly url: string | null;
}

export interface CiFinding {
  readonly id: string;
  readonly title: string;
  readonly conclusion: "failure" | "cancelled" | "timed_out";
  readonly modified_at_ms: number;
  readonly branch: string;
  readonly head_sha: string | null;
  readonly url: string | null;
}

export interface PrFinding {
  readonly id: string;
  readonly title: string;
  readonly number: number;
  readonly mergeable_state: string;
  readonly modified_at_ms: number;
  readonly url: string | null;
}

export interface PreflightCheck<F> {
  readonly count: number;
  readonly findings: readonly F[];
  readonly gap: PreflightGap;
}

export interface DeployPreflightResult {
  readonly service: string;
  readonly target_ref: string;
  readonly computed_at: string;
  readonly verdict: PreflightVerdict;
  readonly checks: {
    readonly active_p1_incidents: PreflightCheck<IncidentFinding>;
    readonly failing_ci_runs: PreflightCheck<CiFinding>;
    readonly merge_conflicts: PreflightCheck<PrFinding>;
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === "string";
}

function nullableUrl(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

/**
 * `typeof x === "number"` is true for NaN and Infinity, both of which render as
 * garbage and sort unpredictably. Every numeric field on this wire goes through
 * one of these two, matching `egress.ts` and `messages.ts`.
 */
function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function count(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function parseGap(v: unknown): PreflightGap | undefined {
  if (v === null) return null;
  return str(v) && (PREFLIGHT_GAPS as readonly string[]).includes(v)
    ? (v as PreflightGap)
    : undefined;
}

function parseIncident(v: unknown): IncidentFinding | null {
  if (!isObj(v)) return null;
  const status = v["status"];
  if (status !== "triggered" && status !== "acknowledged") return null;
  if (!str(v["id"]) || !str(v["title"]) || !str(v["severity"])) return null;
  if (!finite(v["opened_at_ms"])) return null;
  if (!str(v["pagerduty_service_id"]) || !nullableUrl(v["url"])) return null;
  return {
    id: v["id"],
    title: v["title"],
    status,
    severity: v["severity"],
    opened_at_ms: v["opened_at_ms"],
    pagerduty_service_id: v["pagerduty_service_id"],
    url: v["url"],
  };
}

function parseCi(v: unknown): CiFinding | null {
  if (!isObj(v)) return null;
  const c = v["conclusion"];
  if (c !== "failure" && c !== "cancelled" && c !== "timed_out") return null;
  if (!str(v["id"]) || !str(v["title"]) || !str(v["branch"])) return null;
  if (!finite(v["modified_at_ms"])) return null;
  if (!nullableUrl(v["head_sha"]) || !nullableUrl(v["url"])) return null;
  return {
    id: v["id"],
    title: v["title"],
    conclusion: c,
    modified_at_ms: v["modified_at_ms"],
    branch: v["branch"],
    head_sha: v["head_sha"],
    url: v["url"],
  };
}

function parsePr(v: unknown): PrFinding | null {
  if (!isObj(v)) return null;
  if (!str(v["id"]) || !str(v["title"]) || !str(v["mergeable_state"])) return null;
  if (!count(v["number"]) || !finite(v["modified_at_ms"])) return null;
  if (!nullableUrl(v["url"])) return null;
  return {
    id: v["id"],
    title: v["title"],
    number: v["number"],
    mergeable_state: v["mergeable_state"],
    modified_at_ms: v["modified_at_ms"],
    url: v["url"],
  };
}

/**
 * A malformed FINDING is dropped; a malformed CHECK rejects the envelope.
 *
 * `count` is kept as the gateway sent it, never recomputed from what parsed:
 * the count is the gateway's claim about the world, and the findings list is a
 * capped sample of it (`max_findings`). Recomputing would silently turn "12
 * failing runs, here are 10" into "10".
 */
function parseCheck<F>(v: unknown, one: (x: unknown) => F | null): PreflightCheck<F> | null {
  if (!isObj(v) || !count(v["count"]) || !Array.isArray(v["findings"])) return null;
  const gap = parseGap(v["gap"]);
  if (gap === undefined) return null;
  const findings: F[] = [];
  for (const raw of v["findings"]) {
    const parsed = one(raw);
    if (parsed !== null) findings.push(parsed);
  }
  return { count: v["count"], findings, gap };
}

export function parseDeployPreflight(v: unknown): DeployPreflightResult | null {
  if (!isObj(v)) return null;
  const verdict = v["verdict"];
  if (verdict !== "ok" && verdict !== "warn") return null;
  if (!str(v["service"]) || !str(v["target_ref"]) || !str(v["computed_at"])) return null;
  const checks = v["checks"];
  if (!isObj(checks)) return null;
  const incidents = parseCheck(checks["active_p1_incidents"], parseIncident);
  const ci = parseCheck(checks["failing_ci_runs"], parseCi);
  const conflicts = parseCheck(checks["merge_conflicts"], parsePr);
  if (incidents === null || ci === null || conflicts === null) return null;
  return {
    service: v["service"],
    target_ref: v["target_ref"],
    computed_at: v["computed_at"],
    verdict,
    checks: {
      active_p1_incidents: incidents,
      failing_ci_runs: ci,
      merge_conflicts: conflicts,
    },
  };
}

/**
 * Did the gateway say it has never heard of this service?
 *
 * EVERY check must report it. Upstream separated `unknown_service` from
 * `no_repos` deliberately (F24): a service that exists with no repos bound is a
 * different, more fixable problem, and only the former means "that id is wrong".
 */
export function isUnknownService(r: DeployPreflightResult): boolean {
  const { active_p1_incidents, failing_ci_runs, merge_conflicts } = r.checks;
  return (
    active_p1_incidents.gap === "unknown_service" &&
    failing_ci_runs.gap === "unknown_service" &&
    merge_conflicts.gap === "unknown_service"
  );
}
