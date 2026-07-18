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
