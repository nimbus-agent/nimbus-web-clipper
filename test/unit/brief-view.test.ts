// @vitest-environment jsdom
// test/unit/brief-view.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import type { BriefState } from "../../src/background/brief-handlers.ts";
import {
  applyPickLimit,
  type ComposerModel,
  renderComposer,
  renderState,
} from "../../src/brief/brief-view.ts";
import { BRIEF_CAPS } from "../../src/shared/brief.ts";
import type { BriefCitation, BriefReport } from "../../src/shared/brief-report.ts";

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
      useIndex: false,
    });
    const boxes = root.querySelectorAll<HTMLInputElement>('.brief__tabs input[type="checkbox"]');
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
      useIndex: false,
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
      useIndex: false,
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
      useIndex: false,
    });
    expect(root.textContent).toContain("Couldn't read your open tabs");
    expect(root.querySelectorAll('.brief__tabs input[type="checkbox"]')).toHaveLength(0);
  });

  it("offers the scaffolded questions and a COLLAPSED custom-question control", () => {
    renderComposer(root, {
      named: [{ id: 1, url: "https://example.com/a", title: "A" }],
      hiddenCount: 0,
      questions: ["What breaks if all of these land?"],
      selected: new Set(["tab:1"]),
      passages: [],
      useIndex: false,
    });
    expect(root.textContent).toContain("What breaks if all of these land?");
    const details = root.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Ask your own question");
  });

  it("stops the tick at the cap: unticked boxes go dead, ticked ones stay live", () => {
    // Over the cap `isBriefStartRequest` refuses the whole request, so a counter
    // that reads "21 of 20 sources" buys the user a bare `invalid_request` at
    // the end of a composition. The boxes refuse one click earlier instead.
    const named = Array.from({ length: BRIEF_CAPS.maxSources + 1 }, (_, i) => ({
      id: i + 1,
      url: `https://example.com/${i}`,
      title: `T${i}`,
    }));
    renderComposer(root, {
      named,
      hiddenCount: 0,
      questions: [],
      selected: new Set(named.slice(0, BRIEF_CAPS.maxSources).map((t) => `tab:${t.id}`)),
      passages: [],
      useIndex: false,
    });
    const boxes = [
      ...root.querySelectorAll<HTMLInputElement>('.brief__tabs input[type="checkbox"]'),
    ];
    expect(boxes).toHaveLength(BRIEF_CAPS.maxSources + 1);
    expect(boxes.filter((b) => b.disabled).map((b) => b.value)).toEqual([
      `tab:${BRIEF_CAPS.maxSources + 1}`,
    ]);
  });

  it("re-enables every box the moment the pick count drops below the cap", () => {
    const named = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      url: `https://example.com/${i}`,
      title: `T${i}`,
    }));
    renderComposer(root, {
      named,
      hiddenCount: 0,
      questions: [],
      selected: new Set(["tab:1"]),
      passages: [],
      useIndex: false,
    });
    const boxes = [
      ...root.querySelectorAll<HTMLInputElement>('.brief__tabs input[type="checkbox"]'),
    ];
    applyPickLimit(root, BRIEF_CAPS.maxSources);
    expect(boxes.filter((b) => b.disabled)).toHaveLength(2);
    applyPickLimit(root, BRIEF_CAPS.maxSources - 1);
    expect(boxes.filter((b) => b.disabled)).toHaveLength(0);
  });

  it("renders a tab title as text, never as markup", () => {
    renderComposer(root, {
      named: [{ id: 1, url: "https://example.com/a", title: "<img src=x onerror=alert(1)>" }],
      hiddenCount: 0,
      questions: ["q"],
      selected: new Set(),
      passages: [],
      useIndex: false,
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

// Drives the exported renderState path for a single citation, then hands back
// the one <li> that citation rendered into — so each case below can assert on
// that li alone without re-deriving the surrounding finding markup.
function renderCitationsFor(citations: readonly BriefCitation[]): HTMLElement {
  document.body.replaceChildren();
  root = document.createElement("div");
  document.body.appendChild(root);
  const withCitations: BriefReport = {
    ...report,
    findings: [{ text: "f", citations }],
  };
  renderState(root, done({ report: withCitations }));
  const li = root.querySelector("ul.brief__citations li");
  if (li === null) {
    throw new Error("expected a citation <li> to render");
  }
  return li as HTMLElement;
}

describe("renderCitations — index-origin marker", () => {
  it("marks a citation that came from the index, and names its type", () => {
    const li = renderCitationsFor([
      { kind: "clip", title: "PR 482", itemType: "pull_request", url: "https://g.test/p/482" },
    ]);
    expect(li.textContent).toContain("from your index");
    expect(li.textContent).toContain("pull request");
  });

  it("does not mark a source the user picked themselves", () => {
    const li = renderCitationsFor([{ kind: "source", title: "A tab", url: "https://a.test" }]);
    expect(li.textContent).not.toContain("from your index");
  });

  it("marks an indexed citation with no known type, and shows no type label", () => {
    const li = renderCitationsFor([{ kind: "clip", title: "Saved" }]);
    expect(li.textContent).toContain("from your index");
  });

  it("passes an unrecognised type through without mangling it", () => {
    // The label rule is underscores-to-spaces and nothing else. An acronym must
    // survive intact: display is still a place you can misrepresent a value.
    const li = renderCitationsFor([{ kind: "clip", title: "x", itemType: "PR_review" }]);
    expect(li.textContent).toContain("PR review");
  });

  it("never renders an item id", () => {
    // A sha256 digest helps nobody: nothing in this extension accepts one as input.
    const li = renderCitationsFor([
      { kind: "clip", title: "Saved", itemId: "nimbus:clip:aa", itemType: "web_clip" },
    ]);
    expect(li.textContent).not.toContain("nimbus:clip:aa");
  });

  it("links an indexed citation's page through the same safeHttpUrl guard", () => {
    const li = renderCitationsFor([
      { kind: "clip", title: "Bad", itemType: "web_clip", url: "javascript:alert(1)" },
    ]);
    expect(li.querySelector("a")).toBeNull();
    expect(li.textContent).toContain("javascript:alert(1)");
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
    useIndex: false,
    ...model,
  });
  return host;
}

/** Alias for `render`, named the way the requirement describes it. */
function renderComposerInto(model: Partial<ComposerModel> = {}): HTMLElement {
  return render(model);
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
    const boxes = [...host.querySelectorAll(".brief__tabs input[type=checkbox]")].map((b) =>
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
      [...host.querySelectorAll(".brief__tabs input[type=checkbox]")].map((b) =>
        b.getAttribute("value"),
      ),
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
      [...host.querySelectorAll(".brief__tabs input[type=checkbox]")].map((b) =>
        b.getAttribute("value"),
      ),
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

  it("a whole-page group whose tab has closed comes back as a passages row", () => {
    // Whole-page mode is "capture this tab at start", so with no tab it is not a
    // mode at all. Rendering nothing would strand the passages: no row, and so
    // no control carrying the url that would clear the flag.
    const host = render({ passages: [GROUP], wholePage: new Set(["http://h/a"]) });
    expect(host.querySelectorAll(".brief__tab")).toHaveLength(1);
    expect(host.querySelector("input")?.getAttribute("value")).toBe("passages:http://h/a");
    expect(host.querySelector("button.brief__mode")).toBeNull();
  });

  it("a row in whole-page mode carries the way BACK", () => {
    // Without this the switch is a one-way door: the tab row is
    // indistinguishable from a tab that never had passages, and no rendered
    // control names that url any more.
    const host = render({
      named: [{ id: 1, url: "http://h/a", title: "A page" }],
      passages: [GROUP],
      wholePage: new Set(["http://h/a"]),
    });
    const mode = host.querySelector("button.brief__mode");
    expect(mode?.getAttribute("data-url")).toBe("http://h/a");
    expect(mode?.textContent).toBe("Use its passages instead");
  });

  it("a tab with nothing collected offers no mode control", () => {
    const host = render({ named: [{ id: 1, url: "http://h/t", title: "T" }] });
    expect(host.querySelector("button.brief__mode")).toBeNull();
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

describe("composer resilience", () => {
  it("a failed enumeration still offers the passages it holds", () => {
    // A passage group needs no tab — its text was captured when the user
    // highlighted it. Reporting the tab failure AND hiding the collection would
    // deny sources that are sitting in storage and are perfectly usable.
    const host = render({ enumerationFailed: true, passages: [GROUP] });
    expect(host.textContent).toContain("Couldn't read your open tabs");
    expect(host.querySelector("input")?.getAttribute("value")).toBe("passages:http://h/a");
    // No tab is named, so there is nothing to capture whole.
    expect(host.querySelector("button.brief__mode")).toBeNull();
    expect(host.querySelector("#clear-passages")).not.toBeNull();
  });

  it("a failed enumeration does not ALSO claim there are no granted tabs", () => {
    const host = render({ enumerationFailed: true, passages: [GROUP] });
    expect(host.textContent).not.toContain("No open tabs on sites");
  });

  it("a failed enumeration with nothing collected still says only that", () => {
    const host = render({ enumerationFailed: true });
    expect(host.textContent).toContain("Couldn't read your open tabs");
    expect(host.querySelectorAll('.brief__tabs input[type="checkbox"]')).toHaveLength(0);
  });

  it("redraws the question the user has typed, in an OPEN disclosure", () => {
    // The composer repaints mid-compose now (dropping a passage re-reads the
    // store), so a redraw that forgot this would wipe words still being written.
    const host = render({ customQuestion: "Where do these disagree" });
    const box = host.querySelector<HTMLTextAreaElement>("#custom-question");
    expect(box?.value).toBe("Where do these disagree");
    expect(host.querySelector("details")?.open).toBe(true);
  });

  it("leaves the disclosure collapsed when nothing has been typed", () => {
    const host = render();
    expect(host.querySelector<HTMLTextAreaElement>("#custom-question")?.value).toBe("");
    expect(host.querySelector("details")?.open).toBe(false);
  });
});

describe("composer index control", () => {
  it("offers the index control, unchecked by default", () => {
    const root = renderComposerInto({ useIndex: false });
    const box = root.querySelector<HTMLInputElement>("#use-index");
    expect(box).not.toBeNull();
    expect(box?.checked).toBe(false);
  });

  it("reflects a preference that is already on", () => {
    const root = renderComposerInto({ useIndex: true });
    expect(root.querySelector<HTMLInputElement>("#use-index")?.checked).toBe(true);
  });

  it("explains what the control does IN VISIBLE TEXT, not a tooltip", () => {
    const root = renderComposerInto({ useIndex: false });
    const label = root.querySelector(".brief__index");
    expect(label?.textContent?.toLowerCase()).toContain("indexed");
    // A tooltip is invisible to touch and to keyboard users, for exactly the
    // sentence they most need. src/ contains no title= anywhere; keep it that way.
    expect(root.querySelector("[title]")).toBeNull();
  });

  it("does not count the index against the source cap", () => {
    // The cap is about sources the client declares and FEEDS. The index is neither.
    const root = renderComposerInto({ useIndex: true, selected: new Set(["tab:1"]) });
    expect(root.querySelector(".brief__count")?.textContent).toContain("1 of 20");
  });
});
