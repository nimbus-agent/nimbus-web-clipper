// @vitest-environment jsdom
// test/unit/options.test.ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import "../../src/options/options.ts";
import type { ConnectionResponse, PairResponse } from "../../src/shared/messages.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(resolve(ROOT, "src/options/options.html"), "utf8");

// Mirrors src/options/options.html's element ids.
const FIXTURE = `
  <section id="stage-connect">
    <button id="discover" type="button">Find my gateway</button>
    <output id="discover-status"></output>
    <input id="origin" type="text" />
    <input id="code" type="text" />
    <button id="pair" type="button">Pair this browser</button>
    <output id="pairing-status"></output>
  </section>
  <section id="stage-connection">
    <output id="health-line"></output>
    <output id="connection-status"></output>
    <button id="unpair" type="button">Unpair this browser</button>
    <button id="unpair-cancel" type="button" hidden>Cancel</button>
    <div id="shortcut-list"></div>
    <p id="shortcut-hint"></p>
  </section>
  <section id="stage-sites">
    <input id="surface-origin" type="text" />
    <select id="surface-product"></select>
    <button id="surface-add" type="button">Add surface</button>
    <output id="surface-status"></output>
    <div id="surface-list"></div>
  </section>
  <section id="stage-trust">
    <span id="trust-origin"></span>
    <span id="trust-hosts"></span>
    <span id="trust-ledger"></span>
    <button id="trust-ledger-open" type="button">Open Activity</button>
    <input id="preview-toggle" type="checkbox" checked />
    <input id="index-toggle" type="checkbox" />
  </section>
`;

const unpaired: ConnectionResponse = { kind: "connection", paired: false };
const paired: ConnectionResponse = {
  kind: "connection",
  paired: true,
  label: "MacBook",
  origin: "http://127.0.0.1:7474",
  pairedAt: Date.UTC(2026, 5, 27, 12, 0, 0),
  queueDepth: 0,
  reachable: true,
  stale: false,
};

let harness: ChromeHarness;

/** Drain pending promise chains chained after refreshSurfaces(). A single
 * macrotask tick does not reliably drain the awaits in refreshSurfaces() →
 * surfaceRows() → (getAmbientHosts() + hasOrigin() per row) → render → write,
 * so the assertion would race the DOM update. Multiple rounds ensure every
 * layer of chained awaits gets a turn. */
async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`missing #${id}`);
  }
  return found;
}

function input(id: string): HTMLInputElement {
  const found = el(id);
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not an input`);
  }
  return found;
}

function button(id: string): HTMLButtonElement {
  const found = el(id);
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`#${id} is not a button`);
  }
  return found;
}

function select(id: string): HTMLSelectElement {
  const found = el(id);
  if (!(found instanceof HTMLSelectElement)) {
    throw new Error(`#${id} is not a select`);
  }
  return found;
}

/**
 * Click the surface-row control for exactly one origin.
 *
 * Matches `data-origin` by EQUALITY, never by substring. A substring match on a
 * host is the pattern CodeQL flags as `js/incomplete-url-substring-sanitization`
 * — "github.com" is a substring of "evil-github.com.example" too — and although
 * these are test selectors rather than a security check, the exact match is also
 * the more precise selector: built-in rows carry their label verbatim
 * ("github.com", "*.atlassian.net") and stored rows carry their full origin.
 *
 * Throws on a miss rather than no-opping. `find(...)?.click()` silently does
 * nothing when a selector breaks, which turns "the row moved" into a confusing
 * assertion failure somewhere else.
 */
function clickFor(action: string, origin: string): void {
  const match = [...document.querySelectorAll(`[data-action="${action}"]`)].find(
    (node) => node instanceof HTMLElement && node.dataset["origin"] === origin,
  );
  if (!(match instanceof HTMLElement)) {
    throw new Error(`no [data-action="${action}"] control for origin ${origin}`);
  }
  match.click();
}

/**
 * Seeds the fixture DOM and fires DOMContentLoaded — assumes the chrome mock
 * (and any harness state a test wants pre-seeded, e.g. `harness.grantedOrigins`
 * or `harness.storage`) is already installed by the caller.
 */
async function bootOptions(): Promise<void> {
  document.body.innerHTML = FIXTURE;
  document.dispatchEvent(new Event("DOMContentLoaded"));
  await flush();
}

/** Installs the chrome mock, seeds the fixture DOM, and fires DOMContentLoaded. */
async function boot(initialConnection: unknown = unpaired): Promise<void> {
  harness = installChromeMock();
  harness.sendMessage.mockResolvedValue(initialConnection);
  await bootOptions();
}

afterEach(() => {
  // options.ts is imported once for the whole file, and unpairArmed is a
  // module-level singleton — deterministically disarm it so its state doesn't
  // leak into the next test regardless of whether that test itself confirms
  // or cancels the unpair flow.
  const cancel = document.getElementById("unpair-cancel");
  if (cancel instanceof HTMLButtonElement) {
    cancel.click();
  }
  harness.restore();
});

