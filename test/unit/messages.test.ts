import { describe, expect, it, test } from "vitest";
import { BRIEF_CAPS } from "../../src/shared/brief.ts";
import type { CueOpenRequest } from "../../src/shared/messages.ts";
import {
  isAgentRunRequest,
  isAgentStateRequest,
  isAgentStateResponse,
  isBriefStartRequest,
  isCaptureRequest,
  isCaptureResponse,
  isClipRequest,
  isConnectionResponse,
  isConnectionStatusRequest,
  isCueOpenRequest,
  isFetchResponse,
  isPairRequest,
  isPassageClearRequest,
  isPassageDropRequest,
  isPingMessage,
  isQueueListRequest,
  isQueueRemoveRequest,
  isQueueResponse,
  isQueueRetryRequest,
  isRecogniseRequest,
  isRecognitionResponse,
  isRelatedRequest,
  isRelatedResponse,
  isResolveRequest,
  isResolveResponse,
  isUnpairRequest,
} from "../../src/shared/messages.ts";
import { AGENT_LANES } from "../../src/shared/types.ts";

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

describe("isCaptureRequest", () => {
  test("isCaptureRequest accepts a pageUrl and rejects a missing or non-string one", () => {
    expect(isCaptureRequest({ kind: "capture", pageUrl: "https://x.test/a" })).toBe(true);
    expect(isCaptureRequest({ kind: "capture" })).toBe(false);
    expect(isCaptureRequest({ kind: "capture", pageUrl: 7 })).toBe(false);
    expect(isCaptureRequest({ kind: "clip", pageUrl: "https://x.test/a" })).toBe(false);
  });
});

