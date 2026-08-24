// @vitest-environment jsdom
// test/unit/brief-page.test.ts
//
// The brief page's own wiring: selection, question choice, the preview gate, and
// the two message round trips. `brief-view.test.ts` covers what the DOM looks
// like; this file covers what the page DOES.
//
// `src/brief/brief.ts` binds its listeners as a MODULE-EVALUATION side effect, so
// the fixture must exist before the import and every test re-imports through
// `vi.resetModules()` — a second import of a live module would drive the previous
// test's listeners against a detached DOM.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BriefReport } from "../../src/shared/brief-report.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

const FIXTURE = `
  <main class="brief">
    <section id="composer"></section>
    <section id="preview" hidden>
      <div id="preview-body"></div>
      <button id="run" type="button">Send</button>
    </section>
    <section id="state"></section>
  </main>
`;

const TABS = {
  named: [
    { id: 1, url: "https://example.com/a", title: "A" },
    { id: 2, url: "https://example.com/b", title: "B" },
  ],
  hiddenCount: 0,
  questions: ["Where do these contradict each other?"],
  enumerationFailed: false,
};

const REPORT: BriefReport = {
  summary: "They disagree about the rollout date.",
  findings: [],
  conflicts: [],
  gaps: [],
  synthesis: { model: "llama-3", remote: false },
};

let harness: ChromeHarness;

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing #${id}`);
  }
  return node;
}

/** A row's box, found by its PICK ID — `tab:<id>` or `passages:<url>`. */
function pickBox(id: string): HTMLInputElement {
  const box = document.querySelector<HTMLInputElement>(
    `#composer input[type="checkbox"][value="${id}"]`,
  );
  if (box === null) {
    throw new Error(`no checkbox for ${id}`);
  }
  return box;
}

function checkbox(tabId: number): HTMLInputElement {
  return pickBox(`tab:${tabId}`);
}

/**
 * `.click()` rather than a synthetic MouseEvent: a checkbox's pre-click
 * activation behaviour TOGGLES `checked`, so assigning it first and then
 * dispatching flips it back and the delegated handler sees the opposite of what
 * the test asked for.
 */
function tick(box: HTMLInputElement, checked: boolean): void {
  if (box.checked !== checked) {
    box.click();
  }
}

