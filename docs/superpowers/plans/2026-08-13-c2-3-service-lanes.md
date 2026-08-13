# C2.3 Service Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put three service-scoped agent lanes — `catchup`, `decisions`, `ownership` — on a new class of recognised page, the product's own dashboard.

**Architecture:** `SurfaceKind` grows a `"home"` member, so the existing `LANE_SURFACES` table routes the new lanes with no new mechanism. Because the gateway's `service` is a flat connector id identical to this client's `Product`, a service lane needs **no resolve call at all**: the handler goes recogniser → invoke. The panel gets one new `HeaderState` arm for a page that is recognised but has no indexed item, and the run store's key becomes a discriminated subject so a service answer is cached once per product instead of once per page.

**Tech Stack:** TypeScript (strict, no `any`), Vitest (node env; DOM tests opt into jsdom via a docblock), Biome, esbuild, bun.

**Spec:** [`docs/superpowers/specs/2026-08-13-c2-3-service-lanes-design.md`](../specs/2026-08-13-c2-3-service-lanes-design.md)

## Global Constraints

- **TypeScript strict, no `any`.** Cross-boundary data is `unknown`, narrowed by a guard.
- **No `console.*` anywhere in `src/`** — Biome's `noConsole` fails the build. Tests may log.
- **Loopback only.** This slice adds no new network destination and no new host permission.
- **Never log the bearer token or the pairing code.**
- **Briefs are free text from the gateway.** Render with `textContent`; never parse, never pattern-match their prose.
- **Keep pure logic out of the `chrome.*` seam** so it stays unit-testable.
- **Exhaustive literal tables over generated ones.** `LANE_SURFACES`, `LANE_TITLES`, `laneState` and `laneOpen` are keyed `Record<AgentLane, …>` on purpose — adding a lane without declaring every one of them must be a type error, not a silent default.
- **Agent names on the wire are the `AgentLane` members themselves.** `invokeAgent` passes the lane straight through as `{agent}` in `POST /v1/agents/{agent}`, so the spelling must match upstream's handler keys exactly: `catchup`, `decisions`, `ownership`.
- **Service ids, verbatim:** `bitbucket`, `github`, `gitlab`, `jenkins`, `jira`.
- **Commands:** `bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`, `bun run check-build`. A single test file: `bun run test test/unit/<file>.test.ts`. A single test by name: `bun run test test/unit/<file>.test.ts -t "<substring>"`.

---

### Task 1: The `home` surface in the recogniser

Teaches the pure recogniser that a product's dashboard is a recognised page with no item. Nothing consumes it yet — this task only makes `recognise()` able to say `kind: "home"`.

**Files:**
- Modify: `src/shared/types.ts:69` (the `SurfaceKind` union)
- Modify: `src/shared/recognise.ts:58-62` (`KIND_NAMES`), `:77-181` (the five matchers), `:183-188` (`labelFor`), `:249-251` (`surfaceLine`)
- Test: `test/unit/recognise.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SurfaceKind` now includes `"home"`. A home `Recognition` is `{ ok: true, product, kind: "home", label: "<Product> dashboard", ref: "", resolveUrl }`. `surfaceLine` returns the label alone when `ref` is `""`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/recognise.test.ts`:

```ts
describe("dashboard (home) surfaces", () => {
  it("recognises each product's dashboard as kind home", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["https://github.com/", "GitHub dashboard"],
      ["https://gitlab.com/dashboard", "GitLab dashboard"],
      ["https://bitbucket.org/dashboard/overview", "Bitbucket dashboard"],
      ["https://acme.atlassian.net/jira/your-work", "Jira dashboard"],
    ];
    for (const [url, label] of cases) {
      const r = recognise(url, []);
      expect(r.ok, url).toBe(true);
      if (!r.ok) continue;
      expect(r.kind, url).toBe("home");
      expect(r.label, url).toBe(label);
      expect(r.ref, url).toBe("");
    }
  });

  it("recognises a self-hosted Jenkins root under a path prefix", () => {
    const origins = [{ origin: "https://corp.example/jenkins", product: "jenkins" as const }];
    const r = recognise("https://corp.example/jenkins/", origins);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("home");
    expect(r.label).toBe("Jenkins dashboard");
  });

  it("recognises a self-hosted Jira Server dashboard", () => {
    const origins = [{ origin: "https://jira.corp.example", product: "jira" as const }];
    const r = recognise("https://jira.corp.example/secure/Dashboard.jspa", origins);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("home");
  });

  it("does not claim near-miss paths as home", () => {
    // Each of these is one segment away from a dashboard and must stay
    // unrecognised rather than becoming a lane-bearing page.
    const misses: readonly string[] = [
      "https://github.com/acme",
      "https://gitlab.com/dashboard-extra",
      "https://bitbucket.org/dashboards",
      "https://acme.atlassian.net/jira/your-work/extra",
      "https://acme.atlassian.net/browse",
    ];
    for (const url of misses) {
      expect(recognise(url, []).ok, url).toBe(false);
    }
  });

  it("still recognises item pages, which win over the home branch", () => {
    const r = recognise("https://github.com/acme/web/pull/482", []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("pr");
    expect(r.ref).toBe("acme/web #482");
  });

  it("treats two self-hosted instances of one product as the same home", () => {
    // Deliberate: `service` is a flat connector id, so `{service:"jenkins"}`
    // spans BOTH instances and there is exactly one answer. Splitting these
    // would store one answer twice and double the agent runs.
    const origins = [
      { origin: "https://jenkins.dev.local", product: "jenkins" as const },
      { origin: "https://jenkins.prod.local", product: "jenkins" as const },
    ];
    const dev = recognise("https://jenkins.dev.local/", origins);
    const prod = recognise("https://jenkins.prod.local/", origins);
    expect(sameItem(dev, prod)).toBe(true);
  });

  it("renders a home surface line as the label alone", () => {
    const r = recognise("https://github.com/", []);
    expect(surfaceLine(r)).toBe("GitHub dashboard");
  });
});
```

Make sure `sameItem` and `surfaceLine` are in the file's import list from `../../src/shared/recognise.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/unit/recognise.test.ts -t "dashboard"`
Expected: FAIL — the dashboard URLs currently return `{ok: false, reason: "unrecognised-path"}`.

- [ ] **Step 3: Add `"home"` to `SurfaceKind`**

In `src/shared/types.ts`, replace line 69:

```ts
/**
 * What kind of item a recognised page is.
 *
 * `home` is the odd one out and deliberately so: it is a page the recogniser
 * knows and that has NO indexed item — a product's own dashboard. It exists
 * because the service-scoped agents (`catchup`/`decisions`/`ownership`) answer
 * about a whole connector, so they need a page whose scope matches that answer.
 * See LANE_SURFACES below.
 */
export type SurfaceKind = "pr" | "build" | "issue" | "home";
```

- [ ] **Step 4: Teach the recogniser the home branch**

In `src/shared/recognise.ts`, extend `KIND_NAMES` (line 58):

```ts
const KIND_NAMES: Record<SurfaceKind, string> = {
  pr: "PR",
  build: "build",
  issue: "issue",
  home: "dashboard",
};
```

Add this helper just above `MATCHERS` (line 175):

```ts
/**
 * A dashboard match. `ref` is the EMPTY STRING, constant per product, and that
 * is load-bearing: `sameItem` compares `(product, kind, ref)`, so two
 * self-hosted instances of one product compare equal here. That is correct,
 * not a bug — `service` is a flat connector id, so both instances are the same
 * scope and share one answer. `path`/`matchedPath` echo the incoming path so
 * `resolveUrl` is left exactly as it arrived (nothing resolves a dashboard).
 */
