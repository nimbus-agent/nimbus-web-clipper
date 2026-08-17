// @vitest-environment jsdom
// test/unit/brief-view.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import type { BriefState } from "../../src/background/brief-handlers.ts";
import { renderComposer, renderState } from "../../src/brief/brief-view.ts";
import type { BriefReport } from "../../src/shared/brief-report.ts";

let root: HTMLElement;

beforeEach(() => {
  // replaceChildren, not innerHTML — this file asserts that the view never
  // parses text as markup, so it should not reach for the parser itself either.
  document.body.replaceChildren();
  root = document.createElement("div");
  document.body.appendChild(root);
});

const report: BriefReport = {
  summary: "They disagree about retries.",
  findings: [
    { text: "A retries.", citations: [{ kind: "source", title: "A", quote: "we retry" }] },
  ],
  conflicts: [
    {
      text: "A retries, B does not.",
      citations: [
        { kind: "source", title: "A" },
        { kind: "source", title: "B" },
      ],
    },
  ],
  gaps: ["Only 2 of 3 sources were read.", "Ran on a remote model."],
  synthesis: { model: "gpt", remote: true, disclosure: "Ran on a remote model." },
};

function done(over: Partial<Extract<BriefState, { kind: "done" }>> = {}): BriefState {
  return { kind: "done", id: "b1", report, skipped: [], truncated: [], ...over };
}

describe("renderComposer", () => {
  it("lists each named tab with a checkbox", () => {
    renderComposer(root, {
      named: [
        { id: 1, url: "https://example.com/a", title: "A" },
        { id: 2, url: "https://example.com/b", title: "B" },
      ],
      hiddenCount: 0,
      questions: ["Where do these contradict each other?"],
      selected: new Set([1]),
    });
    const boxes = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.checked).toBe(true);
    expect(boxes[1]?.checked).toBe(false);
  });

  it("reports ungranted tabs as a COUNT and names none of them", () => {
    renderComposer(root, {
      named: [{ id: 1, url: "https://example.com/a", title: "A" }],
      hiddenCount: 3,
      questions: ["q"],
      selected: new Set(),
    });
    expect(root.textContent).toContain("3 open tabs");
    expect(root.textContent).toContain("page access");
  });

  it("says nothing about ungranted tabs when there are none", () => {
    renderComposer(root, {
      named: [{ id: 1, url: "https://example.com/a", title: "A" }],
      hiddenCount: 0,
      questions: ["q"],
      selected: new Set(),
    });
    expect(root.textContent).not.toContain("page access");
  });

  it("says the tabs couldn't be READ rather than claiming there are none", () => {
    renderComposer(root, {
      named: [],
      hiddenCount: 0,
      questions: [],
      selected: new Set(),
      enumerationFailed: true,
    });
    expect(root.textContent).toContain("Couldn't read your open tabs");
    expect(root.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it("offers the scaffolded questions and a COLLAPSED custom-question control", () => {
    renderComposer(root, {
      named: [{ id: 1, url: "https://example.com/a", title: "A" }],
      hiddenCount: 0,
      questions: ["What breaks if all of these land?"],
      selected: new Set([1]),
    });
    expect(root.textContent).toContain("What breaks if all of these land?");
    const details = root.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Ask your own question");
  });

  it("renders a tab title as text, never as markup", () => {
    renderComposer(root, {
      named: [{ id: 1, url: "https://example.com/a", title: "<img src=x onerror=alert(1)>" }],
      hiddenCount: 0,
      questions: ["q"],
      selected: new Set(),
    });
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("renderState", () => {
  it("shows feed progress", () => {
    renderState(root, { kind: "feeding", id: "b1", received: 2, expected: 5 });
    expect(root.textContent).toContain("2");
    expect(root.textContent).toContain("5");
  });

  it("renders summary, findings and conflicts", () => {
    renderState(root, done());
    expect(root.textContent).toContain("They disagree about retries.");
    expect(root.textContent).toContain("A retries.");
    expect(root.textContent).toContain("A retries, B does not.");
  });

  it("renders the remote banner and does NOT repeat it in gaps", () => {
    renderState(root, done());
    const text = root.textContent ?? "";
    const occurrences = text.split("Ran on a remote model.").length - 1;
    expect(occurrences).toBe(1);
    expect(text).toContain("Only 2 of 3 sources were read.");
  });

  it("names the model that answered", () => {
    renderState(root, done());
    expect(root.textContent).toContain("gpt");
  });

  it("says so plainly when the answer stayed on the machine", () => {
    renderState(
      root,
      done({ report: { ...report, gaps: [], synthesis: { model: "llama3", remote: false } } }),
    );
    expect(root.textContent?.toLowerCase()).toContain("on your machine");
    expect(root.textContent).toContain("llama3");
  });

  it("names skipped sources and shortened ones", () => {
    renderState(root, done({ skipped: [{ title: "C", reason: "url-changed" }], truncated: ["A"] }));
    expect(root.textContent).toContain("C");
    expect(root.textContent).toContain("A");
  });

  it("renders a failure with its reason and never as an empty panel", () => {
    renderState(root, { kind: "failed", id: "b1", reason: "briefs_disabled", hint: "turn it on" });
    expect(root.textContent).toContain("turn it on");
    expect(root.textContent?.trim()).not.toBe("");
  });

  it("A FAILED SAVE KEEPS THE REPORT ON SCREEN and offers the button again", () => {
    // The whole reason `saveError` exists rather than a transition to `failed`:
    // the user was reading this brief, and a refused save must not erase it.
    renderState(root, done({ saveError: "expired" }));
    expect(root.textContent).toContain("They disagree about retries.");
    expect(root.textContent?.toLowerCase()).toContain("no longer available to save");
    expect(root.querySelector("#save-brief")).not.toBeNull();
  });

  it("hides the save button once saved, and shows no save error", () => {
    renderState(root, done({ savedItemId: "i1" }));
    expect(root.querySelector("#save-brief")).toBeNull();
    expect(root.textContent).toContain("Saved to your index.");
  });

  it("says when the saved copy lost its quotes", () => {
    const stripped: BriefReport = {
      ...report,
      gaps: [...report.gaps, "Supporting quotes were omitted from the saved copy (size limit)."],
    };
    renderState(root, done({ report: stripped, savedItemId: "i1" }));
    expect(root.textContent?.toLowerCase()).toContain("left out the supporting quotes");
  });

  it("escapes source-controlled text rather than parsing it as HTML", () => {
    renderState(root, done({ report: { ...report, summary: "<img src=x onerror=alert(1)>" } }));
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
