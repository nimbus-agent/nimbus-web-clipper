// src/options/brief-log-view.ts
// The disclosure log, rendered in stage 4 — the "Where your data goes" panel,
// which is where a user already goes to ask this question. Pure: no chrome.*,
// no fetch.
//
// This is the second half of that panel's answer. The rest of stage 4 says which
// one origin the extension talks to; this says what it caused to leave.
import { type BriefLogEntry, MAX_LOG_ENTRIES } from "../shared/brief-log.ts";

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

/** One entry in the user's words. `failed` still describes a real egress: the
 *  source text left before synthesis gave up. */
function describeEntry(entry: BriefLogEntry): string {
  const pages = `${entry.sourceCount} ${entry.sourceCount === 1 ? "page" : "pages"}`;
  const shortened = entry.truncatedCount > 0 ? `, ${entry.truncatedCount} shortened to fit` : "";
  if (entry.failed === true) {
    return `${pages} were sent${shortened}, but the brief didn't finish.`;
  }
  if (entry.model === undefined) {
    return `${pages} were sent${shortened}.`;
  }
  return entry.remote === true
    ? `${pages} were sent${shortened} and answered by a remote model (${entry.model}).`
    : `${pages} were sent${shortened} and answered on your machine by ${entry.model}.`;
}

export function renderBriefLog(root: HTMLElement, entries: readonly BriefLogEntry[]): void {
  root.replaceChildren();
  root.appendChild(el("h3", "Research briefs you have run", "stage__sub"));
  root.appendChild(
    el(
      "p",
      `Nimbus's own audit trail does not cover model calls, so this list is kept here, in your browser. The last ${MAX_LOG_ENTRIES} are kept.`,
      "options__status",
    ),
  );
  if (entries.length === 0) {
    root.appendChild(
      el("p", "No research briefs have been run from this browser.", "options__status"),
    );
    return;
  }
  const list = el("ul", undefined, "brief-log");
  // Newest first — a log is read from the top.
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const li = el("li");
    li.appendChild(el("p", new Date(entry.at).toLocaleString(), "brief-log__when"));
    li.appendChild(el("p", entry.question, "brief-log__question"));
    li.appendChild(el("p", describeEntry(entry), "brief-log__what"));
    if (entry.savedItemId !== undefined) {
      li.appendChild(el("p", "Saved to your index.", "brief-log__saved"));
    }
    list.appendChild(li);
  }
  root.appendChild(list);
  const clear = el("button", "Clear this list", "brief-log__clear");
  clear.type = "button";
  clear.id = "clear-brief-log";
  root.appendChild(clear);
}
