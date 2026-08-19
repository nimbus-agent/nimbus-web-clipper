// @vitest-environment jsdom
// test/unit/brief-log-view.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { renderBriefLog } from "../../src/options/brief-log-view.ts";
import { MAX_LOG_ENTRIES } from "../../src/shared/brief-log.ts";

let root: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("div");
  document.body.appendChild(root);
});

describe("renderBriefLog", () => {
  it("says plainly when nothing has left", () => {
    renderBriefLog(root, []);
    expect(root.textContent).toContain("No research briefs");
  });

  it("names the model and whether it was remote", () => {
    renderBriefLog(root, [
      {
        runId: "r1",
        at: 1_700_000_000_000,
        question: "Why?",
        sourceCount: 3,
        truncatedCount: 1,
        model: "gpt-4",
        remote: true,
      },
    ]);
    expect(root.textContent).toContain("gpt-4");
    expect(root.textContent).toContain("3 pages");
    expect(root.textContent?.toLowerCase()).toContain("remote");
    expect(root.textContent).toContain("1 shortened to fit");
  });

  it("distinguishes a local run", () => {
    renderBriefLog(root, [
      {
        runId: "r1",
        at: 1,
        question: "q",
        sourceCount: 1,
        truncatedCount: 0,
        model: "llama3",
        remote: false,
      },
    ]);
    expect(root.textContent?.toLowerCase()).toContain("on your machine");
  });

  it("shows a failed run — the source text still left", () => {
    renderBriefLog(root, [
      { runId: "r1", at: 1, question: "q", sourceCount: 2, truncatedCount: 0, failed: true },
    ]);
    expect(root.textContent?.toLowerCase()).toContain("didn't finish");
    expect(root.textContent).toContain("2 pages were sent");
  });

  it("states the retention cap rather than forgetting quietly", () => {
    renderBriefLog(root, []);
    expect(root.textContent).toContain(String(MAX_LOG_ENTRIES));
  });

  it("newest first", () => {
    renderBriefLog(root, [
      { runId: "old", at: 1, question: "first", sourceCount: 1, truncatedCount: 0 },
      { runId: "new", at: 2, question: "second", sourceCount: 1, truncatedCount: 0 },
    ]);
    const text = root.textContent ?? "";
    expect(text.indexOf("second")).toBeLessThan(text.indexOf("first"));
  });

  it("marks a saved run", () => {
    renderBriefLog(root, [
      {
        runId: "r1",
        at: 1,
        question: "q",
        sourceCount: 1,
        truncatedCount: 0,
        savedItemId: "i1",
      },
    ]);
    expect(root.textContent).toContain("Saved to your index.");
  });

  it("escapes the question rather than parsing it", () => {
    renderBriefLog(root, [
      { runId: "r1", at: 1, question: "<b>hi</b>", sourceCount: 1, truncatedCount: 0 },
    ]);
    expect(root.querySelector("b")).toBeNull();
    expect(root.textContent).toContain("<b>hi</b>");
  });

  it("says when a logged run also searched your index", () => {
    renderBriefLog(root, [
      {
        runId: "r1",
        at: 1,
        question: "q",
        sourceCount: 2,
        truncatedCount: 0,
        usedIndex: true,
      },
    ]);
    expect(root.textContent?.toLowerCase()).toContain("saved clips");
  });

  it("says nothing about the index for a run that did not search it", () => {
    renderBriefLog(root, [
      {
        runId: "r1",
        at: 1,
        question: "q",
        sourceCount: 2,
        truncatedCount: 0,
        usedIndex: false,
      },
    ]);
    expect(root.textContent?.toLowerCase()).not.toContain("saved clips");
    expect(root.textContent?.toLowerCase()).not.toContain("index");
  });

  it("says nothing for an entry written before the field existed", () => {
    // Absent means "not recorded", which is NOT the same as "did not happen".
    renderBriefLog(root, [
      { runId: "r1", at: 1, question: "q", sourceCount: 2, truncatedCount: 0 },
    ]);
    expect(root.textContent?.toLowerCase()).not.toContain("saved clips");
    expect(root.textContent?.toLowerCase()).not.toContain("index");
  });

  it("says how many indexed items the run drew on, when that was recorded", () => {
    renderBriefLog(root, [
      {
        runId: "r1",
        at: 1,
        question: "q",
        sourceCount: 2,
        truncatedCount: 0,
        usedIndex: true,
        indexHits: 3,
      },
    ]);
    expect(root.querySelector(".brief-log__index")?.textContent).toBe(
      "Also searched your saved clips, and drew on 3 of them.",
    );
  });

  it("says plainly when nothing from the search reached the brief, rather than omitting the count", () => {
    renderBriefLog(root, [
      {
        runId: "r1",
        at: 1,
        question: "q",
        sourceCount: 2,
        truncatedCount: 0,
        usedIndex: true,
        indexHits: 0,
      },
    ]);
    const text = root.querySelector(".brief-log__index")?.textContent;
    expect(text).toBe("Also searched your saved clips — nothing from them reached the brief.");
    // indexHits counts what the report CITED, not what the gateway's search
    // matched — this client never sees the search's own results, so the zero
    // case must not claim anything about matching.
    expect(text).not.toContain("matched");
  });

  it("still marks the search when no count was recorded — a run whose report never came", () => {
    // `indexHits` is absent on its own schedule. The marker is what the egress
    // record is FOR, so it renders without a count rather than inventing one.
    renderBriefLog(root, [
      {
        runId: "r1",
        at: 1,
        question: "q",
        sourceCount: 2,
        truncatedCount: 0,
        usedIndex: true,
        failed: true,
      },
    ]);
    expect(root.querySelector(".brief-log__index")?.textContent).toBe(
      "Also searched your saved clips.",
    );
  });

  it("shows no count for a run that did not search at all, whatever indexHits says", () => {
    renderBriefLog(root, [
      {
        runId: "r1",
        at: 1,
        question: "q",
        sourceCount: 2,
        truncatedCount: 0,
        usedIndex: false,
        indexHits: 4,
      },
    ]);
    expect(root.querySelector(".brief-log__index")).toBeNull();
  });
});
