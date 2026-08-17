// src/brief/brief-view.ts
// Pure rendering for the brief page. No chrome.* here and no fetch — the page's
// only job is to draw what the worker sends.
//
// Every node is built with createElement and every string set via textContent.
// Never innerHTML: a report's summary, finding text, citation titles and quotes
// are model output derived from page content, so all of it is untrusted.
import type { BriefState, SkippedSource } from "../background/brief-handlers.ts";
import type { CandidateTab } from "../browser/tabs.ts";
import {
  type BriefReport,
  type BriefReportItem,
  quotesWereOmitted,
  visibleGaps,
} from "../shared/brief-report.ts";
import { safeHttpUrl } from "../shared/safe-url.ts";

export type ComposerModel = {
  readonly named: readonly CandidateTab[];
  readonly hiddenCount: number;
  readonly questions: readonly string[];
  readonly selected: ReadonlySet<number>;
  /** See `TabCandidates.enumerationFailed` — rendered, not logged. */
  readonly enumerationFailed?: boolean;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className !== undefined) {
    node.className = className;
  }
  return node;
}

export function renderComposer(root: HTMLElement, model: ComposerModel): void {
  root.replaceChildren();

  // A failed enumeration is not an empty one. Saying "no eligible tabs" here
  // would be a false statement about the browser rather than an honest one about
  // us, and it is the only place this failure can be reported.
  if (model.enumerationFailed === true) {
    root.appendChild(el("h2", "Pick the pages"));
    root.appendChild(
      el("p", "Couldn't read your open tabs. Reload this page to try again.", "brief__error"),
    );
    return;
  }

  root.appendChild(el("h2", "Pick the pages"));

  const list = el("ul", undefined, "brief__tabs");
  for (const tab of model.named) {
    const item = el("li", undefined, "brief__tab");
    const label = el("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = String(tab.id);
    box.checked = model.selected.has(tab.id);
    label.appendChild(box);
    label.appendChild(el("span", tab.title, "brief__tab-title"));
    label.appendChild(el("span", tab.url, "brief__tab-url"));
    item.appendChild(label);
    list.appendChild(item);
  }
  root.appendChild(list);

  if (model.named.length === 0) {
    root.appendChild(
      el("p", "No open tabs on sites you have granted page access to.", "brief__note"),
    );
  }

  // A COUNT, never a name. Without host permission the url is withheld, so there
  // is nothing honest to print — and an inline permissions.request would need
  // exactly those origins.
  if (model.hiddenCount > 0) {
    const n = model.hiddenCount;
    root.appendChild(
      el(
        "p",
        `${n} open ${n === 1 ? "tab is" : "tabs are"} on sites you haven't granted page access to. Grant it in Options to include them.`,
        "brief__note",
      ),
    );
  }

  root.appendChild(el("h2", "Ask"));
  const questions = el("ul", undefined, "brief__questions");
  for (const q of model.questions) {
    const item = el("li");
    const button = el("button", q, "brief__question");
    button.type = "button";
    button.dataset["question"] = q;
    item.appendChild(button);
    questions.appendChild(item);
  }
  root.appendChild(questions);

  // A collapsed control, not a warning. The non-goal this serves is about which
  // affordance LEADS; someone who arrived with a specific question in mind should
  // reach it in one click and meet no friction there.
  const details = el("details", undefined, "brief__custom");
  details.appendChild(el("summary", "Ask your own question"));
  const input = document.createElement("textarea");
  input.id = "custom-question";
  input.rows = 3;
  details.appendChild(input);
  root.appendChild(details);
}

/** Save refusals in the user's words. `expired` is the common one, not an edge case. */
function saveErrorText(reason: string): string {
  if (reason === "expired" || reason === "not_found") {
    return "This brief is no longer available to save — your gateway only keeps a finished brief for a while.";
  }
  if (reason === "not_paired") {
    return "Not paired with a gateway any more, so there is nowhere to save it.";
  }
  return `Couldn't save it: ${reason}.`;
}

function renderCitations(item: BriefReportItem): HTMLElement {
  const list = el("ul", undefined, "brief__citations");
  for (const c of item.citations) {
    const li = el("li");
    li.appendChild(el("span", c.title, "brief__cite-title"));
    if (c.quote !== undefined) {
      li.appendChild(el("blockquote", c.quote));
    }
    // A citation url is as untrusted as the rest of the report — `isBriefReport`
    // checks it is a string, not that it is safe to click — so the scheme is
    // validated before it reaches an href. A rejected url is still shown as
    // TEXT: the user should see what the citation claimed, just not be able to
    // click it into `javascript:` or `data:`.
    if (c.url !== undefined) {
      const href = safeHttpUrl(c.url);
      if (href === null) {
        li.appendChild(el("span", c.url, "brief__cite-url"));
      } else {
        const a = el("a", c.url, "brief__cite-url");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        li.appendChild(a);
      }
    }
    list.appendChild(li);
  }
  return list;
}

function renderItems(root: HTMLElement, heading: string, items: readonly BriefReportItem[]): void {
  if (items.length === 0) {
    return;
  }
  root.appendChild(el("h2", heading));
  const list = el("ul", undefined, "brief__items");
  for (const item of items) {
    const li = el("li");
    li.appendChild(el("p", item.text));
    li.appendChild(renderCitations(item));
    list.appendChild(li);
  }
  root.appendChild(list);
}

/**
 * Where the synthesis ran, and on what.
 *
 * The model is named on its OWN line rather than folded into the banner text,
 * because on a remote run the banner is the gateway's `disclosure` string
 * verbatim — and that string is not guaranteed to name the model. Rendering only
 * the disclosure would tell the user their source text left the machine without
 * telling them what received it.
 */
function renderBanner(root: HTMLElement, report: BriefReport): void {
  const { remote, disclosure, model } = report.synthesis;
  root.appendChild(
    el(
      "p",
      remote
        ? (disclosure ?? "This brief was written by a remote model.")
        : "Written on your machine.",
      remote ? "brief__banner brief__banner--remote" : "brief__banner brief__banner--local",
    ),
  );
  root.appendChild(el("p", `Model: ${model}`, "brief__model"));
}

function renderShortfall(
  root: HTMLElement,
  skipped: readonly SkippedSource[],
  truncated: readonly string[],
): void {
  if (skipped.length > 0) {
    root.appendChild(el("h2", "Pages that couldn't be read"));
    const list = el("ul", undefined, "brief__skipped");
    for (const s of skipped) {
      list.appendChild(el("li", `${s.title} — ${s.reason}`));
    }
    root.appendChild(list);
  }
  if (truncated.length > 0) {
    root.appendChild(el("p", `Shortened to fit: ${truncated.join(", ")}.`, "brief__note"));
  }
}

function renderSaveControls(root: HTMLElement, state: Extract<BriefState, { kind: "done" }>): void {
  if (state.savedItemId === undefined) {
    // The error goes ABOVE the button, and the button stays: a refusal the user
    // can retry is not a dead end, and the report is still here.
    if (state.saveError !== undefined) {
      root.appendChild(el("p", saveErrorText(state.saveError), "brief__error"));
    }
    const save = el("button", "Save to Nimbus", "brief__save");
    save.type = "button";
    save.id = "save-brief";
    root.appendChild(save);
    return;
  }
  root.appendChild(el("p", "Saved to your index.", "brief__note"));
  // Save is not lossless over the item metadata ceiling — say so rather than
  // present a thinner copy as what the user just read.
  if (quotesWereOmitted(state.report)) {
    root.appendChild(
      el("p", "The saved copy left out the supporting quotes (size limit).", "brief__note"),
    );
  }
}

function renderReport(root: HTMLElement, state: Extract<BriefState, { kind: "done" }>): void {
  const report = state.report;
  renderBanner(root, report);
  root.appendChild(el("h2", "Summary"));
  root.appendChild(el("p", report.summary));
  renderItems(root, "Findings", report.findings);
  renderItems(root, "Where your sources disagree", report.conflicts);

  // Gaps minus the disclosure duplicate, filtered BY EQUALITY — see visibleGaps.
  const gaps = visibleGaps(report);
  if (gaps.length > 0) {
    root.appendChild(el("h2", "Not covered"));
    const list = el("ul", undefined, "brief__gaps");
    for (const g of gaps) {
      list.appendChild(el("li", g));
    }
    root.appendChild(list);
  }

  renderShortfall(root, state.skipped, state.truncated);
  renderSaveControls(root, state);
}

export function renderState(root: HTMLElement, state: BriefState): void {
  root.replaceChildren();
  if (state.kind === "idle") {
    return;
  }
  if (state.kind === "feeding") {
    root.appendChild(el("p", `Reading pages — ${state.received} of ${state.expected}.`));
    return;
  }
  if (state.kind === "running") {
    root.appendChild(el("p", "Your gateway is writing the brief."));
    return;
  }
  if (state.kind === "failed") {
    root.appendChild(el("h2", "Couldn't finish this brief"));
    root.appendChild(el("p", state.reason, "brief__error"));
    if (state.hint !== undefined) {
      root.appendChild(el("p", state.hint, "brief__note"));
    }
    return;
  }
  if (state.kind === "save-failed") {
    // Only reached when the page has no retained `done` state to merge into —
    // normally a save failure arrives here as a `done` state carrying
    // `saveError`, with the report intact. See brief.ts's `lastDone`.
    root.appendChild(el("h2", "Couldn't save this brief"));
    root.appendChild(el("p", saveErrorText(state.reason), "brief__error"));
    return;
  }
  renderReport(root, state);
}
