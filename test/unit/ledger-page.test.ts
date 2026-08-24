// @vitest-environment jsdom
// test/unit/ledger-page.test.ts
//
// The Activity page's own wiring: which messages it sends, when it does NOT
// send one, and what it does with what comes back. `ledger-view.test.ts` covers
// what the DOM looks like; this file covers what the page DOES.
//
// `src/ledger/ledger.ts` binds its listeners and fires its first read as a
// MODULE-EVALUATION side effect, so the fixture must exist before the import and
// every test re-imports through `vi.resetModules()` — a second import of a live
// module would drive the previous test's listeners against a detached DOM.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EgressRow } from "../../src/shared/egress.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

const FIXTURE = `
  <main class="ledger">
    <div class="ledger__controls">
      <button id="scope-ours" type="button">Yours</button>
      <button id="scope-all" type="button">All</button>
      <button id="verify" type="button">Verify chain</button>
      <button id="prove" type="button">Export proof</button>
    </div>
    <section id="ledger-body"></section>
    <button id="older" type="button">Older</button>
  </main>
`;

let harness: ChromeHarness;

function row(over: Partial<EgressRow> = {}): EgressRow {
  return {
    id: 9,
    timestamp: 1_755_600_000_000,
    sourceType: "http",
    sourceId: "Mock Device",
    destination: "github",
    method: "agents.why",
    payloadSummary: "{}",
    hitlStatus: "not_required",
    resultStatus: "authorized",
    rowHash: "aa",
    prevHash: "bb",
    ...over,
  };
}

const OURS = row({ id: 9 });
const THEIRS = row({ id: 8, sourceId: "nimbus-editor", destination: "jira" });

/** The default reply table: one row of ours, one of another client's. */
function replies(over: Record<string, unknown> = {}): (m: { kind: string }) => Promise<unknown> {
  const table: Record<string, unknown> = {
    "egress-window": {
      kind: "egress-window",
      ok: true,
      partition: { ours: [OURS], others: [THEIRS], unattributable: [] },
      rowsTotal: 2,
      rowsTruncated: false,
    },
    "egress-verify": {
      kind: "egress-verify",
      ok: true,
      verdict: { intact: true, brokenAt: null, verifiedRows: 2, reason: null },
    },
    "egress-prove": {
      kind: "egress-prove",
      ok: true,
      proof: { digest: "d", sigB64: "s", pubkeyB64: "p", rowsTotal: 2, rowsTruncated: false },
    },
    ...over,
  };
  return async (m) => table[m.kind];
}

