// src/panel/deploy/deploy-view.ts
// The pure renderer for the deploy-readiness section (C10). No chrome.*, no
// fetch, no DOM outside the fragment it returns — so it is unit-testable in
// jsdom, like every other view in this folder.
import type { DeployPreflightResult, PreflightGap } from "../../shared/deploy.ts";
import type { ServiceResolutionOutcome } from "../../shared/messages.ts";
import { scopeCommand } from "../../shared/scope-command.ts";
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

/**
 * The note for an outcome, or `null` for `silent` — which renders NOTHING, the
 * byte-for-byte C10.1 behaviour a gateway without this route still gets.
 *
 * `unclaimed`'s wording is load-bearing. Upstream matches the URN against
 * `nimbus.toml` by EXACT string comparison, so a null answer also covers a repo
 * that IS configured under different casing, a different coordinate form, or a
 * Jenkins job path spelled another way. Saying "not configured" would send the
 * user to edit a file that is already correct. Say only what was established.
 */
function resolutionNote(resolution: ServiceResolutionOutcome): string | null {
  switch (resolution.kind) {
    case "resolved":
      return `Nimbus maps this repository to “${resolution.serviceId}”.`;
    case "ambiguous":
      return "More than one Nimbus service names this repository. Pick the one you want:";
    case "unclaimed":
      return "No Nimbus service names this repository by this coordinate. The suggestion below is a guess from the repository name.";
    case "forbidden":
      return "This browser's token cannot look that up — it is missing the “resolve” scope.";
    case "silent":
      return null;
  }
}

/** The unbound state: an editable seed, never a silent guess.
 *
 * `resolution` is what the gateway said about this repository (Task 5's
 * `ServiceResolutionOutcome`); `noteOverride`, when present, is a bind
 * REFUSAL and is rendered INSTEAD of the resolution's own note — never both,
 * since "Nimbus maps this repository to checkout" sitting above "Nimbus has
 * no [metrics.dora.checkout] block" reads as a contradiction. The candidate
 * group (present only for `ambiguous`) renders either way, so a refused bind
 * never loses the chips the user was choosing from.
 */
export function renderBindForm(
  doc: Document,
  seed: string,
  resolution: ServiceResolutionOutcome,
  /** A bind refusal, rendered INSTEAD of the resolution's own note — see above. */
  noteOverride?: string,
): HTMLElement {
  const form = doc.createElement("form");
  form.className = "nimbus-deploy__bind";

  const label = doc.createElement("label");
  label.textContent = "Nimbus service for this repository";
  const input = doc.createElement("input");
  input.type = "text";
  // `resolved`/`ambiguous` carry an id the gateway itself vouches for, so it
  // seeds the FIRST render — the form never shows a guess when a real answer
  // is sitting right there. A refusal is the other case: `noteOverride` is
  // only ever a bind refusal, and `seed` is then the id the user actually
  // submitted. Preferring the resolution's id there would silently swap their
  // choice — pick `cart` out of an ambiguous set, have the bind refused, and
  // the form repaints reading `checkout`, so the next click binds a service
  // they never selected while looking like a retry of the one they did.
  const useResolvedSeed =
    noteOverride === undefined &&
    (resolution.kind === "resolved" || resolution.kind === "ambiguous");
  input.value = useResolvedSeed ? resolution.serviceId : seed;
  // The route's own bound, from the one file that writes it down — not a third
  // spelling of 64 (see `MAX_SERVICE_ID_LEN`'s siblings in deploy-client.ts).
  input.maxLength = MAX_SERVICE_ID_LEN;
  input.name = "serviceId";
  label.append(input);

  const submit = doc.createElement("button");
  submit.type = "submit";
  submit.textContent = "Bind";

  const noteText = noteOverride ?? resolutionNote(resolution);
  let note: HTMLElement | null = null;
  if (noteText !== null && noteText !== "") {
    note = doc.createElement("p");
    note.className = "nimbus-deploy__resolution";
    note.textContent = noteText;
    // `noteOverride === undefined` is half of this condition, not decoration:
    // the scope command belongs to the RESOLUTION's note, and an override has
    // replaced that note with a bind refusal. Without it, a `forbidden`
    // resolution followed by a refused bind renders "Nimbus has no
    // [metrics.dora.x] block…" with `nimbus clip scopes …` underneath — a
    // remedy for the problem that is no longer on screen, and the exact
    // "never both" this function's own doc comment promises.
    if (
      noteOverride === undefined &&
      resolution.kind === "forbidden" &&
      resolution.scopeGap !== undefined
    ) {
      const cmd = scopeCommand(resolution.scopeGap);
      if (cmd !== null) {
        const code = doc.createElement("code");
        code.textContent = cmd;
        note.append(doc.createElement("br"), code);
      }
    }
  }

  let group: HTMLElement | null = null;
  if (resolution.kind === "ambiguous") {
    group = doc.createElement("div");
    group.className = "nimbus-deploy__candidates";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Nimbus services that name this repository");
    for (const candidate of resolution.candidates) {
      const chip = doc.createElement("button");
      // A real button: already focusable, already activated by Enter and
      // Space. No tabindex and no keydown handler — adding either
      // re-implements native behaviour, and a keydown beside native
      // activation fires the click twice.
      chip.type = "button";
      chip.className = "nimbus-deploy__chip";
      chip.textContent = candidate;
      chip.addEventListener("click", () => {
        input.value = candidate;
      });
      group.append(chip);
    }
  }

  form.append(...(note === null ? [] : [note]), ...(group === null ? [] : [group]), label, submit);
  return form;
}
