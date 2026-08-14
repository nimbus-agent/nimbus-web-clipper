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

describe("renderHit", () => {
  test("a url hit renders an anchor with safe target/rel and the title as text", () => {
    const el = renderHit(document, base);
    const a = el.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("https://ex.com/d");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a?.textContent).toBe("Doc");
  });
  test("a url:null hit renders the title as plain text (no anchor)", () => {
    const el = renderHit(document, { ...base, url: null });
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Doc");
  });
  test("XSS backstop — markup in title/snippet is inert text, not parsed nodes", () => {
    const el = renderHit(document, {
      ...base,
      url: null,
      title: "<img src=x onerror=alert(1)>",
      snippet: "<script>alert(2)</script>",
    });
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(el.textContent).toContain("<script>alert(2)</script>");
  });
  test("javascript: URL — no anchor rendered, title appears as plain text", () => {
    const el = renderHit(document, { ...base, url: "javascript:alert(1)" });
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Doc");
  });
  test("data: URL — no anchor rendered, title appears as plain text", () => {
    const el = renderHit(document, {
      ...base,
      url: "data:text/html,<script>alert(1)</script>",
    });
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Doc");
  });
});

describe("renderHits", () => {
  test("empty list → the empty-state message", () => {
    expect(renderHits(document, []).textContent).toBe("No related items found.");
  });
  test("renders one node per hit", () => {
    const list = renderHits(document, [base, { ...base, id: "2" }]);
    expect(list.querySelectorAll(".nimbus-related__item")).toHaveLength(2);
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
    expect(no.querySelector("button")).toBeNull();
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
    // Terminal: retrying will never work, which is why this arm is not collapsed.
    expect(el.querySelectorAll("button")).toHaveLength(0);
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
    expect(el.querySelectorAll("button")).toHaveLength(0);
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
    const el = renderLaneBody(document, {
      kind: "done",
      brief: "## Impact\n\n<img src=x onerror=alert(1)>\n\n- a\n- b",
    });
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
    const el = renderLaneBody(document, { kind: "running", runId: "r1" });
    expect(el.textContent).toContain("Working");
  });

  it("offers Re-run on a stale run, and states why", () => {
    const seen: string[] = [];
    const el = renderLaneBody(document, { kind: "failed", reason: "stale" }, () =>
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
      const el = renderLaneBody(document, { kind: "failed", reason }, () => undefined);
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
    const el = renderLaneBody(document, { kind: "failed", reason: "not_paired" }, () =>
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
    ] as const) {
      const el = renderLaneBody(document, { kind: "failed", reason }, () => undefined);
      expect(el.querySelector("button")).toBeNull();
      expect(el.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("names the agents scope on a scope failure, not resolve or fetch", () => {
    const el = renderLaneBody(document, {
      kind: "failed",
      reason: "insufficient_scope",
      scopeGap: { label: "chrome", required: "agents", granted: ["clip", "resolve"] },
    });
    expect(el.textContent).toContain("nimbus clip scopes chrome --set clip,resolve,agents");
  });

  // C2.1's done-when: never a silent empty lane.
  it("renders a stated reason for every failure, never nothing", () => {
    for (const reason of [
      "not_paired",
      "unauthorized",
      "unsupported",
      "not_resolved",
      "agent_failed",
      "unreachable",
      "server_error",
    ] as const) {
      const el = renderLaneBody(document, { kind: "failed", reason });
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
      () => undefined,
    );
    const text = el.textContent?.toLowerCase() ?? "";
    expect(text).not.toContain("hasn't indexed");
    expect(text).not.toContain("not indexed");
  });

  it("blames the gateway for unsupported and the page for not_resolved, never the reverse", () => {
    const gateway = renderLaneBody(
      document,
      { kind: "failed", reason: "unsupported" },
      () => undefined,
    );
    const page = renderLaneBody(
      document,
      { kind: "failed", reason: "not_resolved" },
      () => undefined,
    );
    expect(gateway.textContent?.toLowerCase()).toContain("gateway");
    expect(page.textContent?.toLowerCase()).not.toContain("gateway");
  });

  it("does not report a finished-and-failed run as an error — the call succeeded", () => {
    const el = renderLaneBody(
      document,
      { kind: "failed", reason: "agent_failed" },
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
        renderLaneBody(document, { kind: "failed", reason }, () => undefined).textContent ?? ""
      ).trim();
      expect(text.length).toBeGreaterThan(0);
      const clash = seen.get(text);
      expect(clash, `"${reason}" renders the same text as "${clash}"`).toBeUndefined();
      seen.set(text, reason);
    }
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
  const state = {
    kind: "service" as const,
    surface: "Jenkins dashboard",
    product: "jenkins" as const,
  };

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

  it("renders exactly the surface line and the scope line", () => {
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
});