describe("isCaptureResponse", () => {
  test("isCaptureResponse accepts both arms and a null preview", () => {
    const capture = {
      url: "https://x.test/a",
      title: "T",
      mode: "article",
      body: "b",
      readableFound: true,
    };
    expect(isCaptureResponse({ kind: "capture", ok: true, capture, preview: null })).toBe(true);
    expect(
      isCaptureResponse({
        kind: "capture",
        ok: true,
        capture,
        preview: { fields: [], excerpt: "b", bodyLength: 1, truncated: false },
      }),
    ).toBe(true);
    expect(isCaptureResponse({ kind: "capture", ok: false, reason: "url-changed" })).toBe(true);
  });

  test("isCaptureResponse rejects a success arm with no capture", () => {
    expect(isCaptureResponse({ kind: "capture", ok: true, preview: null })).toBe(false);
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
  test("a capture carrying a canonical rejection still round-trips the guard", () => {
    expect(
      isClipRequest({
        kind: "clip",
        capture: {
          url: "https://example.com/blog/post-5",
          title: "Post 5",
          mode: "article",
          body: "text",
          readableFound: true,
          canonicalRejected: "root-collapse",
        },
        tags: [],
      }),
    ).toBe(true);
  });
  test("a non-string canonicalRejected is refused", () => {
    expect(
      isClipRequest({
        kind: "clip",
        capture: {
          url: "https://example.com/p",
          title: "P",
          mode: "article",
          body: "text",
          readableFound: true,
          canonicalRejected: 7,
        },
        tags: [],
      }),
    ).toBe(false);
  });
  test("a string canonicalRejected that isn't a valid reason is refused", () => {
    expect(
      isClipRequest({
        kind: "clip",
        capture: {
          url: "https://example.com/p",
          title: "P",
          mode: "article",
          body: "text",
          readableFound: true,
          canonicalRejected: "nonsense",
        },
        tags: [],
      }),
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
  test("isRelatedRequest accepts an itemId and rejects a non-string one", () => {
    expect(isRelatedRequest({ kind: "related", itemId: "gh:1" })).toBe(true);
    expect(isRelatedRequest({ kind: "related" })).toBe(true);
    expect(isRelatedRequest({ kind: "related", itemId: 7 })).toBe(false);
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
        queueDepth: 0,
        reachable: true,
        stale: false,
      }),
    ).toBe(true);
  });
  test("rejects a paired response missing fields, the wrong kind, and a missing paired flag", () => {
    expect(isConnectionResponse({ kind: "connection", paired: true, label: "c" })).toBe(false);
    expect(isConnectionResponse({ kind: "clip", paired: false })).toBe(false);
    expect(isConnectionResponse({ kind: "connection" })).toBe(false);
  });
});

describe("recognise message guards", () => {
  it("accepts a well-formed request and rejects a malformed one", () => {
    expect(isRecogniseRequest({ kind: "recognise", pageUrl: "https://x.test/" })).toBe(true);
    expect(isRecogniseRequest({ kind: "recognise" })).toBe(false);
    expect(isRecogniseRequest({ kind: "recognise", pageUrl: 42 })).toBe(false);
    expect(isRecogniseRequest({ kind: "resolve", pageUrl: "https://x.test/" })).toBe(false);
  });

  it("accepts an ok:true response carrying either arm of the recognition", () => {
    expect(
      isRecognitionResponse({
        kind: "recognition",
        ok: true,
        recognition: {
          ok: true,
          product: "github",
          kind: "pr",
          label: "GitHub PR",
          ref: "acme/web #482",
          resolveUrl: "https://github.com/acme/web/pull/482",
        },
      }),
    ).toBe(true);
    expect(
      isRecognitionResponse({
        kind: "recognition",
        ok: true,
        recognition: { ok: false, reason: "unknown-host" },
      }),
    ).toBe(true);
  });

  it("accepts the ok:false storage-failure arm", () => {
    expect(isRecognitionResponse({ kind: "recognition", ok: false, reason: "server_error" })).toBe(
      true,
    );
  });

  it("rejects a malformed response on either arm", () => {
    expect(isRecognitionResponse({ kind: "recognition" })).toBe(false);
    // ok:true with a malformed (or missing) recognition.
    expect(
      isRecognitionResponse({ kind: "recognition", ok: true, recognition: { ok: true } }),
    ).toBe(false);
    expect(isRecognitionResponse({ kind: "recognition", ok: true })).toBe(false);
    // ok:false with no reason.
    expect(isRecognitionResponse({ kind: "recognition", ok: false })).toBe(false);
    expect(
      isRecognitionResponse({
        kind: "resolve",
        ok: true,
        recognition: { ok: false, reason: "x" },
      }),
    ).toBe(false);
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
    expect(
      isAgentRunRequest({ kind: "agent-run", lane: "not-a-lane", pageUrl: "https://x/y" }),
    ).toBe(false);
  });
  test("isAgentRunRequest rejects a missing pageUrl", () => {
    expect(isAgentRunRequest({ kind: "agent-run", lane: "expert" })).toBe(false);
  });
  // The guard reads `AGENT_LANES` at runtime rather than a hand-rolled list
  // (see `isAgentLane`, messages.ts), so it widens automatically the moment a
  // lane is added to that table — this pins the property, rather than one
  // member's name, so the next lane's fixture cannot rot silently the way
  // `"why"` briefly did as this suite's stand-in for an UNKNOWN lane.
  test("isAgentRunRequest accepts every AGENT_LANES member", () => {
    for (const lane of AGENT_LANES) {
      expect(isAgentRunRequest({ kind: "agent-run", lane, pageUrl: "https://x/y" })).toBe(true);
    }
  });

  test("isAgentStateRequest accepts a well-formed request", () => {
    expect(
      isAgentStateRequest({ kind: "agent-state", lane: "expert", pageUrl: "https://x/y" }),
    ).toBe(true);
  });
  test("isAgentStateRequest rejects an unknown lane", () => {
    expect(
      isAgentStateRequest({ kind: "agent-state", lane: "not-a-lane", pageUrl: "https://x/y" }),
    ).toBe(false);
  });
  test("isAgentStateRequest accepts every AGENT_LANES member", () => {
    for (const lane of AGENT_LANES) {
      expect(isAgentStateRequest({ kind: "agent-state", lane, pageUrl: "https://x/y" })).toBe(true);
    }
  });

  describe("the optional lane inputs", () => {
    const base = { kind: "agent-run", lane: "impact", pageUrl: "https://x/y" };

    test("accepts a picked item id", () => {
      expect(isAgentRunRequest({ ...base, itemId: "github:42" })).toBe(true);
    });

    // An empty id can only be a bug: it would key a cache entry under nothing.
    test("rejects an empty or non-string item id", () => {
      expect(isAgentRunRequest({ ...base, itemId: "" })).toBe(false);
      expect(isAgentRunRequest({ ...base, itemId: 42 })).toBe(false);
      expect(isAgentRunRequest({ ...base, itemId: null })).toBe(false);
    });

    test("accepts a normalised term", () => {
      expect(isAgentRunRequest({ ...base, lane: "glossary", term: "blast radius" })).toBe(true);
      expect(
        isAgentStateRequest({ kind: "agent-state", lane: "glossary", pageUrl: "u", term: "x" }),
      ).toBe(true);
    });

    // The boundary validates; it must not quietly repair. A guard that accepted
    // a ragged term would be claiming the sender sent something it did not.
    test("rejects a term that is not already in normal form", () => {
      expect(isAgentRunRequest({ ...base, term: "  padded  " })).toBe(false);
      expect(isAgentRunRequest({ ...base, term: "two\nlines" })).toBe(false);
      expect(isAgentRunRequest({ ...base, term: "" })).toBe(false);
    });

    // Refused, not truncated — see shared/term.ts.
    test("rejects a passage", () => {
      expect(isAgentRunRequest({ ...base, term: "x".repeat(129) })).toBe(false);
      expect(isAgentRunRequest({ ...base, term: "x".repeat(128) })).toBe(true);
    });

    // The run and the poll key ONE cache entry, so the poll's guard has to hold
    // the request to exactly the same standard the run's does.
    test("holds agent-state to the same rules as agent-run", () => {
      const poll = { kind: "agent-state", lane: "glossary", pageUrl: "https://x/y" };
      expect(isAgentStateRequest({ ...poll, term: "  padded  " })).toBe(false);
      expect(isAgentStateRequest({ ...poll, itemId: "" })).toBe(false);
    });
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
        isAgentStateResponse({
          kind: "agent-state",
          lane: "not-a-lane",
          state: { kind: "collapsed" },
        }),
      ).toBe(false);
      expect(
        isAgentStateResponse({
          kind: "agent-state",
          lane: "impact",
          state: { kind: "elsewhere" },
        }),
      ).toBe(false);
    });

    it("accepts a failed state carrying a well-formed scopeGap", () => {
      expect(
        isAgentStateResponse({
          kind: "agent-state",
          lane: "impact",
          state: {
            kind: "failed",
            reason: "insufficient_scope",
            scopeGap: { label: "chrome", required: "agents", granted: ["clip", "resolve"] },
          },
        }),
      ).toBe(true);
    });

    it("rejects a failed state carrying a malformed scopeGap", () => {
      for (const scopeGap of [
        { label: "chrome", required: "agents" }, // missing granted
        { label: "chrome", required: "agents", granted: [1, 2] }, // non-string granted
        { required: "agents", granted: [] }, // missing label
        "chrome",
      ]) {
        expect(
          isAgentStateResponse({
            kind: "agent-state",
            lane: "impact",
            state: { kind: "failed", reason: "insufficient_scope", scopeGap },
          }),
        ).toBe(false);
      }
    });

    it("accepts an agent_failed state carrying a string detail, and one with no detail at all", () => {
      expect(
        isAgentStateResponse({
          kind: "agent-state",
          lane: "impact",
          state: { kind: "failed", reason: "agent_failed", detail: "no LLM configured" },
        }),
      ).toBe(true);
      expect(
        isAgentStateResponse({
          kind: "agent-state",
          lane: "impact",
          state: { kind: "failed", reason: "agent_failed" },
        }),
      ).toBe(true);
    });

    it("rejects a failed state carrying a non-string detail", () => {
      expect(
        isAgentStateResponse({
          kind: "agent-state",
          lane: "impact",
          state: { kind: "failed", reason: "agent_failed", detail: 42 },
        }),
      ).toBe(false);
    });

    // Review finding (round 1, IMPORTANT): this guard used to accept ANY
    // string as `reason`, not just a member of `AGENT_ERRORS` — so a reason
    // outside the union could pass validation, fall through every branch of
    // `renderLaneBody`'s `AgentError` if-chain, and hit its exhaustiveness
    // backstop, which returned the raw string where an `HTMLElement` was
    // promised. `isAgentError` (also used by `agent-run-store.ts`'s own
    // storage guard, so there is exactly one copy of this check) closes that.
    it("rejects a failed state whose reason is not a known AgentError", () => {
      expect(
        isAgentStateResponse({
          kind: "agent-state",
          lane: "impact",
          state: { kind: "failed", reason: "not_a_real_reason" },
        }),
      ).toBe(false);
    });
  });
});

