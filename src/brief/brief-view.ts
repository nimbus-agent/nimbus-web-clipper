// src/brief/brief-view.ts
// Pure rendering for the brief page. No chrome.* here and no fetch — the page's
// only job is to draw what the worker sends.
//
// Every node is built with createElement and every string set via textContent.
// Never innerHTML: a report's summary, finding text, citation titles and quotes
// are model output derived from page content, so all of it is untrusted.
import type { BriefState, SkippedSource } from "../background/brief-handlers.ts";
import type { CandidateTab } from "../browser/tabs.ts";
import { BRIEF_CAPS } from "../shared/brief.ts";
import {
  type BriefReport,
  type BriefReportItem,
  quotesWereOmitted,
  visibleGaps,
} from "../shared/brief-report.ts";
import { groupKey, type PassageGroup } from "../shared/passage.ts";
import { safeHttpUrl } from "../shared/safe-url.ts";

export type ComposerModel = {
  readonly named: readonly CandidateTab[];
  readonly hiddenCount: number;
  readonly questions: readonly string[];
  /** Pick ids — `tab:<id>` or `passages:<url>`. One namespace, so a toggle
   *  identifies its own kind without a lookup. */
  readonly selected: ReadonlySet<string>;
  readonly passages: readonly PassageGroup[];
  /** Urls the user switched back to whole-page mode. */
  readonly wholePage?: ReadonlySet<string>;
  /**
   * What the user has typed into the custom-question box.
   *
   * Carried in the MODEL rather than restored after the fact, so a re-render is
   * idempotent: the same model draws the same composer whoever calls it. The
   * page repaints mid-compose now — dropping a passage re-reads the store — and
   * a redraw that forgot this would wipe a question the user is still writing.
   * Kept apart from the chosen question: picking a suggested one must not make
   * that text appear as though they had typed it.
   */
  readonly customQuestion?: string;
  /** See `TabCandidates.enumerationFailed` — rendered, not logged. */
  readonly enumerationFailed?: boolean;
};

/**
 * One row of the composer: a page, and which of the two things it offers.
 *
 * `tab` on a passages row is the open tab that page is showing, or null when it
 * has none. `group` on a TAB row is the collection this page has that the user
 * switched away from, or null when it has none — it is what the row needs to
 * offer the way back, and a tab row that never had passages has nothing to
 * return to.
 */
export type ComposerRow =
  | { readonly kind: "tab"; readonly tab: CandidateTab; readonly group: PassageGroup | null }
  | {
      readonly kind: "passages";
      readonly group: PassageGroup;
      readonly tab: CandidateTab | null;
    };

/**
 * The rows this composer shows, in the order it shows them.
 *
 * Exported and pure because the page needs the SAME order to build the preview
 * and the run payload: what is listed is what is sent, in that sequence. A
 * second copy of this loop in brief.ts would be a second copy of the one-row-
 * per-page rule, which is exactly the drift the fragment-stripped key exists to
 * prevent.
 *
 * ONE row per page key, whichever kind that row turns out to be. The same page
 * can be open in two tabs — plainly, or as two fragments of one document — and
 * both resolve to one key. Emitting a row per TAB would put two rows for one
 * page in a list whose whole job is "here is what goes", and picking both would
 * declare one page twice in `sources`: `declare()` sends `tab.url` for a tab
 * pick and `group.url` for a passages pick, so the two rows would send
 * `http://h/a#one` and `http://h/a`, which the gateway canonicalises to the same
 * identity. That is the defect the fragment-stripped group key exists to
 * prevent, arriving through a second door.
 *
 * A row switched to whole-page mode renders as a plain tab row, which is exactly
 * what "use the whole page instead" means — and that row CARRIES THE CONTROL
 * BACK, because a switch with no return path would hide the passages the user
 * collected by hand for the rest of the session with nothing naming them.
 *
 * A group in `wholePage` with no named tab is not in whole-page mode in any
 * sense that means anything: the mode is "capture this tab at start", and there
 * is no tab. So it renders as its passages row rather than vanishing. The page
 * prunes such an entry from `wholePage` before it renders, so this is the floor
 * rather than the usual path.
 */
export function composerRows(model: {
  readonly named: readonly CandidateTab[];
  readonly passages: readonly PassageGroup[];
  readonly wholePage?: ReadonlySet<string>;
}): readonly ComposerRow[] {
  const byKey = new Map(model.passages.map((g) => [g.url, g]));
  const whole = model.wholePage ?? new Set<string>();
  const rows: ComposerRow[] = [];
  const seen = new Set<string>();
  for (const tab of model.named) {
    const key = groupKey(tab.url);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const group = byKey.get(key);
    if (group === undefined || whole.has(group.url)) {
      rows.push({ kind: "tab", tab, group: group ?? null });
      continue;
    }
    rows.push({ kind: "passages", group, tab });
  }
  for (const group of model.passages) {
    if (!seen.has(group.url)) {
      rows.push({ kind: "passages", group, tab: null });
    }
  }
  return rows;
}

/** The one place a pick id is spelled. The page compares and stores these
 *  strings; it never parses them, so the two prefixes stay an implementation
 *  detail of this module. */
