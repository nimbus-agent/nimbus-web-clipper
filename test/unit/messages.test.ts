import { describe, expect, test } from "vitest";
import { isClipRequest, isPairRequest, isPingMessage } from "../../src/shared/messages.ts";

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

describe("isPairRequest", () => {
  test("accepts a well-formed pair request", () => {
    expect(isPairRequest({ kind: "pair", origin: "http://127.0.0.1:8765", code: "429173" })).toBe(
      true,
    );
  });
  test("rejects wrong kind / missing fields / non-object", () => {
    expect(isPairRequest({ kind: "clip" })).toBe(false);
    expect(isPairRequest({ kind: "pair", origin: "x" })).toBe(false);
    expect(isPairRequest(null)).toBe(false);
  });
});

describe("isClipRequest", () => {
  const capture = {
    url: "https://ex.com",
    title: "T",
    mode: "article",
    body: "b",
    readableFound: true,
  };
  test("accepts a well-formed clip request", () => {
    expect(isClipRequest({ kind: "clip", capture, tags: ["a"] })).toBe(true);
  });
  test("rejects bad tags / missing capture / non-object", () => {
    expect(isClipRequest({ kind: "clip", capture, tags: "a" })).toBe(false);
    expect(isClipRequest({ kind: "clip", tags: [] })).toBe(false);
    expect(isClipRequest("clip")).toBe(false);
  });
  test("rejects a capture whose optional canonicalUrl is present but not a string", () => {
    expect(
      isClipRequest({ kind: "clip", capture: { ...capture, canonicalUrl: 123 }, tags: [] }),
    ).toBe(false);
  });
});
