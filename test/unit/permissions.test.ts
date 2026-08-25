// test/unit/permissions.test.ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hasOrigin, removeOrigin, requestOrigin } from "../../src/browser/permissions.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

let harness: ChromeHarness;

beforeEach(() => {
  harness = installChromeMock();
});

afterEach(() => {
  harness.restore();
});

describe("permissions seam", () => {
  test("an ungranted pattern is absent", async () => {
    await expect(hasOrigin("https://corp.example/*")).resolves.toBe(false);
  });
  test("request grants, and the grant is then visible", async () => {
    await expect(requestOrigin("https://corp.example/*")).resolves.toBe(true);
    expect(harness.permissionsRequest).toHaveBeenCalledWith({
      origins: ["https://corp.example/*"],
    });
    await expect(hasOrigin("https://corp.example/*")).resolves.toBe(true);
  });
  test("remove revokes", async () => {
    await requestOrigin("https://corp.example/*");
    await expect(removeOrigin("https://corp.example/*")).resolves.toBe(true);
    await expect(hasOrigin("https://corp.example/*")).resolves.toBe(false);
  });
  test("a rejected request resolves false rather than throwing", async () => {
    harness.permissionsRequest.mockRejectedValueOnce(new Error("user gesture required"));
    await expect(requestOrigin("https://corp.example/*")).resolves.toBe(false);
  });
  test("a rejected remove resolves false rather than throwing", async () => {
    // Revocation is offered from a row in Options. Firefox rejects
    // `permissions.remove` for a pattern it considers required, and the row's
    // click handler is `void`-ed — an escaping rejection would surface as an
    // unhandled rejection rather than a false the row can render.
    harness.permissionsRemove.mockRejectedValueOnce(new Error("cannot be removed"));
    await expect(removeOrigin("https://corp.example/*")).resolves.toBe(false);
  });
});
