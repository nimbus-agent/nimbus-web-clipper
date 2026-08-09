// Canned, deterministic responses for the loopback mock gateway used to drive
// deterministic store screenshots. Not shipped in dist/. The RelatedHit typing
// keeps these in lockstep with the locked /v1/clips/related contract; a unit test
// re-asserts the shape at runtime.
import type { RelatedHit } from "../../src/shared/types.ts";

export interface PairConfirmResponse {
  readonly token: string;
  readonly label: string;
}

export interface ClipIngestResponse {
  readonly id: string;
  readonly status: "created" | "updated";
}

export interface RelatedResponse {
  readonly items: readonly RelatedHit[];
}

/** A clearly-fake token — never a real secret. */
export const PAIR_CONFIRM: PairConfirmResponse = {
  token: "mock-bearer-token-not-a-real-secret",
  label: "Mock Device",
};

export const CLIP_INGEST: ClipIngestResponse = {
  id: "clip_mock_0001",
  status: "created",
};

/** `GET /v1/items/resolve` — the contracted resolve route (Nimbus gateway). */
export const RESOLVE_FIXTURE = {
  found: true,
  matchKind: "exact",
  item: {
    id: "gh-pr-482",
    service: "github",
    type: "pr",
    title: "Cache the readability pass",
    url: "https://github.com/acme/web/pull/482",
    // Fixed, not Date.now(): this fixture is never actually rendered in a
    // screenshot (capture.ts injects the panel at http://127.0.0.1:8765/sample,
    // which `recognise()` classifies as unknown-host, so no resolve call ever
    // fires) — it exists as the wire-shape record `mock-gateway.test.ts` asserts
    // against. A fixed literal keeps that record stable; a live Date.now() would
    // make the asserted fixture drift by a day every day, which is the opposite
    // of what a pinned test fixture should do.
    modified_at: 1_700_000_000_000,
  },
} as const;

export const RELATED: RelatedResponse = {
  items: [
    {
      id: "n_001",
      title: "Designing local-first software",
      service: "web",
      snippet: "Seven ideas for software that keeps your data on your own machine…",
      url: "https://www.inkandswitch.com/local-first/",
    },
    {
      id: "n_002",
      title: "Note — hybrid retrieval tradeoffs",
      service: "note",
      snippet: "When re-ranking dense + keyword results beats either alone…",
      url: null,
    },
    {
      id: "n_003",
      title: "Readability.js internals",
      service: "web",
      snippet: "How the article extractor scores DOM nodes to find the main content…",
      url: "https://github.com/mozilla/readability",
    },
  ],
};
