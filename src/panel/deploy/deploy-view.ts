// src/panel/deploy/deploy-view.ts
// The pure renderer for the deploy-readiness section (C10). No chrome.*, no
// fetch, no DOM outside the fragment it returns — so it is unit-testable in
// jsdom, like every other view in this folder.
import type { DeployPreflightResult, PreflightGap } from "../../shared/deploy.ts";
import { findingLink } from "../findings/shared-view.ts";

/**
 * A sentence per gap, as a Record rather than a switch.
 *
 * The Record is what makes this exhaustive: adding a member to `PREFLIGHT_GAPS`
 * without adding a sentence here is a type error, and it can be PROVEN by
 * deleting an arm and watching the build go red. A `switch` with a
 * `satisfies never` backstop would also compile-check, but it leaves a
 * permanently unreachable line that the coverage gate then counts against us.
 */
export const GAP_NOTE: Record<Exclude<PreflightGap, null>, string> = {
  unknown_service: "Your gateway has no service configured under this name.",
  no_pagerduty_mapping: "No PagerDuty services are mapped, so incidents were not checked.",
  no_repos: "This service has no repositories bound, so there was nothing to check.",
  unknown_mergeable_state: "The forge has not reported a mergeable state for these pull requests.",
  pagerduty_urgency_without_priority:
    "PagerDuty reported urgency but no priority, so severity could not be judged.",
};

const CHECK_LABEL = {
  active_p1_incidents: "Active P1 incidents",
  failing_ci_runs: "Failing CI runs",
  merge_conflicts: "Merge conflicts",
} as const;

function totalCount(r: DeployPreflightResult): number {
  const { active_p1_incidents, failing_ci_runs, merge_conflicts } = r.checks;
  return active_p1_incidents.count + failing_ci_runs.count + merge_conflicts.count;
}

function everyCheckGapped(r: DeployPreflightResult): boolean {
  const { active_p1_incidents, failing_ci_runs, merge_conflicts } = r.checks;
  return (
    active_p1_incidents.gap !== null && failing_ci_runs.gap !== null && merge_conflicts.gap !== null
  );
}

/**
 * `warn` carries TWO meanings and they must never be rendered the same way.
 *
 * Upstream returns `warn` both for "found problems" and for "could not
 * evaluate", because `warn` is the only value that fails closed in every
 * consumer; the reason travels in the gap instead. So a zero count with gaps
 * everywhere is "could not evaluate" — never "all clear", and never "0 problems
 * found".
 */
export function verdictLine(r: DeployPreflightResult): string {
  if (r.verdict === "ok") {
    return `Clear to deploy ${r.service} at ${r.target_ref}.`;
  }
  const total = totalCount(r);
  if (total === 0 && everyCheckGapped(r)) {
    return `Could not evaluate ${r.service} — see below.`;
  }
  return `${total} thing${total === 1 ? "" : "s"} to look at before deploying ${r.service}.`;
}

function renderCheck(
  doc: Document,
  label: string,
  check: {
    count: number;
    findings: readonly { title: string; url: string | null }[];
    gap: PreflightGap;
  },
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-deploy__check";

  const head = doc.createElement("p");
  head.className = "nimbus-deploy__check-head";
  head.textContent = check.gap === null ? `${label}: ${check.count}` : label;
  box.append(head);

  if (check.gap !== null) {
    const note = doc.createElement("p");
    note.className = "nimbus-deploy__gap";
    note.textContent = GAP_NOTE[check.gap];
    box.append(note);
    return box;
  }

  if (check.findings.length > 0) {
    const list = doc.createElement("ul");
    for (const f of check.findings) {
      const li = doc.createElement("li");
      li.append(findingLink(doc, f.title, f.url));
      list.append(li);
    }
    box.append(list);
  }
  // A count larger than the findings shown is the max_findings cap, not a bug.
  if (check.count > check.findings.length && check.findings.length > 0) {
    const more = doc.createElement("p");
    more.className = "nimbus-deploy__more";
    more.textContent = `Showing ${check.findings.length} of ${check.count}.`;
    box.append(more);
  }
  return box;
}

export function renderDeployBody(doc: Document, r: DeployPreflightResult): HTMLElement {
  const root = doc.createElement("div");
  root.className = "nimbus-deploy";

  const verdict = doc.createElement("p");
  verdict.className = `nimbus-deploy__verdict nimbus-deploy__verdict--${r.verdict}`;
  verdict.textContent = verdictLine(r);
  root.append(verdict);

  root.append(renderCheck(doc, CHECK_LABEL.active_p1_incidents, r.checks.active_p1_incidents));
  root.append(renderCheck(doc, CHECK_LABEL.failing_ci_runs, r.checks.failing_ci_runs));
  root.append(renderCheck(doc, CHECK_LABEL.merge_conflicts, r.checks.merge_conflicts));
  return root;
}

/** The unbound state: an editable seed, never a silent guess. */
export function renderBindForm(doc: Document, guess: string): HTMLElement {
  const form = doc.createElement("form");
  form.className = "nimbus-deploy__bind";

  const label = doc.createElement("label");
  label.textContent = "Nimbus service for this repository";
  const input = doc.createElement("input");
  input.type = "text";
  input.value = guess;
  input.maxLength = 64;
  input.name = "serviceId";
  label.append(input);

  const submit = doc.createElement("button");
  submit.type = "submit";
  submit.textContent = "Bind";

  form.append(label, submit);
  return form;
}