function click(id: string): void {
  document.getElementById(id)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function sentKinds(): string[] {
  return harness.sendMessage.mock.calls.map((c) => (c[0] as { kind: string }).kind);
}

async function loadPage(): Promise<void> {
  document.body.innerHTML = FIXTURE;
  vi.resetModules();
  await import("../../src/ledger/ledger.ts");
  await vi.waitFor(() =>
    expect(document.querySelectorAll("#ledger-body .ledger__row").length).toBeGreaterThan(0),
  );
}

beforeEach(() => {
  harness = installChromeMock();
  harness.sendMessage.mockImplementation(replies());
  // jsdom implements neither; the page only needs them to not throw.
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Activity page", () => {
  test("reads one window on mount and renders our rows", async () => {
    await loadPage();
    expect(sentKinds()).toEqual(["egress-window"]);
    expect(document.querySelectorAll(".ledger__row")).toHaveLength(1);
    expect(document.body.textContent).toContain("github");
  });

  test("the scope toggle re-renders the SAME response — it never re-reads", async () => {
    // A second read would show a different window than the one on screen, and
    // would spend a gateway read to display rows already in hand.
    await loadPage();
    click("scope-all");
    await vi.waitFor(() => expect(document.querySelectorAll(".ledger__row")).toHaveLength(2));
    expect(document.body.textContent).toContain("jira");
    expect(sentKinds()).toEqual(["egress-window"]);
  });

  test("no verdict is rendered until Verify is pressed", async () => {
    await loadPage();
    expect(document.querySelector(".ledger__verdict")).toBeNull();

    click("verify");
    await vi.waitFor(() =>
      expect(document.querySelector(".ledger__verdict")?.textContent).toContain("Chain verified."),
    );
    expect(sentKinds()).toEqual(["egress-window", "egress-verify"]);
  });

  test("the verdict survives a scope toggle, because it is a claim about the ledger", async () => {
    // verifyEgressChain walks the WHOLE chain upstream, so the verdict is not a
    // claim about the rows currently on screen.
    await loadPage();
    click("verify");
    await vi.waitFor(() => expect(document.querySelector(".ledger__verdict")).not.toBeNull());

    click("scope-all");
    await vi.waitFor(() => expect(document.querySelectorAll(".ledger__row")).toHaveLength(2));
    expect(document.querySelector(".ledger__verdict")?.textContent).toContain("Chain verified.");
    expect(sentKinds().filter((k) => k === "egress-verify")).toHaveLength(1);
  });

  test("a failed verify REQUEST is not reported as a broken chain", async () => {
    // Saying "did not verify" on a transport failure would claim evidence we do
    // not have.
    harness.sendMessage.mockImplementation(
      replies({ "egress-verify": { kind: "egress-verify", ok: false, reason: "unreachable" } }),
    );
    await loadPage();
    click("verify");
    await vi.waitFor(() => expect(document.querySelector(".ledger__error")).not.toBeNull());
    expect(document.body.textContent).not.toContain("did not verify");
  });

  test("Older pages backwards from the oldest row shown, and replaces the page", async () => {
    harness.sendMessage.mockImplementation(
      replies({
        "egress-window": {
          kind: "egress-window",
          ok: true,
          partition: { ours: [OURS], others: [THEIRS], unattributable: [] },
          rowsTotal: 40,
          rowsTruncated: true,
        },
      }),
    );
    await loadPage();
    click("older");
    await vi.waitFor(() =>
      expect(harness.sendMessage).toHaveBeenCalledWith({ kind: "egress-window", before: 8 }),
    );
  });

  test("Older is hidden when the window is not truncated", async () => {
    await loadPage();
    expect((document.getElementById("older") as HTMLButtonElement).hidden).toBe(true);
  });

  test("Export proof is sent only on the gesture, and hands over a file", async () => {
    // It signs with the gateway's Vault key and carries its own tight rate
    // limit, so it must never fire on mount.
    await loadPage();
    expect(sentKinds()).not.toContain("egress-prove");

    click("prove");
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(sentKinds()).toContain("egress-prove");
  });

  test("an error response renders the failure instead of rows", async () => {
    harness.sendMessage.mockImplementation(
      replies({
        "egress-window": {
          kind: "egress-window",
          ok: false,
          reason: "insufficient_scope",
          // Deliberately shell-safe: "Mock Device" has a SPACE, which
          // `scopeCommand`'s SAFE_LABEL refuses to embed — a real gateway label
          // like that renders generic guidance instead, covered in
          // ledger-view.test.ts.
          scopeGap: { label: "mock-device", required: "egress", granted: ["clip"] },
        },
      }),
    );
    document.body.innerHTML = FIXTURE;
    vi.resetModules();
    await import("../../src/ledger/ledger.ts");
    await vi.waitFor(() => expect(document.querySelector(".ledger__error")).not.toBeNull());
    expect(document.body.textContent).toContain("nimbus clip scopes mock-device --set clip,egress");
    expect(document.querySelectorAll(".ledger__row")).toHaveLength(0);
  });

  test("never writes to chrome.storage", async () => {
    // The page shows the gateway's record, never a copy of its own.
    await loadPage();
    click("verify");
    click("scope-all");
    expect(harness.storageSet).not.toHaveBeenCalled();
  });
});