function homeMatch(path: string): Match {
  return { kind: "home", ref: "", path, matchedPath: path };
}
```

Now give each matcher its dashboard case. **The home case goes last in each matcher**, after every item pattern has had its chance, so an item page can never be swallowed by it.

In `matchGithub`, replace the final `return` block with:

```ts
  if (owner === undefined || repo === undefined || section !== "pull") {
    // The signed-in dashboard is the bare root. Checked only after the PR
    // pattern above has declined, so /acme/web/pull/1 can never land here.
    return s.length === 0 ? homeMatch("/") : null;
  }
```

In `matchGitlab`, replace the opening guard:

```ts
  const dash = s.indexOf("-");
  // At least group/project before the "-" separator.
  if (dash < 2 || s[dash + 1] !== "merge_requests") {
    return s.length === 0 || (s.length === 1 && s[0] === "dashboard")
      ? homeMatch(s.length === 0 ? "/" : "/dashboard")
      : null;
  }
```

In `matchBitbucket`, replace the final `return null` of the Cloud branch:

```ts
  if (workspace === undefined || repo === undefined || section !== "pull-requests") {
    return s[0] === "dashboard" ? homeMatch(`/${s.join("/")}`) : null;
  }
```

In `matchJenkins`, replace the guard that rejects an empty job list:

```ts
  const num = s[i];
  if (names.length === 0) {
    // The instance root, after any configured path prefix is stripped.
    return s.length === 0 ? homeMatch("/") : null;
  }
  if (num === undefined || !NUMBER.test(num)) {
    return null;
  }
```

In `matchJira`, replace the opening guard:

```ts
  const [section, key] = s;
  if (section !== "browse" || key === undefined || !JIRA_KEY.test(key)) {
    // Cloud's "Your work" and Server's dashboard servlet.
    const isHome =
      (s.length === 2 && section === "jira" && key === "your-work") ||
      (s.length === 2 && section === "secure" && key === "Dashboard.jspa");
    return isHome ? homeMatch(`/${s.join("/")}`) : null;
  }
```

Finally, make `labelFor` and `surfaceLine` read correctly for a home page. `labelFor` already produces `"<Product> dashboard"` from `KIND_NAMES`, so it needs no change. Replace `surfaceLine` (line 249):

```ts
/**
 * "Bitbucket PR · acme/web #482" — the panel header's first line.
 *
 * A home recognition carries an EMPTY `ref` (see `homeMatch`), so it renders as
 * the label alone rather than trailing a bare separator.
 */
