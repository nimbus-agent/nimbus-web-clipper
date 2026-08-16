// Pure presentation for the keyboard-shortcut readout in Options stage 2.
// No chrome.*, no DOM reads — it takes bindings and returns rows, plus one
// string of per-browser guidance.
import type { CommandBinding } from "../browser/commands.ts";

export interface ShortcutRow {
  readonly label: string;
  /** The bound key combo, or the words "Not set" — never an empty cell. */
  readonly shortcut: string;
  readonly bound: boolean;
}

/**
 * WHY THIS EXISTS AT ALL: `suggested_key` in the manifest is a *suggestion*. When
 * something else already claims the combo, the browser leaves the command
 * unbound, reports nothing, and the keystroke goes to the page. A user in that
 * state concludes the feature is broken. This is the only surface that can tell
 * them otherwise — Alt+Shift+R failing to bind in Chrome is exactly how the
 * defect behind this slice was found.
 */
export function shortcutRows(commands: readonly CommandBinding[]): ShortcutRow[] {
  return commands.map((c) => ({
    // Never an empty label: a row with no text is indistinguishable from a
    // rendering bug, and the name is at least identifying.
    label: c.description === "" ? c.name : c.description,
    shortcut: c.shortcut === "" ? "Not set" : c.shortcut,
    bound: c.shortcut !== "",
  }));
}

/**
 * Where to go to fix an unbound shortcut, per browser.
 *
 * It is guidance plus a copyable path, NOT a link, and that is forced on us:
 * Chrome refuses to let an extension page navigate to `chrome://extensions/shortcuts`,
 * and Firefox's equivalent lives somewhere else entirely. A link that silently
 * does nothing would be a second invisible failure stacked on the one this
 * slice exists to fix.
 */
export function shortcutsHint(isFirefox: boolean): string {
  return isFirefox
    ? "To change these, paste about:addons into the address bar, then use the gear menu → Manage Extension Shortcuts."
    : "To change these, paste chrome://extensions/shortcuts into the address bar. Browsers don't allow a page to link there.";
}

export function renderShortcuts(doc: Document, rows: readonly ShortcutRow[]): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const row of rows) {
    const el = doc.createElement("div");
    el.className = "shortcut";
    // A data attribute, not only different text: the CSS marks the unbound row so
    // it is findable at a glance rather than by reading every line.
    el.dataset["bound"] = String(row.bound);
    const label = doc.createElement("span");
    label.className = "shortcut__label";
    // textContent, never innerHTML — the description comes from the manifest, but
    // this function must stay safe for any caller.
    label.textContent = row.label;
    const key = doc.createElement("span");
    key.className = "shortcut__key";
    key.textContent = row.shortcut;
    el.append(label, key);
    frag.append(el);
  }
  return frag;
}