function pickQuestion(): void {
  const button = document.querySelector<HTMLButtonElement>("#composer button[data-question]");
  button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function click(id: string): void {
  $(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Load the page module against the current fixture and let its initial
 *  `loadTabs()` settle. */
async function loadPage(): Promise<void> {
  document.body.innerHTML = FIXTURE;
  vi.resetModules();
  await import("../../src/brief/brief.ts");
  await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledWith({ kind: "brief-tabs" }));
  await vi.waitFor(() =>
    expect(document.querySelectorAll("#composer .brief__tabs input")).toHaveLength(2),
  );
}

/** Select both tabs and a question — the state from which Send is meaningful. */
async function compose(): Promise<void> {
  tick(checkbox(1), true);
  tick(checkbox(2), true);
  pickQuestion();
  await vi.waitFor(() => expect($("preview").hidden).toBe(false));
}

beforeEach(() => {
  harness = installChromeMock();
  harness.sendMessage.mockResolvedValue(TABS);
});

afterEach(() => {
  harness.restore();
});

describe("composer", () => {
  test("renders a row per named tab and asks the worker for them on load", async () => {
    await loadPage();
    expect(harness.sendMessage).toHaveBeenCalledWith({ kind: "brief-tabs" });
    expect(checkbox(1).checked).toBe(false);
  });

  test("a non-object answer is ignored rather than thrown through", async () => {
    harness.sendMessage.mockResolvedValue(undefined);
    document.body.innerHTML = FIXTURE;
    vi.resetModules();
    await import("../../src/brief/brief.ts");
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalled());
    expect($("composer").children).toHaveLength(0);
  });

  test("a partial answer falls back to empty lists rather than rendering undefined", async () => {
    harness.sendMessage.mockResolvedValue({});
    document.body.innerHTML = FIXTURE;
    vi.resetModules();
    await import("../../src/brief/brief.ts");
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalled());
    expect(document.querySelectorAll("#composer .brief__tabs input[type=checkbox]")).toHaveLength(
      0,
    );
  });

  test("a FAILED brief-tabs renders the error, not a claim about the browser", async () => {
    // The router answers a rejected handler with a BriefState. Read as a tab
    // answer it is an empty browser, and the composer would then say "No open
    // tabs on sites you have granted page access to" — which we have no evidence
    // for. A failed enumeration is not an empty one.
    harness.sendMessage.mockResolvedValue({ kind: "failed", reason: "server_error" });
    document.body.innerHTML = FIXTURE;
    vi.resetModules();
    await import("../../src/brief/brief.ts");
    await vi.waitFor(() => expect($("composer").querySelector(".brief__error")).not.toBeNull());
    expect($("composer").textContent).toContain("Couldn't read your open tabs");
    expect($("composer").textContent).not.toContain("No open tabs on sites you have granted");
  });

  test("the twenty-first box refuses the tick instead of buying an invalid_request", async () => {
    // `isBriefStartRequest` rejects a pick list over the cap WHOLE, so a counter
    // that keeps climbing ends a finished composition at a bare
    // `invalid_request`. The tick is refused at the box instead — and this is
    // the in-place path, which deliberately does not redraw the composer.
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: i + 1,
      url: `https://example.com/t${i}`,
      title: `T${i}`,
    }));
    harness.sendMessage.mockResolvedValue({ ...TABS, named: many });
    document.body.innerHTML = FIXTURE;
    vi.resetModules();
    await import("../../src/brief/brief.ts");
    await vi.waitFor(() =>
      expect(document.querySelectorAll("#composer .brief__tabs input[type=checkbox]")).toHaveLength(
        21,
      ),
    );
    for (let i = 1; i <= 20; i += 1) {
      tick(checkbox(i), true);
    }
    expect($("composer").querySelector(".brief__count")?.textContent).toBe("20 of 20 sources");
    expect(checkbox(21).disabled).toBe(true);
    expect(checkbox(1).disabled).toBe(false);

    // Trading one source for another still works — the cap is not a lock.
    tick(checkbox(1), false);
    expect(checkbox(21).disabled).toBe(false);
  });
});

describe("the preview gate", () => {
  test("stays hidden with sources but no question", async () => {
    await loadPage();
    tick(checkbox(1), true);
    expect($("preview").hidden).toBe(true);
  });

  test("stays hidden with a question but no sources", async () => {
    await loadPage();
    pickQuestion();
    expect($("preview").hidden).toBe(true);
  });

  test("appears once both are present, and names the sources", async () => {
    await loadPage();
    await compose();
    expect($("preview-body").textContent).toContain("A");
    expect($("preview-body").textContent).toContain("B");
  });

  test("unticking the last source hides it again", async () => {
    await loadPage();
    await compose();
    tick(checkbox(1), false);
    tick(checkbox(2), false);
    expect($("preview").hidden).toBe(true);
  });

  test("a typed question drives the preview the same way a picked one does", async () => {
    await loadPage();
    tick(checkbox(1), true);
    const custom = document.createElement("textarea");
    custom.id = "custom-question";
    $("composer").appendChild(custom);
    custom.value = "  What breaks if all of these land?  ";
    custom.dispatchEvent(new Event("input", { bubbles: true }));
    expect($("preview").hidden).toBe(false);
  });
});

