// Canned, deterministic responses for the loopback mock gateway used to drive
// deterministic store screenshots. Not shipped in dist/. A unit test re-asserts
// the shape at runtime against the locked /v1/clips/related contract.

export interface PairConfirmResponse {
  readonly token: string;
  readonly label: string;
}

export interface ClipIngestResponse {
  readonly id: string;
  readonly status: "created" | "updated";
}

/**
 * The WIRE shape of a related hit — deliberately NOT `RelatedHit` from
 * `src/shared/types.ts`. That is the CLIENT type, which carries `modifiedAt`
 * (camelCase) because `gateway-client.ts` renames it at the HTTP boundary.
 * The mock stands in for the gateway, so it must speak `modified_at`.
 *
 * Typing this against the client shape was a real defect: both new fields are
 * optional there, so the fixture omitted them and the panel correctly rendered
 * no kind chip and no freshness line — leaving an e2e for those rows asserting
 * nothing at all.
 */
export interface RelatedHitWire {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly type: string;
  readonly snippet: string;
  readonly url: string | null;
  readonly modified_at: number;
}

export interface RelatedResponse {
  readonly items: readonly RelatedHitWire[];
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

/**
 * `POST /v1/items/fetch` — the contracted targeted-fetch route. The mock imitates
 * the gateway's WIRE format here, so `status`/`itemId` are correct — unlike
 * everywhere else in `src/`, which speaks the client's own camelCase vocabulary
 * after `gateway-client.ts` translates it at the boundary.
 *
 * A fixed literal, never generated: this fixture drives reproducible Playwright
 * screenshots, and a live id would make the asserted response drift between runs.
 */
export const FETCH_FIXTURE = {
  status: "indexed",
  itemId: "gh-pr-482",
} as const;

/** `POST /v1/agents/{agent}` — invoke response: a run id to poll. */
export interface AgentInvokeResponse {
  readonly runId: string;
}

/**
 * `GET /v1/agents/runs/{id}` — the mock reports every run as `done` immediately,
 * with a fixed brief, so a lane never sits in `running` long enough to make a
 * screenshot flaky. A fixed literal, never generated: same reasoning as
 * `FETCH_FIXTURE`'s id above — a live id/brief would make the asserted fixture
 * drift between runs, which is the opposite of what a pinned screenshot needs.
 */
export interface AgentRunDoneResponse {
  readonly status: "done";
  readonly brief: string;
}

export const AGENT_INVOKE: AgentInvokeResponse = {
  runId: "run_mock_0001",
};

export const AGENT_RUN_DONE: AgentRunDoneResponse = {
  status: "done",
  brief:
    "This change touches only the readability cache path; no other module calls " +
    "into it. Low blast radius — safe to land once tests are green.",
};

// Fixed epoch-ms literals, never Date.now(): same reasoning as RESOLVE_FIXTURE
// above — a live value would make this pinned fixture drift between runs.
const ONE_DAY_MS = 86_400_000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

export const RELATED: RelatedResponse = {
  items: [
    {
      id: "n_001",
      title: "Designing local-first software",
      service: "web",
      type: "page",
      snippet: "Seven ideas for software that keeps your data on your own machine…",
      url: "https://www.inkandswitch.com/local-first/",
      modified_at: 1_700_000_000_000,
    },
    {
      id: "n_002",
      title: "Note — hybrid retrieval tradeoffs",
      service: "note",
      type: "note",
      snippet: "When re-ranking dense + keyword results beats either alone…",
      url: null,
      modified_at: 1_700_000_000_000 - ONE_DAY_MS,
    },
    {
      id: "n_003",
      title: "Readability.js internals",
      service: "web",
      type: "page",
      snippet: "How the article extractor scores DOM nodes to find the main content…",
      url: "https://github.com/mozilla/readability",
      modified_at: 1_700_000_000_000 - ONE_WEEK_MS,
    },
  ],
};

/**
 * Per-test overrides for the mock. Every field is optional and falls back to the
 * canned fixture, so the screenshot script needs no scenario at all.
 *
 * A plain object passed at construction — NOT a control endpoint mutating a
 * running server. A control endpoint would make each test's meaning depend on
 * what ran before it, which is the standard way a browser suite becomes flaky.
 */
export interface Scenario {
  /** Keyed by the exact `url` query param `GET /v1/items/resolve` receives. */
  readonly resolve?: Readonly<Record<string, unknown>>;
  /** Answer for any url absent from `resolve`. Defaults to RESOLVE_FIXTURE. */
  readonly resolveDefault?: unknown;
  readonly related?: unknown;
  readonly ingest?: unknown;
  readonly itemsFetch?: unknown;
  readonly agentRun?: unknown;
  /** Path → HTTP status, applied before the body is chosen. */
  readonly status?: Readonly<Record<string, number>>;
  /**
   * Path → milliseconds to hold the response open before it is written.
   * Optional and defaulted OFF (no existing caller, including the screenshot
   * script, is affected by omitting it).
   *
   * Exists because a loopback round trip can settle in well under a
   * millisecond — too fast for an e2e suite to ever observe a genuinely
   * in-flight UI state (a "Saving to Nimbus…" status line, say) without
   * either an arbitrary sleep in the TEST or a real reason the response is
   * slow. This gives the second one: the mock deliberately takes its time on
   * one route, and the suite asserts the in-flight state with an ordinary
   * auto-retrying `expect(locator)` — no sleep in the test itself. Reused by
   * later phases that need a slow (rate-limit pause) or hanging (offline
   * queue) gateway, not just this one.
   */
  readonly delayMs?: Readonly<Record<string, number>>;
}

const NOT_INDEXED = {
  found: false,
  reason: "not_indexed",
  service: null,
  fetchable: false,
} as const;

export const SCENARIOS = {
  happyPath: {},
  /** Every url misses, and the gateway says it cannot fetch them either. */
  resolveMiss: { resolveDefault: NOT_INDEXED },
  fetchNotConfigured: {
    resolveDefault: NOT_INDEXED,
    itemsFetch: { status: "not_configured" },
  },
  rateLimited: { status: { "/v1/clips": 429 } },
} as const satisfies Record<string, Scenario>;
