// @vitest-environment jsdom
// test/unit/panel-view.test.ts
import { describe, expect, it, test, vi } from "vitest";
import {
  type HeaderState,
  type Lane,
  renderError,
  renderFetchPreview,
  renderHeader,
  renderHit,
  renderHits,
  renderLane,
  renderLaneBody,
  renderShell,
} from "../../src/panel/panel-view.ts";
import type { FetchTarget, RelatedHit, ResolvedItem } from "../../src/shared/types.ts";
import { AGENT_ERRORS } from "../../src/shared/types.ts";

const base: RelatedHit = {
  id: "1",
  title: "Doc",
  service: "drive",
  snippet: "a snippet",
  url: "https://ex.com/d",
};

const HIT_NOW = 1_700_000_000_000;

describe("renderHit", () => {
  test("a url hit renders an anchor with safe target/rel and the title as text", () => {
    const el = renderHit(document, base, HIT_NOW);
    const a = el.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("https://ex.com/d");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a?.textContent).toBe("Doc");
  });
  test("a url:null hit renders the title as plain text (no anchor)", () => {
    const el = renderHit(document, { ...base, url: null }, HIT_NOW);
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Doc");
  });
  test("XSS backstop — markup in title/snippet is inert text, not parsed nodes", () => {
    const el = renderHit(
      document,
      {
        ...base,
        url: null,
        title: "<img src=x onerror=alert(1)>",
        snippet: "<script>alert(2)</script>",
      },
      HIT_NOW,
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(el.textContent).toContain("<script>alert(2)</script>");
  });
  test("javascript: URL — no anchor rendered, title appears as plain text", () => {
    const el = renderHit(document, { ...base, url: "javascript:alert(1)" }, HIT_NOW);
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Doc");
  });
  test("data: URL — no anchor rendered, title appears as plain text", () => {
    const el = renderHit(
      document,
      {
        ...base,
        url: "data:text/html,<script>alert(1)</script>",
      },
      HIT_NOW,
    );
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Doc");
  });
});

describe("renderHits", () => {
  test("empty list → the empty-state message", () => {
    expect(renderHits(document, [], HIT_NOW).textContent).toBe("No related items found.");
  });
  test("renders one node per hit", () => {
    const list = renderHits(document, [base, { ...base, id: "2" }], HIT_NOW);
    expect(list.querySelectorAll(".nimbus-related__item")).toHaveLength(2);
  });
});