describe("options: initial load / refreshConnection", () => {
  test("unpaired: stage 1 is active, stage 2 is locked", async () => {
    await boot(unpaired);

    expect(harness.sendMessage).toHaveBeenCalledWith({ kind: "connection-status" });
    expect(el("stage-connect").dataset["state"]).toBe("active");
    expect(el("stage-connection").dataset["state"]).toBe("locked");
    expect(el("health-line").textContent).toBe("Not paired.");
  });

  test("paired: stage 1 is done, stage 2 is active, with label/origin/paired-since", async () => {
    await boot(paired);

    expect(el("stage-connect").dataset["state"]).toBe("done");
    expect(el("stage-connection").dataset["state"]).toBe("active");
    expect(el("connection-status").textContent).toBe('Paired as "MacBook".');
    expect(el("health-line").textContent).toBe(
      'Connected to http://127.0.0.1:7474 as "MacBook", since Jun 27, 2026.',
    );
  });
});

describe("pair()", () => {
  test("empty origin/code shows a validation status without sending a request", async () => {
    await boot();
    input("origin").value = "";
    input("code").value = "";
    harness.sendMessage.mockClear();

    button("pair").click();
    await flush();

    expect(el("pairing-status").textContent).toBe(
      "Enter both the gateway URL and the pairing code.",
    );
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  test("successful pair clears the code, clears status, and refreshes to the paired panel", async () => {
    await boot(unpaired);
    input("origin").value = "http://127.0.0.1:7474";
    input("code").value = "429173";
    const pairOk: PairResponse = { kind: "pair", ok: true, label: "MacBook" };
    harness.sendMessage.mockImplementation(async (req: unknown) => {
      const kind = (req as { kind?: unknown }).kind;
      return kind === "pair" ? pairOk : paired;
    });

    button("pair").click();
    await flush();

    expect(harness.sendMessage).toHaveBeenCalledWith({
      kind: "pair",
      origin: "http://127.0.0.1:7474",
      code: "429173",
    });
    expect(input("code").value).toBe("");
    expect(el("pairing-status").textContent).toBe("");
    expect(el("stage-connection").dataset["state"]).toBe("active");
    expect(el("connection-status").textContent).toBe('Paired as "MacBook".');
  });

  test("pairing_failed shows the mapped error status", async () => {
    await boot();
    input("origin").value = "http://127.0.0.1:7474";
    input("code").value = "000000";
    const fail: PairResponse = { kind: "pair", ok: false, reason: "pairing_failed" };
    harness.sendMessage.mockResolvedValue(fail);

    button("pair").click();
    await flush();

    expect(el("pairing-status").textContent).toBe(
      "Code wrong or expired — run `nimbus clip pair` again.",
    );
  });

  test("bad_origin, unreachable, and server_error map to their own status text", async () => {
    for (const [reason, message] of [
      ["bad_origin", "Enter a 127.0.0.1 / localhost URL."],
      ["unreachable", "Can't reach Nimbus — is the gateway running?"],
      ["server_error", "Nimbus had an error during pairing."],
    ] as const) {
      await boot();
      input("origin").value = "http://127.0.0.1:7474";
      input("code").value = "000000";
      harness.sendMessage.mockResolvedValue({ kind: "pair", ok: false, reason });

      button("pair").click();
      await flush();

      expect(el("pairing-status").textContent).toBe(message);
      harness.restore();
    }
  });

  test("an unmapped reason falls back to a generic 'Pairing failed.' message", async () => {
    await boot();
    input("origin").value = "http://127.0.0.1:7474";
    input("code").value = "000000";
    harness.sendMessage.mockResolvedValue({
      kind: "pair",
      ok: false,
      reason: "some_unmapped_reason",
    });

    button("pair").click();
    await flush();

    expect(el("pairing-status").textContent).toBe("Pairing failed.");
  });

  test("an unexpected response shape sets an 'Unexpected response.' status", async () => {
    await boot();
    input("origin").value = "http://127.0.0.1:7474";
    input("code").value = "000000";
    harness.sendMessage.mockResolvedValue({ not: "a pair response" });

    button("pair").click();
    await flush();

    expect(el("pairing-status").textContent).toBe("Unexpected response.");
  });

  test("sendMessage rejecting recovers the status to a retry-able message", async () => {
    await boot();
    input("origin").value = "http://127.0.0.1:7474";
    input("code").value = "000000";
    harness.sendMessage.mockRejectedValue(new Error("channel closed"));

    button("pair").click();
    await flush();

    expect(el("pairing-status").textContent).toBe(
      "Couldn't reach the extension — please try again.",
    );
  });
});

describe("onUnpairClick() / disarmUnpair()", () => {
  test("first click arms confirmation without sending a request", async () => {
    await boot(paired);
    harness.sendMessage.mockClear();

    button("unpair").click();
    await flush();

    expect(button("unpair").textContent).toBe("Click again to confirm unpair");
    expect(button("unpair-cancel").hidden).toBe(false);
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  test("second click confirms: sends unpair and re-renders the unpaired panel", async () => {
    await boot(paired);
    button("unpair").click();
    await flush();
    harness.sendMessage.mockResolvedValue(unpaired);

    button("unpair").click();
    await flush();

    expect(harness.sendMessage).toHaveBeenCalledWith({ kind: "unpair" });
    expect(el("stage-connect").dataset["state"]).toBe("active");
    expect(el("stage-connection").dataset["state"]).toBe("locked");
    expect(button("unpair").textContent).toBe("Unpair this browser");
    expect(button("unpair").disabled).toBe(false);
    expect(button("unpair-cancel").hidden).toBe(true);
    expect(button("unpair-cancel").disabled).toBe(false);
  });

  test("cancel disarms without sending a request", async () => {
    await boot(paired);
    button("unpair").click();
    await flush();
    harness.sendMessage.mockClear();

    button("unpair-cancel").click();
    await flush();

    expect(button("unpair").textContent).toBe("Unpair this browser");
    expect(button("unpair-cancel").hidden).toBe(true);
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  test("sendMessage rejecting on confirm disarms and re-enables buttons, leaving the paired panel as-is", async () => {
    await boot(paired);
    button("unpair").click();
    await flush();
    harness.sendMessage.mockRejectedValue(new Error("channel closed"));

    button("unpair").click();
    await flush();

    expect(button("unpair").textContent).toBe("Unpair this browser");
    expect(button("unpair").disabled).toBe(false);
    expect(button("unpair-cancel").hidden).toBe(true);
    expect(button("unpair-cancel").disabled).toBe(false);
    // renderConnection was never reached — the paired panel is untouched.
    expect(el("stage-connection").dataset["state"]).toBe("active");
  });
});

describe("recognised surfaces", () => {
  test("the product picker is populated from the registry, not the fixture", async () => {
    await boot();

    expect([...select("surface-product").options].map((o) => o.value)).toEqual([
      "bitbucket",
      "circleci",
      "github",
      "gitlab",
      "jenkins",
      "jira",
    ]);
  });

  test("adding a valid origin stores it and renders a row", async () => {
    await boot();
    input("surface-origin").value = "https://corp.example/jenkins";
    select("surface-product").value = "jenkins";

    button("surface-add").click();
    await flush();

    expect(harness.storage.get("origins")).toEqual([
      { origin: "https://corp.example/jenkins", product: "jenkins" },
    ]);
    expect(el("surface-list").textContent).toContain("https://corp.example/jenkins");
  });

  test("an origin with no scheme is rejected with guidance, and nothing is stored", async () => {
    await boot();
    input("surface-origin").value = "corp.example/jenkins";

    button("surface-add").click();
    await flush();

    expect(el("surface-status").textContent).toContain("full URL");
    expect(harness.storage.get("origins")).toBeUndefined();
  });

  test("Grant requests the HOST pattern, not the path-scoped one", async () => {
    await boot();
    input("surface-origin").value = "https://corp.example/jenkins";
    button("surface-add").click();
    await flush();

    // Built-in rows are always in the list too now, so target the newly added
    // entry's own Grant button rather than the first one in the list.
    [...el("surface-list").querySelectorAll<HTMLButtonElement>("button[data-action='grant']")]
      .find((b) => b.dataset["origin"] === "https://corp.example/jenkins")
      ?.click();
    await flush();

    expect(harness.permissionsRequest).toHaveBeenCalledWith({
      origins: ["https://corp.example/*"],
    });
  });

  test("interleaved mutations do not lose an update", async () => {
    await boot();
    // Delay the storage READ so a second click can start before the first write
    // lands — the interleaving that would otherwise drop one of the two edits.
    // Snapshot the value at REQUEST time and hand it back later. Two handlers
    // that both read before either writes then see the same list — which is
    // exactly the interleaving that drops one of the two edits.
    harness.storageGet.mockImplementation((key: string) => {
      const snapshot = harness.storage.get(key);
      return new Promise((r) => setTimeout(() => r({ [key]: snapshot }), 5));
    });

    input("surface-origin").value = "https://a.example/jira";
    select("surface-product").value = "jira";
    button("surface-add").click();
    input("surface-origin").value = "https://b.example/jenkins";
    select("surface-product").value = "jenkins";
    button("surface-add").click();

    await vi.waitFor(() => {
      expect(harness.storage.get("origins")).toHaveLength(2);
    });
    expect(harness.storage.get("origins")).toEqual([
      { origin: "https://a.example/jira", product: "jira" },
      { origin: "https://b.example/jenkins", product: "jenkins" },
    ]);
  });

  test("a failed revoke is reported, and does not claim siblings were affected", async () => {
    await boot();
    input("surface-origin").value = "https://corp.example/jenkins";
    button("surface-add").click();
    await flush();
    // Built-in rows are always in the list too now, so target the newly added
    // entry's own Grant/Revoke buttons rather than the first ones in the list.
    [...el("surface-list").querySelectorAll<HTMLButtonElement>("button[data-action='grant']")]
      .find((b) => b.dataset["origin"] === "https://corp.example/jenkins")
      ?.click();
    await flush();

    harness.permissionsRemove.mockResolvedValueOnce(false);
    [...el("surface-list").querySelectorAll<HTMLButtonElement>("button[data-action='revoke']")]
      .find((b) => b.dataset["origin"] === "https://corp.example/jenkins")
      ?.click();
    await flush();

    expect(el("surface-status").textContent).toBe("Page access could not be revoked.");
  });

  test("Remove drops the entry from storage", async () => {
    await boot();
    input("surface-origin").value = "https://corp.example/jenkins";
    button("surface-add").click();
    await flush();

    el("surface-list").querySelector<HTMLButtonElement>("button[data-action='remove']")?.click();
    await flush();

    expect(harness.storage.get("origins")).toEqual([]);
  });
});

describe("built-in surfaces in the list", () => {
  test("built-ins are listed even with no stored origins, so they can be granted at all", async () => {
    harness = installChromeMock();
    await bootOptions();
    const text = document.getElementById("surface-list")?.textContent ?? "";
    expect(text).toContain("github.com");
    expect(text).toContain("gitlab.com");
    expect(text).toContain("bitbucket.org");
    expect(text).toContain("*.atlassian.net");
  });

  test("granting a built-in requests exactly its host pattern", async () => {
    harness = installChromeMock();
    await bootOptions();
    clickFor("grant", "github.com");
    await flush();
    expect(harness.permissionsRequest).toHaveBeenCalledWith({
      origins: ["https://github.com/*"],
    });
  });

  test("the Jira Cloud row asks for the tenant wildcard", async () => {
    harness = installChromeMock();
    await bootOptions();
    clickFor("grant", "*.atlassian.net");
    await flush();
    expect(harness.permissionsRequest).toHaveBeenCalledWith({
      origins: ["https://*.atlassian.net/*"],
    });
  });

  test("the remove action is inert for a built-in row even if a crafted click reaches it", async () => {
    // renderSurfaceList never emits a Remove button for a built-in row — this
    // pins the handler's own defence-in-depth guard against a future change to
    // that renderer, by reaching the handler directly with a fabricated one.
    harness = installChromeMock();
    await bootOptions();
    const crafted = document.createElement("button");
    crafted.type = "button";
    crafted.dataset["action"] = "remove";
    crafted.dataset["origin"] = "github.com";
    document.getElementById("surface-list")?.append(crafted);

    crafted.click();
    await flush();

    expect(harness.storage.get("origins")).toBeUndefined();
  });
});

describe("the ambient toggle", () => {
  test("checking it stores the pattern", async () => {
    harness = installChromeMock();
    harness.grantedOrigins.add("https://github.com/*");
    await bootOptions();
    const toggle = [...document.querySelectorAll('[data-action="ambient"]')].find(
      (el) => (el as HTMLInputElement).dataset["pattern"] === "https://github.com/*",
    ) as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(harness.storage.get("ambient-hosts")).toEqual(["https://github.com/*"]);
  });

  test("revoking page access switches the cue off for that host", async () => {
    harness = installChromeMock();
    harness.grantedOrigins.add("https://github.com/*");
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    await bootOptions();
    clickFor("revoke", "github.com");
    await flush();
    expect(harness.storage.get("ambient-hosts")).toEqual([]);
  });

  test("a revoke that failed leaves the preference alone", async () => {
    harness = installChromeMock();
    harness.grantedOrigins.add("https://github.com/*");
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.permissionsRemove.mockResolvedValueOnce(false);
    await bootOptions();
    clickFor("revoke", "github.com");
    await flush();
    expect(harness.storage.get("ambient-hosts")).toEqual(["https://github.com/*"]);
  });

  test("unchecking it removes the pattern", async () => {
    harness = installChromeMock();
    harness.grantedOrigins.add("https://github.com/*");
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    await bootOptions();
    const toggle = [...document.querySelectorAll('[data-action="ambient"]')].find(
      (el) => (el as HTMLInputElement).dataset["pattern"] === "https://github.com/*",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(harness.storage.get("ambient-hosts")).toEqual([]);
  });

  test("a toggle write issued immediately before a revoke is not lost", async () => {
    harness = installChromeMock();
    harness.grantedOrigins.add("https://github.com/*");
    harness.grantedOrigins.add("https://gitlab.com/*");
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    await bootOptions();

    // Delay the storage READ so the revoke's write can be requested before the
    // toggle's write lands — the interleaving that, without both call sites
    // sharing the ambientWrites chain, would drop one of the two edits.
    harness.storageGet.mockImplementation((key: string) => {
      const snapshot = harness.storage.get(key);
      return new Promise((r) => setTimeout(() => r({ [key]: snapshot }), 5));
    });

    // Fake timers make the delayed storageGet calls above — and everything
    // chained after them, including onSurfaceClick's own trailing
    // refreshSurfaces() re-read — settle on a virtual clock we advance
    // ourselves, rather than on a guessed real-time upper bound. That is what
    // makes the drain below exact instead of a wall-clock race against
    // afterEach's harness.restore() on a loaded runner.
    vi.useFakeTimers();
    try {
      const gitlabToggle = [...document.querySelectorAll('[data-action="ambient"]')].find(
        (el) => (el as HTMLInputElement).dataset["pattern"] === "https://gitlab.com/*",
      ) as HTMLInputElement;
      gitlabToggle.checked = true;
      gitlabToggle.dispatchEvent(new Event("change", { bubbles: true }));

      clickFor("revoke", "github.com");

      // Advances the virtual clock (and drains the microtasks interleaved with
      // it) well past every pending 5ms storageGet timer — however many hops
      // deep the chained writes and the trailing refreshSurfaces() turn out to
      // be — with no wall-clock cost and no timer left dangling for afterEach.
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }

    expect(harness.storage.get("ambient-hosts")).toEqual(["https://gitlab.com/*"]);
  });
});

describe("options.html stages", () => {
  test("has all four stages", () => {
    for (const id of ["stage-connect", "stage-connection", "stage-sites", "stage-trust"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("has the discovery control and its status output", () => {
    expect(html).toContain('id="discover"');
    expect(html).toContain('id="discover-status"');
  });

  test("has a health line and the trust panel's data-driven slots", () => {
    expect(html).toContain('id="health-line"');
    expect(html).toContain('id="trust-origin"');
    expect(html).toContain('id="trust-hosts"');
  });

  // Slice 1 shipped this guard inverted — it pinned the copy to NOT promise a
  // payload preview, because back then there wasn't one and a trust panel that
  // overclaims is worse than none. Slice 3 ships the preview, so the guard flips
  // with it: the same defect in the opposite direction is a panel still
  // describing a product that no longer exists. What it guards is unchanged —
  // this paragraph says exactly what the shipped gestures do, no more, no less.
  test("the trust panel describes what clipping actually sends — preview included", () => {
    expect(html).toContain("shows you the whole payload");
    expect(html).toContain("sends nothing until you confirm");
    expect(html).toContain("send straight away");
  });

  test("the trust panel does not claim a popup URL lookup", () => {
    expect(html).not.toContain("opening the popup");
  });

  test("stage 2 and stage 3 default to locked in the shipped HTML", () => {
    expect(html).toMatch(/id="stage-connection"\s+class="stage"\s+data-state="locked"/);
    expect(html).toMatch(/id="stage-sites"\s+class="stage"\s+data-state="locked"/);
  });

  test("the manual gateway URL field survives — discovery never removes it", () => {
    expect(html).toContain('id="origin"');
  });

  // The index toggle is an EGRESS control: ticking it lets a brief's question
  // reach the gateway's embedding provider, which may be remote. Stage 4 opens
  // with "One destination... no cloud service and no analytics", so the toggle
  // cannot sit two paragraphs below that with a bare label. The composer already
  // carries this sentence beside its own checkbox; Options is the second surface
  // for the same preference and gets the same disclosure.
  test("the index toggle carries its description in VISIBLE text, not a tooltip", () => {
    expect(html).toContain('id="index-hint"');
    expect(html).toContain("Adds up to 8 matching items from your index");
    expect(html).toContain("whichever embedding provider your gateway is configured to use");
    // A tooltip is invisible to touch and to keyboard users, for exactly the
    // sentence they most need. src/ contains no title= anywhere; keep it that way.
    expect(html).not.toContain("title=");
  });
});

describe("trust panel: the activity summary (#trust-ledger)", () => {
  /** A kind-aware reply table — the panel now sends two different messages. */
  function bootWith(egress: unknown): Promise<void> {
    harness = installChromeMock();
    harness.sendMessage.mockImplementation(async (m: { kind: string }) =>
      m.kind === "egress-window" ? egress : unpaired,
    );
    return bootOptions();
  }

  test("states the window total and our share", async () => {
    await bootWith({
      kind: "egress-window",
      ok: true,
      partition: { ours: [{ id: 1 }, { id: 2 }], others: [{ id: 3 }], unattributable: [] },
      ourLabel: "MacBook",
      outcomes: {},
      rowsTruncated: false,
    });
    expect(el("trust-ledger").textContent).toContain("3 outbound actions recorded");
    expect(el("trust-ledger").textContent).toContain("2 of them from this browser");
  });

  test("says at-least when the window is truncated, never an exact split", async () => {
    await bootWith({
      kind: "egress-window",
      ok: true,
      partition: { ours: [{ id: 1 }], others: [], unattributable: [] },
      ourLabel: "MacBook",
      outcomes: {},
      rowsTruncated: true,
    });
    expect(el("trust-ledger").textContent).toContain("at least 1");
  });

  test("names a too-old gateway rather than showing nothing", async () => {
    await bootWith({ kind: "egress-window", ok: false, reason: "unsupported" });
    expect(el("trust-ledger").textContent).toContain("does not offer");
  });

  test("renders the built scope command when the scope is missing", async () => {
    await bootWith({
      kind: "egress-window",
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { label: "mock-device", required: "egress", granted: ["clip"] },
    });
    expect(el("trust-ledger").textContent).toContain(
      "nimbus clip scopes mock-device --set clip,egress",
    );
  });

  test("a NULL reply reports rather than throwing", async () => {
    // `typeof null === "object"`, so the old hand-rolled shape check let null
    // through to `res.kind` and threw.
    await bootWith(null);
    expect((el("trust-ledger").textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  test("a malformed success is reported, never destructured", async () => {
    await bootWith({ kind: "egress-window", ok: true });
    expect((el("trust-ledger").textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  test("a dead service worker reports rather than rendering a blank line", async () => {
    await bootWith(undefined);
    expect((el("trust-ledger").textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  test("a REJECTING channel reports rather than throwing", async () => {
    // An unguarded await here surfaces as an unhandled rejection that fails the
    // whole run — which is exactly how CI caught it.
    harness = installChromeMock();
    harness.sendMessage.mockRejectedValue(new Error("channel closed"));
    await bootOptions();
    expect(el("trust-ledger").textContent).toContain("Could not read");
  });

  test("a reply for a DIFFERENT request is not read as a window", async () => {
    await bootWith({ kind: "connection", paired: false });
    expect((el("trust-ledger").textContent ?? "").trim().length).toBeGreaterThan(0);
  });
});

describe("trust panel content (#trust-origin / #trust-hosts)", () => {
  // These are the only assertions on what the data-driven half of the trust
  // panel actually RENDERS, as opposed to the ids merely existing in the
  // markup — the case that would catch a future switch from textContent back
  // to innerHTML going unnoticed.
  test("#trust-origin shows the real configured origin when paired", async () => {
    await boot(paired);
    expect(el("trust-origin").textContent).toBe("http://127.0.0.1:7474");
  });

  test("#trust-origin shows the not-paired wording when not paired", async () => {
    await boot(unpaired);
    expect(el("trust-origin").textContent).toBe("your local gateway (not paired yet)");
  });

  test("#trust-hosts reads 'no sites yet' with no grants", async () => {
    await boot();
    expect(el("trust-hosts").textContent).toBe("no sites yet");
  });

  test("#trust-hosts lists a granted origin", async () => {
    harness = installChromeMock();
    harness.grantedOrigins.add("https://github.com/*");
    harness.sendMessage.mockResolvedValue(unpaired);
    await bootOptions();
    expect(el("trust-hosts").textContent).toBe("github.com");
  });
});

describe("refreshConnection failure", () => {
  test("a rejecting connection-status leaves the shipped locked defaults, rather than throwing", async () => {
    harness = installChromeMock();
    harness.sendMessage.mockRejectedValue(new Error("channel closed"));
    await bootOptions();

    expect(el("stage-connection").dataset["state"]).toBeUndefined();
    expect(el("stage-sites").dataset["state"]).toBeUndefined();
  });
});

describe("options.html shortcuts block", () => {
  test("stage 2 carries the shortcut list and hint slots", () => {
    expect(html).toContain('id="shortcut-list"');
    expect(html).toContain('id="shortcut-hint"');
  });

  test("the shortcut block lives inside stage 2, not its own stage", () => {
    const stage2 = html.slice(
      html.indexOf('id="stage-connection"'),
      html.indexOf('id="stage-sites"'),
    );
    expect(stage2).toContain('id="shortcut-list"');
  });
});

describe("shortcuts render into Options", () => {
  test("a bound and an unbound command both render, with the unbound one marked", async () => {
    // Seed BEFORE booting — see the harness note below. Never call boot() and
    // then dispatch DOMContentLoaded again.
    harness = installChromeMock();
    harness.commandsGetAll = [
      {
        name: "show_related",
        description: "Show related items in Nimbus",
        shortcut: "Alt+Shift+R",
      },
      { name: "clip-page", description: "Clip the current page to Nimbus", shortcut: "" },
    ];
    await bootOptions();

    const rows = el("shortcut-list").querySelectorAll(".shortcut");
    expect(rows).toHaveLength(2);
    expect(el("shortcut-list").querySelectorAll('[data-bound="false"]')).toHaveLength(1);
  });

  test("the hint names a settings path the user can paste", async () => {
    harness = installChromeMock();
    await bootOptions();
    expect(el("shortcut-hint").textContent?.toLowerCase()).toContain("paste");
  });

  test("no commands at all renders an empty list, not a broken page", async () => {
    harness = installChromeMock();
    harness.commandsGetAll = [];
    await bootOptions();
    expect(el("shortcut-list").querySelectorAll(".shortcut")).toHaveLength(0);
    expect(el("shortcut-hint").textContent?.length).toBeGreaterThan(0);
  });
});

describe("preview toggle", () => {
  test("reflects the stored preference", async () => {
    harness = installChromeMock();
    harness.storage.set("preview-enabled", false);
    await bootOptions();
    const toggle = document.getElementById("preview-toggle");
    expect(toggle instanceof HTMLInputElement && toggle.checked).toBe(false);
  });

  test("defaults to on when nothing is stored", async () => {
    harness = installChromeMock();
    await bootOptions();
    const toggle = document.getElementById("preview-toggle");
    expect(toggle instanceof HTMLInputElement && toggle.checked).toBe(true);
  });

  test("switching it off persists", async () => {
    harness = installChromeMock();
    await bootOptions();
    const toggle = document.getElementById("preview-toggle");
    if (toggle instanceof HTMLInputElement) {
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change"));
    }
    await flush();
    expect(harness.storage.get("preview-enabled")).toBe(false);
  });
});

describe("index-search toggle", () => {
  test("reflects the stored preference", async () => {
    harness = installChromeMock();
    harness.storage.set("index-search-enabled", true);
    await bootOptions();
    const toggle = document.getElementById("index-toggle");
    expect(toggle instanceof HTMLInputElement && toggle.checked).toBe(true);
  });

  test("defaults to off when nothing is stored", async () => {
    harness = installChromeMock();
    await bootOptions();
    const toggle = document.getElementById("index-toggle");
    expect(toggle instanceof HTMLInputElement && toggle.checked).toBe(false);
  });

  test("switching it on persists", async () => {
    harness = installChromeMock();
    await bootOptions();
    const toggle = document.getElementById("index-toggle");
    if (toggle instanceof HTMLInputElement) {
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));
    }
    await flush();
    expect(harness.storage.get("index-search-enabled")).toBe(true);
  });

  // The opposite fail-safe from the preview toggle: an unreadable preference
  // must never present a wider search as switched on.
  test("falls back to unchecked on a read failure", async () => {
    harness = installChromeMock();
    harness.storage.set("index-search-enabled", true);
    harness.storageGet.mockImplementation(async (key: string) => {
      if (key === "index-search-enabled") {
        throw new Error("storage unavailable");
      }
      return { [key]: harness.storage.get(key) };
    });
    await bootOptions();
    const toggle = document.getElementById("index-toggle");
    expect(toggle instanceof HTMLInputElement && toggle.checked).toBe(false);
  });
});

describe("the trust panel matches what ships", () => {
  test("it now states the popup shows you the payload first", () => {
    expect(html.toLowerCase()).toContain("before it is sent");
  });

  test("it still says the hotkey does not preview", () => {
    expect(html.toLowerCase()).toContain("hotkey");
  });
});
/**
 * Boot Options with a reply table keyed by message kind.
 *
 * `boot()` above answers EVERY message with one value, which is enough for the
 * connection panel but not for a page that also asks for a discovery result and
 * a disclosure log. `#brief-log` and `#open-brief` are appended rather than
 * added to FIXTURE so the assertions in the rest of this file keep counting the
 * messages they already count.
 */
async function bootWithReplies(table: Record<string, unknown>): Promise<void> {
  harness = installChromeMock();
  harness.sendMessage.mockImplementation(async (m: unknown) => {
    const kind = (m as { kind?: string }).kind ?? "";
    return kind in table ? table[kind] : unpaired;
  });
  document.body.innerHTML = `${FIXTURE}<section id="stage-briefs"><button id="open-brief" type="button">Open</button><div id="brief-log"></div></section>`;
  document.dispatchEvent(new Event("DOMContentLoaded"));
  await flush();
}

describe("discover()", () => {
  test("fills the gateway URL field with what the worker found", async () => {
    // The whole point of the button: the user should not have to know the port.
    await bootWithReplies({ discover: { kind: "discover", origin: "http://127.0.0.1:7474" } });
    input("origin").value = "";

    button("discover").click();
    await flush();

    expect(input("origin").value).toBe("http://127.0.0.1:7474");
    expect(el("discover-status").textContent).toContain("http://127.0.0.1:7474");
  });

  test("a miss leaves the field alone and says where to go instead", async () => {
    // Overwriting a URL the user typed with nothing would destroy their input
    // to report a failure.
    await bootWithReplies({ discover: { kind: "discover", origin: null } });
    input("origin").value = "http://127.0.0.1:9999";

    button("discover").click();
    await flush();

    expect(input("origin").value).toBe("http://127.0.0.1:9999");
    expect(el("discover-status").textContent).toContain("No gateway found");
  });

  test("a reply for a DIFFERENT request is never read as a discovery", async () => {
    // `sendMessage` is typed `unknown` at the seam, so a stale or mismatched
    // reply must not reach `res.origin` — which on a connection reply is the
    // paired gateway, i.e. exactly the wrong answer rendered confidently.
    await bootWithReplies({
      discover: { kind: "connection", paired: true, origin: "http://evil" },
    });
    input("origin").value = "";

    button("discover").click();
    await flush();

    expect(input("origin").value).toBe("");
    expect(el("discover-status").textContent).toBe("Unexpected response.");
  });

  test("a rejected message channel recovers the status rather than sticking on Looking…", async () => {
    harness = installChromeMock();
    harness.sendMessage.mockImplementation(async (m: unknown) => {
      if ((m as { kind?: string }).kind === "discover") {
        throw new Error("worker asleep");
      }
      return unpaired;
    });
    await bootOptions();

    button("discover").click();
    await flush();

    expect(el("discover-status").textContent).toContain("Couldn't reach the extension");
  });
});

describe("the disclosure log panel", () => {
  const entry = {
    runId: "r1",
    at: Date.UTC(2026, 5, 27, 12, 0, 0),
    question: "what changed in auth",
    sourceCount: 2,
    truncatedCount: 0,
    model: "llama3",
    remote: false,
  };

  test("renders the entries the worker holds", async () => {
    await bootWithReplies({ "brief-log": { kind: "brief-log", entries: [entry] } });
    expect(el("brief-log").textContent).toContain("what changed in auth");
  });

  test("drops an entry that fails the guard rather than rendering a half-entry", async () => {
    // Storage is external input. A malformed entry rendered as blanks would
    // claim an egress happened without saying what left.
    await bootWithReplies({
      "brief-log": { kind: "brief-log", entries: [entry, { runId: 7 }, null] },
    });
    expect(el("brief-log").querySelectorAll(".brief-log li")).toHaveLength(1);
  });

  test("a reply with no entries array renders the empty state, not a crash", async () => {
    await bootWithReplies({ "brief-log": { kind: "brief-log" } });
    expect(el("brief-log").textContent).toContain("No research briefs have been run");
  });

  test("a rejected read leaves the section as it was", async () => {
    // On a failed read the section must not claim nothing has ever been sent —
    // which would be the one wrong thing to say here.
    harness = installChromeMock();
    harness.sendMessage.mockImplementation(async (m: unknown) => {
      if ((m as { kind?: string }).kind === "brief-log") {
        throw new Error("worker asleep");
      }
      return unpaired;
    });
    document.body.innerHTML = `${FIXTURE}<div id="brief-log">held over</div>`;
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush();

    expect(el("brief-log").textContent).toBe("held over");
  });

  test("Clear empties the list through the worker, then repaints from it", async () => {
    let cleared = false;
    harness = installChromeMock();
    harness.sendMessage.mockImplementation(async (m: unknown) => {
      const kind = (m as { kind?: string }).kind;
      if (kind === "brief-log-clear") {
        cleared = true;
        return { kind: "brief-log-clear", ok: true };
      }
      if (kind === "brief-log") {
        return { kind: "brief-log", entries: cleared ? [] : [entry] };
      }
      return unpaired;
    });
    document.body.innerHTML = `${FIXTURE}<div id="brief-log"></div>`;
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush();
    expect(el("brief-log").textContent).toContain("what changed in auth");

    button("clear-brief-log").click();
    await flush();

    expect(cleared).toBe(true);
    expect(el("brief-log").textContent).toContain("No research briefs have been run");
  });

  test("a failed clear still repaints from whatever the worker holds", async () => {
    harness = installChromeMock();
    harness.sendMessage.mockImplementation(async (m: unknown) => {
      const kind = (m as { kind?: string }).kind;
      if (kind === "brief-log-clear") {
        throw new Error("worker asleep");
      }
      if (kind === "brief-log") {
        return { kind: "brief-log", entries: [entry] };
      }
      return unpaired;
    });
    document.body.innerHTML = `${FIXTURE}<div id="brief-log"></div>`;
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await flush();

    const readsBefore = harness.sendMessage.mock.calls.filter(
      (c) => (c[0] as { kind?: string }).kind === "brief-log",
    ).length;

    button("clear-brief-log").click();
    await flush();

    // The repaint is what proves the failure did not abandon the panel: the
    // entry still being on screen would also be true of a handler that did
    // nothing at all.
    const readsAfter = harness.sendMessage.mock.calls.filter(
      (c) => (c[0] as { kind?: string }).kind === "brief-log",
    ).length;
    expect(readsAfter).toBeGreaterThan(readsBefore);
    expect(el("brief-log").textContent).toContain("what changed in auth");
  });
});