describe("send", () => {
  test("sends the picked question and tab picks, and renders what comes back", async () => {
    await loadPage();
    await compose();
    harness.sendMessage.mockResolvedValueOnce({
      kind: "feeding",
      id: "b1",
      received: 0,
      expected: 2,
    });

    click("run");

    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({
        kind: "brief-start",
        question: "Where do these contradict each other?",
        picks: [
          { kind: "tab", id: 1 },
          { kind: "tab", id: 2 },
        ],
        useIndex: false,
      }),
    );
    await vi.waitFor(() => expect($("state").textContent).not.toBe(""));
  });

  // The ticked path had no unit coverage at all: every assertion was on
  // `useIndex: false`, so deleting the `target.id === "use-index"` early return
  // in brief.ts let the box fall through to the generic pick branch — `selected`
  // gains the checkbox's default value "on", the source count is wrong, and
  // `useIndex` stays false forever — with the whole unit suite still green.
  test("ticking the index box sends useIndex, and does NOT enrol it as a source", async () => {
    await loadPage();
    await compose();
    const box = document.querySelector<HTMLInputElement>("#use-index");
    expect(box).not.toBeNull();
    if (box !== null) {
      tick(box, true);
    }

    // The index is not a source: it is the gateway's own corpus, not something
    // this client declares and feeds, so the cap counter must not move.
    await vi.waitFor(() =>
      expect(document.querySelector(".brief__count")?.textContent).toContain("2 of 20"),
    );

    harness.sendMessage.mockResolvedValueOnce({
      kind: "feeding",
      id: "b1",
      received: 0,
      expected: 2,
    });

    click("run");

    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({
        kind: "brief-start",
        question: "Where do these contradict each other?",
        // Exactly the two tabs — no third pick built from the checkbox's own
        // value, which is what a fall-through to the generic branch produces.
        picks: [
          { kind: "tab", id: 1 },
          { kind: "tab", id: 2 },
        ],
        useIndex: true,
      }),
    );
  });

  test("an answer without a kind is not rendered as state", async () => {
    await loadPage();
    await compose();
    harness.sendMessage.mockResolvedValueOnce({ nope: true });

    click("run");

    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(2));
    expect($("state").textContent).toBe("");
  });

  test("a rejected send leaves the page intact rather than throwing", async () => {
    await loadPage();
    await compose();
    harness.sendMessage.mockRejectedValueOnce(new Error("worker gone"));

    click("run");

    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(2));
    expect($("state").textContent).toBe("");
  });
});

describe("pushed state", () => {
  test("a brief-state broadcast renders", async () => {
    await loadPage();
    await harness.emitMessage({ kind: "brief-state", state: { kind: "running", id: "b1" } });
    expect($("state").textContent).not.toBe("");
  });

  test("an unrelated broadcast is ignored", async () => {
    await loadPage();
    await harness.emitMessage({ kind: "clip", ok: true });
    expect($("state").textContent).toBe("");
  });
});

describe("save", () => {
  async function reachDone(): Promise<void> {
    await loadPage();
    await harness.emitMessage({
      kind: "brief-state",
      state: { kind: "done", id: "b1", report: REPORT, skipped: [], truncated: [] },
    });
    await vi.waitFor(() => expect(document.getElementById("save-brief")).not.toBeNull());
  }

  test("sends the finished brief's id and reports the save", async () => {
    await reachDone();
    harness.sendMessage.mockResolvedValueOnce({
      kind: "done",
      id: "b1",
      report: REPORT,
      skipped: [],
      truncated: [],
      savedItemId: "item-9",
    });

    click("save-brief");

    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({ kind: "brief-save", id: "b1" }),
    );
    await vi.waitFor(() => expect($("state").textContent).toContain("Saved to your index."));
  });

  test("a save-failed keeps the report on screen and offers the button again", async () => {
    await reachDone();
    harness.sendMessage.mockResolvedValueOnce({
      kind: "save-failed",
      id: "b1",
      reason: "expired",
    });

    click("save-brief");

    // The report survives a failed save — the whole reason `save-failed` is not
    // a `failed` state — and the retry control comes back.
    await vi.waitFor(() => expect(document.getElementById("save-brief")).not.toBeNull());
    expect($("state").textContent).toContain(REPORT.summary);
  });

  test("a save-failed with no report ever seen renders as its own state", async () => {
    await loadPage();
    await harness.emitMessage({
      kind: "brief-state",
      state: { kind: "save-failed", id: "b1", reason: "expired" },
    });
    expect($("state").textContent).not.toBe("");
  });

  test("a rejected save re-enables the button rather than leaving a dead control", async () => {
    await reachDone();
    harness.sendMessage.mockRejectedValueOnce(new Error("worker gone"));

    click("save-brief");

    await vi.waitFor(() => {
      const save = document.getElementById("save-brief") as HTMLButtonElement | null;
      expect(save?.disabled).toBe(false);
    });
  });

  test("a stray click in the state panel is not a save", async () => {
    await reachDone();
    const calls = harness.sendMessage.mock.calls.length;
    $("state").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(harness.sendMessage.mock.calls).toHaveLength(calls);
  });
});

