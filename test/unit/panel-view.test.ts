// @vitest-environment jsdom
// test/unit/panel-view.test.ts
import { describe, expect, test } from "vitest";
import {
  type HeaderState,
  type Lane,
  renderError,
  renderHeader,
  renderHit,
  renderHits,
  renderLane,
  renderShell,
} from "../../src/panel/panel-view.ts";
import type { RelatedHit, ResolvedItem } from "../../src/shared/types.ts";

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
  canonicalUrl: "https://bitbucket.org/acme/web/pull-requests/482",
  url: "https://bitbucket.org/acme/web/pull-requests/482",
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
    });
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Cache the index between runs");
  });
  test("not-indexed — honest miss, no loose hits implied", () => {
    const el = renderHeader(document, { kind: "not-indexed", surface: "Jira issue · PLAT-9" });
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
