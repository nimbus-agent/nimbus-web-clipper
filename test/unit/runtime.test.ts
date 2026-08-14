// test/unit/runtime.test.ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addCommandListener } from "../../src/browser/commands.ts";
import {
  addInstalledListener,
  addMessageListener,
  sendMessage,
} from "../../src/browser/runtime.ts";
import type { ExtensionRequest } from "../../src/shared/messages.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

let harness: ChromeHarness;

beforeEach(() => {
  harness = installChromeMock();
});

afterEach(() => {
  harness.restore();
});

describe("browser/runtime seam", () => {
  test("sendMessage forwards the request to chrome.runtime and returns the response", async () => {
    harness.sendMessage.mockResolvedValue({ ok: true });
    const req = { kind: "clip" } as unknown as ExtensionRequest;

    const res = await sendMessage(req);

    expect(harness.sendMessage).toHaveBeenCalledWith(req);
    expect(res).toEqual({ ok: true });
  });

  test("addMessageListener hands the handler the message and a respond callback", async () => {
    addMessageListener((message, respond) => {
      respond({ echo: message });
      return true;
    });

    const response = await harness.emitMessage({ kind: "ping" });

    expect(response).toEqual({ echo: { kind: "ping" } });
  });

  // The `cue-open` route reads its tab from the BROWSER's sender, never the
  // message payload — see CueOpenRequest's doc comment. That is only safe
  // because THIS seam forwards the sender's own tab id, not anything forgeable
  // by the page. Both halves of that contract need a case: a message that came
  // from a tab, and one that (like the popup or options page) did not.
  test("addMessageListener forwards { tabId: 7 } when the message came from tab 7", async () => {
    let received: { readonly tabId?: number } | undefined;
    addMessageListener((message, respond, sender) => {
      received = sender;
      respond({ echo: message });
      return true;
    });

    await harness.emitMessageFromTab({ kind: "cue-open" }, 7);

    expect(received).toEqual({ tabId: 7 });
  });

  test("addMessageListener forwards { tabId: undefined } for a popup/options message (no sender.tab)", async () => {
    let received: { readonly tabId?: number } | undefined;
    addMessageListener((message, respond, sender) => {
      received = sender;
      respond({ echo: message });
      return true;
    });

    await harness.emitMessage({ kind: "ping" });

    // toStrictEqual, not toEqual: the conditional-spread in addMessageListener
    // must produce `{}` (the key ABSENT) here, not `{ tabId: undefined }` (the
    // key present with an explicit undefined) — toEqual treats those as equal
    // and would not catch a regression to the latter.
    expect(received).toStrictEqual({});
  });

  test("addCommandListener forwards keyboard commands", () => {
    let received = "";
    addCommandListener((command) => {
      received = command;
    });

    harness.emitCommand("clip-page");

    expect(received).toBe("clip-page");
  });

  test("addInstalledListener is invoked on runtime.onInstalled", () => {
    let installedCount = 0;
    addInstalledListener(() => {
      installedCount += 1;
    });

    harness.emitInstalled();

    expect(installedCount).toBe(1);
  });
});
