import { describe, expect, test } from "vitest";
import { isPingMessage } from "../../src/shared/messages.ts";

describe("isPingMessage", () => {
  test("accepts a well-formed ping", () => {
    expect(isPingMessage({ kind: "ping" })).toBe(true);
  });

  test("rejects other shapes and non-objects", () => {
    expect(isPingMessage({ kind: "clip" })).toBe(false);
    expect(isPingMessage(null)).toBe(false);
    expect(isPingMessage("ping")).toBe(false);
    expect(isPingMessage(undefined)).toBe(false);
  });
});
