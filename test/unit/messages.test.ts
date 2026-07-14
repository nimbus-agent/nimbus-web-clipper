import { describe, expect, test } from "vitest";
import {
  isClipRequest,
  isPairRequest,
  isPingMessage,
  isQueueListRequest,
  isQueueRemoveRequest,
  isQueueResponse,
  isQueueRetryRequest,
  isRelatedRequest,
  isRelatedResponse,
} from "../../src/shared/messages.ts";

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

describe("isRelatedRequest", () => {
  test("accepts a related request with all/optional fields", () => {
    expect(
      isRelatedRequest({ kind: "related", title: "T", canonicalUrl: "u", selection: "s" }),
    ).toBe(true);
    expect(isRelatedRequest({ kind: "related" })).toBe(true);
  });
  test("rejects wrong kind, non-string fields, and non-objects", () => {
    expect(isRelatedRequest({ kind: "clip" })).toBe(false);
    expect(isRelatedRequest({ kind: "related", title: 1 })).toBe(false);
    expect(isRelatedRequest(null)).toBe(false);
  });
});

describe("isRelatedResponse", () => {
  const hit = { id: "1", title: "T", service: "gmail", snippet: "s", url: null };
  test("accepts ok with a RelatedHit[] and a failure with a reason", () => {
    expect(isRelatedResponse({ kind: "related", ok: true, items: [hit] })).toBe(true);
    expect(isRelatedResponse({ kind: "related", ok: false, reason: "not_paired" })).toBe(true);
  });
  test("rejects malformed items, wrong kind, and missing ok", () => {
    expect(isRelatedResponse({ kind: "related", ok: true, items: [{ id: 1 }] })).toBe(false);
    expect(isRelatedResponse({ kind: "clip", ok: true, items: [] })).toBe(false);
    expect(isRelatedResponse({ kind: "related" })).toBe(false);
  });
});

describe("queue request guards", () => {
  test("accept their kinds and the optional/required url", () => {
    expect(isQueueListRequest({ kind: "queue-list" })).toBe(true);
    expect(isQueueRetryRequest({ kind: "queue-retry" })).toBe(true);
    expect(isQueueRetryRequest({ kind: "queue-retry", url: "u" })).toBe(true);
    expect(isQueueRemoveRequest({ kind: "queue-remove", url: "u" })).toBe(true);
  });
  test("reject wrong kinds, bad url types, and a remove without a url", () => {
    expect(isQueueListRequest({ kind: "clip" })).toBe(false);
    expect(isQueueRetryRequest({ kind: "queue-retry", url: 1 })).toBe(false);
    expect(isQueueRemoveRequest({ kind: "queue-remove" })).toBe(false);
  });
});

describe("isQueueResponse", () => {
  const view = { url: "u", title: "T", queuedAt: 1, attempts: 0 };
  test("accepts a well-formed view list", () => {
    expect(isQueueResponse({ kind: "queue", items: [view] })).toBe(true);
    expect(isQueueResponse({ kind: "queue", items: [] })).toBe(true);
  });
  test("rejects malformed items and the wrong kind", () => {
    expect(isQueueResponse({ kind: "queue", items: [{ url: 1 }] })).toBe(false);
    expect(isQueueResponse({ kind: "clip", items: [] })).toBe(false);
  });
});
