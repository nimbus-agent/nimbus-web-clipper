// src/palette/palette-in-page.ts
// Injected as dist/<target>/palette.js. Defines globalThis.__nimbusPalette(init);
// the worker calls it after injecting this file (two-step, like cue.js and
// toast.js). The rows and the key reducer are pure, in palette-view.ts; this file
// is only the DOM, the listeners and the one message a choice sends.
//
// NO module-level mutable state, on purpose: every press of the command re-runs
// `executeScript({files:["palette.js"]})`, which re-evaluates this bundle, so a
// top-level `let` would be reset by a second press while the first palette is
// still open. Everything a palette owns lives in `mount`'s closure, and the only
// thing that survives a re-evaluation is the host's `__nimbusClose` expando.
import { sendMessage } from "../browser/runtime.ts";
import { headerFrom, withPick } from "../panel/header-state.ts";
import { laneContextFrom, termStateFrom } from "../panel/lane-input.ts";
import { isResolveResponse } from "../shared/messages.ts";
import {
  PANEL_HOST_ID,
  PANEL_STATE_HOOK,
  type PaletteInit,
  type PanelHostState,
  samePage,
} from "../shared/panel-host.ts";
import { PALETTE_CSS } from "./palette-css.ts";
import {
  enterAction,
  filterRows,
  type PaletteAction,
  type PaletteEvent,
  type PaletteInput,
  type PaletteRow,
  type PaletteState,
  paletteRows,
  reducePalette,
} from "./palette-view.ts";

const HOST_ID = "nimbus-palette-host";
const LISTBOX_ID = "nimbus-palette-list";
/** Same cadence as the panel's and the cue's: an SPA navigation fires no load
 *  event, and a palette offering lanes for the page you just left is wrong. */
const NAV_CHECK_MS = 500;

interface PaletteHost extends HTMLElement {
  __nimbusClose?: () => void;
}

/**
 * How the palette closed, which decides what it gives back to the page (§4.3):
 *
 * - `dismiss` — Esc, Tab, the toggle, a URL change, focus going nowhere: restore
 *   the selection and refocus the element that had focus at mount.
 * - `quick-clip` — the same, before the clip message is sent.
 * - `intent` — restore the selection but refocus nothing: focus would bounce
 *   page → panel, and focusing a page input can collapse the selection just
 *   restored. The panel takes focus itself.
 * - `leave` — focus moved to a page element the user chose. Nothing is pulled
 *   back: refocusing the mount-time element or restoring an old selection over
 *   the user's own click would fight them.
 */
type CloseHow = "dismiss" | "quick-clip" | "intent" | "leave";

interface SavedSelection {
  readonly ranges: readonly Range[];
  readonly text: string;
}

/** Taken before the input is focused, because focusing it collapses the page
 *  selection that Clip selection and a freshly mounted panel both read (§4.5). */
function saveSelection(): SavedSelection {
  const sel = window.getSelection();
  if (sel === null) {
    return { ranges: [], text: "" };
  }
  const ranges: Range[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    ranges.push(sel.getRangeAt(i).cloneRange());
  }
  return { ranges, text: sel.toString() };
}

function restoreSelection(saved: SavedSelection): void {
  if (saved.ranges.length === 0) {
    return;
  }
  try {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    for (const range of saved.ranges) {
      sel?.addRange(range);
    }
  } catch {
    // The page mutated the range's nodes. Clip selection then fails the way a
    // lost selection already does: the "Select some text first." toast.
  }
}

function refocus(el: Element | null): void {
  if (el instanceof HTMLElement && el.isConnected) {
    el.focus({ preventScroll: true });
  }
}

interface OpenPanel {
  /** A panel is mounted (ours: only our own host carries the state hook). */
  readonly present: boolean;
  /** Its pick, only when it is pinned to THIS page (fragment ignored, §5.2). */
  readonly chosenId: string | null;
}

/** Read once at mount: it decides placement and the pick folded into the header.
 *  Anything that opens or closes the panel later moves focus, which closes us. */
function readOpenPanel(): OpenPanel {
  const host = document.getElementById(PANEL_HOST_ID) as
    | (HTMLElement & { [PANEL_STATE_HOOK]?: unknown })
    | null;
  const hook = host?.[PANEL_STATE_HOOK];
  if (typeof hook !== "function") {
    return { present: false, chosenId: null };
  }
  const state = (hook as () => PanelHostState)();
  return {
    present: true,
    chosenId: samePage(state.pinnedUrl, window.location.href) ? state.chosenId : null,
  };
}

/** The resolve answer → the same header and lane context the panel derives
 *  (panel-in-page.ts `loadHeader`), with the open panel's pick folded in. An
 *  unreadable answer is still `done`: `headerFrom` turns it into an error
 *  header, whose sentence becomes the status row. */
function resolvedFrom(
  res: unknown,
  chosenId: string | null,
  selectionText: string,
): PaletteInput["resolved"] {
  const header = withPick(headerFrom(res, Date.now(), false), chosenId);
  const valid = isResolveResponse(res) ? res : null;
  const ok = valid?.ok === true ? valid : null;
  const ctx = laneContextFrom({
    shown: header,
    recognition: valid?.recognition ?? null,
    file: ok?.file ?? null,
    offered: ok?.offeredLanes ?? null,
    term: termStateFrom(selectionText === "" ? null : selectionText),
  });
  return { kind: "done", ctx, header };
}

