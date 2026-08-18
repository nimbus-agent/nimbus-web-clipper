// src/brief/brief.ts
// The brief page. Sends messages, renders what comes back.
//
// It never calls the gateway and it never polls: the service worker owns the run
// (one poller, and it is not here), so this file holds no timers and no fetch.
//
// Every send goes through `sendMessage` from the browser seam, typed as
// `ExtensionRequest` — the same way popup.ts and options.ts send. A raw
// `chrome.runtime.sendMessage` here would take `unknown`, which is how a
// breaking change to `BriefStartRequest` once got past the compiler.
import type { BriefState } from "../background/brief-handlers.ts";
import { sendMessage } from "../browser/runtime.ts";
import type { CandidateTab } from "../browser/tabs.ts";
import type { BriefPick, PassageClearRequest, PassageDropRequest } from "../shared/messages.ts";
import { groupKey, type PassageGroup } from "../shared/passage.ts";
import { type BriefPreviewSource, buildBriefPreview } from "../shared/preview.ts";
import { renderPreview } from "../shared/preview-view.ts";
import {
  type ComposerRow,
  composerRows,
  pickId,
  renderComposer,
  renderState,
  sourceCountText,
} from "./brief-view.ts";

/** Pick ids, never parsed — see `pickId`. A row's own id is what goes in and
 *  what comes out, so this file needs no knowledge of the two prefixes. */
const selected = new Set<string>();
/** Urls the user switched back to whole-page mode. Page state, not stored: it
 *  is a choice about THIS composition, and it dies with the page. */
const wholePage = new Set<string>();
let named: readonly CandidateTab[] = [];
let passages: readonly PassageGroup[] = [];
let hiddenCount = 0;
let questions: readonly string[] = [];
let enumerationFailed = false;
let question = "";
/**
 * What is in the custom-question box, kept apart from `question`.
 *
 * `question` is whichever question is in play, suggested or typed; this is only
 * the typed text, so a picked suggestion never reappears as though the user had
 * written it. It goes into the model so a repaint redraws it — the composer now
 * repaints mid-compose whenever the collection changes.
 */
let customQuestion = "";

/**
 * The last `done` state, retained so a later save failure can be shown WITHOUT
 * discarding the brief the user is reading. `save-failed` carries no report —
 * the worker may no longer hold one — so merging it here is what keeps the
 * report on screen.
 */
let lastDone: Extract<BriefState, { kind: "done" }> | null = null;

function root(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing #${id}`);
  }
  return node;
}

function show(state: BriefState): void {
  if (state.kind === "done") {
    lastDone = state;
    renderState(root("state"), state);
    return;
  }
  if (state.kind === "save-failed" && lastDone !== null) {
    renderState(root("state"), { ...lastDone, saveError: state.reason });
    return;
  }
  renderState(root("state"), state);
}

/** The rows the composer is showing, in its order. */
function rows(): readonly ComposerRow[] {
  return composerRows({ named, passages, wholePage });
}

/**
 * The picked rows, IN DISPLAYED ORDER — not in the order they were ticked.
 *
 * The preview and the run payload are both built from this one list, so the
 * order the user reads is the order the gateway is told. Deriving it from the
 * displayed rows also means a pick whose row is gone can never be sent.
 */
function pickedRows(): readonly ComposerRow[] {
  return rows().filter((row) => selected.has(pickId(row)));
}

function sourceFor(row: ComposerRow): BriefPreviewSource {
  return row.kind === "tab"
    ? { title: row.tab.title, url: row.tab.url }
    : {
        title: row.group.title,
        url: row.group.url,
        // The presence of `passages` is what marks this an excerpt set; the
        // preview needs no second flag.
        passages: row.group.passages.map((p) => p.text),
      };
}

function pickFor(row: ComposerRow): BriefPick {
  return row.kind === "tab"
    ? { kind: "tab", id: row.tab.id }
    : { kind: "passages", url: row.group.url };
}