describe("isCueOpenRequest", () => {
  test("accepts the envelope the cue sends", () => {
    expect(isCueOpenRequest({ kind: "cue-open" })).toBe(true);
  });

  test("rejects other kinds, non-objects and null", () => {
    expect(isCueOpenRequest({ kind: "resolve", pageUrl: "https://x/" })).toBe(false);
    expect(isCueOpenRequest("cue-open")).toBe(false);
    expect(isCueOpenRequest(null)).toBe(false);
    expect(isCueOpenRequest(undefined)).toBe(false);
  });

  test("carries no page-supplied payload — there is nothing for a hostile page to forge", () => {
    expect(Object.keys({ kind: "cue-open" } satisfies CueOpenRequest)).toEqual(["kind"]);
  });
});

describe("ConnectionResponse health fields", () => {
  test("a full paired response is accepted", () => {
    expect(
      isConnectionResponse({
        kind: "connection",
        paired: true,
        label: "chrome",
        origin: "http://127.0.0.1:7474",
        pairedAt: 1,
        lastClipAt: 2,
        queueDepth: 3,
        reachable: true,
        stale: false,
      }),
    ).toBe(true);
  });

  test("lastClipAt is optional — a fresh pairing has never clipped", () => {
    expect(
      isConnectionResponse({
        kind: "connection",
        paired: true,
        label: "chrome",
        origin: "http://127.0.0.1:7474",
        pairedAt: 1,
        queueDepth: 0,
        reachable: true,
        stale: false,
      }),
    ).toBe(true);
  });

  test("a paired response missing queueDepth is rejected", () => {
    expect(
      isConnectionResponse({
        kind: "connection",
        paired: true,
        label: "chrome",
        origin: "http://127.0.0.1:7474",
        pairedAt: 1,
        reachable: true,
        stale: false,
      }),
    ).toBe(false);
  });

  test("the unpaired arm is unchanged", () => {
    expect(isConnectionResponse({ kind: "connection", paired: false })).toBe(true);
  });
});

