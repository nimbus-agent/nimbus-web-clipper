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

/** One source `POST /v1/briefs/{id}/sources` received — the wire body a real
 *  feed sends, so a test asserting on it is asserting on the bytes that left
 *  the extension, not on the extension's own idea of what it sent. */
export interface FedBriefSource {
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly capturedAt: number;
  readonly truncated: boolean;
}

/**
 * A minimal done report: one finding citing the first source.
 *
 * Shaped against `isBriefReport` (src/shared/brief-report.ts), not against a
 * looser sketch — that guard is what decides whether a report is accepted, and
 * a fixture missing a field (`citations[].kind`, notably) would make the page
 * render a failure for a reason that has nothing to do with what the e2e is
 * actually testing.
 */
export const BRIEF_REPORT = {
  summary: "Both sources describe the same change.",
  findings: [
    {
      text: "The sources agree on the approach.",
      citations: [{ kind: "source", url: "", title: "Source 1" }],
    },
  ],
  conflicts: [],
  gaps: [],
  synthesis: { remote: false, model: "local-fixture" },
} as const;

/**
 * The done report for a run that asked to also search the index (`useIndex:
 * true` on create) — same shape as {@link BRIEF_REPORT} plus one more finding
 * whose citations are indexed hits, not sources the caller declared.
 *
 * Two different `itemType` values, deliberately: `web_clip` is a type this
 * client's `itemTypeLabel` (`src/brief/brief-view.ts`) has always rendered,
 * and `slack_message` is one it has never heard of — connectors ship on the
 * gateway's own schedule, so the label function degrades ANY snake_case type
 * to spaced words rather than special-casing a known list, and this fixture
 * is what an e2e can hold that claim against. Only the `web_clip` citation
 * carries a `clipId`: the wire contract reserves that field for a citation
 * that is also an ingested clip, and a Slack message is not one.
 */
export const INDEX_BRIEF_REPORT = {
  summary: "Both sources describe the same change, and your index adds more.",
  findings: [
    {
      text: "The sources agree on the approach.",
      citations: [{ kind: "source", url: "", title: "Source 1" }],
    },
    {
      text: "Your index has related material on this too.",
      citations: [
        {
          kind: "clip",
          title: "Local-first sync notes",
          url: "https://example.com/notes",
          clipId: "clip_idx_001",
          itemId: "item_idx_001",
          itemType: "web_clip",
        },
        {
          kind: "clip",
          title: "#eng-platform — deploy freeze thread",
          itemId: "item_idx_002",
          itemType: "slack_message",
        },
      ],
    },
  ],
  conflicts: [],
  gaps: [],
  synthesis: { remote: false, model: "local-fixture" },
} as const;

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
  /**
   * Called with every request's pathname, before routing. Exists for the same
   * reason `delayMs` does — some claims this harness needs to make ("no second
   * run started", "the cached brief replayed instead of invoking again") are
   * about a request NOT happening, and the project's own no-arbitrary-sleep
   * rule (a claim about the future is proven by waiting, which this repo
   * treats as undeterminable, not as "wait long enough") rules out proving a
   * negative by timing a response instead. A plain counter the calling TEST
   * owns is a value to assert on, same as a locator — never a mutable control
   * endpoint the server exposes to itself, which is what would make one test's
   * meaning depend on another's.
   */
  readonly onRequest?: (pathname: string) => void;
  /** Called with every `POST /v1/briefs/{id}/sources` body — the assertion no
   *  unit test can make: what a feed actually put on the wire. */
  readonly onBriefSource?: (source: FedBriefSource) => void;
  /** Called with every `POST /v1/briefs` (create) body — the assertion no unit
   *  test can make: whether `useIndex` actually left the browser, rather than
   *  the client's own idea of what it sent. */
  readonly onBriefCreate?: (body: FedBriefCreate) => void;
  /** Called with every `POST /v1/clips` body — the assertion no unit test and
   *  no preview check can make: whether `canonicalUrl` actually left the
   *  browser. A regression could hide the preview's Canonical URL row while
   *  still putting the refused address on the wire, where it decides identity. */
  readonly onClipIngest?: (body: FedClip) => void;
}

/** One `POST /v1/clips` body received, as it arrived. Only the field whose
 *  presence is the whole point is named; the rest of the clip is not this
 *  fixture's business. */
export interface FedClip {
  readonly url?: unknown;
  readonly canonicalUrl?: unknown;
  readonly source?: unknown;
}

/** One create body `POST /v1/briefs` received — the wire shape, unknown
 *  `sources` entries included, since this fixture cares only about `useIndex`
 *  actually arriving, not about re-validating the source declarations. */
export interface FedBriefCreate {
  readonly brief?: unknown;
  readonly sources?: unknown;
  readonly useIndex?: unknown;
}