export function pickId(row: ComposerRow): string {
  return row.kind === "tab" ? `tab:${row.tab.id}` : `passages:${row.group.url}`;
}

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

/** Exported so ticking a box can refresh the counter WITHOUT redrawing the
 *  composer: a redraw would recreate the custom-question box the user may be
 *  typing in, and a tick changes nothing else on the page. */
export function sourceCountText(picked: number): string {
  return `${picked} of ${BRIEF_CAPS.maxSources} sources`;
}

function pickBox(value: string, checked: boolean): HTMLInputElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.value = value;
  box.checked = checked;
  return box;
}

function iconButton(
  className: string,
  text: string,
  data: Record<string, string>,
): HTMLButtonElement {
  const button = el("button", text, className);
  button.type = "button";
  for (const [key, value] of Object.entries(data)) {
    button.dataset[key] = value;
  }
  return button;
}

function tabRow(
  row: Extract<ComposerRow, { kind: "tab" }>,
  selected: ReadonlySet<string>,
): HTMLElement {
  const item = el("li", undefined, "brief__tab");
  const label = el("label");
  const id = pickId(row);
  label.appendChild(pickBox(id, selected.has(id)));
  label.appendChild(el("span", row.tab.title, "brief__tab-title"));
  label.appendChild(el("span", row.tab.url, "brief__tab-url"));
  item.appendChild(label);

  // The way BACK, and the reason whole-page mode is a choice rather than a
  // one-way door: without it the passages the user collected by hand would
  // disappear from the composer for the rest of the session, with no control
  // carrying their url and nothing saying they still exist.
  if (row.group !== null) {
    item.appendChild(iconButton("brief__mode", "Use its passages instead", { url: row.group.url }));
  }
  return item;
}

/** The passages held for one page, each removable, plus the row's own controls. */
function passageRow(
  row: Extract<ComposerRow, { kind: "passages" }>,
  selected: ReadonlySet<string>,
): HTMLElement {
  const group = row.group;
  const item = el("li", undefined, "brief__tab brief__tab--passages");
  const label = el("label");
  const id = pickId(row);
  label.appendChild(pickBox(id, selected.has(id)));
  label.appendChild(el("span", group.title, "brief__tab-title"));
  const n = group.passages.length;
  label.appendChild(el("span", `${n} ${n === 1 ? "passage" : "passages"}`, "brief__tab-count"));
  label.appendChild(el("span", group.url, "brief__tab-url"));
  item.appendChild(label);

  // Offered ONLY when the tab is open: whole-page mode means "capture this tab
  // at start", so on a closed tab it would be a dead control.
  if (row.tab !== null) {
    item.appendChild(iconButton("brief__mode", "Use the whole page instead", { url: group.url }));
  }

  const list = el("ul", undefined, "brief__passages");
  for (const passage of group.passages) {
    const line = el("li");
    // textContent via `el` — passage text is page content, never markup.
    line.appendChild(el("span", passage.text, "brief__passage-text"));
    line.appendChild(
      iconButton("brief__drop", "Remove", { url: group.url, at: String(passage.at) }),
    );
    list.appendChild(line);
  }
  item.appendChild(list);
  item.appendChild(iconButton("brief__drop-row", "Remove page", { url: group.url }));
  return item;
}

export function renderComposer(root: HTMLElement, model: ComposerModel): void {
  root.replaceChildren();

  root.appendChild(el("h2", "Pick the pages"));

  // A failed enumeration is not an empty one. Saying "no eligible tabs" here
  // would be a false statement about the browser rather than an honest one about
  // us, and it is the only place this failure can be reported.
  //
  // It reports the TABS and stops there — it no longer returns. A passage group
  // needs no tab: its text was captured when the user highlighted it, and the
  // run path feeds it without touching `listTabs`. Hiding the collection behind
  // a tab failure would deny the user sources that are sitting in storage and
  // are perfectly usable. Those rows carry no whole-page control, because no tab
  // is named — already the right behaviour for a group whose tab has closed.
  if (model.enumerationFailed === true) {
    root.appendChild(
      el("p", "Couldn't read your open tabs. Reload this page to try again.", "brief__error"),
    );
  }

  const list = el("ul", undefined, "brief__tabs");
  for (const row of composerRows(model)) {
    list.appendChild(
      row.kind === "tab" ? tabRow(row, model.selected) : passageRow(row, model.selected),
    );
  }
  root.appendChild(list);

  // Not said when the enumeration FAILED: the error line above already accounts
  // for the empty list, and saying both would claim two different reasons for it.
  if (model.named.length === 0 && model.enumerationFailed !== true) {
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

  // Both kinds count against ONE cap: the gateway's source cap is about sources,
  // and a set of passages is a source.
  root.appendChild(el("p", sourceCountText(model.selected.size), "brief__count"));
  if (model.passages.length > 0) {
    const clear = el("button", "Clear collected passages", "brief__clear");
    clear.type = "button";
    clear.id = "clear-passages";
    root.appendChild(clear);
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
  const typed = model.customQuestion ?? "";
  input.value = typed;
  details.appendChild(input);
  // Opened when there is text, because restoring the words into a collapsed
  // disclosure would look exactly like losing them.
  details.open = typed !== "";
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