describe("isBriefStartRequest", () => {
  it("accepts a well-formed request", () => {
    expect(
      isBriefStartRequest({
        kind: "brief-start",
        question: "q",
        picks: [
          { kind: "tab", id: 1 },
          { kind: "tab", id: 2 },
        ],
        useIndex: false,
      }),
    ).toBe(true);
  });

  it("rejects a non-array picks", () => {
    expect(isBriefStartRequest({ kind: "brief-start", question: "q", picks: 1 })).toBe(false);
  });

  it("rejects an empty picks — a brief needs at least one source", () => {
    expect(isBriefStartRequest({ kind: "brief-start", question: "q", picks: [] })).toBe(false);
  });

  it("rejects a blank question", () => {
    expect(
      isBriefStartRequest({
        kind: "brief-start",
        question: "   ",
        picks: [{ kind: "tab", id: 1 }],
      }),
    ).toBe(false);
  });

  it("rejects the wrong kind", () => {
    expect(
      isBriefStartRequest({ kind: "clip", question: "q", picks: [{ kind: "tab", id: 1 }] }),
    ).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isBriefStartRequest(null)).toBe(false);
    expect(isBriefStartRequest("brief-start")).toBe(false);
  });

  it("accepts a brief-start carrying useIndex", () => {
    expect(
      isBriefStartRequest({
        kind: "brief-start",
        question: "q",
        picks: [{ kind: "tab", id: 1 }],
        useIndex: true,
      }),
    ).toBe(true);
  });

  it("rejects a brief-start whose useIndex is missing or not a boolean", () => {
    const base = { kind: "brief-start", question: "q", picks: [{ kind: "tab", id: 1 }] };
    expect(isBriefStartRequest(base)).toBe(false);
    expect(isBriefStartRequest({ ...base, useIndex: "true" })).toBe(false);
    expect(isBriefStartRequest({ ...base, useIndex: 1 })).toBe(false);
  });

  it("the guard's caps match shared/brief.ts, which is the source of truth", () => {
    // Two literals for one rule drift silently; this is the assertion that stops
    // it. The guard cannot import BRIEF_CAPS without dragging types.ts into the
    // narrowing boundary, so the agreement is checked here instead.
    const tooMany = Array.from({ length: BRIEF_CAPS.maxSources + 1 }, () => ({
      kind: "tab" as const,
      id: 1,
    }));
    const atCap = Array.from({ length: BRIEF_CAPS.maxSources }, () => ({
      kind: "tab" as const,
      id: 1,
    }));
    expect(isBriefStartRequest({ kind: "brief-start", question: "q", picks: tooMany })).toBe(false);
    expect(
      isBriefStartRequest({ kind: "brief-start", question: "q", picks: atCap, useIndex: false }),
    ).toBe(true);
    expect(
      isBriefStartRequest({
        kind: "brief-start",
        question: "q".repeat(BRIEF_CAPS.maxQuestionChars),
        picks: [{ kind: "tab", id: 1 }],
        useIndex: false,
      }),
    ).toBe(true);
    expect(
      isBriefStartRequest({
        kind: "brief-start",
        question: "q".repeat(BRIEF_CAPS.maxQuestionChars + 1),
        picks: [{ kind: "tab", id: 1 }],
      }),
    ).toBe(false);
  });
});