export function surfaceLine(r: Recognition): string | null {
  if (!r.ok) {
    return null;
  }
  return r.ref === "" ? r.label : `${r.label} · ${r.ref}`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test test/unit/recognise.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: clean. If `KIND_NAMES` was missed, `tsc` reports a missing `home` property.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/shared/recognise.ts test/unit/recognise.test.ts
git commit -m "feat(recognise): a product dashboard is a recognised page with no item"
```

---

### Task 2: A discriminated subject in the run store

Replaces the store's `itemId` string with a subject that can be an item **or** a service, so a service-scoped answer is cached once per product. Handlers and the service worker are updated mechanically in the same task, because `StoredRun` is their shared type and the tree must compile.

**Files:**
- Modify: `src/background/agent-run-store.ts:32-47`, `:88-102`, `:123-139`, `:153-158`
- Modify: `src/background/handlers.ts:284-293` (the `getRun`/`putRun` dep signatures), `:429`, `:448`, `:462`
- Modify: `src/background/service-worker.ts:171-173`, `:275-280`, `:290-295`, `:308-313`
- Test: `test/unit/agent-run-store.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `export type RunSubject = { readonly kind: "item"; readonly id: string } | { readonly kind: "service"; readonly service: string }`
  - `StoredRun` is now `{ subject: RunSubject; lane: AgentLane; runId: string; state: LaneState; expiresAtMs: number }`
  - `getRun(subject: RunSubject, lane: AgentLane, nowMs: number)` and `putRun(run: StoredRun, nowMs: number)`
  - Handler deps become `getRun: (subject: RunSubject, lane: AgentLane) => Promise<StoredRun | null>` and `putRun: (run: Omit<StoredRun, "expiresAtMs">) => Promise<void>`

- [ ] **Step 1: Write the failing tests**

In `test/unit/agent-run-store.test.ts`, add these. Keep the existing tests; they will need their `run(...)` helper and `realKey(...)` updated in Step 3 — do that as part of making these pass.

```ts
describe("run subjects", () => {
  it("keeps an item subject and a service subject with the same text apart", async () => {
    const item = { kind: "item" as const, id: "jenkins" };
    const service = { kind: "service" as const, service: "jenkins" };
    await putRun(
      { subject: item, lane: "impact", runId: "r1", state: { kind: "done", brief: "I" }, expiresAtMs: NOW + 1000 },
      NOW,
    );
    await putRun(
      { subject: service, lane: "catchup", runId: "r2", state: { kind: "done", brief: "S" }, expiresAtMs: NOW + 1000 },
      NOW,
    );
    expect((await getRun(item, "impact", NOW))?.runId).toBe("r1");
    expect((await getRun(service, "catchup", NOW))?.runId).toBe("r2");
  });

  it("shares one entry across two instances of the same service", async () => {
    // Two self-hosted Jenkins dashboards produce the SAME subject, so the
    // second visit replays the first answer instead of spending a second run.
    // `service` is a flat connector id — both instances are one scope.
    const subject = { kind: "service" as const, service: "jenkins" };
    await putRun(
      { subject, lane: "catchup", runId: "r1", state: { kind: "done", brief: "B" }, expiresAtMs: NOW + 1000 },
      NOW,
    );
    expect((await getRun(subject, "catchup", NOW))?.runId).toBe("r1");
  });

  it("drops a stored entry written in the old itemId shape", async () => {
    // The pre-subject shape. Dropping it costs at most one re-run: this store
    // is a ten-minute cache, not durable state. Written through
    // `chrome.storage.local.set` directly, exactly as this file's existing
    // "drops a malformed X" tests do.
    chrome.storage.local.set({
      agentRuns: {
        [realKey("item", "abc", "impact")]: {
          itemId: "abc",
          lane: "impact",
          runId: "r1",
          state: { kind: "done", brief: "B" },
          expiresAtMs: NOW + 1000,
          writtenAtMs: NOW,
        },
      },
    });
    expect(await getRun({ kind: "item", id: "abc" }, "impact", NOW)).toBeNull();
  });
});
```

Update the file's existing `realKey` helper (it currently takes `itemId, lane`) to the three-part shape, and update its `run` helper to build `{subject, …}` instead of `{itemId, …}`:

```ts
// The store's real key format (kind + U+0000 + value + U+0000 + lane, matching
// agent-run-store.ts's own KEY_SEP) — built via String.fromCharCode, never a
// literal control character typed into this source file.
const SEP = String.fromCharCode(0);
const realKey = (kind: string, value: string, lane: string) =>
  `${kind}${SEP}${value}${SEP}${lane}`;

const run = (itemId: string, lane: AgentLane, expiresAtMs: number) => ({
  subject: { kind: "item" as const, id: itemId },
  lane,
  runId: `run_${itemId}_${lane}`,
  state: { kind: "done" as const, brief: "B" },
  expiresAtMs,
});
```

Every existing call site of `realKey(itemId, lane)` becomes `realKey("item", itemId, lane)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/unit/agent-run-store.test.ts`
Expected: FAIL — `putRun` does not accept a `subject`.

- [ ] **Step 3: Implement the subject in the store**

In `src/background/agent-run-store.ts`, replace lines 32-47:

```ts
/**
 * What a run is ABOUT.
 *
 * `item` is C2.1's shape: a lane answering about one indexed item. `service` is
 * C2.3's: a lane answering about a whole connector, which has no item to key on.
 * A discriminated union rather than a synthetic string like "service:bitbucket"
 * because upstream item ids are already `${service}:${externalId}`
 * (packages/gateway/src/index/item-key.ts), so a synthetic key would share a
 * namespace SHAPE with real ids — confusable by inspection, and one connector
 * rename away from being ambiguous in fact.
 */
export type RunSubject =
  | { readonly kind: "item"; readonly id: string }
  | { readonly kind: "service"; readonly service: string };

export interface StoredRun {
  readonly subject: RunSubject;
  readonly lane: AgentLane;
  readonly runId: string;
  readonly state: LaneState;
  readonly expiresAtMs: number;
}

// Keyed by `${kind}\u0000${value}\u0000${lane}` — a separator that cannot occur
// in any of the three parts — so neither an item id that looks like a lane name
// nor a service id equal to some item id can collide. UNCHANGED from the
// pre-subject store: keep the escape sequence, never a literal control
// character typed into source.
const KEY_SEP = "\u0000";

function subjectValue(subject: RunSubject): string {
  return subject.kind === "item" ? subject.id : subject.service;
}

function makeKey(subject: RunSubject, lane: AgentLane): string {
  return `${subject.kind}${KEY_SEP}${subjectValue(subject)}${KEY_SEP}${lane}`;
}

function isRunSubject(v: unknown): v is RunSubject {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "item") {
    return typeof v["id"] === "string";
  }
  return v["kind"] === "service" && typeof v["service"] === "string";
}
```

`isObject` is declared below this point in the file today; move the `isObject` declaration above `isRunSubject`, or leave `isRunSubject` where the other guards live — function declarations hoist, so either compiles, but keep the guards together for readability.

Replace the `itemId` check in `isStoredEntry` (line 95):

```ts
    isRunSubject(v["subject"]) &&
```

Replace `toStoredRun` (line 123):

```ts
function toStoredRun(entry: StoredEntry): StoredRun {
  const { subject, lane, runId, state, expiresAtMs } = entry;
  return { subject, lane, runId, state, expiresAtMs };
}
```

Replace the `getRun` signature and body head (line 128):

```ts
export async function getRun(
  subject: RunSubject,
  lane: AgentLane,
  nowMs: number,
): Promise<StoredRun | null> {
  const all = await readAll();
  const found = all[makeKey(subject, lane)];
```

And in `putRun` (line 156):

```ts
    const key = makeKey(run.subject, run.lane);
```

- [ ] **Step 4: Update the handler deps and the service worker**

In `src/background/handlers.ts`, import `RunSubject` alongside `StoredRun`, then change both dep signatures (lines 284 and 292):

```ts
  readonly getRun: (subject: RunSubject, lane: AgentLane) => Promise<StoredRun | null>;
```

At line 429 (`handleAgentRun`'s cache read), line 448 (`putRun`) and line 462 (`handleAgentState`'s cache read), wrap the item id:

```ts
  const cached = await deps.getRun({ kind: "item", id: item.id }, req.lane);
```

```ts
  await deps.putRun({ subject: { kind: "item", id: item.id }, lane: req.lane, runId: invoked.runId, state });
```

```ts
  const cached = await deps.getRun({ kind: "item", id: resolved.item.id }, req.lane);
```

In `src/background/service-worker.ts`, line 172:

```ts
const agentStoreDeps = {
  getRun: (subject: RunSubject, lane: AgentLane) => storeGetRun(subject, lane, Date.now()),
};
```

and in `tickAgentPoll`, the three `putRun` calls (lines 275, 290, 308) each replace `itemId: run.itemId,` with `subject: run.subject,`. Add `RunSubject` to the import from `./agent-run-store.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test test/unit/agent-run-store.test.ts && bun run test test/unit/handlers.test.ts`
Expected: PASS. `handlers.test.ts` will need its fake `getRun`/`putRun` updated to the subject shape — do that now; the assertions themselves do not change.

- [ ] **Step 6: Typecheck and run the whole suite**

Run: `bun run typecheck && bun run test`
Expected: clean, all green.

- [ ] **Step 7: Commit**

```bash
git add src/background/agent-run-store.ts src/background/handlers.ts src/background/service-worker.ts test/unit/
git commit -m "refactor(background): a run is about an item or a service, not only an item"
```

---

### Task 3: Declare the three service lanes

Adds the lanes to the single-sourced tables. After this task the lanes exist and are correctly gated — they render nowhere yet, because no header state offers them.

**Files:**
- Modify: `src/shared/types.ts:239-269` (`AGENT_LANES`, `LANE_SURFACES`)
- Modify: `src/panel/panel-in-page.ts:92-95` (`LANE_TITLES`), `:512-518` (`laneState`, `laneOpen`)
- Test: `test/unit/lane-surfaces.test.ts`

**Interfaces:**
- Consumes: `SurfaceKind`'s `"home"` member (Task 1).
- Produces: `AgentLane` now includes `"catchup" | "decisions" | "ownership"`. `LANE_SURFACES` maps each to `["home"]`. The `isAgentLane` guard in `messages.ts:461` reads `AGENT_LANES`, so it accepts the new lanes with no edit.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/lane-surfaces.test.ts`:

```ts
describe("service lanes", () => {
  it("puts the service-scoped lanes on home and nowhere else", () => {
    for (const lane of ["catchup", "decisions", "ownership"] as const) {
      expect(LANE_SURFACES[lane], lane).toEqual(["home"]);
    }
  });

  it("keeps the item-scoped lanes off home", () => {
    for (const lane of ["impact", "expert"] as const) {
      expect(LANE_SURFACES[lane].includes("home"), lane).toBe(false);
    }
  });

  it("gives every surface kind at least one lane", () => {
    const kinds: readonly SurfaceKind[] = ["pr", "build", "issue", "home"];
    const covered = new Set(Object.values(LANE_SURFACES).flat());
    // `build` and `issue` deliberately have no agent lane yet — assert the two
    // that DO, so this test fails loudly if a future edit empties them.
    expect(covered.has("pr")).toBe(true);
    expect(covered.has("home")).toBe(true);
    expect(kinds.length).toBe(4);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/unit/lane-surfaces.test.ts -t "service lanes"`
Expected: FAIL — `LANE_SURFACES["catchup"]` does not exist.

- [ ] **Step 3: Declare the lanes**

In `src/shared/types.ts`, replace `AGENT_LANES` (line 249) and `LANE_SURFACES` (line 266). Keep the existing doc comment above `AGENT_LANES` and add to it:

```ts
/**
 * The lanes this client ships, and the agent each maps to. A member IS the wire
 * agent name — `invokeAgent` passes it straight through as `{agent}` in
 * `POST /v1/agents/{agent}` — so these must be spelled exactly as upstream's
 * handler keys, and `catchup` is first because it is the question a dashboard
 * exists to answer.
 *
 * `why` is deliberately ABSENT — see the existing note above.
 *
 * `preflight`, `premortem`, `whyPeek` and `negotiate` are absent because
 * upstream excludes them from the HTTP surface entirely
 * (HTTP_EXCLUDED_AGENT_METHODS in packages/gateway/src/ipc/agents-rpc.ts).
 * `ghost` and `conflicts` are absent because both require `{ file }` — a local
 * checkout the browser does not have.
 */
export const AGENT_LANES = ["impact", "expert", "catchup", "decisions", "ownership"] as const;
export type AgentLane = (typeof AGENT_LANES)[number];
```

```ts
export const LANE_SURFACES: Record<AgentLane, readonly SurfaceKind[]> = {
  impact: ["pr"],
  expert: ["pr"],
  // Service-scoped: these answer about a whole connector, so they belong on the
  // one page whose scope is the connector. On an item page they would repeat
  // the same answer for every item on that host.
  catchup: ["home"],
  decisions: ["home"],
  ownership: ["home"],
};
```

- [ ] **Step 4: Give the new lanes titles and initial state**

In `src/panel/panel-in-page.ts`, replace `LANE_TITLES` (line 92):

```ts
const LANE_TITLES: Record<AgentLane, string> = {
  impact: "What breaks if it lands",
  expert: "Who should review it",
  catchup: "What happened while I was away",
  decisions: "What got decided",
  ownership: "Who owns what",
};
```

and the two lane records (lines 512 and 518):

```ts
  const laneState: Record<AgentLane, LaneState> = {
    impact: { kind: "collapsed" },
    expert: { kind: "collapsed" },
    catchup: { kind: "collapsed" },
    decisions: { kind: "collapsed" },
    ownership: { kind: "collapsed" },
  };
  // Whether each lane's own <details> is open, carried across repaints exactly
  // like `relatedExpanded` above.
  const laneOpen: Record<AgentLane, boolean> = {
    impact: false,
    expert: false,
    catchup: false,
    decisions: false,
    ownership: false,
  };
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `bun run test test/unit/lane-surfaces.test.ts && bun run typecheck`
Expected: PASS and clean. If a `Record<AgentLane, …>` was missed, `tsc` names it.

- [ ] **Step 6: Verify no lane leaked onto item pages**

Run: `bun run test test/unit/panel-in-page.test.ts`
Expected: PASS unchanged — a PR page's `surfaceKind` is `"pr"`, so the three new lanes filter out.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/panel/panel-in-page.ts test/unit/lane-surfaces.test.ts
git commit -m "feat(panel): declare the catchup, decisions and ownership lanes"
```

---

### Task 4: Invoke a service lane without resolving

The handler change that makes a service lane possible: on a home page, recognise, then invoke — no resolve call, no item.

**Files:**
- Modify: `src/shared/types.ts` (add `PRODUCT_SERVICE_ID` near `Product`, line 66)
- Modify: `src/background/handlers.ts:331-341` (`ResolveForAgent`), `:353-398` (`resolveForAgent`, `agentParams`), `:419-464` (both handlers)
- Test: `test/unit/handlers.test.ts`

**Interfaces:**
- Consumes: `RunSubject` (Task 2), `"home"` (Task 1), the three lanes (Task 3).
- Produces: `PRODUCT_SERVICE_ID: Record<Product, string>`. `resolveForAgent` now returns a discriminated success: an `item` arm (as today) or a `service` arm carrying `{ origin, token, label, service }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/handlers.test.ts`, following the file's existing dep-fake style. Add `PRODUCT_SERVICE_ID` to that file's import from `../../src/shared/types.ts` — the distinctness test below reads it directly:

```ts
describe("service lanes on a home page", () => {
  it("invokes with the service and never calls resolve", async () => {
    let resolveCalls = 0;
    const invoked: Array<{ agent: string; params: unknown }> = [];
    const deps = {
      getOrigins: async () => [{ origin: "https://jenkins.corp.example", product: "jenkins" as const }],
      getConnection: async () => ({ origin: "http://127.0.0.1:7777", token: "t", label: "dev" }),
      resolveItem: async () => {
        resolveCalls += 1;
        throw new Error("resolve must not be called on a home page");
      },
      invokeAgent: async (_o: string, _t: string, agent: string, params: unknown) => {
        invoked.push({ agent, params });
        return { ok: true as const, runId: "run_1" };
      },
      getRun: async () => null,
      putRun: async () => undefined,
    };

    const res = await handleAgentRun(deps, {
      kind: "agent-run",
      lane: "catchup",
      pageUrl: "https://jenkins.corp.example/",
    });

    expect(resolveCalls).toBe(0);
    expect(invoked).toEqual([{ agent: "catchup", params: { service: "jenkins" } }]);
    expect(res.state).toEqual({ kind: "running", runId: "run_1" });
  });

  it("caches a service run under the service, not a page", async () => {
    const puts: unknown[] = [];
    const deps = {
      getOrigins: async () => [],
      getConnection: async () => ({ origin: "http://127.0.0.1:7777", token: "t", label: "dev" }),
      resolveItem: async () => { throw new Error("unused"); },
      invokeAgent: async () => ({ ok: true as const, runId: "run_2" }),
      getRun: async () => null,
      putRun: async (r: unknown) => { puts.push(r); },
    };

    await handleAgentRun(deps, {
      kind: "agent-run",
      lane: "decisions",
      pageUrl: "https://github.com/",
    });

    expect(puts).toEqual([
      { subject: { kind: "service", service: "github" }, lane: "decisions", runId: "run_2", state: { kind: "running", runId: "run_2" } },
    ]);
  });

  it("replays a cached service answer without a second invoke", async () => {
    let invokes = 0;
    const deps = {
      getOrigins: async () => [],
      getConnection: async () => ({ origin: "http://127.0.0.1:7777", token: "t", label: "dev" }),
      resolveItem: async () => { throw new Error("unused"); },
      invokeAgent: async () => { invokes += 1; return { ok: true as const, runId: "run_3" }; },
      getRun: async () => ({
        subject: { kind: "service" as const, service: "github" },
        lane: "catchup" as const,
        runId: "run_old",
        state: { kind: "done" as const, brief: "Yesterday: 3 merges." },
        expiresAtMs: Number.MAX_SAFE_INTEGER,
      }),
      putRun: async () => undefined,
    };

    const res = await handleAgentRun(deps, {
      kind: "agent-run",
      lane: "catchup",
      pageUrl: "https://github.com/",
    });

    expect(invokes).toBe(0);
    expect(res.state).toEqual({ kind: "done", brief: "Yesterday: 3 merges." });
  });

  it("maps every product to a distinct service id", () => {
    // The one mistake in this map a compiler cannot see: a copy-paste typo
    // like `github: "gitlab"` typechecks fine and silently asks the wrong
    // connector. An upstream RENAME is still undetectable here — see the map's
    // own doc comment — so this asserts distinctness, not correctness.
    const ids = Object.values(PRODUCT_SERVICE_ID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuses a service lane when the page is not recognised", async () => {
    const deps = {
      getOrigins: async () => [],
      getConnection: async () => ({ origin: "http://127.0.0.1:7777", token: "t", label: "dev" }),
      resolveItem: async () => { throw new Error("unused"); },
      invokeAgent: async () => { throw new Error("must not invoke"); },
      getRun: async () => null,
      putRun: async () => undefined,
    };

    const res = await handleAgentRun(deps, {
      kind: "agent-run",
      lane: "catchup",
      pageUrl: "https://example.com/whatever",
    });

    expect(res.state).toEqual({ kind: "failed", reason: "not_resolved" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/unit/handlers.test.ts -t "service lanes on a home page"`
Expected: FAIL — `resolveForAgent` calls `resolveItem`, which throws.

- [ ] **Step 3: Add the product→service map**

In `src/shared/types.ts`, directly below the `Product` declaration (line 66):

```ts
/**
 * The gateway's connector id for each recognised product.
 *
 * MIRRORS upstream's per-connector `SERVICE_ID` constants
 * (packages/gateway/src/connectors/<product>-sync.ts) — the value written to
 * `item.service` and the value `agents.catchup`/`decisions`/`ownership` filter
 * on. Today it is an identity map, and it is written out anyway on purpose:
 * the agreement between this union and those constants is CONVENTION BETWEEN
 * TWO REPOSITORIES, not contract.
 *
 * What this buys is discoverability, NOT enforcement. The type only checks that
 * every `Product` has an entry — if upstream renamed "jenkins" to "jenkins-ci",
 * this map would keep typechecking green while every Jenkins lane quietly asked
 * about a service that no longer exists. Validating against
 * `GET /v1/connectors` was considered and rejected: it reads the `sync_state`
 * table, so an unconfigured connector is absent from it exactly like a renamed
 * one, and it cannot tell the two apart.
 */
export const PRODUCT_SERVICE_ID: Record<Product, string> = {
  bitbucket: "bitbucket",
  github: "github",
  gitlab: "gitlab",
  jenkins: "jenkins",
  jira: "jira",
};
```

- [ ] **Step 4: Branch the agent path on a home page**

In `src/background/handlers.ts`, replace the `ResolveForAgent` type (line 331):

```ts
/**
 * What a lane needs before it can invoke. Two success arms, because a lane is
 * about one of two things: an indexed ITEM (C2.1) or a whole SERVICE (C2.3).
 * The service arm exists precisely so the home path can skip the resolve call —
 * there is no item to resolve, and a dashboard URL sent to `resolve` would come
 * back `unresolvable`, reporting a miss for a page that was never meant to hit.
 */
type ResolveForAgent =
  | {
      readonly ok: true;
      readonly scope: "item";
      readonly origin: string;
      readonly token: string;
      readonly label: string;
      /** The URL sent to `resolve` — the same one `impact` is given. */
      readonly resolveUrl: string;
      readonly item: ResolvedItem;
    }
  | {
      readonly ok: true;
      readonly scope: "service";
      readonly origin: string;
      readonly token: string;
      readonly label: string;
      readonly service: string;
    }
  | { readonly ok: false; readonly reason: AgentError; readonly scopeGap?: ScopeGap };
```

In `resolveForAgent`, insert the home branch immediately after the recogniser gate (after line 362) and add `scope: "item"` to the existing success return:

```ts
  const conn = await deps.getConnection();
  if (conn === null) {
    return { ok: false, reason: "not_paired" };
  }
  if (recognition.kind === "home") {
    // No resolve call: a dashboard has no indexed item, and `Recognition.product`
    // IS the gateway's connector id, so the only parameter these lanes need is
    // already in hand. This is also why a service lane works on a pairing that
    // never received the `resolve` scope — it needs only `agents`.
    return {
      ok: true,
      scope: "service",
      origin: conn.origin,
      token: conn.token,
      label: conn.label,
      service: PRODUCT_SERVICE_ID[recognition.product],
    };
  }
```

(The existing `const conn = …` block at line 363 moves above the new branch; delete the old copy so the connection is read exactly once.)

Then in the final success return of `resolveForAgent`, add the discriminant:

```ts
  return {
    ok: true,
    scope: "item",
    origin: conn.origin,
    ...
  };
```

Replace `agentParams` (line 396):

```ts
/**
 * The gateway validates this body verbatim, so each agent gets exactly what it
 * accepts: `impact` takes the page's PR URL, `expert` free text to match against
 * indexed titles, and the three service lanes take the connector id alone.
 *
 * No `sinceMs`, `minConfidence` or `limit` is sent. The gateway owns those
 * defaults and re-reads its config per call, so a client-side knob would only
 * be a second place for the same number to disagree.
 */
function agentParams(lane: AgentLane, resolved: ResolveForAgent & { ok: true }): unknown {
  if (resolved.scope === "service") {
    return { service: resolved.service };
  }
  return lane === "impact"
    ? { fileOrPrUrl: resolved.resolveUrl }
    : { topicOrFile: resolved.item.title };
}

/** The cache key for a lane: the item it is about, or the service it is about. */
function subjectFor(resolved: ResolveForAgent & { ok: true }): RunSubject {
  return resolved.scope === "service"
    ? { kind: "service", service: resolved.service }
    : { kind: "item", id: resolved.item.id };
}
```

Update `handleAgentRun` (from line 427) to use them:

```ts
  const subject = subjectFor(resolved);
  const cached = await deps.getRun(subject, req.lane);
  if (cached !== null && (cached.state.kind === "running" || cached.state.kind === "done")) {
    return { kind: "agent-state", lane: req.lane, state: cached.state };
  }

  const params = agentParams(req.lane, resolved);
  const invoked = await invokeWithRetry(deps, resolved.origin, resolved.token, req.lane, params);
  if (!invoked.ok) {
    const scopeGap =
      invoked.scopeGap === undefined ? undefined : { label: resolved.label, ...invoked.scopeGap };
    return failedResponse(req.lane, invoked.reason, scopeGap);
  }
  const state = { kind: "running" as const, runId: invoked.runId };
  await deps.putRun({ subject, lane: req.lane, runId: invoked.runId, state });
  return { kind: "agent-state", lane: req.lane, state };
```

and `handleAgentState` (line 462):

```ts
  const cached = await deps.getRun(subjectFor(resolved), req.lane);
```

Add `PRODUCT_SERVICE_ID` to the `../shared/types.ts` import and `RunSubject` to the `./agent-run-store.ts` import.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test test/unit/handlers.test.ts`
Expected: PASS, including every pre-existing agent test.

- [ ] **Step 6: Typecheck, lint, full suite**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: clean, all green.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/background/handlers.ts test/unit/handlers.test.ts
git commit -m "feat(background): a service lane invokes from the recogniser alone"
```

---

### Task 5: Answer a home page without calling resolve

`handleResolve` is what the panel calls to build its header. On a home page it must short-circuit before the gateway, exactly as it already does for an unrecognised page.

**Files:**
- Modify: `src/background/handlers.ts:173-192` (`handleResolve`)
- Test: `test/unit/handlers.test.ts`

**Interfaces:**
- Consumes: `"home"` (Task 1).
- Produces: `handleResolve` on a home page returns `{kind:"resolve", ok:true, recognition, outcome:{kind:"not-indexed", fetchable:false}}` with **no** gateway call. The outcome is inert — Task 7's `headerFrom` branches on `recognition.kind` before reading it.

- [ ] **Step 1: Write the failing test**

```ts
it("answers a home page without calling the gateway", async () => {
  let resolveCalls = 0;
  const deps = {
    getOrigins: async () => [],
    getConnection: async () => ({ origin: "http://127.0.0.1:7777", token: "t", label: "dev" }),
    resolveItem: async () => {
      resolveCalls += 1;
      return { ok: true as const, outcome: { kind: "not-indexed" as const, fetchable: false } };
    },
  };

  const res = await handleResolve(deps, {
    kind: "resolve",
    pageUrl: "https://github.com/",
    title: "GitHub",
  });

  expect(resolveCalls).toBe(0);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.recognition.ok).toBe(true);
  if (!res.recognition.ok) return;
  expect(res.recognition.kind).toBe("home");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test test/unit/handlers.test.ts -t "without calling the gateway"`
Expected: FAIL — `resolveCalls` is 1.

- [ ] **Step 3: Short-circuit the home page**

In `src/background/handlers.ts`, insert after the unrecognised gate (after line 187):

```ts
  if (recognition.kind === "home") {
    // A dashboard has no indexed item and is not supposed to have one, so there
    // is nothing to ask the gateway. The outcome below is INERT: `headerFrom`
    // (panel-in-page.ts) branches on `recognition.kind` before it reads an
    // outcome, so a home page never renders as a miss. It is filled in only
    // because `ResolveResponse`'s ok arm requires one — the same synthetic the
    // unrecognised branch above already uses. `fetchable:false` keeps the C3.1
    // button away from a page that is not a fetch candidate.
    return {
      kind: "resolve",
      ok: true,
      recognition,
      outcome: { kind: "not-indexed", fetchable: false },
    };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test test/unit/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Pin that the ambient cue stays silent on a dashboard**

`ambient.ts:79` mounts a cue only when `response.outcome.kind === "found"`, so a
home page is silent by construction — Step 3's synthetic outcome is `not-indexed`.
That is a behaviour the spec commits to, so pin it rather than leaving it to
survive by luck. Append to `test/unit/ambient.test.ts`, following that file's
existing dep-injection style:

```ts
it("mounts no cue on a product dashboard", async () => {
  let mounted = 0;
  const deps = {
    ...baseDeps,
    resolve: async () => ({
      kind: "resolve" as const,
      ok: true as const,
      recognition: {
        ok: true as const,
        product: "github" as const,
        kind: "home" as const,
        label: "GitHub dashboard",
        ref: "",
        resolveUrl: "https://github.com/",
      },
      outcome: { kind: "not-indexed" as const, fetchable: false },
    }),
    mountCue: async () => {
      mounted += 1;
    },
  };

  await maybeSurfaceCue(deps, { tabId: 1, pageUrl: "https://github.com/" });

  expect(mounted).toBe(0);
});
```

Use the file's real exported entry point and dep names rather than `baseDeps` /
`maybeSurfaceCue` if they differ — the assertion is what matters: a home resolve
mounts nothing.

Run: `bun run test test/unit/ambient.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/handlers.ts test/unit/handlers.test.ts test/unit/ambient.test.ts
git commit -m "feat(background): a dashboard resolves to nothing, without asking"
```

---

### Task 6: The service header

A pure-view task: one new `HeaderState` arm and its rendering.

**Files:**
- Modify: `src/panel/panel-view.ts:99-179` (`HeaderState`), `:302-463` (`renderHeader`)
- Test: `test/unit/panel-view.test.ts`

**Interfaces:**
- Consumes: `Product` from `shared/types.ts` (already imported by this file).
- Produces: `HeaderState` gains `{ readonly kind: "service"; readonly surface: string; readonly product: Product }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/panel-view.test.ts` (this file already opts into jsdom — keep its docblock):

```ts
describe("the service header", () => {
  const state = {
    kind: "service" as const,
    surface: "Jenkins dashboard",
    product: "jenkins" as const,
  };

  it("names the surface and states the scope", () => {
    const el = renderHeader(document, state);
    expect(el.textContent).toContain("Jenkins dashboard");
    expect(el.textContent).toContain("across all indexed Jenkins builds");
  });

  it("offers no fetch button, no freshness line and no item link", () => {
    const el = renderHeader(document, state);
    expect(el.querySelector("button")).toBeNull();
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).not.toContain("Updated");
    expect(el.textContent).not.toContain("Not indexed");
  });

  it("does not name the instance host", () => {
    // Naming `jenkins.prod.local` would imply the answer is scoped to that
    // instance; it spans every indexed Jenkins. The scope line says the true,
    // coarser thing instead.
    const el = renderHeader(document, state);
    expect(el.textContent).not.toContain("local");
    expect(el.textContent).not.toContain("http");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/unit/panel-view.test.ts -t "the service header"`
Expected: FAIL — `"service"` is not assignable to `HeaderState`.

- [ ] **Step 3: Add the arm**

In `src/panel/panel-view.ts`, add to the `HeaderState` union (after the `unrecognised` arm, line 101):

```ts
  /**
   * A recognised page with NO indexed item, and that is correct rather than a
   * failure: a product's own dashboard. Deliberately not `not-indexed`, which
   * describes a page that should have resolved and didn't — and which offers a
   * fetch button that would propose indexing a dashboard as an item.
   */
  | { readonly kind: "service"; readonly surface: string; readonly product: Product }
```

- [ ] **Step 4: Render it**

First add the corpus table next to the file's other copy constants (near
`PRODUCT_NAMES`, which this file already imports for the `fetching` arm at line
398). A single noun would be wrong for four of the five products — "builds" is
false about Jira — and a false claim about what the lanes cover is exactly what
this header exists to avoid:

```ts
/** What a connector's indexed items ARE, for the dashboard scope line. The
 *  lanes answer across the whole connector, so this noun is a claim about
 *  coverage — a wrong one reads as a promise the answer does not keep. */
const PRODUCT_CORPUS: Record<Product, string> = {
  bitbucket: "Bitbucket repositories",
  github: "GitHub repositories",
  gitlab: "GitLab projects",
  jenkins: "Jenkins builds",
  jira: "Jira projects",
};
```

Then, in `renderHeader`, add this branch immediately after the shared
`box.append(line(doc, "nimbus-related__surface", state.surface));` at line 337:

```ts
  if (state.kind === "service") {
    // The scope line, not the host. Stripped of the item link, the freshness
    // line and the fetch button, this header would otherwise be a bare product
    // name — and the scope is the one fact needed to read the lanes correctly:
    // `{service}` spans the whole connector, so the answer covers every indexed
    // instance, not the one in the address bar.
    box.append(
      line(
        doc,
        "nimbus-related__status",
        `Nimbus can answer across all indexed ${PRODUCT_CORPUS[state.product]}.`,
      ),
    );
    return box;
  }
```

For `product: "jenkins"` this renders "Nimbus can answer across all indexed
Jenkins builds." — the substring Step 1's test asserts on.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test test/unit/panel-view.test.ts`
Expected: PASS, including the exhaustiveness backstop at line 459 — the new arm returns before it.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/panel/panel-view.ts test/unit/panel-view.test.ts
git commit -m "feat(panel): a header for a page Nimbus knows and has no item for"
```

---

### Task 7: Wire the dashboard panel

Connects the pieces: a home resolve becomes the service header, the three lanes render there, and the related lane does not.

**Files:**
- Modify: `src/panel/panel-in-page.ts:275-315` (`headerFrom`), `:883-927` (`paint`'s header and lane assembly)
- Test: `test/unit/panel-in-page.test.ts`

**Interfaces:**
- Consumes: the service `HeaderState` arm (Task 6), the lanes (Task 3), the home resolve response (Task 5).
- Produces: no new exports. `paint()` renders `agentLanes` when the shown header is `resolved` **or** `service`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/panel-in-page.test.ts`. This uses the file's existing
`mountPanelWithResolve(resolveResponse)` helper (line 67), which stubs the
`resolve` message with the given response, answers `related` with an empty list,
and returns the panel's shadow root:

```ts
describe("the dashboard panel", () => {
  const HOME_RESOLVE = {
    kind: "resolve",
    ok: true,
    recognition: {
      ok: true,
      product: "github",
      kind: "home",
      label: "GitHub dashboard",
      ref: "",
      resolveUrl: "https://github.com/",
    },
    outcome: { kind: "not-indexed", fetchable: false },
  };

  const PR_RESOLVE = {
    kind: "resolve",
    ok: true,
    recognition: {
      ok: true,
      product: "github",
      kind: "pr",
      label: "GitHub PR",
      ref: "acme/web #482",
      resolveUrl: "https://github.com/acme/web/pull/482",
    },
    outcome: {
      kind: "found",
      matchKind: "exact",
      item: {
        id: "github:482",
        service: "github",
        type: "pr",
        title: "Add the thing",
        url: "https://github.com/acme/web/pull/482",
        modifiedAt: 1_800_000_000_000,
      },
    },
  };

  const laneIds = (root: ShadowRoot): (string | null)[] =>
    [...root.querySelectorAll("details[data-lane]")].map((el) => el.getAttribute("data-lane"));

  it("renders the service header and the three service lanes", async () => {
    const root = await mountPanelWithResolve(HOME_RESOLVE);
    expect(headerText()).toContain("GitHub dashboard");
    expect(laneIds(root)).toEqual(["catchup", "decisions", "ownership"]);
  });

  it("shows no related lane on a dashboard", async () => {
    const root = await mountPanelWithResolve(HOME_RESOLVE);
    expect(root.querySelector('details[data-lane="related"]')).toBeNull();
  });

  it("still shows related and the item lanes on a pull request", async () => {
    const root = await mountPanelWithResolve(PR_RESOLVE);
    expect(laneIds(root)).toEqual(["related", "impact", "expert"]);
  });
});
```

If `PR_RESOLVE`'s item shape drifts from the fixture the file already uses for
resolved pull requests, prefer the file's existing one — it is the same response
shape, and two copies that disagree is the drift this repo keeps single-sourcing
to avoid.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/unit/panel-in-page.test.ts -t "the dashboard panel"`
Expected: FAIL — the header renders as "Not indexed." and no agent lanes appear.

- [ ] **Step 3: Map a home recognition to the service header**

In `src/panel/panel-in-page.ts`, in `headerFrom`, insert immediately after the `surface === null` check (after line 295):

```ts
  // Before any outcome is read. A home page carries an inert outcome
  // (handlers.ts fills one in only because the response type demands it), so
  // reading it here would render a dashboard as a miss.
  if (res.recognition.ok && res.recognition.kind === "home") {
    return { kind: "service", surface, product: res.recognition.product };
  }
```

- [ ] **Step 4: Render lanes on the service header, and drop related there**

In `paint()`, replace the `agentLanes` gate (line 908) and the `lanes` assembly (line 924):

```ts
    const agentLanes: Lane[] =
      (shown.kind === "resolved" || shown.kind === "service") && surfaceKind !== null
        ? AGENT_LANES.filter((lane) => LANE_SURFACES[lane].includes(surfaceKind)).map((lane) => ({
            id: lane,
            title: LANE_TITLES[lane],
            expanded: laneOpen[lane],
            render: (doc: Document) =>
              renderLaneBody(doc, laneState[lane], () => {
                sendAgentRun(lane).catch(() => undefined);
              }),
          }))
        : [];
    // No related lane on a dashboard: `/v1/clips/related` keyed on a dashboard's
    // title and URL returns noise dressed as recall. The related REQUEST is still
    // sent — it is fired in parallel with the resolve, before the recognition is
    // known, and serialising the two would slow every item page to save one
    // loopback call on a dashboard. Its answer is simply not rendered.
    const lanes: Lane[] =
      surfaceKind === "home"
        ? agentLanes
        : [
            { id: "related", title: "Related", expanded: relatedExpanded, render: relatedBody },
            ...agentLanes,
          ];
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test test/unit/panel-in-page.test.ts`
Expected: PASS, all pre-existing tests included.

- [ ] **Step 6: Full gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/panel/panel-in-page.ts test/unit/panel-in-page.test.ts
git commit -m "feat(panel): the dashboard panel — three service lanes, no related"
```

---

### Task 8: Forget cached runs when the pairing changes

`handleUnpair` clears the connection and nothing else, so cached agent answers
outlive the gateway they came from. Re-pair to a different gateway inside the
ten-minute TTL and a lane can replay the previous gateway's answer.

This is pre-existing — it is already true of item-scoped runs — but the service
lanes make it materially easier to hit, which is why it lands here. An item
subject is `{kind:"item", id:"github:482"}`, at least somewhat specific; a
service subject is `{kind:"service", service:"github"}`, which is **identical on
every gateway**. Any two gateways that both index GitHub collide on it.

**Files:**
- Modify: `src/background/agent-run-store.ts` (add `clearRuns`)
- Modify: `src/background/handlers.ts:524-529` (`UnpairDeps`, `handleUnpair`)
- Modify: `src/background/service-worker.ts:563` (the unpair route's deps)
- Test: `test/unit/agent-run-store.test.ts`, `test/unit/handlers.test.ts`

**Interfaces:**
- Consumes: `RunSubject` and the store from Task 2.
- Produces: `export function clearRuns(): Promise<void>` in `agent-run-store.ts`. `UnpairDeps` grows `readonly clearRuns: () => Promise<void>`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/agent-run-store.test.ts`:

```ts
it("clears every stored run", async () => {
  await putRun(
    { subject: { kind: "service", service: "github" }, lane: "catchup", runId: "r1", state: { kind: "done", brief: "B" }, expiresAtMs: NOW + 1000 },
    NOW,
  );
  await clearRuns();
  expect(await getRun({ kind: "service", service: "github" }, "catchup", NOW)).toBeNull();
});
```

In `test/unit/handlers.test.ts`:

```ts
it("forgets cached agent runs on unpair", async () => {
  let cleared = 0;
  const res = await handleUnpair({
    clearConnection: async () => undefined,
    clearRuns: async () => {
      cleared += 1;
    },
  });
  expect(cleared).toBe(1);
  expect(res).toEqual({ kind: "connection", paired: false });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/unit/agent-run-store.test.ts -t "clears every stored run"`
Expected: FAIL — `clearRuns` is not exported.

- [ ] **Step 3: Implement `clearRuns`**

In `src/background/agent-run-store.ts`, beside `putRun` so it joins the same
single-writer chain — a clear racing a concurrent `putRun` would otherwise be
overwritten by a snapshot read before it:

```ts
/**
 * Drop every cached run. Called on unpair: a cached brief is an answer from ONE
 * gateway, and the next pairing may be a different one. A service subject makes
 * this sharp — `{kind:"service", service:"github"}` is identical on every
 * gateway, so without this a lane could replay another gateway's answer for the
 * rest of the TTL.
 */
export function clearRuns(): Promise<void> {
  const next = chain.then(async () => {
    await storageSet(STORE_KEY, {});
  });
  chain = next.catch(() => undefined);
  return next;
}
```

- [ ] **Step 4: Call it from unpair**

In `src/background/handlers.ts`, extend `UnpairDeps` and `handleUnpair`:

```ts
export interface UnpairDeps {
  readonly clearConnection: () => Promise<void>;
  /** Cached briefs belong to the gateway that produced them — see clearRuns. */
  readonly clearRuns: () => Promise<void>;
}

export async function handleUnpair(deps: UnpairDeps): Promise<ConnectionResponse> {
  await deps.clearConnection();
  await deps.clearRuns();
  return { kind: "connection", paired: false };
}
```

In `src/background/service-worker.ts` line 563, pass the new dep and add
`clearRuns` to the `./agent-run-store.ts` import:

```ts
    handleUnpair({ clearConnection, clearRuns })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test test/unit/agent-run-store.test.ts && bun run test test/unit/handlers.test.ts`
Expected: PASS.

- [ ] **Step 6: Full gate**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: clean, all green.

- [ ] **Step 7: Commit**

```bash
git add src/background/agent-run-store.ts src/background/handlers.ts src/background/service-worker.ts test/unit/
git commit -m "fix(background): a cached brief belongs to the gateway that made it"
```

---

### Task 9: Documentation and roadmap corrections

The slice is not done until the reference docs describe it and the roadmap stops being wrong about upstream.

**Files:**
- Modify: `docs/architecture.md` (the agent-lanes section)
- Modify: `ROADMAP.md` (C2.3's brief)
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Document the service-lane path in `docs/architecture.md`**

In the agent-lanes section, add a subsection covering: the two lane scopes (item vs service); that a service lane skips resolve entirely because `Recognition.product` is the connector id; that it therefore needs only the `agents` scope; the `RunSubject` key, why two instances of one product share an entry, and why unpair now clears the store (Task 8); and that `ownership` degrades to a gap brief without `[[filesystem.roots]]`.

- [ ] **Step 2: Correct C2.3 in `ROADMAP.md`**

Mark C2.3 shipped, and correct the three stale claims the spec identifies, in the same style C2.1 used for its own correction:

- the agent count ("thirteen agents") is stale as of upstream `ea37e0d0`;
- there are **four** HTTP exclusions, not three — `agents.negotiate` is the fourth, excluded because combined with `--person` it would let any holder of the `agents` token assemble a contribution dossier on any indexed person;
- the brief framed `catchup`/`decisions`/`ownership` as lanes to map onto existing surfaces; they are service-scoped and needed a service-scoped surface, which this slice added.

Also note what shipped: dashboard recognition as `SurfaceKind: "home"`, the three lanes there and nowhere else, no resolve call on that path, and the ambient cue staying silent on dashboards.

- [ ] **Step 3: Add the changelog entry**

Under `## [Unreleased]`:

```markdown
### Added
- The panel now recognises a product's own dashboard — GitHub, GitLab, Bitbucket,
  Jira and Jenkins — and offers three lanes there: *What happened while I was
  away*, *What got decided* and *Who owns what*. They answer across the whole
  connector, which is what the header says, and they need no indexed item.

### Fixed
- Unpairing now clears cached agent answers, so a brief can no longer outlive the
  gateway that produced it.
```

- [ ] **Step 4: Verify the docs match the code**

Re-read the spec's "Done when" list and confirm each line is true of the implementation. Run the full gate one more time:

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md ROADMAP.md CHANGELOG.md
git commit -m "docs: record the service lanes, and correct C2.3's upstream claims"
```

---

## Manual verification

`docs/development.md` is the dev-load checklist for surfaces that are not unit-tested. After Task 7, load the unpacked build and confirm on a real profile:

1. On `https://github.com/` with page access granted, open the panel. The header reads **GitHub dashboard** and names the scope; the three service lanes are present; there is no Related lane and no fetch button.
2. Expand *What happened while I was away*. It reaches `running`, then `done` with a brief — or a named failure. Never an empty lane.
3. Close and reopen the panel, then re-expand the same lane. The stored brief replays; no second run starts.
4. Open the panel on a pull request. Related, *What breaks if it lands* and *Who should review it* are present; none of the three service lanes are.
5. On the dashboard, confirm **no ambient cue** appears, with the per-host toggle on.
6. With no `[[filesystem.roots]]` configured, *Who owns what* renders the gateway's gap brief including its `nimbus index add` line — not a blank lane.

## Deferred, with reasons

**Skipping the `related` request on a dashboard.** Task 7 suppresses the related
*lane* but still lets the request fire — it goes out in parallel with the resolve,
before any recognition is known. Two fixes were considered and both cost more than
the waste:

- *Short-circuit `handleRelated` in the service worker.* `RelatedDeps` has no
  `getOrigins` today (`handlers.ts:112`), so this adds a `chrome.storage` read plus
  a `recognise()` call to **every** related request — taxing the item-page hot path
  to save one loopback call on the cold path. Backwards.
- *Check the URL in the panel before sending.* The panel can import `recognise`,
  but not the user's configured origins — those live behind the service worker. It
  would therefore work for the built-in SaaS hosts and silently not work for
  self-hosted Jenkins, Jira Server and Bitbucket Server, which is exactly where the
  dashboards matter most. A check that works on half the surfaces is worse than no
  check.

What is actually spent is one loopback POST to a local gateway whose response is
discarded: no user-visible latency (it is parallel), no privacy exposure, no
meaningful rate-limit pressure. Revisit if `RelatedDeps` ever grows `getOrigins`
for its own reasons — then the short-circuit is free.

## Known-weak lane

`ownership` returns a gap-only brief on a gateway with no git-aware filesystem roots (`packages/gateway/src/agents/ownership.ts:80`), which is the normal case for a browser-first user. The client cannot detect this in advance, so the lane cannot be hidden when it will not answer. The brief already carries its own remedy — **do not add a client-side action beside it**, which would require pattern-matching gateway prose. See the spec's "Honest gaps" section.