describe("renderHits — the richer row", () => {
  const NOW = 1_700_000_000_000;
  function hit(over: Partial<RelatedHit> = {}): RelatedHit {
    return { id: "gh:1", title: "T", service: "github", snippet: "body words", url: null, ...over };
  }

  test("a hit with a type renders a chip with the humanised label", () => {
    const el = renderHits(document, [hit({ type: "pr" })], NOW);
    expect(el.querySelector(".nimbus-related__kind")?.textContent).toBe("Pull request");
  });

  test("a hit without a type renders no chip at all", () => {
    const el = renderHits(document, [hit()], NOW);
    expect(el.querySelector(".nimbus-related__kind")).toBeNull();
  });

  test("modifiedAt renders as 'Updated …', the header's wording", () => {
    const el = renderHits(document, [hit({ modifiedAt: NOW - 3 * 24 * 60 * 60 * 1000 })], NOW);
    expect(el.querySelector(".nimbus-related__age")?.textContent).toBe("Updated 3 days ago");
  });

  test("no modifiedAt renders no age line", () => {
    const el = renderHits(document, [hit()], NOW);
    expect(el.querySelector(".nimbus-related__age")).toBeNull();
  });

  test("an empty snippet omits the paragraph rather than rendering it blank", () => {
    const el = renderHits(document, [hit({ snippet: "" })], NOW);
    expect(el.querySelector(".nimbus-related__snippet")).toBeNull();
  });

  test("a group heading names the service and counts its hits", () => {
    const el = renderHits(document, [hit({ id: "a" }), hit({ id: "b" })], NOW);
    const heads = [...el.querySelectorAll(".nimbus-related__group-head")].map((h) => h.textContent);
    expect(heads).toEqual(["github · 2"]);
  });

  test("two services produce two headings in rank order", () => {
    const el = renderHits(
      document,
      [hit({ id: "j", service: "jira" }), hit({ id: "g", service: "github" })],
      NOW,
    );
    const heads = [...el.querySelectorAll(".nimbus-related__group-head")].map((h) => h.textContent);
    expect(heads).toEqual(["jira · 1", "github · 1"]);
  });

  test("gateway strings are never treated as markup", () => {
    const el = renderHits(document, [hit({ title: "<img src=x onerror=alert(1)>" })], NOW);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("no hits still renders the empty state", () => {
    const el = renderHits(document, [], NOW);
    expect(el.textContent).toBe("No related items found.");
  });
});

describe("renderError", () => {
  test("renders the message as text", () => {
    expect(renderError(document, "Boom").textContent).toBe("Boom");
  });
});

const item: ResolvedItem = {
  id: "i1",
  service: "bitbucket",
  type: "pr",
  title: "Cache the index between runs",
  url: "https://bitbucket.org/acme/web/pull-requests/482",
  modifiedAt: 1_700_000_000_000,
};

describe("renderHeader", () => {
  test("loading — the state before the one resolve round trip returns", () => {
    const el = renderHeader(document, { kind: "loading" });
    expect(el.textContent).toContain("Checking Nimbus");
  });
  test("unrecognised — says so and points at Options", () => {
    const el = renderHeader(document, { kind: "unrecognised" });
    expect(el.textContent).toContain("Not a recognised Nimbus surface");
    expect(el.textContent).toContain("Options");
  });
  test("resolved — names the indexed item and links it", () => {
    const el = renderHeader(document, {
      kind: "resolved",
      surface: "Bitbucket PR · acme/web #482",
      item,
      matchKind: "exact",
      nowMs: item.modifiedAt,
    });
    expect(el.textContent).toContain("Cache the index between runs");
    expect(el.querySelector("a")?.getAttribute("href")).toBe(item.url);
    expect(el.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  });
  test("resolved with a javascript: url renders no anchor", () => {
    const el = renderHeader(document, {
      kind: "resolved",
      surface: "s",
      item: { ...item, url: "javascript:alert(1)" },
      matchKind: "exact",
      nowMs: item.modifiedAt,
    });
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Cache the index between runs");
  });
  test("not-indexed — honest miss, no loose hits implied", () => {
    const el = renderHeader(document, {
      kind: "not-indexed",
      surface: "Jira issue · PLAT-9",
      product: "jira",
      fetchable: false,
    });
    expect(el.textContent).toContain("Not indexed");
  });
  test("error — shows the message and keeps the surface line", () => {
    const el = renderHeader(document, {
      kind: "error",
      surface: "GitHub PR · acme/web #1",
      message: "This Nimbus gateway can't resolve pages yet.",
    });
    expect(el.textContent).toContain("GitHub PR · acme/web #1");
    expect(el.textContent).toContain("can't resolve pages yet");
  });
  test("error with no surface still renders the message", () => {
    const el = renderHeader(document, { kind: "error", surface: null, message: "Boom" });
    expect(el.textContent).toContain("Boom");
  });
  test("XSS backstop — an item title is inert text", () => {
    const el = renderHeader(document, {
      kind: "resolved",
      surface: "s",
      item: { ...item, url: null, title: "<img src=x onerror=alert(1)>" },
      matchKind: "exact",
      nowMs: item.modifiedAt,
    });
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("renderLane", () => {
  const lane: Lane = {
    id: "related",
    title: "Related",
    expanded: true,
    render: (doc) => {
      const p = doc.createElement("p");
      p.textContent = "lane body";
      return p;
    },
  };

  test("renders a native collapsible with the title in the summary", () => {
    const el = renderLane(document, lane);
    expect(el.tagName).toBe("DETAILS");
    expect(el.querySelector("summary")?.textContent).toBe("Related");
    expect(el.textContent).toContain("lane body");
  });
  test("expanded:true renders open", () => {
    expect((renderLane(document, lane) as HTMLDetailsElement).open).toBe(true);
  });
  test("expanded:false renders collapsed", () => {
    const el = renderLane(document, { ...lane, expanded: false });
    expect((el as HTMLDetailsElement).open).toBe(false);
  });
});

describe("renderShell", () => {
  const header: HeaderState = { kind: "unrecognised" };
  const lane = (id: string): Lane => ({
    id,
    title: id,
    expanded: true,
    render: (doc) => doc.createElement("p"),
  });

  test("renders the header and one node per lane, in order", () => {
    const el = renderShell(document, { header, lanes: [lane("a"), lane("b")] });
    const lanes = el.querySelectorAll("details");
    expect(lanes).toHaveLength(2);
    expect(lanes[0]?.querySelector("summary")?.textContent).toBe("a");
    expect(el.querySelector(".nimbus-related__header-state")).not.toBeNull();
  });
  test("a shell with no lanes still renders its header", () => {
    const el = renderShell(document, { header, lanes: [] });
    expect(el.textContent).toContain("Not a recognised Nimbus surface");
  });
});

const ITEM = {
  id: "i1",
  service: "github",
  type: "pr",
  title: "Fix the flake",
  url: "https://github.com/a/b/pull/1",
  modifiedAt: 1_700_000_000_000,
};
const NOW = ITEM.modifiedAt + 3 * 60_000;

describe("renderHeader — freshness and match confidence", () => {
  it("shows the surface, a linked title and the indexed age on an exact match", () => {
    const el = renderHeader(document, {
      kind: "resolved",
      surface: "GitHub PR · a/b #1",
      item: ITEM,
      matchKind: "exact",
      nowMs: NOW,
    });
    expect(el.textContent).toContain("GitHub PR · a/b #1");
    expect(el.textContent).toContain("Fix the flake");
    expect(el.textContent).toContain("Updated 3 min ago");
    // The value is the ITEM's last-modified time from the gateway, not when the row
    // was written — so the label must not say "Indexed".
    expect(el.textContent).not.toContain("Indexed");
    // An exact match makes no hedge.
    expect(el.textContent).not.toContain("Closest match");
    const link = el.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/a/b/pull/1");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("does not hedge a query_stripped match — the query is not identity here", () => {
    const el = renderHeader(document, {
      kind: "resolved",
      surface: "S",
      item: ITEM,
      matchKind: "query_stripped",
      nowMs: NOW,
    });
    expect(el.textContent).not.toContain("Closest match");
  });

  it("marks a path_trimmed match as the weaker claim it is", () => {
    const el = renderHeader(document, {
      kind: "resolved",
      surface: "S",
      item: ITEM,
      matchKind: "path_trimmed",
      nowMs: NOW,
    });
    expect(el.textContent).toContain("Closest match");
  });

  it("renders a title-only line when the item has no url", () => {
    const el = renderHeader(document, {
      kind: "resolved",
      surface: "S",
      item: { ...ITEM, url: null },
      matchKind: "exact",
      nowMs: NOW,
    });
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Fix the flake");
  });

  it("renders gateway strings as text, never as markup", () => {
    const el = renderHeader(document, {
      kind: "resolved",
      surface: "S",
      item: { ...ITEM, title: "<img src=x onerror=alert(1)>" },
      matchKind: "exact",
      nowMs: NOW,
    });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("renderHeader — needs-scope", () => {
  it("names the command that grants the scope instead of blaming the gateway", () => {
    const el = renderHeader(document, {
      kind: "needs-scope",
      surface: "GitHub PR · a/b #1",
      scopeGap: { label: "chrome", required: "resolve", granted: ["clip", "briefs"] },
    });
    expect(el.textContent).toContain("GitHub PR · a/b #1");
    expect(el.textContent).toContain("nimbus clip scopes chrome --set clip,briefs,resolve");
    // It is a grant the owner has not made — not an error, and not a re-pair.
    expect(el.textContent).not.toContain("error");
    expect(el.textContent?.toLowerCase()).not.toContain("re-pair");
  });

  it("renders the real label and the full resulting scope set", () => {
    const el = renderHeader(document, {
      kind: "needs-scope",
      surface: "GitHub PR · a/b #1",
      scopeGap: { label: "chrome", required: "resolve", granted: ["clip", "briefs"] },
    });
    expect(el.textContent).toContain("nimbus clip scopes chrome --set clip,briefs,resolve");
    // The literal placeholder does not paste, and an ellipsis is not valid CLI syntax.
    expect(el.textContent).not.toContain("<label>");
    expect(el.textContent).not.toContain("...");
  });

  it("falls back to generic guidance when the 403 carried no scope detail", () => {
    const el = renderHeader(document, {
      kind: "needs-scope",
      surface: "S",
      scopeGap: null,
    });
    expect(el.textContent).toContain("nimbus clip scopes");
    expect(el.textContent).not.toContain("--set");
  });

  // SECURITY end-to-end: full 403 detail is present, but the label is unsafe to
  // paste into a shell. The render layer must fall back to the SAME generic
  // guidance as a null scopeGap — echoing neither the label nor a `--set` list.
  it("falls back to generic guidance, and leaks neither label nor --set, when the label is unsafe", () => {
    const el = renderHeader(document, {
      kind: "needs-scope",
      surface: "S",
      scopeGap: { label: "chrome; rm -rf ~", required: "resolve", granted: ["clip", "briefs"] },
    });
    expect(el.textContent).toContain(
      "Grant it on the gateway: run nimbus clip status to find this device, then nimbus clip scopes.",
    );
    expect(el.textContent).not.toContain("chrome; rm -rf ~");
    expect(el.textContent).not.toContain("--set");
  });
});

describe("renderHeader — ambiguous", () => {
  const candidates = [
    { id: "a", service: "jira", type: "issue", title: "One", url: "https://j.test/a" },
    { id: "b", service: "jira", type: "issue", title: "Two", url: null },
  ];

  it("offers one button per candidate and reports the choice", () => {
    const chosen: string[] = [];
    const el = renderHeader(
      document,
      { kind: "ambiguous", surface: "Jira issue · ABC-1", candidates, truncated: false },
      (c) => chosen.push(c.id),
    );
    const buttons = el.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toContain("One");
    (buttons[1] as HTMLButtonElement).click();
    expect(chosen).toEqual(["b"]);
  });

  it("shows NO chooser when truncated — upstream sends no list, so there is nothing honest to offer", () => {
    const el = renderHeader(document, {
      kind: "ambiguous",
      surface: "Jira issue · ABC-1",
      candidates: [],
      truncated: true,
    });
    expect(el.querySelectorAll("button")).toHaveLength(0);
    expect(el.textContent).toContain("Too many matches");
  });
});

describe("renderHeader — chosen", () => {
  it("shows the chosen candidate without claiming a freshness it does not have", () => {
    const el = renderHeader(document, {
      kind: "chosen",
      surface: "Jira issue · ABC-1",
      candidate: { id: "a", service: "jira", type: "issue", title: "One", url: "https://j.test/a" },
    });
    expect(el.textContent).toContain("One");
    expect(el.textContent).not.toContain("Updated");
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("renderHeader — fetch affordance", () => {
  it("offers the button only when the miss is fetchable, naming the product", () => {
    const yes = renderHeader(document, {
      kind: "not-indexed",
      surface: "GitHub PR · a/b #1",
      product: "github",
      fetchable: true,
    });
    const btn = yes.querySelector("button");
    expect(btn?.textContent).toBe("Fetch this from GitHub");

    const no = renderHeader(document, {
      kind: "not-indexed",
      surface: "GitHub PR · a/b #1",
      product: "github",
      fetchable: false,
    });
    // No fetch button — nothing left to fetch — but this is exactly the miss
    // `offersCapture` covers, so the capture offer takes its place.
    expect(no.querySelector(".nimbus-related__fetch")).toBeNull();
    expect(no.querySelector(".nimbus-related__capture")).not.toBeNull();
    expect(no.textContent).toContain("Not indexed.");
  });

  it("reports the click", () => {
    const seen: string[] = [];
    const el = renderHeader(
      document,
      { kind: "not-indexed", surface: "S", product: "jira", fetchable: true },
      undefined,
      (a) => seen.push(a),
    );
    (el.querySelector("button") as HTMLButtonElement).click();
    expect(seen).toEqual(["fetch"]);
  });

  it("shows progress with no button while fetching", () => {
    const el = renderHeader(document, { kind: "fetching", surface: "S", product: "github" });
    expect(el.textContent).toContain("Fetching from GitHub");
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("renderHeader — fetch outcomes", () => {
  it("names the connector on not-configured, from the recognised product", () => {
    const el = renderHeader(document, {
      kind: "fetch-blocked",
      surface: "S",
      product: "github",
      reason: "not-configured",
      scopeGap: null,
    });
    expect(el.textContent).toContain("No GitHub connector is configured");
    // Terminal: retrying will never work, which is why this arm is not
    // collapsed — the one button here is the capture offer, not a retry.
    const buttons = el.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.className).toContain("nimbus-related__capture");
  });

  it("says plainly that it cannot fetch, with no action", () => {
    const el = renderHeader(document, {
      kind: "fetch-blocked",
      surface: "S",
      product: "github",
      reason: "unfetchable",
      scopeGap: null,
    });
    expect(el.textContent).toContain("can't fetch this page");
    // No retry — the one button here is the capture offer.
    const buttons = el.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.className).toContain("nimbus-related__capture");
  });

  it("names the fetch scope — not resolve — and builds the command", () => {
    const el = renderHeader(document, {
      kind: "fetch-blocked",
      surface: "S",
      product: "github",
      reason: "needs-fetch-scope",
      scopeGap: { label: "chrome", required: "fetch", granted: ["clip", "briefs", "resolve"] },
    });
    expect(el.textContent).toContain("nimbus clip scopes chrome --set clip,briefs,resolve,fetch");
    expect(el.textContent).not.toContain("<label>");
  });

  // SECURITY end-to-end, mirroring the `needs-scope` case: full 403 detail is
  // present, but the label is unsafe to paste into a shell. Falls back to the
  // same generic guidance, leaking neither the label nor a `--set` list.
  it("falls back to generic guidance, and leaks neither label nor --set, when the label is unsafe", () => {
    const el = renderHeader(document, {
      kind: "fetch-blocked",
      surface: "S",
      product: "github",
      reason: "needs-fetch-scope",
      scopeGap: {
        label: "chrome; rm -rf ~",
        required: "fetch",
        granted: ["clip", "briefs", "resolve"],
      },
    });
    expect(el.textContent).toContain(
      "Grant it on the gateway: run nimbus clip status to find this device, then nimbus clip scopes.",
    );
    expect(el.textContent).not.toContain("chrome; rm -rf ~");
    expect(el.textContent).not.toContain("--set");
  });

  it("offers a fetch retry on a rate limit", () => {
    const seen: string[] = [];
    const el = renderHeader(
      document,
      { kind: "fetch-retry", surface: "S", reason: "rate-limited" },
      undefined,
      (a) => seen.push(a),
    );
    expect(el.textContent).toContain("Rate limited");
    (el.querySelector("button") as HTMLButtonElement).click();
    expect(seen).toEqual(["fetch"]);
  });

  it("on a timeout, never claims failure and retries the RESOLVE, not the fetch", () => {
    const seen: string[] = [];
    const el = renderHeader(
      document,
      { kind: "fetch-retry", surface: "S", reason: "still-working" },
      undefined,
      (a) => seen.push(a),
    );
    expect(el.textContent).toContain("Still working");
    expect(el.textContent?.toLowerCase()).not.toContain("failed");
    expect(el.textContent?.toLowerCase()).not.toContain("couldn't fetch");
    (el.querySelector("button") as HTMLButtonElement).click();
    // The whole point: a recovery click must not fire a second outbound request.
    expect(seen).toEqual(["resolve"]);
  });
});

describe("renderLaneBody", () => {
  it("renders a brief as TEXT, never as markup", () => {
    const el = renderLaneBody(
      document,
      {
        kind: "done",
        brief: "## Impact\n\n<img src=x onerror=alert(1)>\n\n- a\n- b",
      },
      NOW,
    );
    // The brief is gateway-generated and, on a configured gateway, LLM-generated.
    // Parsing it would be an XSS path from model output into a Shadow DOM over the
    // user's authenticated session.
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("h2")).toBeNull();
    expect(el.querySelector("li")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(el.textContent).toContain("## Impact");
  });

  it("shows progress while running, with no result text", () => {
    const el = renderLaneBody(document, { kind: "running", runId: "r1" }, NOW);
    expect(el.textContent).toContain("Working");
  });

  it("offers Re-run on a stale run, and states why", () => {
    const seen: string[] = [];
    const el = renderLaneBody(document, { kind: "failed", reason: "stale" }, NOW, () =>
      seen.push("rerun"),
    );
    expect(el.textContent?.toLowerCase()).toContain("gone");
    (el.querySelector("button") as HTMLButtonElement).click();
    expect(seen).toEqual(["rerun"]);
  });

  // Re-run is offered for failures a retry could actually fix, and withheld for
  // ones it cannot. Offering it everywhere would invite a click that fails
  // identically; withholding it everywhere but `stale` would strand a lane on a
  // transient blip until the panel is reopened — the same dead-control shape the
  // rate-limited retry hit in the fetch slice.
  it("offers Re-run for transient failures", () => {
    // `agent_failed` belongs here: the run reached the agent and the agent could not
    // answer, which a retry may well fix. It is NOT `server_error` — the call worked.
    for (const reason of ["stale", "unreachable", "server_error", "agent_failed"] as const) {
      const el = renderLaneBody(document, { kind: "failed", reason }, NOW, () => undefined);
      expect(el.querySelector("button")).not.toBeNull();
    }
  });

  // `not_paired` is PRODUCED by the user being unpaired right now:
  // `resolveForAgent` (handlers.ts) short-circuits on its own missing connection
  // before it reads any cached run, so this state means there is no pairing — not
  // that an older one went stale. The copy must therefore say so and name pairing
  // as the remedy; the earlier "this result is from before your current pairing"
  // told an unpaired user a result existed and that it was merely out of date.
  // The button stays because the retry belongs here once pairing is done (Task 6
  // narrowed the cache short-circuit to running/done, so a Re-run re-invokes).
  it("tells an unpaired user to pair, and still offers the re-run", () => {
    const seen: string[] = [];
    const el = renderLaneBody(document, { kind: "failed", reason: "not_paired" }, NOW, () =>
      seen.push("rerun"),
    );
    const text = el.textContent?.toLowerCase() ?? "";
    expect(text).toContain("pair");
    expect(text).toContain("options");
    // Must not claim a result exists, nor that it is merely stale.
    expect(text).not.toContain("out of date");
    expect(text).not.toContain("before your current pairing");
    (el.querySelector("button") as HTMLButtonElement).click();
    expect(seen).toEqual(["rerun"]);
  });

  it("shows the gateway's own explanation as text, never parsed", () => {
    const el = renderLaneBody(
      document,
      {
        kind: "failed",
        reason: "agent_failed",
        detail: "<img src=x onerror=alert(1)> no LLM configured",
      },
      NOW,
      () => undefined,
    );
    // The tag-stripped substring alone would also pass a lossy sanitiser — assert
    // the raw markup survives verbatim in textContent, same discriminator as the
    // brief's own XSS test above.
    expect(el.textContent).toContain("<img src=x onerror=alert(1)> no LLM configured");
    expect(el.textContent).toContain("no LLM configured");
    expect(el.querySelector("img")).toBeNull();
  });

  it("still states something when the gateway gave no explanation", () => {
    const el = renderLaneBody(
      document,
      { kind: "failed", reason: "agent_failed" },
      NOW,
      () => undefined,
    );
    expect(el.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("withholds Re-run where retrying cannot help, and says what would", () => {
    // Each of these needs a different action on ANOTHER surface first — re-pair,
    // grant a scope, index the page, or a gateway that has the surface at all. A
    // Re-run button would just fail again. `not_paired` is NOT here: see the
    // dedicated test above for why it is the one exception.
    for (const reason of [
      "unauthorized",
      "insufficient_scope",
      "unsupported",
      "not_resolved",
      "no_term",
    ] as const) {
      const el = renderLaneBody(document, { kind: "failed", reason }, NOW, () => undefined);
      expect(el.querySelector("button")).toBeNull();
      expect(el.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("names the agents scope on a scope failure, not resolve or fetch", () => {
    const el = renderLaneBody(
      document,
      {
        kind: "failed",
        reason: "insufficient_scope",
        scopeGap: { label: "chrome", required: "agents", granted: ["clip", "resolve"] },
      },
      NOW,
    );
    expect(el.textContent).toContain("nimbus clip scopes chrome --set clip,resolve,agents");
  });

  // C2.1's done-when: never a silent empty lane.
  it("renders a stated reason for every failure, never nothing", () => {
    for (const reason of [
      "not_paired",
      "unauthorized",
      "unsupported",
      "not_resolved",
      "no_term",
      "agent_failed",
      "unreachable",
      "server_error",
    ] as const) {
      const el = renderLaneBody(document, { kind: "failed", reason }, NOW);
      expect(el.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  // These four reasons exist BECAUSE collapsing them told users falsehoods. The
  // generic "every failure states something" loop cannot catch a regression here:
  // a false-but-non-empty string passes it. Assert the PROPERTY, not the exact
  // wording, so a future rewrite stays free while the false claim stays caught.
  it("never claims the page is unindexed for not_resolved — it also covers the ambiguous case", () => {
    const el = renderLaneBody(
      document,
      { kind: "failed", reason: "not_resolved" },
      NOW,
      () => undefined,
    );
    const text = el.textContent?.toLowerCase() ?? "";
    expect(text).not.toContain("hasn't indexed");
    expect(text).not.toContain("not indexed");
  });

  // `no_term` is about the INPUT, not the page and not the gateway. Saying
  // "couldn't pin this page to one indexed item" for a missing selection would
  // send the user off to fix a page that is fine.
  it("blames neither the page nor the gateway for a missing term", () => {
    const el = renderLaneBody(
      document,
      { kind: "failed", reason: "no_term" },
      NOW,
      () => undefined,
    );
    const text = el.textContent?.toLowerCase() ?? "";
    expect(text).toContain("select");
    expect(text).not.toContain("indexed item");
    expect(text).not.toContain("gateway");
  });

  it("blames the gateway for unsupported and the page for not_resolved, never the reverse", () => {
    const gateway = renderLaneBody(
      document,
      { kind: "failed", reason: "unsupported" },
      NOW,
      () => undefined,
    );
    const page = renderLaneBody(
      document,
      { kind: "failed", reason: "not_resolved" },
      NOW,
      () => undefined,
    );
    expect(gateway.textContent?.toLowerCase()).toContain("gateway");
    expect(page.textContent?.toLowerCase()).not.toContain("gateway");
  });

  it("does not report a finished-and-failed run as an error — the call succeeded", () => {
    const el = renderLaneBody(
      document,
      { kind: "failed", reason: "agent_failed" },
      NOW,
      () => undefined,
    );
    expect(el.textContent?.toLowerCase()).not.toContain("error");
  });

  // The strongest guard, and the one that survives every rewording: no two reasons
  // may render the same sentence. Collapsing any two is how each of this branch's
  // copy bugs began.
  it("gives every AgentError its own distinct copy", () => {
    const seen = new Map<string, string>();
    for (const reason of AGENT_ERRORS) {
      const text = (
        renderLaneBody(document, { kind: "failed", reason }, NOW, () => undefined).textContent ?? ""
      ).trim();
      expect(text.length).toBeGreaterThan(0);
      const clash = seen.get(text);
      expect(clash, `"${reason}" renders the same text as "${clash}"`).toBeUndefined();
      seen.set(text, reason);
    }
  });

  test("a done state without findings renders the prose brief, as before", () => {
    const el = renderLaneBody(document, { kind: "done", brief: "prose text" }, NOW);
    expect(el.querySelector("pre.nimbus-related__brief")?.textContent).toBe("prose text");
    expect(el.querySelector(".nimbus-findings")).toBeNull();
  });

  test("gaps and provenance render even when findings are absent", () => {
    // The sibling-not-child decision, pinned: a lane that fell back to prose can
    // still say why it is empty and whether a model wrote it.
    const el = renderLaneBody(
      document,
      {
        kind: "done",
        brief: "prose",
        gaps: [{ category: "empty_index", detail: "Nothing indexed." }],
        synthesis: { attempted: true, used: true, model: "llama3", remote: false },
      },
      NOW,
    );
    expect(el.querySelector("pre.nimbus-related__brief")).not.toBeNull();
    expect(el.textContent).toContain("Nothing indexed.");
    expect(el.textContent).toContain("llama3");
  });

  test("structured findings replace the prose body", () => {
    const el = renderLaneBody(
      document,
      {
        kind: "done",
        brief: "prose",
        findings: {
          kind: "why",
          findings: [
            {
              lane: "ticket",
              title: "T",
              detail: "d",
              url: null,
              occurredAt: null,
              entityId: null,
            },
          ],
          subject: null,
          changeSubject: null,
          itemSubject: null,
        },
      },
      NOW,
    );
    expect(el.querySelector("pre.nimbus-related__brief")).toBeNull();
    expect(el.querySelector(".nimbus-findings")).not.toBeNull();
  });
});

describe("the navigated-away notice", () => {
  const LANES = [
    {
      id: "related",
      title: "Related",
      expanded: false,
      render: (d: Document) => d.createElement("div"),
    },
  ];

  it("names the pinned item so every lane below it is attributed", () => {
    const shell = renderShell(document, {
      header: { kind: "loading" },
      lanes: LANES,
      navAway: { pinnedRef: "acme/web #482", onReread: () => undefined },
    });
    const notice = shell.querySelector(".nimbus-related__navaway");
    expect(notice?.textContent).toContain("You've moved on.");
    expect(notice?.textContent).toContain("This panel is still about acme/web #482.");
  });

  it("falls back to generic copy when the pinned page had no ref", () => {
    const shell = renderShell(document, {
      header: { kind: "unrecognised" },
      lanes: LANES,
      navAway: { pinnedRef: null, onReread: () => undefined },
    });
    expect(shell.querySelector(".nimbus-related__navaway")?.textContent).toContain(
      "This panel is still about the page you opened it on.",
    );
  });

  // A screen-reader user must learn that the panel's subject no longer matches
  // the tab; nothing else in the panel announces it.
  it("announces itself as a status region", () => {
    const shell = renderShell(document, {
      header: { kind: "loading" },
      lanes: LANES,
      navAway: { pinnedRef: "acme/web #482", onReread: () => undefined },
    });
    expect(shell.querySelector(".nimbus-related__navaway")?.getAttribute("role")).toBe("status");
  });

  it("calls onReread once per click", () => {
    const onReread = vi.fn();
    const shell = renderShell(document, {
      header: { kind: "loading" },
      lanes: LANES,
      navAway: { pinnedRef: "acme/web #482", onReread },
    });
    shell.querySelector<HTMLButtonElement>(".nimbus-related__navaway button")?.click();
    expect(onReread).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when navAway is absent", () => {
    const shell = renderShell(document, { header: { kind: "loading" }, lanes: LANES });
    expect(shell.querySelector(".nimbus-related__navaway")).toBeNull();
  });

  // The notice sits between the header and the lanes so it coexists with every
  // header state instead of replacing one.
  it("sits after the header and before the lanes, and leaves the lanes enabled", () => {
    const shell = renderShell(document, {
      header: { kind: "loading" },
      lanes: LANES,
      navAway: { pinnedRef: "acme/web #482", onReread: () => undefined },
    });
    const classes = [...shell.children].map((c) => c.className);
    expect(classes[0]).toContain("nimbus-related__header-state");
    expect(classes[1]).toContain("nimbus-related__navaway");
    expect(shell.querySelectorAll("[disabled]")).toHaveLength(0);
  });
});

describe("the capture refusal line", () => {
  const LANES = [
    {
      id: "related",
      title: "Related",
      expanded: false,
      render: (d: Document) => d.createElement("div"),
    },
  ];

  // Finding 1: a refusal must sit BENEATH the header, never replace it — the
  // header (and its still-live capture offer) is the retry.
  it("renders beneath the header, leaving the header's own content in place", () => {
    const shell = renderShell(document, {
      header: { kind: "unrecognised" },
      lanes: LANES,
      captureRefusal: "Couldn't read this page.",
    });
    const classes = [...shell.children].map((c) => c.className);
    expect(classes[0]).toContain("nimbus-related__header-state");
    expect(classes[1]).toContain("nimbus-related__capture-refusal");
    expect(shell.querySelector(".nimbus-related__capture-refusal")?.textContent).toContain(
      "Couldn't read this page.",
    );
    // The offer (rendered by renderHeader's own unrecognised arm) is still there.
    expect(shell.querySelector(".nimbus-related__capture")).not.toBeNull();
  });

  it("renders nothing when captureRefusal is absent", () => {
    const shell = renderShell(document, { header: { kind: "unrecognised" }, lanes: LANES });
    expect(shell.querySelector(".nimbus-related__capture-refusal")).toBeNull();
  });
});

describe("the fetch preview", () => {
  const target: FetchTarget = {
    product: "github",
    surface: "pr",
    url: "https://github.com/acme/web/pull/1",
  };

  it("names the target — Service/Type/Address, not a bare question", () => {
    const el = renderFetchPreview(
      document,
      target,
      () => undefined,
      () => undefined,
    );
    expect(el.textContent).toContain("Service");
    expect(el.textContent).toContain("github");
    expect(el.textContent).toContain("Type");
    expect(el.textContent).toContain("pr");
    expect(el.textContent).toContain("Address");
    expect(el.textContent).toContain(target.url);
    expect(el.textContent?.toLowerCase()).not.toContain("fetch this item?");
  });

  it("renders in the same header-state box renderHeader itself uses", () => {
    const el = renderFetchPreview(
      document,
      target,
      () => undefined,
      () => undefined,
    );
    expect(el.classList.contains("nimbus-related__header-state")).toBe(true);
  });

  it("offers Send and Cancel, each with its own stable class — never the shared action class alone", () => {
    const el = renderFetchPreview(
      document,
      target,
      () => undefined,
      () => undefined,
    );
    const send = el.querySelector<HTMLButtonElement>("button.nimbus-related__fetch-send");
    const cancel = el.querySelector<HTMLButtonElement>("button.nimbus-related__fetch-cancel");
    expect(send?.textContent).toBe("Send");
    expect(send?.type).toBe("button");
    expect(cancel?.textContent).toBe("Cancel");
    expect(cancel?.type).toBe("button");
  });

  it("Send and Cancel report their own click, and only their own", () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();
    const el = renderFetchPreview(document, target, onSend, onCancel);
    el.querySelector<HTMLButtonElement>("button.nimbus-related__fetch-send")?.click();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("stacks Send and Cancel full-width, not side by side, in one actions container", () => {
    const el = renderFetchPreview(
      document,
      target,
      () => undefined,
      () => undefined,
    );
    const actions = el.querySelector(".nimbus-related__fetch-actions");
    expect(actions).not.toBeNull();
    expect(actions?.children).toHaveLength(2);
    expect(actions?.children[0]?.className).toContain("nimbus-related__fetch-send");
    expect(actions?.children[1]?.className).toContain("nimbus-related__fetch-cancel");
  });

  it("renderShell shows the preview INSTEAD of the header when fetchPreview is set", () => {
    const el = renderShell(document, {
      header: {
        kind: "not-indexed",
        surface: "GitHub PR · a/b #1",
        product: "github",
        fetchable: true,
      },
      lanes: [],
      fetchPreview: { target, onSend: () => undefined, onCancel: () => undefined },
    });
    expect(el.textContent).not.toContain("Fetch this from");
    expect(el.textContent).not.toContain("Not indexed");
    expect(el.textContent).toContain("Address");
  });
});

describe("the service header", () => {
  const NOW = 1_700_000_000_000;
  const base = {
    kind: "service" as const,
    surface: "Jenkins dashboard",
    product: "jenkins" as const,
    nowMs: NOW,
  };
  // `unknown` — the state an older gateway (or an unreadable answer) reports —
  // is the regression guard: it must render byte-identical to what this header
  // rendered before Task 4 existed. Written first, and asserted last below by
  // the exact-content check, so a change to `gatePolicy`'s `unknown` row cannot
  // silently regress the one output every user on an unpaired-with-health
  // gateway is actually looking at today.
  const state = { ...base, connector: { state: "unknown" as const } };

  it("names the surface and states the scope", () => {
    const el = renderHeader(document, state);
    expect(el.textContent).toContain("Jenkins dashboard");
    expect(el.textContent).toContain("across all indexed Jenkins builds");
  });

  it("offers no fetch button, no freshness line and no item link", () => {
    const el = renderHeader(document, state);
    expect(el.querySelector("button")).toBeNull();
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).not.toContain("Updated");
    expect(el.textContent).not.toContain("Not indexed");
  });

  it("renders exactly the surface line and the scope line — no note, no age line", () => {
    // No assertion here names the instance host directly, because the `service`
    // arm carries no host field — `{surface, product}` only — so a host is
    // unrenderable by construction; there is nothing to withhold. This exact-
    // content check is what would catch a regression that reintroduced one: any
    // extra line (a host, a freshness line, a stray label) fails it, unlike a
    // substring check against a fixture that never contained a host to begin
    // with.
    const el = renderHeader(document, state);
    const lines = [...el.children].map((c) => c.textContent);
    expect(lines).toEqual([
      "Jenkins dashboard",
      "Nimbus can answer across all indexed Jenkins builds.",
    ]);
  });

  it("a healthy connector renders the same two lines as unknown, and no note", () => {
    const el = renderHeader(document, { ...base, connector: { state: "healthy" } });
    const lines = [...el.children].map((c) => c.textContent);
    expect(lines).toEqual([
      "Jenkins dashboard",
      "Nimbus can answer across all indexed Jenkins builds.",
    ]);
  });

  it("a healthy connector with a sync time renders its age line", () => {
    // The doc comment on `appendServiceHeader` used to claim `healthy` renders "no
    // age" — false: the age gate keys only on the state not being `unknown`, so a
    // healthy connector with a `lastSuccessfulSyncMs` renders it too. The other
    // healthy test above uses a connector with no sync time, so this case was
    // previously unpinned.
    const el = renderHeader(document, {
      ...base,
      connector: { state: "healthy", lastSuccessfulSyncMs: NOW - 3 * 60_000 },
    });
    expect(el.textContent).toContain("Synced 3 min ago");
  });

  it("a degraded connector keeps the scope line and adds a caveat naming the product", () => {
    const el = renderHeader(document, { ...base, connector: { state: "degraded" } });
    expect(el.textContent).toContain("Nimbus can answer across all indexed Jenkins builds.");
    expect(el.textContent).toContain("Jenkins");
    expect(el.textContent).toMatch(/degraded/i);
    expect(el.textContent).not.toContain("Synced");
  });

  it("a degraded connector with a sync time adds the age line too", () => {
    const el = renderHeader(document, {
      ...base,
      connector: { state: "degraded", lastSuccessfulSyncMs: NOW - 3 * 60_000 },
    });
    expect(el.textContent).toContain("Synced 3 min ago");
  });

  it("a rate-limited connector keeps the lanes and names the specific caveat", () => {
    const el = renderHeader(document, { ...base, connector: { state: "rate_limited" } });
    expect(el.textContent).toContain("Nimbus can answer across all indexed Jenkins builds.");
    expect(el.textContent).toContain(
      "Jenkins is rate-limiting Nimbus, so recent items may be missing.",
    );
  });

  it("a paused connector keeps the lanes and names the specific caveat", () => {
    const el = renderHeader(document, { ...base, connector: { state: "paused" } });
    expect(el.textContent).toContain("Nimbus can answer across all indexed Jenkins builds.");
    expect(el.textContent).toContain("Syncing Jenkins is paused, so recent items may be missing.");
  });

  it("rate_limited and paused read differently from each other and from degraded", () => {
    // Policy-level tests only assert lanes===true and note!==null for this trio —
    // this is the coverage that would catch the three notes getting swapped.
    const degraded = renderHeader(document, {
      ...base,
      connector: { state: "degraded" },
    }).textContent;
    const rateLimited = renderHeader(document, {
      ...base,
      connector: { state: "rate_limited" },
    }).textContent;
    const paused = renderHeader(document, { ...base, connector: { state: "paused" } }).textContent;
    expect(new Set([degraded, rateLimited, paused]).size).toBe(3);
  });

  it("an unknown connector renders no age line even when the gateway supplied a sync time", () => {
    // `unknown` covers both an older gateway and an unrecognised eighth state —
    // `parseConnectorHealth` keeps a real `lastSuccessfulSync` even while
    // coercing the state to `unknown`, and the byte-identical-to-today guarantee
    // must not depend on which fields that far end happened to send.
    const el = renderHeader(document, {
      ...base,
      connector: { state: "unknown", lastSuccessfulSyncMs: NOW - 3 * 60_000 },
    });
    const lines = [...el.children].map((c) => c.textContent);
    expect(lines).toEqual([
      "Jenkins dashboard",
      "Nimbus can answer across all indexed Jenkins builds.",
    ]);
    expect(el.textContent).not.toContain("Synced");
  });

  it("an unconfigured connector withholds the scope line and renders only the note", () => {
    const el = renderHeader(document, { ...base, connector: { state: "not_configured" } });
    const lines = [...el.children].map((c) => c.textContent);
    expect(lines).toHaveLength(2); // surface line + the one note
    expect(el.textContent).not.toContain("Nimbus can answer");
    expect(el.textContent).toMatch(/never synced/i);
  });

  it("a withheld state renders no age line even when the gateway supplied a sync time", () => {
    const el = renderHeader(document, {
      ...base,
      connector: { state: "unauthenticated", lastSuccessfulSyncMs: NOW - 3 * 60_000 },
    });
    expect(el.textContent).not.toContain("Synced");
    expect(el.textContent).not.toContain("min ago");
  });

  it("not_configured and unauthenticated read differently", () => {
    const a = renderHeader(document, {
      ...base,
      connector: { state: "not_configured" },
    }).textContent;
    const b = renderHeader(document, {
      ...base,
      connector: { state: "unauthenticated" },
    }).textContent;
    expect(a).not.toBe(b);
  });
});

describe("the file header", () => {
  it("names the surface and no more, on a hit", () => {
    const el = renderHeader(document, { kind: "file", surface: "GitHub file" });
    const lines = [...el.children].map((c) => c.textContent);
    expect(lines).toEqual(["GitHub file"]);
  });

  it.each([
    [
      "remote_not_tracked",
      "Nimbus has no local checkout of `acme/web`, so it cannot answer about its files.",
    ],
    ["file_not_indexed", "Nimbus has a checkout of `acme/web`, but this file is not in its index."],
  ])("renders its own sentence for %s", (_reason, sentence) => {
    const el = renderHeader(document, { kind: "file", surface: "GitHub file", banner: sentence });
    expect(el.textContent).toContain(sentence);
  });
});

describe("the captured-copy header", () => {
  const NOW = 1_700_000_000_000;
  const item = {
    id: "nimbus:clip:1",
    service: "nimbus",
    type: "web_clip",
    title: "Runbook",
    url: "https://wiki.example.com/runbook",
    modifiedAt: NOW - 3 * 24 * 60 * 60 * 1000,
  };

  test("names the item and says it is a copy you saved", () => {
    const el = renderHeader(document, { kind: "captured", item, ageNowMs: NOW });
    expect(el.textContent).toContain("Runbook");
    expect(el.textContent).toContain("Updated 3 days ago");
    expect(el.textContent?.toLowerCase()).toContain("copy");
  });

  test("renders NO surface line — an unrecognised page has no surface", () => {
    const el = renderHeader(document, { kind: "captured", item, ageNowMs: NOW });
    expect(el.querySelector(".nimbus-related__surface")).toBeNull();
  });

  test("offers Update this copy", () => {
    let called = false;
    const el = renderHeader(
      document,
      { kind: "captured", item, ageNowMs: NOW },
      undefined,
      undefined,
      undefined,
      () => {
        called = true;
      },
    );
    const btn = el.querySelector(".nimbus-related__recapture") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn?.click();
    expect(called).toBe(true);
  });

  test("a captured title is never treated as markup", () => {
    const el = renderHeader(document, {
      kind: "captured",
      item: { ...item, title: "<img src=x onerror=alert(1)>" },
      ageNowMs: NOW,
    });
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("the capture offer", () => {
  test("an unrecognised page offers capture and keeps the Options hint", () => {
    let called = false;
    const el = renderHeader(document, { kind: "unrecognised" }, undefined, undefined, () => {
      called = true;
    });
    expect(el.textContent).toContain("Options");
    const btn = el.querySelector(".nimbus-related__capture") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn?.click();
    expect(called).toBe(true);
  });

  test("a fetchable miss shows the fetch button and NO capture button", () => {
    const el = renderHeader(document, {
      kind: "not-indexed",
      surface: "GitHub pull request",
      product: "github",
      fetchable: true,
    });
    expect(el.querySelector(".nimbus-related__fetch")).not.toBeNull();
    expect(el.querySelector(".nimbus-related__capture")).toBeNull();
  });
});
