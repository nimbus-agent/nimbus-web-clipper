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
  </section>
  <section id="stage-sites">
    <input id="surface-origin" type="text" />
    <select id="surface-product">
      <option value="jenkins">Jenkins</option>
      <option value="jira">Jira</option>
    </select>
    <button id="surface-add" type="button">Add surface</button>
    <output id="surface-status"></output>
    <div id="surface-list"></div>
  </section>
  <section id="stage-trust">
    <span id="trust-origin"></span>
    <span id="trust-hosts"></span>
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

  test("the trust panel describes what clipping actually sends — no payload preview promise", () => {
    expect(html).toContain(
      "sends the page's title, URL, and the extracted article or selected text",
    );
    expect(html).not.toContain("shows you the whole payload first");
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
