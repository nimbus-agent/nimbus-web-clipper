// src/brief/brief.ts
// The brief page. Sends messages, renders what comes back.
//
// It never calls the gateway and it never polls: the service worker owns the run
// (one poller, and it is not here), so this file holds no timers and no fetch.
import type { BriefState } from "../background/brief-handlers.ts";
import type { CandidateTab } from "../browser/tabs.ts";
import { buildBriefPreview } from "../shared/preview.ts";
import { renderPreview } from "../shared/preview-view.ts";
import { renderComposer, renderState } from "./brief-view.ts";

const selected = new Set<number>();
let named: readonly CandidateTab[] = [];
let question = "";

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

function showPreview(): void {
  const sources = named
    .filter((t) => selected.has(t.id))
    .map((t) => ({ title: t.title, url: t.url }));
  const panel = root("preview");
  if (sources.length === 0 || question === "") {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const body = root("preview-body");
  body.replaceChildren(renderPreview(document, buildBriefPreview({ question, sources })));
}

interface TabsAnswer {
  readonly named?: CandidateTab[];
  readonly hiddenCount?: number;
  readonly questions?: string[];
  readonly enumerationFailed?: boolean;
}

async function loadTabs(): Promise<void> {
  const res: unknown = await chrome.runtime.sendMessage({ kind: "brief-tabs" });
  if (typeof res !== "object" || res === null) {
    return;
  }
  const data = res as TabsAnswer;
  named = data.named ?? [];
  renderComposer(root("composer"), {
    named,
    hiddenCount: data.hiddenCount ?? 0,
    questions: data.questions ?? [],
    selected,
    enumerationFailed: data.enumerationFailed === true,
  });
  showPreview();
}

root("composer").addEventListener("click", (ev) => {
  const target = ev.target;
  if (target instanceof HTMLInputElement && target.type === "checkbox") {
    const id = Number(target.value);
    if (target.checked) {
      selected.add(id);
    } else {
      selected.delete(id);
    }
    showPreview();
    return;
  }
  if (target instanceof HTMLButtonElement && target.dataset["question"] !== undefined) {
    question = target.dataset["question"];
    showPreview();
  }
});

root("composer").addEventListener("input", (ev) => {
  const target = ev.target;
  if (target instanceof HTMLTextAreaElement && target.id === "custom-question") {
    question = target.value.trim();
    showPreview();
  }
});

root("run").addEventListener("click", () => {
  void chrome.runtime
    .sendMessage({
      kind: "brief-start",
      question,
      picks: [...selected].map((id) => ({ kind: "tab" as const, id })),
    })
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
  void chrome.runtime
    .sendMessage({ kind: "brief-save", id })
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
