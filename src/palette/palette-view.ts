// src/palette/palette-view.ts
// The command palette's rows and its key/filter reducer. Pure — no DOM, no
// messaging — so what the user sees and what Enter does are unit-testable on
// their own. The overlay that renders these lives in palette-in-page.ts.
import { deployBelongsOnSurface } from "../panel/deploy/deploy-section.ts";
import { type LaneContext, visibleLanes } from "../panel/lane-input.ts";
import { type HeaderState, headerStatusLine } from "../panel/panel-view.ts";
import type { PanelIntent } from "../shared/panel-host.ts";
import type { Recognition } from "../shared/types.ts";

export type PaletteAction =
  | { readonly kind: "intent"; readonly intent: PanelIntent }
  | { readonly kind: "quick-clip"; readonly mode: "article" | "selection" };

export interface PaletteRow {
  /** Stable: "lane:<lane>", "deploy", "related", "clip-page", "clip-selection",
   *  "status", "candidates", "no-match". */
  readonly id: string;
  readonly title: string;
  readonly hint?: string;
  readonly enabled: boolean;
  /** `null` for disabled and status rows. */
  readonly action: PaletteAction | null;
}

export interface PaletteInput {
  readonly recognition: Recognition;
  /** "" when there is no selection. */
  readonly selectionText: string;
  readonly resolved:
    | { readonly kind: "pending" }
    | { readonly kind: "failed" }
    | { readonly kind: "done"; readonly ctx: LaneContext; readonly header: HeaderState };
}

const LOOKING_UP = "Looking up this page…";
const PICK_IN_PANEL = "Pick the item in the panel";
const NO_MATCH = "No matching actions";
const NEED_SELECTION = "Select some text first";
const CONNECT_FAILED = "Couldn't connect to Nimbus.";

function statusRow(title: string): PaletteRow {
  return { id: "status", title, enabled: false, action: null };
}

function intentRow(id: string, title: string, intent: PanelIntent): PaletteRow {
  return { id, title, enabled: true, action: { kind: "intent", intent } };
}

function laneRows(ctx: LaneContext, selectionText: string): readonly PaletteRow[] {
  return visibleLanes(ctx).map((v): PaletteRow => {
    const id = `lane:${v.lane}`;
    if (!v.canRun) {
      return {
        id,
        title: v.title,
        ...(v.refusal === undefined ? {} : { hint: v.refusal }),
        enabled: false,
        action: null,
      };
    }
    // The glossary lane is a selection intent: the worker refuses a bare
    // `{kind:"lane", lane:"glossary"}`.
    return v.lane === "glossary"
      ? intentRow(id, v.title, { kind: "selection", text: selectionText, intent: "define" })
      : intentRow(id, v.title, { kind: "lane", lane: v.lane });
  });
}

function extraRow(header: HeaderState): PaletteRow | null {
  if (header.kind === "ambiguous" && !header.truncated) {
    return intentRow("candidates", PICK_IN_PANEL, { kind: "candidates" });
  }
  const line = headerStatusLine(header);
  return line === null ? null : statusRow(line);
}

function resolvedRows(input: PaletteInput): readonly PaletteRow[] {
  const { resolved, selectionText } = input;
  if (resolved.kind === "pending") {
    return [statusRow(LOOKING_UP)];
  }
  if (resolved.kind === "failed") {
    return [statusRow(CONNECT_FAILED)];
  }
  const extra = extraRow(resolved.header);
  return [...laneRows(resolved.ctx, selectionText), ...(extra === null ? [] : [extra])];
}

function showsDeploy(r: Recognition): boolean {
  return r.ok && deployBelongsOnSurface(r.kind) && r.scope !== undefined && r.origin !== undefined;
}

function clipSelectionRow(selectionText: string): PaletteRow {
  return selectionText === ""
    ? {
        id: "clip-selection",
        title: "Clip selection",
        hint: NEED_SELECTION,
        enabled: false,
        action: null,
      }
    : {
        id: "clip-selection",
        title: "Clip selection",
        enabled: true,
        action: { kind: "quick-clip", mode: "selection" },
      };
}