function optionId(rowId: string): string {
  return `nimbus-palette-opt-${rowId.replaceAll(/[^A-Za-z0-9-]/g, "-")}`;
}

function renderRow(row: PaletteRow, active: boolean): HTMLLIElement {
  const li = document.createElement("li");
  li.id = optionId(row.id);
  li.className = "nimbus-palette__row";
  li.dataset["rowId"] = row.id;
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", String(active));
  if (!row.enabled) {
    li.setAttribute("aria-disabled", "true");
  }
  const title = document.createElement("span");
  title.className = "nimbus-palette__title";
  title.textContent = row.title;
  li.append(title);
  if (row.hint !== undefined) {
    const hint = document.createElement("span");
    hint.className = "nimbus-palette__hint";
    hint.textContent = row.hint;
    li.append(hint);
  }
  return li;
}

function renderList(
  list: HTMLElement,
  input: HTMLInputElement,
  rows: readonly PaletteRow[],
  state: PaletteState,
): void {
  const visible = filterRows(rows, state.filter);
  list.replaceChildren(...visible.map((row) => renderRow(row, row.id === state.activeId)));
  const active = visible.find((row) => row.id === state.activeId);
  if (active === undefined) {
    input.removeAttribute("aria-activedescendant");
  } else {
    input.setAttribute("aria-activedescendant", optionId(active.id));
  }
}

interface PaletteDom {
  readonly host: PaletteHost;
  readonly root: ShadowRoot;
  readonly dialog: HTMLElement;
  readonly input: HTMLInputElement;
  readonly list: HTMLElement;
}

function buildDom(besidePanel: boolean): PaletteDom {
  const host = document.createElement("div") as PaletteHost;
  host.id = HOST_ID;
  // Open, not closed — the cue's reasoning: closed buys nothing against an
  // isolated-world script's real attack, synthesised input, which every
  // handler below refuses on `!isTrusted`.
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = PALETTE_CSS;

  const dialog = document.createElement("div");
  dialog.className = besidePanel ? "nimbus-palette nimbus-palette--beside-panel" : "nimbus-palette";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Nimbus command palette");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "nimbus-palette__input";
  input.placeholder = "Ask Nimbus about this page…";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", "Nimbus action");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", LISTBOX_ID);

  const list = document.createElement("ul");
  list.id = LISTBOX_ID;
  list.className = "nimbus-palette__list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Nimbus actions");

  dialog.append(input, list);
  root.append(style, dialog);
  return { host, root, dialog, input, list };
}

/** The send for a chosen row. Fire-and-forget: a rejection has nowhere to be
 *  reported (noConsole, and this is someone else's page). */
function send(action: PaletteAction): void {
  const req =
    action.kind === "intent"
      ? ({ kind: "palette-intent", intent: action.intent } as const)
      : ({ kind: "quick-clip", mode: action.mode } as const);
  sendMessage(req).catch(() => undefined);
}

/** Everything one mounted palette owns. */
interface Palette {
  readonly dom: PaletteDom;
  readonly signal: AbortSignal;
  readonly rows: () => readonly PaletteRow[];
  readonly state: () => PaletteState;
  readonly dispatch: (event: PaletteEvent) => void;
  readonly close: (how: CloseHow) => boolean;
  readonly run: (action: PaletteAction) => void;
}

function onInputKey(p: Palette, event: KeyboardEvent): void {
  if (!event.isTrusted) {
    return;
  }
  // Keys typed here must not reach the page's own shortcuts: the event is
  // retargeted to our host, which a page's "ignore keys typed in inputs" check
  // does not recognise as an input.
  event.stopPropagation();
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    p.dispatch({ kind: "move", delta: event.key === "ArrowDown" ? 1 : -1 });
  } else if (event.key === "Enter") {
    event.preventDefault();
    const action = enterAction(p.state(), p.rows(), event.isComposing);
    if (action !== null) {
      p.run(action);
    }
  } else if (event.key === "Tab") {
    // Not trapped: it closes, like focus leaving, and the default move goes on.
    p.close("dismiss");
  }
}

function onRowClick(p: Palette, event: MouseEvent): void {
  if (!event.isTrusted || !(event.target instanceof Element)) {
    return;
  }
  const rowId = event.target.closest<HTMLElement>("[data-row-id]")?.dataset["rowId"];
  const row = filterRows(p.rows(), p.state().filter).find((r) => r.id === rowId);
  if (row?.enabled === true && row.action !== null) {
    p.run(row.action);
  }
}

function onFocusOut(p: Palette, event: FocusEvent): void {
  if (!event.isTrusted) {
    return;
  }
  const next = event.relatedTarget;
  if (next instanceof Node && p.dom.root.contains(next)) {
    return;
  }
  p.close(next === null ? "dismiss" : "leave");
}

function stopKeyBubble(event: Event): void {
  if (event.isTrusted) {
    event.stopPropagation();
  }
}

