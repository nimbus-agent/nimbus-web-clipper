// test/unit/runtime.test.ts
import { afterEach, describe, expect, test } from "vitest";
import { addCommandListener, addMessageListener, sendMessage } from "../../src/browser/runtime.ts";
import type { ExtensionRequest } from "../../src/shared/messages.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

let harness: ChromeHarness;

afterEach(() => {
  harness.restore();
});

describe("browser/runtime seam", () => {
  test("sendMessage forwards the request to chrome.runtime and returns the response", async () => {
    harness = installChromeMock();
    harness.sendMessage.mockResolvedValue({ ok: true });
    const req = { kind: "clip" } as unknown as ExtensionRequest;

    const res = await sendMessage(req);

    expect(harness.sendMessage).toHaveBeenCalledWith(req);
    expect(res).toEqual({ ok: true });
  });

  test("addMessageListener hands the handler the message and a respond callback", async () => {
    harness = installChromeMock();
    addMessageListener((message, respond) => {
      respond({ echo: message });
      return true;
    });

    const response = await harness.emitMessage({ kind: "ping" });

    expect(response).toEqual({ echo: { kind: "ping" } });
  });

  test("addCommandListener forwards keyboard commands", () => {
    harness = installChromeMock();
    let received = "";
    addCommandListener((command) => {
      received = command;
    });

    harness.emitCommand("clip-page");

    expect(received).toBe("clip-page");
  });
});