function instantRows(input: PaletteInput): readonly PaletteRow[] {
  const { recognition, selectionText } = input;
  const rows: PaletteRow[] = [];
  if (showsDeploy(recognition)) {
    rows.push(intentRow("deploy", "Deploy readiness", { kind: "deploy" }));
  }
  if (!recognition.ok || recognition.kind !== "home") {
    rows.push(intentRow("related", "Related items", { kind: "related" }));
  }
  rows.push({
    id: "clip-page",
    title: "Clip page",
    enabled: true,
    action: { kind: "quick-clip", mode: "article" },
  });
  rows.push(clipSelectionRow(selectionText));
  return rows;
}

/** Lanes (or the one status row) first, then the instant rows. Resolve only
 *  ever adds rows above the instant ones; it never removes one. */
export function paletteRows(input: PaletteInput): readonly PaletteRow[] {
  return [...resolvedRows(input), ...instantRows(input)];
}

export interface PaletteState {
  readonly filter: string;
  readonly activeId: string | null;
  /** The user has typed or pressed an arrow key: rows must not jump under them. */
  readonly touched: boolean;
}

export type PaletteEvent =
  | { readonly kind: "rows-changed" }
  | { readonly kind: "type"; readonly filter: string }
  | { readonly kind: "move"; readonly delta: 1 | -1 };

const NO_MATCH_ROW: PaletteRow = { id: "no-match", title: NO_MATCH, enabled: false, action: null };

/** Trimmed, case-insensitive substring match on the title. No match leaves one
 *  disabled "No matching actions" row. */
export function filterRows(rows: readonly PaletteRow[], filter: string): readonly PaletteRow[] {
  const needle = filter.trim().toLowerCase();
  if (needle === "") {
    return rows;
  }
  const kept = rows.filter((r) => r.title.toLowerCase().includes(needle));
  return kept.length === 0 ? [NO_MATCH_ROW] : kept;
}

function firstEnabledId(rows: readonly PaletteRow[]): string | null {
  return rows.find((r) => r.enabled)?.id ?? null;
}

function stillActive(rows: readonly PaletteRow[], id: string | null): boolean {
  return id !== null && rows.some((r) => r.id === id && r.enabled);
}

function movedId(
  rows: readonly PaletteRow[],
  activeId: string | null,
  delta: 1 | -1,
): string | null {
  const enabled = rows.filter((r) => r.enabled);
  if (enabled.length === 0) {
    return null;
  }
  const at = enabled.findIndex((r) => r.id === activeId);
  if (at === -1) {
    return (delta === 1 ? enabled[0] : enabled[enabled.length - 1])?.id ?? null;
  }
  return enabled[(at + delta + enabled.length) % enabled.length]?.id ?? null;
}

/** Every event is evaluated against the FILTERED rows, with `filter` the one the
 *  event leaves behind. */
export function reducePalette(
  state: PaletteState,
  event: PaletteEvent,
  rows: readonly PaletteRow[],
): PaletteState {
  const filter = event.kind === "type" ? event.filter : state.filter;
  const visible = filterRows(rows, filter);
  const keep = stillActive(visible, state.activeId) ? state.activeId : firstEnabledId(visible);
  switch (event.kind) {
    case "move":
      return { filter, touched: true, activeId: movedId(visible, state.activeId, event.delta) };
    case "type":
      return { filter, touched: true, activeId: keep };
    case "rows-changed":
      return {
        filter,
        touched: state.touched,
        activeId: state.touched ? keep : firstEnabledId(visible),
      };
  }
}

/** What Enter runs: nothing while an IME composition is in flight, with no
 *  active row, or on a disabled one. */
export function enterAction(
  state: PaletteState,
  rows: readonly PaletteRow[],
  isComposing: boolean,
): PaletteAction | null {
  if (isComposing || state.activeId === null) {
    return null;
  }
  const row = filterRows(rows, state.filter).find((r) => r.id === state.activeId);
  return row?.enabled === true ? row.action : null;
}
