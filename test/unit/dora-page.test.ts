// @vitest-environment jsdom
// test/unit/dora-page.test.ts
//
// The DORA page's own wiring: which messages it sends, in what order, and what
// it does with replies that arrive late, fail, or belong to an older selection.
// `dora-view.test.ts` covers what a row looks like.
//
// `src/dora/dora.ts` runs on import, so every test sets the DOM and the URL
// first and re-imports through `vi.resetModules()` (the ledger-page pattern).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DAY_MS } from "../../src/shared/dora.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

const FIXTURE = `
  <select id="service-picker"></select>
  <button id="range-4w"></button><button id="range-13w"></button><button id="range-26w"></button>
  <p id="dora-notice" hidden></p>
  <ul id="delivery-rows"></ul>
  <ul id="activity-rows"></ul>
  <footer id="dora-footer"></footer>
`;

let harness: ChromeHarness;

type Msg = { kind: string; serviceId?: string; range?: string; metric?: string };

const binding = (serviceId: string, scope = `acme/${serviceId}`) => ({
  product: "github",
  origin: "https://github.com",
  scope,
  serviceId,
});

function doraOk(serviceId: string, v = 1.4) {
  const m = { value: v, unit: "deploys_per_day", sample: 9, gap: null };
  return {
    kind: "dora-metrics",
    ok: true,
    result: {
      service: serviceId,
      since_ms: 1,
      computed_at: "2026-10-07T09:00:00.000Z",
      metrics: {
        deployment_frequency: m,
        lead_time_for_changes: m,
        change_failure_rate: m,
        mttr: m,
      },
    },
  };
}

function statsOk(serviceId: string, metric: string, v = 2) {
  return {
    kind: "metrics-stats",
    ok: true,
    series: {
      metric,
      service: serviceId,
      window: { since_ms: 0, until_ms: 91 * DAY_MS },
      bucket_ms: 7 * DAY_MS,
      points: [
        { start_ms: 0, end_ms: 7 * DAY_MS, value: v, unit: "merges", sample: v, gap: null },
        {
          start_ms: 7 * DAY_MS,
          end_ms: 14 * DAY_MS,
          value: v,
          unit: "merges",
          sample: v,
          gap: null,
        },
      ],
    },
  };
}

/** Answers every kind sensibly; `over` replaces one kind's handler. */
function replies(
  bindings: unknown[],
  over: Partial<Record<string, (m: Msg) => Promise<unknown>>> = {},
): (m: Msg) => Promise<unknown> {
  return async (m) => {
    const h = over[m.kind];
    if (h !== undefined) return h(m);
    if (m.kind === "service-bindings-list")
      return { kind: "service-bindings-list", ok: true, bindings };
    if (m.kind === "dora-metrics") return doraOk(m.serviceId ?? "");
    if (m.kind === "metrics-stats") return statsOk(m.serviceId ?? "", m.metric ?? "");
    return undefined;
  };
}

function sent(kind?: string): Msg[] {
  const all = harness.sendMessage.mock.calls.map((c) => c[0] as Msg);
  return kind === undefined ? all : all.filter((m) => m.kind === kind);
}

async function loadPage(search = ""): Promise<void> {
  document.body.innerHTML = FIXTURE;
  window.history.replaceState(null, "", `/dora.html${search}`);
  vi.resetModules();
  await import("../../src/dora/dora.ts");
}

const rowValue = (metric: string) =>
  document.querySelector(`[data-metric="${metric}"] .dora-row__value`)?.textContent;

