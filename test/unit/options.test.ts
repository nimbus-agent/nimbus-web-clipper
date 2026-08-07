// @vitest-environment jsdom
// test/unit/options.test.ts
import { afterEach, describe, expect, test, vi } from "vitest";
import "../../src/options/options.ts";
import type { ConnectionResponse, PairResponse } from "../../src/shared/messages.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

// Mirrors src/options/options.html's element ids.
const FIXTURE = `
  <section id="pairing-section">
    <input id="origin" type="text" />
    <input id="code" type="text" />
    <button id="pair" type="button">Pair this browser</button>
    <output id="pairing-status"></output>
  </section>
  <section id="connection-section" hidden>
    <output id="connection-status"></output>
    <button id="unpair" type="button">Unpair this browser</button>
    <button id="unpair-cancel" type="button" hidden>Cancel</button>
  </section>
  <section id="surfaces-section">
    <input id="surface-origin" type="text" />
    <select id="surface-product">
      <option value="jenkins">Jenkins</option>
      <option value="jira">Jira</option>
    </select>
    <button id="surface-add" type="button">Add surface</button>
    <output id="surface-status"></output>
    <div id="surface-list"></div>
  </section>
`;

const unpaired: ConnectionResponse = { kind: "connection", paired: false };
const paired: ConnectionResponse = {
  kind: "connection",
  paired: true,
  label: "MacBook",
  origin: "http://127.0.0.1:7474",
  pairedAt: Date.UTC(2026, 5, 27, 12, 0, 0),
};

let harness: ChromeHarness;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

/** Installs the chrome mock, seeds the fixture DOM, and fires DOMContentLoaded. */
async function boot(initialConnection: unknown = unpaired): Promise<void> {
  harness = installChromeMock();
  harness.sendMessage.mockResolvedValue(initialConnection);
  document.body.innerHTML = FIXTURE;
  document.dispatchEvent(new Event("DOMContentLoaded"));
  await flush();
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
  test("unpaired: shows the pairing section, hides the connection section", async () => {
    await boot(unpaired);

    expect(harness.sendMessage).toHaveBeenCalledWith({ kind: "connection-status" });
    expect(el("connection-section").hidden).toBe(true);
    expect(el("pairing-section").hidden).toBe(false);
  });

  test("paired: shows the connection section with label/origin/paired-since", async () => {
    await boot(paired);

    expect(el("connection-section").hidden).toBe(false);
    expect(el("pairing-section").hidden).toBe(true);
    expect(el("connection-status").textContent).toBe(
      'Paired as "MacBook" to http://127.0.0.1:7474, since Jun 27, 2026.',
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
    expect(el("connection-section").hidden).toBe(false);
    expect(el("pairing-section").hidden).toBe(true);
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
    expect(el("connection-section").hidden).toBe(true);
    expect(el("pairing-section").hidden).toBe(false);
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
    expect(el("connection-section").hidden).toBe(false);
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

    el("surface-list").querySelector<HTMLButtonElement>("button[data-action='grant']")?.click();
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
    el("surface-list").querySelector<HTMLButtonElement>("button[data-action='grant']")?.click();
    await flush();

    harness.permissionsRemove.mockResolvedValueOnce(false);
    el("surface-list").querySelector<HTMLButtonElement>("button[data-action='revoke']")?.click();
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