describe("isBriefStartRequest picks", () => {
  const base = { kind: "brief-start", question: "q", useIndex: false };

  test("accepts a mixed, ordered pick list", () => {
    expect(
      isBriefStartRequest({
        ...base,
        picks: [
          { kind: "tab", id: 3 },
          { kind: "passages", url: "http://h/a" },
        ],
      }),
    ).toBe(true);
  });

  test("rejects an empty or over-long list", () => {
    expect(isBriefStartRequest({ ...base, picks: [] })).toBe(false);
    expect(
      isBriefStartRequest({
        ...base,
        picks: Array.from({ length: 21 }, () => ({ kind: "tab", id: 1 })),
      }),
    ).toBe(false);
  });

  test("rejects a kind outside the union", () => {
    expect(isBriefStartRequest({ ...base, picks: [{ kind: "clip", id: 1 }] })).toBe(false);
  });

  test("rejects a non-integer or negative tab id, as tabIds did", () => {
    expect(isBriefStartRequest({ ...base, picks: [{ kind: "tab", id: 1.5 }] })).toBe(false);
    expect(isBriefStartRequest({ ...base, picks: [{ kind: "tab", id: -1 }] })).toBe(false);
    expect(isBriefStartRequest({ ...base, picks: [{ kind: "tab", id: "1" }] })).toBe(false);
  });

  test("rejects a url safeHttpUrl rejects, not merely a non-string", () => {
    expect(isBriefStartRequest({ ...base, picks: [{ kind: "passages", url: 5 }] })).toBe(false);
    expect(
      isBriefStartRequest({ ...base, picks: [{ kind: "passages", url: "javascript:alert(1)" }] }),
    ).toBe(false);
    expect(isBriefStartRequest({ ...base, picks: [{ kind: "passages", url: "not a url" }] })).toBe(
      false,
    );
  });

  test("still rejects a missing or over-long question", () => {
    expect(isBriefStartRequest({ kind: "brief-start", picks: [{ kind: "tab", id: 1 }] })).toBe(
      false,
    );
    expect(
      isBriefStartRequest({
        ...base,
        question: "q".repeat(BRIEF_CAPS.maxQuestionChars + 1),
        picks: [{ kind: "tab", id: 1 }],
      }),
    ).toBe(false);
  });

  // Before `picks`, a request named its tabs as `{tabIds: number[]}`. `picks` is
  // absent from that shape, so it reads as `undefined` and fails the
  // `Array.isArray` check — the old shape is rejected, not silently accepted.
  test("rejects the old {tabIds} shape", () => {
    expect(isBriefStartRequest({ kind: "brief-start", question: "q", tabIds: [1, 2] })).toBe(false);
  });
});

describe("isPassageDropRequest", () => {
  test("accepts a whole-page drop, which carries no `at`", () => {
    expect(isPassageDropRequest({ kind: "passage-drop", url: "http://h/a" })).toBe(true);
  });

  test("accepts one passage, named by its capture instant", () => {
    expect(isPassageDropRequest({ kind: "passage-drop", url: "http://h/a", at: 100 })).toBe(true);
  });

  test("rejects a url safeHttpUrl rejects, not merely a non-string", () => {
    expect(isPassageDropRequest({ kind: "passage-drop", url: 5 })).toBe(false);
    expect(isPassageDropRequest({ kind: "passage-drop", url: "javascript:alert(1)" })).toBe(false);
    expect(isPassageDropRequest({ kind: "passage-drop", url: "not a url" })).toBe(false);
  });

  test("rejects a non-integer `at` rather than letting it match nothing", () => {
    expect(isPassageDropRequest({ kind: "passage-drop", url: "http://h/a", at: 1.5 })).toBe(false);
    expect(isPassageDropRequest({ kind: "passage-drop", url: "http://h/a", at: "100" })).toBe(
      false,
    );
    expect(isPassageDropRequest({ kind: "passage-drop", url: "http://h/a", at: null })).toBe(false);
  });

  test("rejects the wrong kind and non-objects", () => {
    expect(isPassageDropRequest({ kind: "passage-clear", url: "http://h/a" })).toBe(false);
    expect(isPassageDropRequest(null)).toBe(false);
    expect(isPassageDropRequest("passage-drop")).toBe(false);
  });
});

describe("isPassageClearRequest", () => {
  test("accepts the bare message and rejects everything else", () => {
    expect(isPassageClearRequest({ kind: "passage-clear" })).toBe(true);
    expect(isPassageClearRequest({ kind: "passage-drop", url: "http://h/a" })).toBe(false);
    expect(isPassageClearRequest(null)).toBe(false);
  });
});
