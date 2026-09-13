// The `GET /v1/preflight/deploy` wire shape, transcribed from
// packages/gateway/src/preflight/preflight.ts (upstream repo `Nimbus`).
//
// NOT `agents.preflight`. That agent is on EXTERNAL_EXCLUDED_AGENT_METHODS and
// is never exposed on any external surface; this is a side-effect-free read on
// the public read-only table. See the C10 design, §2.
//
// Duplicated here rather than imported: the gateway is a SEPARATE repository and
// this extension ships with no node_modules.

import { MAX_SERVICE_ID_LEN } from "./services.ts";

/** Two values. There is no "pass" and no third verdict. */
export type PreflightVerdict = "ok" | "warn";

/**
 * The gap strings THIS VERSION knows, single-sourced as an array so the parser
 * reads this rather than declaring its own literal list — the drift class
 * `RESOLVE_MATCH_KINDS` exists to prevent.
 *
 * It is an open set upstream: the union has already been split once (F24, which
 * separated `unknown_service` from `no_repos`). See `UNRECOGNISED_GAP` for what
 * happens the day a seventh member arrives.
 */
export const PREFLIGHT_GAPS = [
  "unknown_service",
  "no_pagerduty_mapping",
  "no_repos",
  "unknown_mergeable_state",
  "pagerduty_urgency_without_priority",
] as const;

/**
 * NEVER on the wire — a client-only member meaning "the gateway named a reason
 * this version of the extension does not know".
 *
 * The alternative was rejecting the whole envelope on an unknown gap string,
 * which is what an additive upstream release would then do to the two checks
 * that answered perfectly well: the user would lose the entire verdict because
 * one check cited a newer reason. This degrades exactly one check instead,
 * which is the graceful-degradation pattern the rest of this client uses.
 *
 * It stays DISTINCT from `null`: "could not evaluate, reason unknown here" is
 * not "no gap", and §4.4's rule turns on that difference. It is also distinct
 * from a gap of the wrong TYPE — a number, an object — which is a shape
 * violation rather than a newer vocabulary, and still rejects the check.
 */
export const UNRECOGNISED_GAP = "unrecognised_gap";

export type PreflightGap = (typeof PREFLIGHT_GAPS)[number] | typeof UNRECOGNISED_GAP | null;

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

/**
 * `undefined` means "not a gap at all" and rejects the check. A STRING this
 * version does not know is a different thing — an additive upstream release,
 * not a malformed body — and becomes `UNRECOGNISED_GAP` on that one check.
 */
function parseGap(v: unknown): PreflightGap | undefined {
  if (v === null) return null;
  if (!str(v)) return undefined;
  return (PREFLIGHT_GAPS as readonly string[]).includes(v) ? (v as PreflightGap) : UNRECOGNISED_GAP;
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

/**
 * `GET /v1/services/resolve`'s body. A TOTAL key set upstream: `ambiguous` and
 * `candidates` are present on every answer, including the null one, so a client
 * cannot mistake "this gateway does not disclose ambiguity" for "this binding
 * is uncontested".
 */
export interface ServiceResolution {
  readonly service: string | null;
  readonly ambiguous: boolean;
  readonly candidates: readonly string[];
}

/**
 * An id short enough that it could be sent back to the gateway.
 *
 * Exported so the message-boundary guards in `messages.ts` enforce the SAME
 * bound as this wire parser rather than spelling `64` a third time. The two
 * validate one shape at two boundaries — a resolution parsed off the wire here,
 * and the same data crossing `chrome.runtime` there — and a guard that accepts
 * a bare `string` where this one demands a bounded id is how the panel ends up
 * rendering an id it can never send back.
 */
export function sendableId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= MAX_SERVICE_ID_LEN;
}

/**
 * The resolution, or `null` for anything this client does not fully understand.
 *
 * REJECTS THE WHOLE BODY on a bad member rather than filtering it out —
 * `parseScopeGap` is the precedent, and the reasoning transfers: a partially
 * accepted body silently changes what the client believes the gateway said.
 * A rejection surfaces as `server_error`, which the panel renders as the silent
 * row: the guess, and no false sentence.
 *
 * Bounds every id by `MAX_SERVICE_ID_LEN`, `service` and candidates alike. An
 * id longer than the gateway's own bound can never be sent back to it, so it
 * must not be readable back as though it could — the rule `isServiceBinding`
 * already applies to stored bindings.
 *
 * Asserts the two invariants rather than trusting either field alone
 * (`docs/architecture.md`, "`services/resolve` seeds the bind form from the
 * worker, never the panel", read off upstream's `resolveServicesByRepoUrn`,
 * which returns `serviceId: claimants[0] ?? null` beside
 * `candidateServiceIds: claimants`):
 *   - `ambiguous` is exactly `candidates.length > 1`;
 *   - `service` is null exactly when `candidates` is empty.
 * A body where those disagree is a gateway this client does not understand, and
 * guessing which field to believe is how a dead branch gets written.
 */
export function parseServiceResolution(v: unknown): ServiceResolution | null {
  if (!isObj(v)) return null;
  const service = v["service"];
  const ambiguous = v["ambiguous"];
  const candidates = v["candidates"];
  if (typeof ambiguous !== "boolean" || !Array.isArray(candidates)) return null;
  if (service !== null && !sendableId(service)) return null;
  for (const c of candidates) {
    if (!sendableId(c)) return null;
  }
  if (ambiguous !== candidates.length > 1) return null;
  if ((service === null) !== (candidates.length === 0)) return null;
  // The nominated service must be one of the disclosed candidates. Upstream
  // guarantees it by construction — `serviceId` IS `claimants[0]` and
  // `candidateServiceIds` IS `claimants` — so a body where it does not hold is
  // not a gateway this client understands. Checked rather than assumed for the
  // same reason as the two invariants above: the seed is taken from `service`,
  // so a `service` outside `candidates` would seed an id the picker cannot
  // reach and the user cannot re-select after a failed bind.
  if (service !== null && !candidates.includes(service)) return null;
  return { service, ambiguous, candidates: [...candidates] };
}