beforeEach(() => {
  harness = installChromeMock();
  try {
    localStorage.clear();
  } catch {
    // jsdom always has it; the page must survive without it (tested below).
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the DORA page", () => {
  test("?service= loads that service: one headline read and six trend reads, all for the default range", async () => {
    harness.sendMessage.mockImplementation(replies([binding("web")]));
    await loadPage("?service=web");
    await vi.waitFor(() => expect(sent("metrics-stats")).toHaveLength(6));
    expect(sent("dora-metrics")).toEqual([
      { kind: "dora-metrics", serviceId: "web", range: "13w" },
    ]);
    expect(new Set(sent("metrics-stats").map((m) => m.metric)).size).toBe(6);
    await vi.waitFor(() => expect(rowValue("pr-merges")).toBe("4"));
  });

  test("a fast row renders while a slow one is still pending", async () => {
    let release: (v: unknown) => void = () => undefined;
    const slow = new Promise((r) => {
      release = r;
    });
    harness.sendMessage.mockImplementation(
      replies([binding("web")], {
        "metrics-stats": async (m) => (m.metric === "mttr" ? slow : statsOk("web", m.metric ?? "")),
      }),
    );
    await loadPage("?service=web");
    await vi.waitFor(() => expect(rowValue("pr-merges")).toBe("4"));
    expect(document.querySelector('[data-metric="mttr"] svg')).toBeNull();
    release(statsOk("web", "mttr"));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-metric="mttr"] svg')).not.toBeNull(),
    );
  });

  test("one failed trend read leaves the other rows drawn", async () => {
    harness.sendMessage.mockImplementation(
      replies([binding("web")], {
        "metrics-stats": async (m) =>
          m.metric === "lead-time"
            ? { kind: "metrics-stats", ok: false, reason: "server_error" }
            : statsOk("web", m.metric ?? ""),
      }),
    );
    await loadPage("?service=web");
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-metric="lead_time_for_changes"]')?.textContent,
      ).toContain("Couldn't load this trend."),
    );
    expect(document.querySelectorAll("#delivery-rows svg, #activity-rows svg").length).toBe(5);
    expect(document.getElementById("dora-notice")?.hidden).toBe(true);
  });

  test("all seven unreachable is one page-level message", async () => {
    harness.sendMessage.mockImplementation(
      replies([binding("web")], {
        "dora-metrics": async () => ({ kind: "dora-metrics", ok: false, reason: "unreachable" }),
        "metrics-stats": async () => {
          throw new Error("Could not establish connection");
        },
      }),
    );
    await loadPage("?service=web");
    await vi.waitFor(() =>
      expect(document.getElementById("dora-notice")?.textContent).toBe(
        "Can't reach your Nimbus gateway.",
      ),
    );
  });

  test("a 404 on the trend route is one 'newer gateway' line, and headlines still render", async () => {
    harness.sendMessage.mockImplementation(
      replies([binding("web")], {
        "metrics-stats": async () => ({ kind: "metrics-stats", ok: false, reason: "unsupported" }),
      }),
    );
    await loadPage("?service=web");
    await vi.waitFor(() =>
      expect(document.getElementById("dora-notice")?.textContent).toBe(
        "Trends need a newer Nimbus gateway.",
      ),
    );
    await vi.waitFor(() => expect(rowValue("deployment_frequency")).toBe("1.4 / day"));
    expect(document.querySelectorAll("svg")).toHaveLength(0);
  });

  test("a stale reply never overwrites a newer selection", async () => {
    let releaseOld: (v: unknown) => void = () => undefined;
    const oldReply = new Promise((r) => {
      releaseOld = r;
    });
    harness.sendMessage.mockImplementation(
      replies([binding("web")], {
        "dora-metrics": async (m) => (m.range === "13w" ? oldReply : doraOk("web", 9.9)),
      }),
    );
    await loadPage("?service=web");
    await vi.waitFor(() => expect(sent("dora-metrics")).toHaveLength(1));
    document.getElementById("range-26w")?.click();
    await vi.waitFor(() => expect(rowValue("deployment_frequency")).toBe("9.9 / day"));
    releaseOld(doraOk("web", 1.1));
    await new Promise((r) => setTimeout(r, 0));
    expect(rowValue("deployment_frequency")).toBe("9.9 / day");
  });

  test("an unbound ?service= still loads, and joins the picker as not bound here", async () => {
    harness.sendMessage.mockImplementation(replies([binding("web")]));
    await loadPage("?service=payments");
    await vi.waitFor(() => expect(sent("dora-metrics")[0]?.serviceId).toBe("payments"));
    const opt = [...document.querySelectorAll<HTMLOptionElement>("#service-picker option")].find(
      (o) => o.value === "payments",
    );
    expect(opt?.textContent).toContain("not bound in this browser");
  });

  test("an encoded ?service= loads that exact id", async () => {
    harness.sendMessage.mockImplementation(replies([]));
    await loadPage(`?service=${encodeURIComponent("a b/c")}`);
    await vi.waitFor(() => expect(sent("dora-metrics")[0]?.serviceId).toBe("a b/c"));
  });

  test("a single binding auto-selects", async () => {
    harness.sendMessage.mockImplementation(replies([binding("web")]));
    await loadPage();
    await vi.waitFor(() => expect(sent("dora-metrics")[0]?.serviceId).toBe("web"));
  });

  test("several bindings and no ?service= wait for a choice — then the URL follows it", async () => {
    harness.sendMessage.mockImplementation(replies([binding("web"), binding("api")]));
    await loadPage();
    await vi.waitFor(() => expect(sent("service-bindings-list")).toHaveLength(1));
    expect(sent("dora-metrics")).toHaveLength(0);
    const picker = document.getElementById("service-picker") as HTMLSelectElement;
    picker.value = "api";
    picker.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(sent("dora-metrics")[0]?.serviceId).toBe("api"));
    expect(window.location.search).toBe("?service=api");
  });

  test("no bindings and no ?service= make no gateway reads", async () => {
    harness.sendMessage.mockImplementation(replies([]));
    await loadPage();
    await vi.waitFor(() => expect(document.getElementById("dora-notice")?.hidden).toBe(false));
    expect(sent("dora-metrics")).toHaveLength(0);
    expect(sent("metrics-stats")).toHaveLength(0);
    // No "…" placeholders under the notice.
    expect(document.querySelectorAll(".dora-row")).toHaveLength(0);
    expect(document.getElementById("range-13w")?.getAttribute("aria-pressed")).toBe("true");
  });

  test("the chosen range is remembered", async () => {
    harness.sendMessage.mockImplementation(replies([binding("web")]));
    await loadPage("?service=web");
    document.getElementById("range-4w")?.click();
    await vi.waitFor(() => expect(sent("dora-metrics").at(-1)?.range).toBe("4w"));
    await loadPage("?service=web");
    await vi.waitFor(() => expect(sent("dora-metrics").at(-1)?.range).toBe("4w"));
  });

  test("localStorage throwing still renders, on the default range", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    harness.sendMessage.mockImplementation(replies([binding("web")]));
    await loadPage("?service=web");
    await vi.waitFor(() => expect(sent("dora-metrics")[0]?.range).toBe("13w"));
    document.getElementById("range-4w")?.click();
    await vi.waitFor(() => expect(sent("dora-metrics").at(-1)?.range).toBe("4w"));
  });

  test("a range click with no service selected repaints the buttons and reads nothing", async () => {
    harness.sendMessage.mockImplementation(replies([binding("web"), binding("api")]));
    await loadPage();
    await vi.waitFor(() => expect(sent("service-bindings-list")).toHaveLength(1));
    document.getElementById("range-4w")?.click();
    expect(document.getElementById("range-4w")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById("range-13w")?.getAttribute("aria-pressed")).toBe("false");
    expect(sent("dora-metrics")).toHaveLength(0);
    expect(sent("metrics-stats")).toHaveLength(0);
  });

  test("an unsupported answer arriving last hides trends that already loaded", async () => {
    let release: (v: unknown) => void = () => undefined;
    const slow = new Promise((r) => {
      release = r;
    });
    harness.sendMessage.mockImplementation(
      replies([binding("web")], {
        "metrics-stats": async (m) => (m.metric === "mttr" ? slow : statsOk("web", m.metric ?? "")),
      }),
    );
    await loadPage("?service=web");
    await vi.waitFor(() => expect(document.querySelectorAll("svg").length).toBe(5));
    release({ kind: "metrics-stats", ok: false, reason: "unsupported" });
    await vi.waitFor(() => expect(document.querySelectorAll("svg")).toHaveLength(0));
    expect(document.getElementById("dora-notice")?.textContent).toBe(
      "Trends need a newer Nimbus gateway.",
    );
    expect(rowValue("deployment_frequency")).toBe("1.4 / day");
  });

  test("a refused trend read shows nothing extra on its row", async () => {
    harness.sendMessage.mockImplementation(
      replies([binding("web")], {
        "metrics-stats": async (m) =>
          m.metric === "mttr"
            ? { kind: "metrics-stats", ok: false, reason: "refused" }
            : statsOk("web", m.metric ?? ""),
      }),
    );
    await loadPage("?service=web");
    await vi.waitFor(() => expect(document.querySelectorAll("svg")).toHaveLength(5));
    const row = document.querySelector('[data-metric="mttr"]');
    expect(row?.textContent).not.toContain("Couldn't load this trend.");
    expect(document.body.textContent).not.toContain("Couldn't load this trend.");
    expect(document.getElementById("dora-notice")?.hidden).toBe(true);
    expect(rowValue("deployment_frequency")).toBe("1.4 / day");
  });

  test("choosing the placeholder after a service loaded snaps the picker back", async () => {
    harness.sendMessage.mockImplementation(replies([binding("web"), binding("api")]));
    await loadPage("?service=web");
    await vi.waitFor(() => expect(rowValue("pr-merges")).toBe("4"));
    const calls = sent().length;
    const picker = document.getElementById("service-picker") as HTMLSelectElement;
    picker.value = "";
    picker.dispatchEvent(new Event("change"));
    expect(picker.value).toBe("web");
    expect(sent()).toHaveLength(calls);
    expect(rowValue("pr-merges")).toBe("4");
  });
});
