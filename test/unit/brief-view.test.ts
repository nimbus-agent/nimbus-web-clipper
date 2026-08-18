// @vitest-environment jsdom
// test/unit/brief-view.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import type { BriefState } from "../../src/background/brief-handlers.ts";
import { type ComposerModel, renderComposer, renderState } from "../../src/brief/brief-view.ts";
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
      selected: new Set(["tab:1"]),
      passages: [],
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
      passages: [],
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
      passages: [],
    });
    expect(root.textContent).not.toContain("page access");
  });

  it("says the tabs couldn't be READ rather than claiming there are none", () => {
    renderComposer(root, {
      named: [],
      hiddenCount: 0,
      questions: [],
      selected: new Set(),
      passages: [],
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
      selected: new Set(["tab:1"]),
      passages: [],
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
      passages: [],
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

  it("links an http(s) citation url, opened safely", () => {
    const withUrl: BriefReport = {
      ...report,
      findings: [
        { text: "f", citations: [{ kind: "source", title: "A", url: "https://ex.com/a" }] },
      ],
    };
    renderState(root, done({ report: withUrl }));
    const a = root.querySelector<HTMLAnchorElement>("a");
    expect(a?.href).toBe("https://ex.com/a");
    expect(a?.rel).toBe("noopener noreferrer");
    expect(a?.target).toBe("_blank");
  });

  it("NEVER puts a javascript: citation url into an href, but still shows it", () => {
    // The report crosses two trust boundaries and isBriefReport only checks that
    // `url` is a string. Rendering it as text keeps the hostile citation visible
    // rather than hiding what was claimed.
    for (const hostile of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "vbscript:x",
    ]) {
      document.body.replaceChildren();
      root = document.createElement("div");
      document.body.appendChild(root);
      const withUrl: BriefReport = {
        ...report,
        findings: [{ text: "f", citations: [{ kind: "source", title: "A", url: hostile }] }],
      };
      renderState(root, done({ report: withUrl }));
      expect(root.querySelector("a")).toBeNull();
      expect(root.textContent).toContain(hostile);
    }
  });

  it("escapes source-controlled text rather than parsing it as HTML", () => {
    renderState(root, done({ report: { ...report, summary: "<img src=x onerror=alert(1)>" } }));
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

const GROUP = {
  url: "http://h/a",
  title: "A page",
  passages: [
    { url: "http://h/a", title: "A page", text: "one", at: 100 },
    { url: "http://h/a#x", title: "A page", text: "two", at: 200 },
  ],
};

function render(model: Partial<ComposerModel> = {}): HTMLElement {
  const host = document.createElement("div");
  renderComposer(host, {
    named: [],
    hiddenCount: 0,
    questions: [],
    selected: new Set<string>(),
    passages: [],
    ...model,
  });
  return host;
}

describe("composer passage rows", () => {
  it("a collected page renders one row saying how many passages it holds", () => {
    const host = render({ passages: [GROUP] });
    const row = host.querySelector(".brief__tab");
    expect(row?.textContent).toContain("2 passages");
    expect(row?.querySelector("input")?.getAttribute("value")).toBe("passages:http://h/a");
  });

  it("a collected page that is also an open tab renders ONCE, in passages mode", () => {
    const host = render({
      named: [{ id: 1, url: "http://h/a#live", title: "A page" }],
      passages: [GROUP],
    });
    const boxes = [...host.querySelectorAll("input[type=checkbox]")].map((b) =>
      b.getAttribute("value"),
    );
    expect(boxes).toEqual(["passages:http://h/a"]);
  });

  it("the same page open in two tabs is still ONE passages row", () => {
    // Two fragments of one document, or the same page opened twice: one page
    // key, one row. A row per tab would let the user pick the page twice, and
    // `declare()` would send `http://h/a#one` and `http://h/a` — two strings the
    // gateway canonicalises to one identity.
    const host = render({
      named: [
        { id: 1, url: "http://h/a#one", title: "A page" },
        { id: 2, url: "http://h/a#two", title: "A page" },
      ],
      passages: [GROUP],
    });
    expect(host.querySelectorAll(".brief__tab")).toHaveLength(1);
    expect(
      [...host.querySelectorAll("input[type=checkbox]")].map((b) => b.getAttribute("value")),
    ).toEqual(["passages:http://h/a"]);
  });

  it("the same page open in two tabs with NO passages is one tab row", () => {
    // The shipped composer emits a row per tab and so shows this page twice.
    // This slice makes one-row-per-page an invariant; the two cases must agree.
    const host = render({
      named: [
        { id: 1, url: "http://h/dup", title: "Dup" },
        { id: 2, url: "http://h/dup", title: "Dup" },
      ],
    });
    expect(
      [...host.querySelectorAll("input[type=checkbox]")].map((b) => b.getAttribute("value")),
    ).toEqual(["tab:1"]);
  });

  it("that row offers the whole-page control", () => {
    const host = render({
      named: [{ id: 1, url: "http://h/a", title: "A page" }],
      passages: [GROUP],
    });
    expect(host.querySelector("button.brief__mode")?.getAttribute("data-url")).toBe("http://h/a");
  });

  it("a group whose tab is closed renders without the whole-page control", () => {
    // Whole-page mode means "capture this tab at start"; a closed tab has
    // nothing to capture, so offering it would be a dead control.
    const host = render({ passages: [GROUP] });
    expect(host.querySelector("button.brief__mode")).toBeNull();
    expect(host.querySelector("input")?.getAttribute("value")).toBe("passages:http://h/a");
  });

  it("whole-page mode for a row renders the tab checkbox instead", () => {
    const host = render({
      named: [{ id: 1, url: "http://h/a", title: "A page" }],
      passages: [GROUP],
      wholePage: new Set(["http://h/a"]),
    });
    expect(host.querySelector("input")?.getAttribute("value")).toBe("tab:1");
  });

  it("a whole-page group whose tab has closed renders nowhere", () => {
    // Neither branch: no tab to capture, and the user asked not to use its
    // passages. It comes back the moment they toggle the mode off.
    const host = render({ passages: [GROUP], wholePage: new Set(["http://h/a"]) });
    expect(host.querySelectorAll(".brief__tab")).toHaveLength(0);
  });

  it("each passage is listed with its own remove control", () => {
    const host = render({ passages: [GROUP] });
    const drops = [...host.querySelectorAll("button.brief__drop")].map((b) => [
      b.getAttribute("data-url"),
      b.getAttribute("data-at"),
    ]);
    expect(drops).toEqual([
      ["http://h/a", "100"],
      ["http://h/a", "200"],
    ]);
  });

  it("the row and the collection each have their own remove", () => {
    const host = render({ passages: [GROUP] });
    expect(host.querySelector("button.brief__drop-row")?.getAttribute("data-url")).toBe(
      "http://h/a",
    );
    expect(host.querySelector("#clear-passages")).not.toBeNull();
  });

  it("no collection renders no clear-all", () => {
    expect(render().querySelector("#clear-passages")).toBeNull();
  });

  it("the cap counter counts both kinds", () => {
    const host = render({
      named: [{ id: 1, url: "http://h/t", title: "T" }],
      passages: [GROUP],
      selected: new Set(["tab:1", "passages:http://h/a"]),
    });
    expect(host.textContent).toContain("2 of 20");
  });

  it("passage text is set with textContent, never parsed as markup", () => {
    const host = render({
      passages: [
        {
          ...GROUP,
          passages: [{ url: "http://h/a", title: "A", text: "<img src=x onerror=1>", at: 1 }],
        },
      ],
    });
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<img src=x onerror=1>");
  });
});