describe("collected passages", () => {
  const GROUP = {
    url: "https://example.com/c",
    title: "C page",
    passages: [
      { url: "https://example.com/c", title: "C page", text: "first excerpt", at: 100 },
      { url: "https://example.com/c#x", title: "C page", text: "second excerpt", at: 200 },
    ],
  };

  async function loadWithPassages(): Promise<void> {
    harness.sendMessage.mockResolvedValue({ ...TABS, passages: [GROUP] });
    document.body.innerHTML = FIXTURE;
    vi.resetModules();
    await import("../../src/brief/brief.ts");
    await vi.waitFor(() =>
      expect(document.querySelectorAll("#composer .brief__tabs input[type=checkbox]")).toHaveLength(
        3,
      ),
    );
  }

  test("a collected page renders its own row beside the tabs", async () => {
    await loadWithPassages();
    expect(pickBox("passages:https://example.com/c").checked).toBe(false);
    expect($("composer").textContent).toContain("2 passages");
  });

  test("picking it sends a passages pick, not a tab id", async () => {
    await loadWithPassages();
    tick(pickBox("passages:https://example.com/c"), true);
    pickQuestion();
    await vi.waitFor(() => expect($("preview").hidden).toBe(false));
    harness.sendMessage.mockResolvedValueOnce({
      kind: "feeding",
      id: "b1",
      received: 0,
      expected: 1,
    });

    click("run");

    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({
        kind: "brief-start",
        question: "Where do these contradict each other?",
        picks: [{ kind: "passages", url: "https://example.com/c" }],
        useIndex: false,
      }),
    );
  });

  test("the preview shows the passage text that will be sent", async () => {
    await loadWithPassages();
    tick(pickBox("passages:https://example.com/c"), true);
    pickQuestion();
    await vi.waitFor(() => expect($("preview").hidden).toBe(false));
    const shown = $("preview-body").textContent ?? "";
    expect(shown).toContain("first excerpt");
    expect(shown).toContain("second excerpt");
    expect(shown).toContain("2 passages");
  });

  test("removing one passage tells the worker WHICH one, then re-reads the store", async () => {
    await loadWithPassages();
    const drop = document.querySelector<HTMLButtonElement>("#composer button.brief__drop");
    drop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({
        kind: "passage-drop",
        url: "https://example.com/c",
        at: 100,
      }),
    );
    // Re-read rather than patched locally: the store is the authority.
    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenLastCalledWith({ kind: "brief-tabs" }),
    );
  });

  test("removing the page sends no `at`, and clear-all names nothing", async () => {
    await loadWithPassages();
    document
      .querySelector<HTMLButtonElement>("#composer button.brief__drop-row")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({
        kind: "passage-drop",
        url: "https://example.com/c",
      }),
    );

    click("clear-passages");
    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({ kind: "passage-clear" }),
    );
  });

  test("a question the user typed survives dropping a passage", async () => {
    // The drop re-reads the store and redraws — the right architecture — but a
    // redraw that forgot the typed words would make an unrelated click eat them.
    await loadWithPassages();
    const custom = document.querySelector<HTMLTextAreaElement>("#custom-question");
    if (custom === null) {
      throw new Error("no custom-question box");
    }
    custom.value = "What do these have in common?";
    custom.dispatchEvent(new Event("input", { bubbles: true }));
    tick(pickBox("passages:https://example.com/c"), true);
    expect($("preview").hidden).toBe(false);

    document
      .querySelector<HTMLButtonElement>("#composer button.brief__drop")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenLastCalledWith({ kind: "brief-tabs" }),
    );
    const redrawn = document.querySelector<HTMLTextAreaElement>("#custom-question");
    expect(redrawn?.value).toBe("What do these have in common?");
    expect($("preview").hidden).toBe(false);
    expect($("preview-body").textContent).toContain("What do these have in common?");
  });

  test("ticking a row updates the source counter without redrawing the composer", async () => {
    await loadWithPassages();
    const custom = document.querySelector<HTMLTextAreaElement>("#custom-question");
    custom?.focus();
    tick(pickBox("passages:https://example.com/c"), true);
    expect($("composer").querySelector(".brief__count")?.textContent).toBe("1 of 20 sources");
    // The node the user was in is the SAME node — a tick redraws nothing.
    expect(document.querySelector("#custom-question")).toBe(custom);
    tick(pickBox("passages:https://example.com/c"), false);
    expect($("composer").querySelector(".brief__count")?.textContent).toBe("0 of 20 sources");
  });

  /** The group's page is ALSO open as tab 3, so the mode control is offered. */
  async function loadWithOpenTab(): Promise<void> {
    harness.sendMessage.mockResolvedValue({
      ...TABS,
      named: [...TABS.named, { id: 3, url: "https://example.com/c#live", title: "C page" }],
      passages: [GROUP],
    });
    document.body.innerHTML = FIXTURE;
    vi.resetModules();
    await import("../../src/brief/brief.ts");
    await vi.waitFor(() =>
      expect(document.querySelectorAll("#composer .brief__tabs input[type=checkbox]")).toHaveLength(
        3,
      ),
    );
  }

  function clickMode(): void {
    const button = document.querySelector<HTMLButtonElement>("#composer button.brief__mode");
    if (button === null) {
      throw new Error("no mode control on the composer");
    }
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  test("switching a row to the whole page moves the pick rather than dropping it", async () => {
    await loadWithOpenTab();
    tick(pickBox("passages:https://example.com/c"), true);
    pickQuestion();

    clickMode();

    // Same page, other mode — and still picked.
    expect(pickBox("tab:3").checked).toBe(true);
    expect(
      document.querySelector('#composer input[value="passages:https://example.com/c"]'),
    ).toBeNull();
    expect($("preview-body").textContent).toContain("https://example.com/c#live");
  });

  test("and switches BACK, with the passages intact", async () => {
    // The return path. Without it the switch destroys visible work: the tab row
    // is indistinguishable from a tab that never had passages, and nothing on
    // the page names their url again.
    await loadWithOpenTab();
    tick(pickBox("passages:https://example.com/c"), true);
    pickQuestion();
    clickMode();
    expect(pickBox("tab:3").checked).toBe(true);

    clickMode();

    const back = pickBox("passages:https://example.com/c");
    expect(back.checked).toBe(true);
    expect(document.querySelector('#composer input[value="tab:3"]')).toBeNull();
    expect($("composer").textContent).toContain("2 passages");
    expect($("preview-body").textContent).toContain("first excerpt");
  });

  test("a tab closing releases whole-page mode rather than stranding the passages", async () => {
    // A stale whole-page url with no tab would keep the group out of BOTH render
    // branches — no row, so no control carrying the url that would clear it.
    await loadWithOpenTab();
    clickMode();
    expect(pickBox("tab:3")).not.toBeNull();

    // Tab 3 has gone; the collection has not.
    harness.sendMessage.mockResolvedValue({ ...TABS, passages: [GROUP] });
    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() =>
      expect(
        document.querySelector('#composer input[value="passages:https://example.com/c"]'),
      ).not.toBeNull(),
    );
    expect($("composer").textContent).toContain("2 passages");
  });
});

describe("re-enumeration", () => {
  test("a grant made in Options refreshes the composer without a reload", async () => {
    await loadPage();
    const calls = harness.sendMessage.mock.calls.length;

    harness.emitPermissionsAdded();

    await vi.waitFor(() => expect(harness.sendMessage.mock.calls.length).toBeGreaterThan(calls));
    expect(harness.sendMessage).toHaveBeenLastCalledWith({ kind: "brief-tabs" });
  });

  test("regaining focus re-enumerates too", async () => {
    await loadPage();
    const calls = harness.sendMessage.mock.calls.length;

    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => expect(harness.sendMessage.mock.calls.length).toBeGreaterThan(calls));
  });

  test("a re-enumeration that rejects is swallowed, not thrown at the page", async () => {
    await loadPage();
    harness.sendMessage.mockRejectedValueOnce(new Error("worker gone"));

    harness.emitPermissionsAdded();

    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(2));
    expect(document.querySelectorAll("#composer .brief__tabs input[type=checkbox]")).toHaveLength(
      2,
    );
  });
});