function wire(p: Palette): void {
  const { signal } = p;
  const { dialog, input } = p.dom;
  // Window CAPTURE, so it runs before the panel's document-capture Escape and
  // stops it: one Esc closes the palette and leaves the panel open.
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted || event.key !== "Escape") {
        return;
      }
      event.stopImmediatePropagation();
      event.preventDefault();
      p.close("dismiss");
    },
    { signal, capture: true },
  );
  input.addEventListener("keydown", (event) => onInputKey(p, event), { signal });
  input.addEventListener(
    "input",
    (event) => {
      if (event.isTrusted) {
        p.dispatch({ kind: "type", filter: input.value });
      }
    },
    { signal },
  );
  dialog.addEventListener("keyup", stopKeyBubble, { signal });
  dialog.addEventListener("keypress", stopKeyBubble, { signal });
  // Keeps focus in the input, so the row is still in the DOM when `click` fires.
  dialog.addEventListener(
    "pointerdown",
    (event) => {
      if (event.isTrusted) {
        event.preventDefault();
      }
    },
    { signal },
  );
  p.dom.list.addEventListener("click", (event) => onRowClick(p, event), { signal });
  dialog.addEventListener("focusout", (event) => onFocusOut(p, event), { signal });
}

/**
 * Mount a palette, synchronously: no `await` before the host is appended and
 * `__nimbusClose` is set, so a second press finds this host and toggles it
 * cleanly. Returns the step that starts resolve — run only after mount returns.
 */
function mount(init: PaletteInit): () => Promise<void> {
  const saved = saveSelection();
  const focusedAtMount = document.activeElement;
  const panel = readOpenPanel();
  const dom = buildDom(panel.present);
  const controller = new AbortController();
  const mountedUrl = window.location.href;
  let resolved: PaletteInput["resolved"] = { kind: "pending" };
  let state: PaletteState = { filter: "", activeId: null, touched: false };
  let closed = false;
  let navTimer: ReturnType<typeof setInterval> | undefined;

  const rows = (): readonly PaletteRow[] =>
    paletteRows({ recognition: init.recognition, selectionText: saved.text, resolved });
  const dispatch = (event: PaletteEvent): void => {
    state = reducePalette(state, event, rows());
    renderList(dom.list, dom.input, rows(), state);
  };
  const close = (how: CloseHow): boolean => {
    if (closed) {
      return false;
    }
    closed = true;
    // Listeners first: removing a focused host must not re-enter via focusout.
    controller.abort();
    clearInterval(navTimer);
    dom.host.remove();
    if (how !== "leave") {
      restoreSelection(saved);
    }
    if (how === "dismiss" || how === "quick-clip") {
      refocus(focusedAtMount);
    }
    return true;
  };
  const run = (action: PaletteAction): void => {
    // The host is gone and the selection back BEFORE the worker hears anything:
    // quick-clip reads the page selection, and so does a freshly mounted panel.
    if (close(action.kind === "intent" ? "intent" : "quick-clip")) {
      send(action);
    }
  };
  const palette: Palette = {
    dom,
    signal: controller.signal,
    rows,
    state: () => state,
    dispatch,
    close,
    run,
  };
  wire(palette);

  document.documentElement.append(dom.host);
  dom.host.__nimbusClose = () => {
    close("dismiss");
  };
  dispatch({ kind: "rows-changed" });
  dom.input.focus();
  navTimer = setInterval(() => {
    // The page can detach our host without going through close(); a timer that
    // never self-terminates is not acceptable on someone else's page.
    if (!dom.host.isConnected || window.location.href !== mountedUrl) {
      close("dismiss");
    }
  }, NAV_CHECK_MS);

  return async () => {
    let next: PaletteInput["resolved"];
    try {
      const res = await sendMessage({
        kind: "resolve",
        pageUrl: mountedUrl,
        title: document.title,
      });
      next = resolvedFrom(res, panel.chosenId, saved.text);
    } catch {
      next = { kind: "failed" };
    }
    if (closed) {
      return;
    }
    resolved = next;
    dispatch({ kind: "rows-changed" });
  };
}

/**
 * The entry point. A host counts as ours only if it carries the `__nimbusClose`
 * expando this module sets — set from the isolated world, so a page cannot forge
 * it. Ours means toggle: close it and stop. Anything else under the id is a
 * decoy, removed (every match, as the cue does) before a fresh mount, so a
 * planted `<div id="nimbus-palette-host">` cannot swallow the first press.
 */
function togglePalette(init: PaletteInit): void {
  let ownClose: (() => void) | null = null;
  for (const el of document.querySelectorAll(`#${HOST_ID}`)) {
    const close = (el as PaletteHost).__nimbusClose;
    if (ownClose === null && typeof close === "function") {
      ownClose = close;
    } else {
      el.remove();
    }
  }
  if (ownClose !== null) {
    ownClose();
    return;
  }
  const startResolve = mount(init);
  void startResolve();
}

(globalThis as unknown as { __nimbusPalette?: (init: PaletteInit) => void }).__nimbusPalette =
  togglePalette;
