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
 * `GET /v1/items/resolve-file` — C7's proposed forge-file probe (not shipped
 * upstream yet; see `GATEWAY_PATHS.resolveFile`'s own doc comment). Mirrors the
 * wire shape `resolveFile` (gateway-client.ts) parses: `{ ok: true, path }` on a
 * hit, `{ ok: false, reason, repo }` on a miss. Never rendered in a screenshot
 * for the same reason RESOLVE_FIXTURE isn't — the sample page's product is
 * unknown-host — so this exists purely as the pinned wire-shape record
 * `mock-gateway.test.ts` asserts against and the default a scenario-free call
 * gets.
 */
export const RESOLVE_FILE_FIXTURE = { ok: true, path: "src/a.ts" } as const;

/**
 * The two miss reasons `FileMissReason` (src/shared/types.ts) closes over, each
 * as its own fixture so a scenario can key either one to a coordinate and make
 * both reachable — the panel renders a different sentence per reason, and a
 * harness that could only ever produce one would leave the other unexercised.
 */
export const RESOLVE_FILE_MISS_UNTRACKED = {
  ok: false,
  reason: "remote_not_tracked",
  repo: "acme/web",
} as const;

export const RESOLVE_FILE_MISS_NOT_INDEXED = {
  ok: false,
  reason: "file_not_indexed",
  repo: "acme/web",
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

// Fixed epoch-ms literals, never Date.now(): same reasoning as RESOLVE_FIXTURE
// above — a live value would make this pinned fixture drift between runs.
const ONE_DAY_MS = 86_400_000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

/**
 * Wire shape of the `why` lane's structured brief, exactly as the gateway's
 * `WhyBrief` (`@nimbus-dev/sdk`) sends it — deliberately NOT `WhyFindings`
 * from `src/shared/findings.ts`, same reasoning as `RelatedHitWire` above:
 * this mimics the GATEWAY's shape, which nests `gaps` (and the other
 * `AgentBriefBase` fields) inside the findings object itself, while the
 * client's `WhyFindings` projection deliberately excludes `gaps` — it is
 * stored once as a sibling of `findings` on `LaneState` (see that type's own
 * comment in `src/shared/findings.ts`).
 */
export interface AgentRunWhyFindingsWire {
  readonly kind: "why";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: readonly {
    readonly category: string;
    readonly detail: string;
    readonly remediation?: string;
  }[];
  readonly findings: readonly {
    readonly lane: string;
    readonly title: string;
    readonly detail: string;
    readonly url: string | null;
    readonly occurredAt: number | null;
    readonly entityId: string | null;
  }[];
  readonly subject: null;
  readonly changeSubject: {
    readonly itemId: string;
    readonly entityId: string;
    readonly repo: string;
    readonly number: number | null;
    readonly url: string;
    readonly title: string;
    readonly modifiedAt: number | null;
  } | null;
  readonly itemSubject: null;
}

/**
 * Wire shape of the `glossary` lane's structured brief, exactly as the
 * gateway's own glossary brief type sends it (`glossary-types.ts`, Nimbus
 * repo). `@nimbus-dev/sdk` 2.0.0 publishes this brief and its entry types
 * (`GlossaryEntry`, `GlossarySourceRef`) — `src/shared/findings.ts` imports
 * them rather than hand-declaring a mirror — but this fixture still
 * hand-declares its own wire-shape interface here, because it drives the mock
 * gateway's raw HTTP response body, not the client's already-parsed type.
 * `gaps` nests inside `findings` here, same as `AgentRunWhyFindingsWire`
 * above — `gapsOfBrief` (findings-guards.ts) reads it off the raw findings
 * object for every agent, not just `why`.
 */
export interface AgentRunGlossaryFindingsWire {
  readonly kind: "glossary";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: readonly {
    readonly category: string;
    readonly detail: string;
    readonly remediation?: string;
  }[];
  readonly mode: "list" | "term" | "miss";
  readonly matchedVia: "exact" | "synonym" | null;
  readonly entries: readonly {
    readonly term: string;
    readonly definition: string | null;
    readonly definitionSource: "llm" | "snippet" | "manual" | null;
    readonly docFreq: number;
    readonly score: number;
    readonly serviceSpread: number;
    readonly firstSeenAt: number;
    readonly lastSeenAt: number;
    readonly topSources: readonly {
      readonly itemId: string;
      readonly title: string;
      readonly url: string | null;
      readonly service: string;
      readonly modifiedAt: number;
    }[];
    readonly synonyms: readonly string[];
    readonly nearMisses: readonly string[];
  }[];
  readonly suggestions: readonly string[];
}

/**
 * Wire shape of the `decisions` lane's structured brief, exactly as the
 * gateway's own decisions brief type sends it (`decisions-types.ts`, Nimbus
 * repo). `@nimbus-dev/sdk` 2.0.0 publishes this brief and its evidence type
 * (`DecisionEvidence`) — `src/shared/findings.ts` imports it rather than
 * hand-declaring a mirror — but this fixture still hand-declares its own
 * wire-shape interface here, same reasoning as `AgentRunGlossaryFindingsWire`
 * above: it drives the mock gateway's raw HTTP response body, not the
 * client's already-parsed type. `stats` NESTS `truncatedSources` here, exactly as
 * `decisionsFindingsFrom` (findings-guards.ts) expects on the wire — the
 * client's own projection flattens it onto the top level instead, which is
 * the distinction that guard's idempotence test exists to pin.
 */
export interface AgentRunDecisionsFindingsWire {
  readonly kind: "decisions";
  readonly agentVersion: number;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: readonly {
    readonly category: string;
    readonly detail: string;
    readonly remediation?: string;
  }[];
  readonly entries: readonly {
    readonly id: string;
    readonly statement: string;
    readonly rationale: string | null;
    readonly alternatives: readonly string[];
    readonly confidence: number;
    readonly decidedAt: number;
    readonly hasAdr: boolean;
    readonly extractionSource: "llm" | "snippet" | null;
    readonly evidence: readonly {
      readonly kind: "source" | "pr" | "commit" | "migration" | "iac" | "adr";
      readonly entityId: string | null;
      readonly itemId: string | null;
      readonly label: string;
      readonly url: string | null;
      readonly occurredAt: number | null;
    }[];
  }[];
  readonly stats: {
    readonly truncatedSources: number;
  };
}

/**
 * Wire shape of the `catchup` lane's structured brief, exactly as the
 * gateway's own catchup brief type sends it (`@nimbus-dev/sdk` — one of the
 * four lanes C8.3 imports rather than mirrors). `involvement` and each
 * `sections[]` entry are nested exactly as `catchupFindingsFrom`
 * (findings-guards.ts) expects on the wire, and — unlike
 * `AgentRunDecisionsFindingsWire`'s `stats.truncatedSources` — the client's
 * own `CatchupFindings` projection keeps both nested objects VERBATIM rather
 * than flattening either, which is exactly what keeps this shape and the
 * projection's shape identical and the guard idempotent over its own output
 * (see `docs/architecture.md`'s "The `sanitiseState` idempotence invariant").
 */
export interface AgentRunCatchupFindingsWire {
  readonly kind: "catchup";
  readonly agentVersion: number;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: readonly {
    readonly category: string;
    readonly detail: string;
    readonly remediation?: string;
  }[];
  readonly selfPersonId: string | null;
  readonly involvement: {
    readonly ownedServices: readonly string[];
    readonly activeRepos: readonly string[];
    readonly incidentServices: readonly string[];
    readonly collaboratorPersonIds: readonly string[];
  };
  readonly sections: readonly {
    readonly serviceId: string;
    readonly totalItemsInWindow: number;
    readonly items: readonly {
      readonly itemId: string;
      readonly title: string;
      readonly modifiedAt: number;
      readonly relevanceScore: number;
      readonly relevanceReasons: readonly string[];
    }[];
  }[];
}

/** Wire shape of `synthesis` — a sibling field of `findings`, never nested
 *  inside it (see `terminalLaneState`, service-worker.ts). */
export interface AgentRunSynthesisWire {
  readonly attempted: true;
  readonly used: true;
  readonly model: string;
  readonly remote: boolean;
}

/**
 * `GET /v1/agents/runs/{id}` — the mock reports every run as `done` immediately,
 * with a fixed brief, so a lane never sits in `running` long enough to make a
 * screenshot flaky. A fixed literal, never generated: same reasoning as
 * `FETCH_FIXTURE`'s id above — a live id/brief would make the asserted fixture
 * drift between runs, which is the opposite of what a pinned screenshot needs.
 *
 * `findings`/`synthesis` are shaped as a realistic `why` answer — `kind` is
 * checked against the invoking lane (`laneFindingsFrom`, findings-guards.ts),
 * so only a `why` invoke ever parses this as structured; the other six lanes
 * fall back to `brief` exactly as before. This is what lets
 * `development.md`'s agent-lane manual step describe a real timeline instead
 * of only the flattened paragraph.
 */
export interface AgentRunDoneResponse {
  readonly status: "done";
  readonly brief: string;
  readonly findings?:
    | AgentRunWhyFindingsWire
    | AgentRunGlossaryFindingsWire
    | AgentRunDecisionsFindingsWire
    | AgentRunCatchupFindingsWire;
  readonly synthesis?: AgentRunSynthesisWire;
}

export const AGENT_INVOKE: AgentInvokeResponse = {
  runId: "run_mock_0001",
};

export const AGENT_RUN_DONE: AgentRunDoneResponse = {
  status: "done",
  brief:
    "This change touches only the readability cache path; no other module calls " +
    "into it. Low blast radius — safe to land once tests are green.",
  findings: {
    kind: "why",
    agentVersion: 1,
    generatedAt: 1_700_000_000_000,
    latencyMs: 420,
    gaps: [
      {
        category: "missing_connector",
        detail: "No chat connector is indexed, so discussion around this change is not searchable.",
        remediation: "Run `nimbus index add --connector slack` to index chat history.",
      },
    ],
    findings: [
      {
        lane: "authorship",
        title: "Asaf Golombek",
        detail: "Wrote the original readability cache in this file.",
        url: null,
        occurredAt: 1_700_000_000_000 - ONE_WEEK_MS,
        entityId: "person:asaf",
      },
      {
        lane: "pull_request",
        title: "Cache the readability pass",
        detail: "Introduced the cache this change touches.",
        url: "https://github.com/acme/web/pull/482",
        occurredAt: 1_700_000_000_000 - ONE_DAY_MS,
        entityId: "gh-pr-482",
      },
      {
        lane: "ticket",
        title: "Clipper is slow on large articles",
        detail: "The ticket this change was written to close.",
        url: "https://acme.atlassian.net/browse/PLAT-91",
        occurredAt: 1_700_000_000_000 - 2 * ONE_DAY_MS,
        entityId: "jira:PLAT-91",
      },
    ],
    subject: null,
    changeSubject: {
      itemId: "github:acme/web#482",
      entityId: "gh-pr-482",
      repo: "acme/web",
      number: 482,
      url: "https://github.com/acme/web/pull/482",
      title: "Cache the readability pass",
      modifiedAt: 1_700_000_000_000 - ONE_DAY_MS,
    },
    itemSubject: null,
  },
  synthesis: {
    attempted: true,
    used: true,
    model: "local-fixture",
    remote: false,
  },
};

/**
 * `GET /v1/agents/runs/{id}` for a `glossary` invoke — a second done response,
 * not a variant of {@link AGENT_RUN_DONE}: the mock answers every agent with
 * the same fixture by default (mock-gateway.ts), so a test that wants the
 * glossary lane's STRUCTURED render has to opt in via `Scenario.agentRun` (see
 * input-lanes.e2e.ts). One entry, shaped to satisfy `glossaryFindingsFrom`
 * (findings-guards.ts) with the field combination that exercises the
 * renderer's two real branches: a `definitionSource` (so the badge renders),
 * two `topSources` — one with a `url` (`findingLink` emits an `<a>`) and one
 * with `url: null` (it emits a plain `<span>` instead) — and a non-empty
 * `synonyms` list.
 */
export const AGENT_RUN_DONE_GLOSSARY: AgentRunDoneResponse = {
  status: "done",
  brief: "“cache” is defined below, with its two source mentions.",
  findings: {
    kind: "glossary",
    agentVersion: 1,
    generatedAt: 1_700_000_000_000,
    latencyMs: 180,
    gaps: [],
    mode: "term",
    matchedVia: "exact",
    entries: [
      {
        term: "cache",
        definition:
          "A layer that stores a computed result so a later call can reuse it instead of recomputing.",
        definitionSource: "llm",
        docFreq: 4,
        score: 0.82,
        serviceSpread: 2,
        firstSeenAt: 1_700_000_000_000 - ONE_WEEK_MS,
        lastSeenAt: 1_700_000_000_000 - ONE_DAY_MS,
        topSources: [
          {
            itemId: "gh-pr-482",
            title: "Cache the readability pass",
            url: "https://github.com/acme/web/pull/482",
            service: "github",
            modifiedAt: 1_700_000_000_000 - ONE_DAY_MS,
          },
          {
            itemId: "note_cache_001",
            title: "Note — caching strategy tradeoffs",
            url: null,
            service: "note",
            modifiedAt: 1_700_000_000_000 - 2 * ONE_DAY_MS,
          },
        ],
        synonyms: ["memoization"],
        nearMisses: [],
      },
    ],
    suggestions: [],
  },
  synthesis: {
    attempted: true,
    used: true,
    model: "local-fixture",
    remote: false,
  },
};

/**
 * `GET /v1/agents/runs/{id}` for a `decisions` invoke — a third done response,
 * same reasoning as {@link AGENT_RUN_DONE_GLOSSARY}: the mock answers every
 * agent with {@link AGENT_RUN_DONE} by default, so a test that wants the
 * `decisions` lane's STRUCTURED render opts in via `Scenario.agentRun`. Two
 * entries, shaped to satisfy `decisionsFindingsFrom` (findings-guards.ts) with
 * the field combination that exercises the renderer's real branches: an ADR
 * badge on one entry and not the other, a rationale and alternatives on one
 * and neither on the other, one evidence row with a `url` (`findingLink`
 * emits an `<a>`) and one with `url: null` (a plain `<span>` instead), and a
 * non-zero `stats.truncatedSources` so the per-window caveat line renders.
 */
export const AGENT_RUN_DONE_DECISIONS: AgentRunDoneResponse = {
  status: "done",
  brief: "Two decisions were extracted from this connector's indexed history.",
  findings: {
    kind: "decisions",
    agentVersion: 1,
    generatedAt: 1_700_000_000_000,
    latencyMs: 260,
    gaps: [],
    entries: [
      {
        id: "d1",
        statement: "Use WAL mode for the index database.",
        rationale: "Concurrent readers during a sync pass need to keep reading.",
        alternatives: ["Rollback journal"],
        confidence: 0.9,
        decidedAt: 1_700_000_000_000 - ONE_DAY_MS,
        hasAdr: true,
        extractionSource: "snippet",
        evidence: [
          {
            kind: "pr",
            entityId: "gh-pr-482",
            itemId: "github:acme/web#482",
            label: "Cache the readability pass",
            url: "https://github.com/acme/web/pull/482",
            occurredAt: 1_700_000_000_000 - ONE_DAY_MS,
          },
        ],
      },
      {
        id: "d2",
        statement: "Retry a failed egress append at most once.",
        rationale: null,
        alternatives: [],
        confidence: 0.6,
        decidedAt: 1_700_000_000_000 - ONE_WEEK_MS,
        hasAdr: false,
        extractionSource: "llm",
        evidence: [
          {
            kind: "commit",
            entityId: null,
            itemId: null,
            label: "Note — retry policy discussion",
            url: null,
            occurredAt: 1_700_000_000_000 - ONE_WEEK_MS,
          },
        ],
      },
    ],
    stats: { truncatedSources: 2 },
  },
  synthesis: {
    attempted: true,
    used: true,
    model: "local-fixture",
    remote: false,
  },
};

/**
 * `GET /v1/agents/runs/{id}` for a `catchup` invoke — a fourth done response,
 * same reasoning as {@link AGENT_RUN_DONE_DECISIONS}: the mock answers every
 * agent with {@link AGENT_RUN_DONE} by default, so a test that wants the
 * `catchup` lane's STRUCTURED render opts in via `Scenario.agentRun`. Shaped to
 * exercise the renderer's real branches: `involvement` carries all FOUR arrays
 * non-empty — including `incidentServices`, which the render spec originally
 * omitted and this fixture now pins as part of the involvement line — one
 * section whose `items.length` equals `totalItemsInWindow` (no truncation
 * count) and a second that is truncated (renders the "N of M" count), so both
 * of `renderCatchupFindings`'s branches for that line are covered by one
 * fixture.
 */
export const AGENT_RUN_DONE_CATCHUP: AgentRunDoneResponse = {
  status: "done",
  brief: "Three items moved across two services while you were away.",
  findings: {
    kind: "catchup",
    agentVersion: 1,
    generatedAt: 1_700_000_000_000,
    latencyMs: 310,
    gaps: [],
    selfPersonId: "person:asaf",
    involvement: {
      ownedServices: ["billing-service"],
      activeRepos: ["acme/web"],
      incidentServices: ["checkout-service"],
      collaboratorPersonIds: ["person:2", "person:3"],
    },
    sections: [
      {
        serviceId: "billing-service",
        totalItemsInWindow: 1,
        items: [
          {
            itemId: "github:acme/web#482",
            title: "Cache the readability pass",
            modifiedAt: 1_700_000_000_000 - ONE_DAY_MS,
            relevanceScore: 0.9,
            relevanceReasons: ["you own billing-service"],
          },
        ],
      },
      {
        serviceId: "checkout-service",
        totalItemsInWindow: 3,
        items: [
          {
            itemId: "jira:PLAT-91",
            title: "Clipper is slow on large articles",
            modifiedAt: 1_700_000_000_000 - 2 * ONE_DAY_MS,
            relevanceScore: 0.6,
            relevanceReasons: ["active in checkout-service"],
          },
        ],
      },
    ],
  },
  synthesis: {
    attempted: true,
    used: true,
    model: "local-fixture",
    remote: false,
  },
};

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
/**
 * A ledger window as `GET /v1/egress` returns it: newest first, with the totals
 * counted over the whole window rather than derived from this page.
 *
 * The four rows are deliberately one of each shape the Activity page has to
 * tell apart — an agent run this browser caused, an agent run another client
 * caused, a targeted fetch nothing can attribute yet (the gateway hardcodes
 * `sourceId: null` for those), and a scheduled background sync nobody asked for.
 */
export const EGRESS_WINDOW = {
  rows: [
    {
      // The outcome marker for the targeted fetch below. Higher id, so a
      // newest-first read hands it over BEFORE the row it describes — which is
      // exactly the ordering the page has to cope with.
      id: 5,
      timestamp: 1_755_600_500_000,
      sourceType: "outcome",
      sourceId: "c3".repeat(32),
      destination: "github",
      method: "items.fetch.outcome",
      payloadSummary: '{"status":"indexed","itemId":"github:acme/web#482"}',
      hitlStatus: "not_required",
      resultStatus: "authorized",
      rowHash: "e5".repeat(32),
      prevHash: "d4".repeat(32),
    },
    {
      id: 4,
      timestamp: 1_755_600_000_000,
      sourceType: "sync",
      sourceId: null,
      destination: "slack",
      method: "sync.run",
      payloadSummary: '{"method":"sync.run"}',
      hitlStatus: "not_required",
      resultStatus: "authorized",
      rowHash: "d4".repeat(32),
      prevHash: "c3".repeat(32),
    },
    {
      id: 3,
      timestamp: 1_755_599_000_000,
      sourceType: "sync",
      sourceId: null,
      destination: "github",
      method: "items.fetch",
      payloadSummary: '{"method":"items.fetch"}',
      hitlStatus: "not_required",
      resultStatus: "authorized",
      rowHash: "c3".repeat(32),
      prevHash: "b2".repeat(32),
    },
    {
      id: 2,
      timestamp: 1_755_598_000_000,
      sourceType: "http",
      sourceId: "nimbus-editor",
      destination: "jira",
      method: "agents.impact",
      payloadSummary: '{"agent":"impact"}',
      hitlStatus: "not_required",
      resultStatus: "authorized",
      rowHash: "b2".repeat(32),
      prevHash: "a1".repeat(32),
    },
    {
      id: 1,
      timestamp: 1_755_597_000_000,
      sourceType: "http",
      // The SAME label the harness pairs with, not a second hardcoded string:
      // `partitionRows` matches on exact label, so a fixture that invented its
      // own would put every row in "other clients" and quietly prove nothing.
      sourceId: PAIR_CONFIRM.label,
      destination: "github",
      method: "agents.why",
      payloadSummary: '{"agent":"why"}',
      hitlStatus: "not_required",
      resultStatus: "authorized",
      rowHash: "a1".repeat(32),
      prevHash: "00".repeat(32),
    },
  ],
  rowsTotal: 5,
  rowsTruncated: false,
} as const;

export const EGRESS_HEAD = { head: "e5".repeat(32), count: 5 } as const;

/** The gateway's own verdict vocabulary — `ok`/`verifiedRows`, not a re-spelling. */
export const EGRESS_VERIFY = { ok: true, verifiedRows: 5 } as const;

export const EGRESS_PROVE = {
  digest: "ab".repeat(32),
  sigB64: "c2lnbmF0dXJl",
  pubkeyB64: "cHVibGlja2V5",
  rowsTotal: 5,
  rowsTruncated: false,
} as const;

export interface Scenario {
  /** Keyed by the exact `url` query param `GET /v1/items/resolve` receives. */
  readonly resolve?: Readonly<Record<string, unknown>>;
  /** Answer for any url absent from `resolve`. Defaults to RESOLVE_FIXTURE. */
  readonly resolveDefault?: unknown;
  /**
   * Keyed by `service:repo:refAndPath`, joined in that order from the three
   * query params `GET /v1/items/resolve-file` receives — the same
   * keyed-by-exact-request shape as `resolve` above, so a scenario can put a
   * miss (either reason) on one coordinate while every other coordinate keeps
   * getting the default hit.
   */
  readonly resolveFile?: Readonly<Record<string, unknown>>;
  /** Answer for any coordinate absent from `resolveFile`. Defaults to RESOLVE_FILE_FIXTURE. */
  readonly resolveFileDefault?: unknown;
  readonly related?: unknown;
  readonly ingest?: unknown;
  readonly itemsFetch?: unknown;
  readonly agentRun?: unknown;
  readonly egress?: unknown;
  readonly egressHead?: unknown;
  readonly egressVerify?: unknown;
  readonly egressProve?: unknown;
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
