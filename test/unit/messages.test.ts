import { describe, expect, it, test } from "vitest";
import {
  isAgentRunRequest,
  isAgentStateRequest,
  isAgentStateResponse,
  isClipRequest,
  isConnectionResponse,
  isConnectionStatusRequest,
  isFetchResponse,
  isPairRequest,
  isPingMessage,
  isQueueListRequest,
  isQueueRemoveRequest,
  isQueueResponse,
  isQueueRetryRequest,
  isRelatedRequest,
  isRelatedResponse,
  isResolveRequest,
  isResolveResponse,
  isUnpairRequest,
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

describe("connection request guards", () => {
  test("accept their kinds", () => {
    expect(isConnectionStatusRequest({ kind: "connection-status" })).toBe(true);
    expect(isUnpairRequest({ kind: "unpair" })).toBe(true);
  });
  test("reject wrong kinds and non-objects", () => {
    expect(isConnectionStatusRequest({ kind: "unpair" })).toBe(false);
    expect(isUnpairRequest({ kind: "connection-status" })).toBe(false);
    expect(isConnectionStatusRequest(null)).toBe(false);
  });
});

describe("isConnectionResponse", () => {
  test("accepts not-paired and a well-formed paired response", () => {
    expect(isConnectionResponse({ kind: "connection", paired: false })).toBe(true);
    expect(
      isConnectionResponse({
        kind: "connection",
        paired: true,
        label: "chrome",
        origin: "http://127.0.0.1:8765",
        pairedAt: 1,
      }),
    ).toBe(true);
  });
  test("rejects a paired response missing fields, the wrong kind, and a missing paired flag", () => {
    expect(isConnectionResponse({ kind: "connection", paired: true, label: "c" })).toBe(false);
    expect(isConnectionResponse({ kind: "clip", paired: false })).toBe(false);
    expect(isConnectionResponse({ kind: "connection" })).toBe(false);
  });
});

describe("resolve guards", () => {
  test("isResolveRequest accepts a well-formed request", () => {
    expect(isResolveRequest({ kind: "resolve", pageUrl: "https://x/y" })).toBe(true);
  });
  test("isResolveRequest rejects a missing pageUrl", () => {
    expect(isResolveRequest({ kind: "resolve" })).toBe(false);
  });
});

describe("isResolveResponse", () => {
  const recognition = {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref: "a/b #1",
    resolveUrl: "https://github.com/a/b/pull/1",
  };

  it("accepts a found outcome", () => {
    expect(
      isResolveResponse({
        kind: "resolve",
        ok: true,
        recognition,
        outcome: {
          kind: "found",
          matchKind: "path_trimmed",
          item: { id: "i", service: "s", type: "t", title: "T", url: null, modifiedAt: 5 },
        },
      }),
    ).toBe(true);
  });

  it("accepts every non-found outcome", () => {
    const outcomes = [
      { kind: "not-indexed", fetchable: true },
      { kind: "unresolvable", fetchable: false },
      {
        kind: "ambiguous",
        fetchable: false,
        truncated: false,
        candidates: [{ id: "a", service: "jira", type: "issue", title: "One", url: null }],
      },
    ];
    for (const outcome of outcomes) {
      expect(isResolveResponse({ kind: "resolve", ok: true, recognition, outcome })).toBe(true);
    }
  });

  it("accepts a failure arm and keeps the recognition", () => {
    expect(
      isResolveResponse({
        kind: "resolve",
        ok: false,
        recognition,
        reason: "insufficient_scope",
      }),
    ).toBe(true);
  });

  it("accepts a failure arm carrying a well-formed scopeGap", () => {
    expect(
      isResolveResponse({
        kind: "resolve",
        ok: false,
        recognition,
        reason: "insufficient_scope",
        scopeGap: { label: "chrome", required: "resolve", granted: ["clip", "briefs"] },
      }),
    ).toBe(true);
  });

  it("rejects a failure arm carrying a malformed scopeGap", () => {
    for (const scopeGap of [
      { label: "chrome", required: "resolve" }, // missing granted
      { label: "chrome", required: "resolve", granted: [1, 2] }, // non-string granted
      { required: "resolve", granted: [] }, // missing label
      "chrome",
    ]) {
      expect(
        isResolveResponse({
          kind: "resolve",
          ok: false,
          recognition,
          reason: "insufficient_scope",
          scopeGap,
        }),
      ).toBe(false);
    }
  });

  it("rejects an item missing modifiedAt, an unknown outcome kind, and a bad candidate", () => {
    for (const outcome of [
      {
        kind: "found",
        matchKind: "exact",
        item: { id: "i", service: "s", type: "t", title: "T", url: null },
      },
      {
        kind: "found",
        matchKind: "guessed",
        item: { id: "i", service: "s", type: "t", title: "T", url: null, modifiedAt: 5 },
      },
      { kind: "elsewhere", fetchable: true },
      {
        kind: "ambiguous",
        fetchable: false,
        truncated: false,
        candidates: [{ id: "a" }],
      },
    ]) {
      expect(isResolveResponse({ kind: "resolve", ok: true, recognition, outcome })).toBe(false);
    }
  });
});

describe("isFetchResponse", () => {
  const recognition = {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref: "a/b #1",
    resolveUrl: "https://github.com/a/b/pull/1",
  };

  it("accepts each outcome", () => {
    for (const outcome of [
      { kind: "indexed", itemId: "i1" },
      { kind: "unfetchable" },
      { kind: "not-configured" },
      { kind: "rate-limited" },
    ]) {
      expect(isFetchResponse({ kind: "fetch", ok: true, recognition, outcome })).toBe(true);
    }
  });

  it("rejects indexed without an itemId and an unknown kind", () => {
    for (const outcome of [{ kind: "indexed" }, { kind: "elsewhere" }]) {
      expect(isFetchResponse({ kind: "fetch", ok: true, recognition, outcome })).toBe(false);
    }
  });

  it("accepts a failure arm with a scope gap", () => {
    expect(
      isFetchResponse({
        kind: "fetch",
        ok: false,
        recognition,
        reason: "insufficient_scope",
        scopeGap: { label: "chrome", required: "fetch", granted: ["clip"] },
      }),
    ).toBe(true);
  });
});

describe("agent-lane guards", () => {
  test("isAgentRunRequest accepts a well-formed request", () => {
    expect(isAgentRunRequest({ kind: "agent-run", lane: "impact", pageUrl: "https://x/y" })).toBe(
      true,
    );
  });
  test("isAgentRunRequest rejects an unknown lane", () => {
    expect(isAgentRunRequest({ kind: "agent-run", lane: "why", pageUrl: "https://x/y" })).toBe(
      false,
    );
  });
  test("isAgentRunRequest rejects a missing pageUrl", () => {
    expect(isAgentRunRequest({ kind: "agent-run", lane: "expert" })).toBe(false);
  });

  test("isAgentStateRequest accepts a well-formed request", () => {
    expect(
      isAgentStateRequest({ kind: "agent-state", lane: "expert", pageUrl: "https://x/y" }),
    ).toBe(true);
  });
  test("isAgentStateRequest rejects an unknown lane", () => {
    expect(isAgentStateRequest({ kind: "agent-state", lane: "why", pageUrl: "https://x/y" })).toBe(
      false,
    );
  });

  describe("isAgentStateResponse", () => {
    it("accepts every LaneState arm", () => {
      const states = [
        { kind: "collapsed" },
        { kind: "running", runId: "r1" },
        { kind: "done", brief: "b" },
        { kind: "failed", reason: "stale" },
      ];
      for (const state of states) {
        expect(isAgentStateResponse({ kind: "agent-state", lane: "impact", state })).toBe(true);
      }
    });

    it("rejects a running/done state missing its required field", () => {
      for (const state of [{ kind: "running" }, { kind: "done" }]) {
        expect(isAgentStateResponse({ kind: "agent-state", lane: "impact", state })).toBe(false);
      }
    });

    it("rejects an unknown lane or an unknown state kind", () => {
      expect(
        isAgentStateResponse({ kind: "agent-state", lane: "why", state: { kind: "collapsed" } }),
      ).toBe(false);
      expect(
        isAgentStateResponse({
          kind: "agent-state",
          lane: "impact",
          state: { kind: "elsewhere" },
        }),
      ).toBe(false);
    });
  });
});
