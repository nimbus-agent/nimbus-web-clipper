// src/panel/deploy/deploy-view.ts
// The pure renderer for the deploy-readiness section (C10). No chrome.*, no
// fetch, no DOM outside the fragment it returns — so it is unit-testable in
// jsdom, like every other view in this folder.
import type { DeployPreflightResult, PreflightGap } from "../../shared/deploy.ts";
import { MAX_SERVICE_ID_LEN } from "../../shared/services.ts";
import { findingLink } from "../findings/shared-view.ts";

/** "Deploy readiness" in the UI, `deploy-preflight` in code, never bare
 *  "preflight" — the design spec's §2 naming rule, and the string
 *  `development.md` and the Options page both tell the user to look for. */
export const DEPLOY_SECTION_TITLE = "Deploy readiness";

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
  // Not a wire value: the gateway named a reason newer than this extension.
  // It still has to say SOMETHING, because the alternative — silence under a
  // count of zero — is exactly the "all clear" §4.4 forbids.
  unrecognised_gap:
    "Nimbus gave a reason this version of the extension doesn't know, so this check could not be read here. Updating the extension should explain it.",
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
  // A count larger than the findings shown is usually the max_findings cap,
  // not a bug — but a count with NOTHING under it is the §4.4 failure mode in
  // miniature: "Failing CI runs: 1" and an empty space reads as a number the
  // user can act on, when in fact every finding was malformed and dropped (or
  // the gateway sent none). It gets its own sentence rather than the cap's,
  // which would claim we are showing 0 of 1 on purpose.
  if (check.count > check.findings.length) {
    const more = doc.createElement("p");
    more.className = "nimbus-deploy__more";
    more.textContent =
      check.findings.length === 0
        ? `Nimbus counted ${check.count} but sent no details to show.`
        : `Showing ${check.findings.length} of ${check.count}.`;
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

/**
 * The section's frame: the heading every other panel section has, and the body
 * element the controller repaints on each state change.
 *
 * The title lives OUTSIDE that body on purpose — the controller replaces the
 * body's children four times over the section's life (loading, verdict, bind
 * form, refusal) and the section's name should not blink out of existence
 * during any of them. `.nimbus-deploy__title` carries the lane title's inset
 * and weight (deploy-css.ts), so the section lines up with the lanes above it
 * rather than reading as a bolt-on beneath them.
 */
export function renderSectionFrame(doc: Document): {
  readonly title: HTMLElement;
  readonly body: HTMLElement;
} {
  const title = doc.createElement("p");
  title.className = "nimbus-deploy__title";
  title.textContent = DEPLOY_SECTION_TITLE;
  const body = doc.createElement("div");
  body.className = "nimbus-deploy__body";
  return { title, body };
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
  // The route's own bound, from the one file that writes it down — not a third
  // spelling of 64 (see `MAX_SERVICE_ID_LEN`'s siblings in deploy-client.ts).
  input.maxLength = MAX_SERVICE_ID_LEN;
  input.name = "serviceId";
  label.append(input);

  const submit = doc.createElement("button");
  submit.type = "submit";
  submit.textContent = "Bind";

  form.append(label, submit);
  return form;
}