function showPreview(): void {
  const sources = pickedRows().map(sourceFor);
  const panel = root("preview");
  if (sources.length === 0 || question === "") {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const body = root("preview-body");
  body.replaceChildren(renderPreview(document, buildBriefPreview({ question, sources })));
}

/**
 * Draw the composer from current state.
 *
 * Two prunes first, both about not stranding something the user can still see a
 * reason for.
 *
 * A whole-page url with no matching tab is released: the mode means "capture
 * this tab at start", so without a tab it is not a mode but a stale flag — and
 * leaving it set would keep that page's passages out of the list with no control
 * anywhere naming the url that would clear it.
 *
 * Then picks whose row has gone are dropped — a tab closed, a page's passages
 * removed — because the cap counter reads `selected.size` and must describe what
 * is on the screen, not what was ticked before the last refresh.
 */
function paint(): void {
  for (const url of [...wholePage]) {
    if (!named.some((t) => groupKey(t.url) === url)) {
      wholePage.delete(url);
    }
  }
  const live = new Set(rows().map(pickId));
  for (const id of [...selected]) {
    if (!live.has(id)) {
      selected.delete(id);
    }
  }
  renderComposer(root("composer"), {
    named,
    hiddenCount,
    questions,
    selected,
    passages,
    wholePage,
    customQuestion,
    enumerationFailed,
  });
  showPreview();
}

interface TabsAnswer {
  readonly named?: CandidateTab[];
  readonly hiddenCount?: number;
  readonly questions?: string[];
  readonly enumerationFailed?: boolean;
  readonly passages?: PassageGroup[];
}

async function loadTabs(): Promise<void> {
  const res: unknown = await sendMessage({ kind: "brief-tabs" });
  if (typeof res !== "object" || res === null) {
    return;
  }
  const data = res as TabsAnswer;
  named = data.named ?? [];
  passages = data.passages ?? [];
  hiddenCount = data.hiddenCount ?? 0;
  questions = data.questions ?? [];
  enumerationFailed = data.enumerationFailed === true;
  paint();
}

/**
 * Switch one row between its passages and the whole page.
 *
 * The pick MOVES rather than being dropped: the user asked for a different mode
 * of the same page, not to unselect it. Both directions come through here — the
 * passages row offers "use the whole page instead", and the tab row it becomes
 * offers "use its passages instead" — so the switch is a choice, not a one-way
 * door. Offered only where a tab is open, so a url with no matching tab is a
 * no-op rather than a mode with nothing to capture.
 */
function toggleWholePage(url: string): void {
  const tab = named.find((t) => groupKey(t.url) === url);
  const group = passages.find((g) => g.url === url);
  if (tab === undefined || group === undefined) {
    return;
  }
  const asWhole = wholePage.has(url);
  const asTab = { kind: "tab", tab, group } as const;
  const asPassages = { kind: "passages", group, tab } as const;
  const from = pickId(asWhole ? asTab : asPassages);
  const to = pickId(asWhole ? asPassages : asTab);
  if (asWhole) {
    wholePage.delete(url);
  } else {
    wholePage.add(url);
  }
  if (selected.delete(from)) {
    selected.add(to);
  }
  paint();
}

/**
 * Mutate the collection, then re-read it.
 *
 * Re-read rather than patched in place: the store is the authority, and a local
 * guess at what a refused write left behind is exactly the drift that makes a
 * consent surface untrustworthy.
 */
async function mutate(req: PassageDropRequest | PassageClearRequest): Promise<void> {
  await sendMessage(req);
  await loadTabs();
}

function onButtonClick(target: HTMLButtonElement): void {
  const asked = target.dataset["question"];
  if (asked !== undefined) {
    question = asked;
    showPreview();
    return;
  }
  if (target.id === "clear-passages") {
    void mutate({ kind: "passage-clear" }).catch(() => undefined);
    return;
  }
  const url = target.dataset["url"];
  if (url === undefined) {
    return;
  }
  if (target.classList.contains("brief__mode")) {
    toggleWholePage(url);
    return;
  }
  if (target.classList.contains("brief__drop-row")) {
    void mutate({ kind: "passage-drop", url }).catch(() => undefined);
    return;
  }
  const at = Number(target.dataset["at"]);
  if (target.classList.contains("brief__drop") && Number.isInteger(at)) {
    void mutate({ kind: "passage-drop", url, at }).catch(() => undefined);
  }
}

root("composer").addEventListener("click", (ev) => {
  const target = ev.target;
  if (target instanceof HTMLInputElement && target.type === "checkbox") {
    // The box's value IS the pick id — no lookup, and nothing to parse.
    if (target.checked) {
      selected.add(target.value);
    } else {
      selected.delete(target.value);
    }
    // The counter is the only thing a tick changes, so it is updated in place
    // rather than by redrawing — a redraw would recreate the custom-question box
    // and lose what the user is typing in it.
    const count = root("composer").querySelector(".brief__count");
    if (count !== null) {
      count.textContent = sourceCountText(selected.size);
    }
    showPreview();
    return;
  }
  if (target instanceof HTMLButtonElement) {
    onButtonClick(target);
  }
});

root("composer").addEventListener("input", (ev) => {
  const target = ev.target;
  if (target instanceof HTMLTextAreaElement && target.id === "custom-question") {
    // The raw value is kept for the redraw and the trimmed one for the request:
    // trimming what is redrawn would eat a space the moment it is typed.
    customQuestion = target.value;
    question = target.value.trim();
    showPreview();
  }
});

root("run").addEventListener("click", () => {
  void sendMessage({ kind: "brief-start", question, picks: pickedRows().map(pickFor) })
    .then((res: unknown) => {
      if (typeof res === "object" && res !== null && "kind" in res) {
        show(res as BriefState);
      }
    })
    .catch(() => undefined);
});

// The Save button is created by `renderState`, so it is bound by DELEGATION on a
// container that outlives it rather than by id after each render.
root("state").addEventListener("click", (ev) => {
  const target = ev.target;
  if (!(target instanceof HTMLButtonElement) || target.id !== "save-brief") {
    return;
  }
  const id = lastDone?.id;
  if (id === undefined) {
    return;
  }
  target.disabled = true;
  void sendMessage({ kind: "brief-save", id })
    .then((res: unknown) => {
      if (typeof res === "object" && res !== null && "kind" in res) {
        show(res as BriefState);
      }
    })
    .catch(() => {
      // Re-enabled rather than left dead: an unreachable worker is retryable,
      // and a control stuck disabled is the failure mode this guards against.
      target.disabled = false;
    });
});

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { kind?: string }).kind === "brief-state"
  ) {
    show((msg as { state: BriefState }).state);
  }
});

// Returning from Options must not need a manual reload — the grant may have
// added tabs this composer could not name a moment ago.
chrome.permissions.onAdded.addListener(() => {
  void loadTabs().catch(() => undefined);
});
window.addEventListener("focus", () => {
  void loadTabs().catch(() => undefined);
});

void loadTabs().catch(() => undefined);
