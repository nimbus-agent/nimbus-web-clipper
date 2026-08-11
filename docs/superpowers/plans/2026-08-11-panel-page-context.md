# Panel Page Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An open panel describes exactly one page — the one its header names — and
offers only the lanes that page's surface can answer.

**Architecture:** The panel pins its page URL at mount and sends that URL with
every message, so the header and a lane can never describe different items. A
500 ms watcher compares the tab's *item identity* (not its URL) against the pin
and, on a real change, renders a notice naming the pinned item with one **Re-read
page** button that re-pins and resets the page-scoped state. Separately, the two
agent lanes move behind a `LANE_SURFACES` table so they appear on pull requests
only.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`), Vitest (node env; jsdom via a per-file docblock),
Biome, esbuild, Bun as the runner. MV3 extension — Chrome + Firefox.

**Spec:** [`docs/superpowers/specs/2026-08-11-panel-page-context-design.md`](../specs/2026-08-11-panel-page-context-design.md)
(read it first; the review round at its end records what was rejected and why).

## Global Constraints

- **No `any`.** Cross-boundary data is `unknown`, narrowed by a guard in
  `src/shared/messages.ts`.
- **No `console.*` anywhere in `src/`.** Biome enforces it (`noConsole`). Detached
  promises swallow with `.catch(() => undefined)`, matching the existing code.
- **No non-null assertions** (`noNonNullAssertion`). Narrow instead.
- **Never log or render the bearer token or the pairing code.**
- **Loopback only.** This slice adds no fetch, no host permission, no new
  destination. `handleRecognise` must make **no** gateway call.
- **No new runtime dependency.** The shipped extension has no `node_modules`.
- **Keep pure logic out of the `chrome.*` seam** so it stays unit-testable.
- **`exactOptionalPropertyTypes` is on:** add an optional property with
  `...(x === undefined ? {} : { key: x })`, never `key: undefined`.
- **Copy is fixed** (from the spec, use verbatim): notice lead **"You've moved
  on."**; second line **"This panel is still about `<ref>`."** or, when there is no
  ref, **"This panel is still about the page you opened it on."**; button
  **"Re-read page"**.
- **Every task ends green:** `bun run typecheck && bun run lint && bun run test`.
- **Commit at the end of every task.** Conventional-commit prefixes as in
  `git log` (`feat(panel):`, `fix(panel):`, `docs:`).

---

### Task 1: `sameItem` — the identity comparison

**Files:**
- Modify: `src/shared/recognise.ts` (append after `surfaceLine`, ~line 220)
- Test: `test/unit/recognise.test.ts`

**Interfaces:**
- Consumes: `Recognition` from `src/shared/types.ts` (already imported in
  `recognise.ts`).
- Produces: `export function sameItem(a: Recognition, b: Recognition): boolean` —
  used by Task 7's watcher.

**Why identity and not URL equality:** `resolveUrl` deliberately preserves sub-tab
segments and the query string (`recognise.ts:192-207`), so `/pull/482` and
`/pull/482/files` have different `resolveUrl`s and are the same item. The identity
is `(product, kind, ref)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/recognise.test.ts` (the file already defines `NONE` and
`SELF_HOSTED` at the top — reuse them):

```ts
describe("sameItem", () => {
  const gh = (path: string) => recognise(`https://github.com${path}`, NONE);

  it("is true across a PR's sub-tabs", () => {
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/web/pull/482/files"))).toBe(true);
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/web/pull/482/commits"))).toBe(true);
  });

  it("is true across query strings and fragments", () => {
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/web/pull/482?diff=split"))).toBe(true);
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/web/pull/482#issuecomment-1"))).toBe(true);
  });

  it("is false for a different number or repo", () => {
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/web/pull/517"))).toBe(false);
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/api/pull/482"))).toBe(false);
  });

  it("is false between a recognised and an unrecognised page", () => {
    expect(sameItem(gh("/acme/web/pull/482"), gh("/acme/web"))).toBe(false);
    expect(sameItem(gh("/acme/web"), gh("/acme/web/pull/482"))).toBe(false);
  });

  // Both are "no item here". Their `reason` (unknown-host vs unrecognised-path) is
  // a diagnostic about the URL, not a different item — without this rule, wandering
  // between two unrecognised pages under an open panel would re-notify for no
  // user-visible change.
  it("treats any two unrecognised pages as the same non-item", () => {
    expect(sameItem(gh("/acme/web"), gh("/acme/api"))).toBe(true);
    expect(sameItem(gh("/acme/web"), recognise("https://example.com/x", NONE))).toBe(true);
  });

  // The Jira matcher upper-cases the key, so one issue has one identity however
  // the link was typed (recognise.ts's own reasoning).
  it("ignores Jira issue-key case", () => {
    const a = recognise("https://corp.example/jira/browse/abc-12", SELF_HOSTED);
    const b = recognise("https://corp.example/jira/browse/ABC-12", SELF_HOSTED);
    expect(sameItem(a, b)).toBe(true);
  });

  it("distinguishes two products that resolve the same ref shape", () => {
    const jenkins = recognise("https://corp.example/jenkins/job/web/482", SELF_HOSTED);
    expect(sameItem(gh("/acme/web/pull/482"), jenkins)).toBe(false);
  });
});
```

Add `sameItem` to the existing import from `../../src/shared/recognise.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/recognise.test.ts -t "sameItem"`
Expected: FAIL — `sameItem is not a function` (or a TS resolution error).

- [ ] **Step 3: Implement**

Append to `src/shared/recognise.ts`:

```ts
/**
 * Whether two recognitions name the SAME indexed item.
 *
 * NOT a URL comparison, and it must not become one: `resolveUrl` above keeps
 * sub-tab segments and the query string on purpose, so `/pull/482` and
 * `/pull/482/files` differ as URLs while being one pull request. The identity is
 * `(product, kind, ref)`, all three of which the matchers normalise.
 *
 * Two UNRECOGNISED pages compare EQUAL: both are "no item here", and their
 * `reason` describes the URL, not a different item. The panel's navigation watcher
 * relies on that — otherwise moving between two unrecognised pages under an open
 * panel would announce a change the user cannot see.
 */
export function sameItem(a: Recognition, b: Recognition): boolean {
  if (!a.ok || !b.ok) {
    return !a.ok && !b.ok;
  }
  return a.product === b.product && a.kind === b.kind && a.ref === b.ref;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/recognise.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Full gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test
git add src/shared/recognise.ts test/unit/recognise.test.ts
git commit -m "feat(shared): sameItem — compare page identity, not URL"
```

---

### Task 2: `LANE_SURFACES` — which lanes belong on which surface

**Files:**
- Modify: `src/shared/types.ts` (immediately after `AGENT_LANES`, ~line 239)
- Test: Create `test/unit/lane-surfaces.test.ts`

**Interfaces:**
- Consumes: `AgentLane`, `SurfaceKind` (both already in `types.ts`).
- Produces: `export const LANE_SURFACES: Record<AgentLane, readonly SurfaceKind[]>`
  — consumed by Task 4's filter.

**Note:** `src/shared/types.ts` contains **no functions** — it is types and frozen
constants only. Keep it that way: this task adds a constant, and the filter that
reads it lives at its one call site in Task 4.

- [ ] **Step 1: Write the failing test**

Create `test/unit/lane-surfaces.test.ts`:

```ts
// test/unit/lane-surfaces.test.ts
import { describe, expect, it } from "vitest";
import { AGENT_LANES, LANE_SURFACES, type SurfaceKind } from "../../src/shared/types.ts";

const ALL_KINDS: readonly SurfaceKind[] = ["pr", "build", "issue"];

describe("LANE_SURFACES", () => {
  it("covers every lane", () => {
    expect(Object.keys(LANE_SURFACES).sort()).toEqual([...AGENT_LANES].sort());
  });

  // A lane with no surfaces could never render — it would be dead config that
  // typechecks. A lane naming a kind the recogniser cannot produce is the same
  // defect pointing the other way.
  it("gives every lane at least one real surface kind", () => {
    for (const lane of AGENT_LANES) {
      expect(LANE_SURFACES[lane].length).toBeGreaterThan(0);
      for (const kind of LANE_SURFACES[lane]) {
        expect(ALL_KINDS).toContain(kind);
      }
    }
  });

  // The C2.1 lanes ask about a change under review. `agents.impact` takes a
  // `fileOrPrUrl` and `expert` asks who should review it — neither question means
  // anything about a Jenkins build or a Jira issue.
  it("puts the shipped lanes on pull requests only", () => {
    expect(LANE_SURFACES.impact).toEqual(["pr"]);
    expect(LANE_SURFACES.expert).toEqual(["pr"]);
  });

  it("offers no lane on a build or an issue", () => {
    for (const kind of ["build", "issue"] as const) {
      expect(AGENT_LANES.filter((lane) => LANE_SURFACES[lane].includes(kind))).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/lane-surfaces.test.ts`
Expected: FAIL — `LANE_SURFACES` is not exported.

- [ ] **Step 3: Implement**

In `src/shared/types.ts`, directly below `AGENT_LANES` / `AgentLane`:

```ts
/**
 * Which recognised surfaces each lane belongs on.
 *
 * The panel renders only the lanes whose entry contains the page's recognised
 * `SurfaceKind`. Before this table, lanes were gated on "the page resolved to an
 * item" alone, so a resolved Jira issue offered *What breaks if it lands* and
 * handed the issue URL to `agents.impact` as its `fileOrPrUrl` — a question that
 * does not apply, answered from an input the agent was not built for.
 *
 * Keyed by `AgentLane`, so adding a lane without declaring its surfaces is a type
 * error rather than a lane that silently appears everywhere. Gated on the
 * RECOGNISER's kind — a closed union this repo owns — not on `ResolvedItem.type`,
 * which is a free-form string from the wire.
 */
export const LANE_SURFACES: Record<AgentLane, readonly SurfaceKind[]> = {
  impact: ["pr"],
  expert: ["pr"],
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/lane-surfaces.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test
git add src/shared/types.ts test/unit/lane-surfaces.test.ts
git commit -m "feat(shared): LANE_SURFACES — declare where each lane belongs"
```

---

### Task 3: Pin the page at mount

**Files:**
- Modify: `src/panel/panel-in-page.ts` — add state in `createPanel` (~line 402);
  change the four send sites at lines **513** (`agent-state`), **575**
  (`agent-run`), **729** (`resolve`), **774** (`fetch`); set the pin in
  `loadHeader`
- Test: `test/unit/panel-in-page.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: closure state `pinnedUrl` and `pinnedRecognition` inside
  `createPanel`, read by Tasks 4 and 7. No exported surface changes.

**The defect:** the header is painted once from the URL at mount, but each of the
four sites above reads `window.location.href` at **send** time. On an SPA
(GitHub, GitLab and Jira all are) a client-side navigation leaves the panel
mounted with no repaint, so expanding a lane answers about the tab's current page
under a header naming the old one.

The `related` message is **not** in this list: it carries `readContext()` (title,
canonical link, selection) and no URL, and it is sent once at mount, so it already
matches the pinned page.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/panel-in-page.test.ts`. `mountPanelWithResolve` is already
defined in that file; `history.pushState` is how jsdom changes `location.href`
without a real navigation.

```ts
describe("the panel pins the page it was opened on", () => {
  const RESOLVED = {
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
        id: "it-1",
        service: "github",
        type: "pr",
        title: "Add retry budget",
        url: "https://github.com/acme/web/pull/482",
        modifiedAt: Date.now(),
      },
    },
  };

  it("sends the pinned url after a client-side navigation, not the live one", async () => {
    window.history.pushState({}, "", "/acme/web/pull/482");
    const pinned = window.location.href;
    const root = await mountPanelWithResolve(RESOLVED);

    window.history.pushState({}, "", "/acme/web/pull/517");
    expect(window.location.href).not.toBe(pinned);

    const lane = root.querySelector<HTMLDetailsElement>('[data-lane="impact"]');
    expect(lane).not.toBeNull();
    lane?.dispatchEvent(new Event("toggle"));
    await flush();

    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent-run", lane: "impact", pageUrl: pinned }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/panel-in-page.test.ts -t "pinned url"`
Expected: FAIL — the message carries the `/pull/517` URL, not the pinned one.

- [ ] **Step 3: Add the pinned state**

In `createPanel`, immediately after `let header: HeaderState = { kind: "loading" };`:

```ts
  /**
   * The page this panel describes, captured ONCE at mount.
   *
   * Every message this panel sends carries this URL, never
   * `window.location.href`: on an SPA the two diverge the moment the user
   * navigates, and a lane answering about the tab's current page under a header
   * naming the pinned one is precisely the defect this exists to make
   * impossible. `reread()` is the only writer, from an explicit user click.
   */
  let pinnedUrl = window.location.href;
  /**
   * The pinned page's identity, taken from the resolve response's `recognition`
   * — which rides on BOTH arms of that response on purpose (see `handleResolve`).
   * One source, so the pin cannot disagree with the header painted from the same
   * response, and a re-read re-pins it as an ordinary consequence of re-running
   * `loadHeader` rather than as a second thing to remember.
   *
   * Null until the first resolve lands.
   */
  let pinnedRecognition: Recognition | null = null;
```

Add `type Recognition` to the existing `../shared/types.ts` import block.

- [ ] **Step 4: Set the pin where the resolve response lands**

In `loadHeader`, immediately before the existing `header = headerFrom(...)` line:

```ts
    if (isResolveResponse(res)) {
      // The identity of the page this panel describes, from the same response the
      // header is built from — never a second recognition of its own.
      pinnedRecognition = res.recognition;
    }
```

`isResolveResponse` is already imported in this file.

- [ ] **Step 5: Switch the four send sites to the pin**

Replace `window.location.href` with `pinnedUrl` in exactly these four calls:

```ts
// in pollLane (~line 513)
res = await sendMessage({ kind: "agent-state", lane, pageUrl: pinnedUrl });
// in sendAgentRun (~line 575)
res = await sendMessage({ kind: "agent-run", lane, pageUrl: pinnedUrl });
// in loadHeader (~line 729)
res = await sendMessage({ kind: "resolve", pageUrl: pinnedUrl, title: document.title });
// in sendFetch (~line 774)
res = await sendMessage({ kind: "fetch", pageUrl: pinnedUrl });
```

Leave `readContext()` and the `related` send alone.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/panel-in-page.test.ts`
Expected: PASS, whole file — including the pre-existing assertion at ~line 401
(`pageUrl: window.location.href`), which still holds because that test never
navigates.

- [ ] **Step 7: Full gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test
git add src/panel/panel-in-page.ts test/unit/panel-in-page.test.ts
git commit -m "fix(panel): pin the page a panel describes at mount"
```

---

### Task 4: Gate the lanes on the pinned surface

**Files:**
- Modify: `src/panel/panel-in-page.ts` — `paint()`'s `showAgentLanes` (~line 669)
- Test: `test/unit/panel-in-page.test.ts`

**Interfaces:**
- Consumes: `LANE_SURFACES` (Task 2), `pinnedRecognition` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/panel-in-page.test.ts`. Build the resolved response with a
helper so the surface kind is the only variable:

```ts
describe("lanes appear only where they can answer", () => {
  function resolved(product: string, kind: string, ref: string): unknown {
    return {
      kind: "resolve",
      ok: true,
      recognition: {
        ok: true,
        product,
        kind,
        label: `${product} ${kind}`,
        ref,
        resolveUrl: "https://example.test/x",
      },
      outcome: {
        kind: "found",
        matchKind: "exact",
        item: {
          id: "it-1",
          service: product,
          type: kind,
          title: "An indexed item",
          url: "https://example.test/x",
          modifiedAt: Date.now(),
        },
      },
    };
  }

  it("offers both lanes on a resolved pull request", async () => {
    const root = await mountPanelWithResolve(resolved("github", "pr", "acme/web #482"));
    expect(root.querySelector('[data-lane="impact"]')).not.toBeNull();
    expect(root.querySelector('[data-lane="expert"]')).not.toBeNull();
  });

  // Before LANE_SURFACES these appeared here too, and expanding one handed the
  // issue/build URL to agents.impact as its `fileOrPrUrl`.
  it("offers no agent lane on a resolved Jira issue", async () => {
    const root = await mountPanelWithResolve(resolved("jira", "issue", "ABC-12"));
    expect(root.querySelector('[data-lane="impact"]')).toBeNull();
    expect(root.querySelector('[data-lane="expert"]')).toBeNull();
    // The Related lane is unaffected — it works in every header state.
    expect(root.querySelector('[data-lane="related"]')).not.toBeNull();
  });

  it("offers no agent lane on a resolved Jenkins build", async () => {
    const root = await mountPanelWithResolve(resolved("jenkins", "build", "web #482"));
    expect(root.querySelector('[data-lane="impact"]')).toBeNull();
    expect(root.querySelector('[data-lane="expert"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/panel-in-page.test.ts -t "only where they can answer"`
Expected: FAIL — the Jira and Jenkins cases find both lanes.

- [ ] **Step 3: Implement the filter**

In `paint()`, replace the `showAgentLanes` line and the `agentLanes` construction.
Update the existing comment above it — it explains why `chosen` is excluded (keep
that reasoning) and now must also carry the surface rule:

```ts
    // The two agent lanes ask a question about ONE resolved item, on a surface
    // where that question applies — see LANE_SURFACES (shared/types.ts). There is
    // nothing to ask about on a miss, an error, or an ambiguous answer, and
    // nothing worth asking `impact` about on a build or an issue.
    //
    // `chosen` is deliberately NOT included, even though the user has by then
    // pinned down which item this page is. `agent-run` carries only
    // `{lane, pageUrl}` (messages.ts), so `handleAgentRun` re-runs the resolve
    // itself — and on an ambiguous page that second resolve is ambiguous again,
    // which `resolveForAgent` refuses with `not_resolved` (handlers.ts).
    // Rendering the lanes here would put "Nimbus couldn't pin this page to one
    // indexed item." under a header naming the item the user just picked, with no
    // Re-run to escape it. Lanes on a chosen candidate need the picked id carried
    // through `agent-run` — see ROADMAP C2.5.
    //
    // The surface kind comes from `pinnedRecognition`, not from the header: the
    // `resolved` HeaderState carries only the human surface LINE ("GitHub PR ·
    // acme/web #482"), not the typed kind.
    const surfaceKind = pinnedRecognition?.ok === true ? pinnedRecognition.kind : null;
    const agentLanes: Lane[] =
      shown.kind === "resolved" && surfaceKind !== null
        ? AGENT_LANES.filter((lane) => LANE_SURFACES[lane].includes(surfaceKind)).map((lane) => ({
            id: lane,
            title: LANE_TITLES[lane],
            expanded: laneOpen[lane],
            render: (doc: Document) =>
              // Every rendered lane gets a REAL Re-run handler — never omitted.
              // `renderLaneBody`'s third argument is optional so it can be unit
              // tested without one, but a lane rendered here without it would
              // ship a Re-run button that silently does nothing.
              renderLaneBody(doc, laneState[lane], () => {
                sendAgentRun(lane).catch(() => undefined);
              }),
          }))
        : [];
```

Add `LANE_SURFACES` to the existing `../shared/types.ts` import block.

The two `for (const lane of AGENT_LANES)` loops elsewhere in `paint()` need no
change: both already skip a lane whose element is absent (`if (el !== null)`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/panel-in-page.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Full gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test
git add src/panel/panel-in-page.ts test/unit/panel-in-page.test.ts
git commit -m "fix(panel): agent lanes only on the surfaces they can answer"
```

---

### Task 5: The `recognise` message

**Files:**
- Modify: `src/shared/messages.ts` — request/response types, the
  `ExtensionRequest` union, two guards
- Modify: `src/background/handlers.ts` — `handleRecognise` (place it directly
  above `handleResolve`, ~line 145)
- Modify: `src/background/service-worker.ts` — the import block and a route beside
  the `isResolveRequest` branch (~line 424)
- Test: `test/unit/messages.test.ts`, `test/unit/handlers.test.ts`,
  `test/unit/service-worker.test.ts`

**Interfaces:**
- Consumes: `recognise` (`src/shared/recognise.ts`), `Recognition`
  (`src/shared/types.ts`), the private `isRecognition` guard already in
  `messages.ts:338`.
- Produces:
  - `export interface RecogniseRequest { readonly kind: "recognise"; readonly pageUrl: string }`
  - `export type RecognitionResponse = { readonly kind: "recognition"; readonly recognition: Recognition }`
  - `export function isRecogniseRequest(v: unknown): v is RecogniseRequest`
  - `export function isRecognitionResponse(v: unknown): v is RecognitionResponse`
  - `export async function handleRecognise(deps: RecogniseDeps, req: RecogniseRequest): Promise<RecognitionResponse>`
  - `export interface RecogniseDeps { readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]> }`

**Why a message at all:** the panel cannot classify a URL itself — the configured
origins live in the worker (`src/background/origin-store.ts`) and the panel only
ever receives the `recognition` embedded in a resolve response. Shipping the
origins list into a content script was rejected in the spec: answering one
question is less exposure than handing over the config that answers all of them.

- [ ] **Step 1: Write the failing handler test**

Add to `test/unit/handlers.test.ts` (follow the file's existing pattern of
injecting deps):

```ts
describe("handleRecognise", () => {
  it("classifies a built-in origin", async () => {
    const res = await handleRecognise(
      { getOrigins: async () => [] },
      { kind: "recognise", pageUrl: "https://github.com/acme/web/pull/482" },
    );
    expect(res).toEqual({
      kind: "recognition",
      recognition: {
        ok: true,
        product: "github",
        kind: "pr",
        label: "GitHub PR",
        ref: "acme/web #482",
        resolveUrl: "https://github.com/acme/web/pull/482",
      },
    });
  });

  it("classifies a configured self-hosted origin", async () => {
    const res = await handleRecognise(
      { getOrigins: async () => [{ origin: "https://corp.example/jira", product: "jira" }] },
      { kind: "recognise", pageUrl: "https://corp.example/jira/browse/abc-12" },
    );
    expect(res.recognition).toMatchObject({ ok: true, product: "jira", ref: "ABC-12" });
  });

  it("reports an unrecognised page as a miss, not an error", async () => {
    const res = await handleRecognise(
      { getOrigins: async () => [] },
      { kind: "recognise", pageUrl: "https://example.com/whatever" },
    );
    expect(res.recognition).toEqual({ ok: false, reason: "unknown-host" });
  });

  // This route exists so the panel can ask "same item?" on every navigation. If it
  // ever touched the gateway or the token it would be a per-navigation network
  // call under a client whose whole story is that nothing leaves without asking.
  it("never reads a connection and never calls the gateway", async () => {
    const getConnection = vi.fn();
    const resolveItem = vi.fn();
    await handleRecognise(
      { getOrigins: async () => [], ...({ getConnection, resolveItem } as object) },
      { kind: "recognise", pageUrl: "https://github.com/acme/web/pull/482" },
    );
    expect(getConnection).not.toHaveBeenCalled();
    expect(resolveItem).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run test/unit/handlers.test.ts -t "handleRecognise"`
Expected: FAIL — `handleRecognise` is not exported.

- [ ] **Step 3: Add the message types and guards**

In `src/shared/messages.ts`, after `FetchRequest` (~line 77):

```ts
/**
 * Classify a URL — nothing more. The panel sends this while watching for a
 * client-side navigation, to learn whether the tab is still showing the item its
 * header names.
 *
 * Deliberately NOT a resolve: `handleRecognise` runs the pure recogniser and
 * makes no gateway call, so a navigation check costs no network and no token.
 */
export interface RecogniseRequest {
  readonly kind: "recognise";
  readonly pageUrl: string;
}
```

Add `RecogniseRequest` to the `ExtensionRequest` union (after `FetchRequest`).

After the `ResolveResponse` type, add:

```ts
export type RecognitionResponse = {
  readonly kind: "recognition";
  readonly recognition: Recognition;
};
```

Beside `isFetchRequest` (~line 276):

```ts
export function isRecogniseRequest(v: unknown): v is RecogniseRequest {
  return isObject(v) && v["kind"] === "recognise" && typeof v["pageUrl"] === "string";
}
```

And beside `isResolveResponse` (~line 368), reusing the existing private
`isRecognition`:

```ts
export function isRecognitionResponse(v: unknown): v is RecognitionResponse {
  return isObject(v) && v["kind"] === "recognition" && isRecognition(v["recognition"]);
}
```

- [ ] **Step 4: Add the handler**

In `src/background/handlers.ts`, directly above `handleResolve`:

```ts
export interface RecogniseDeps {
  readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]>;
}

/**
 * Classify a page URL. The whole handler — no connection read, no gateway call,
 * no token.
 *
 * It is `handleResolve`'s first line, exposed on its own so the panel's
 * navigation watcher can ask "is the tab still showing the item my header names?"
 * without asking the gateway anything. The panel cannot answer that itself: the
 * configured origins live in the worker, and shipping them into a content script
 * would expose the user's internal hostnames to save a message that costs no
 * network.
 */
export async function handleRecognise(
  deps: RecogniseDeps,
  req: RecogniseRequest,
): Promise<RecognitionResponse> {
  return { kind: "recognition", recognition: recognise(req.pageUrl, await deps.getOrigins()) };
}
```

Add `RecogniseRequest` / `RecognitionResponse` to the `../shared/messages.ts`
type imports in that file.

- [ ] **Step 5: Run the handler test to verify it passes**

Run: `bunx vitest run test/unit/handlers.test.ts -t "handleRecognise"`
Expected: PASS (4 tests).

- [ ] **Step 6: Route it in the service worker**

Add `isRecogniseRequest` to the `../shared/messages.ts` import and `handleRecognise`
to the `./handlers.ts` import in `src/background/service-worker.ts`, then add this
branch directly above the `isResolveRequest` branch (~line 424):

```ts
  if (isRecogniseRequest(message)) {
    handleRecognise({ getOrigins }, message)
      .then(respond)
      .catch(() => {
        // The recogniser itself cannot throw, so this is the storage read
        // failing. Answering "no item here" is the honest degraded answer and
        // matches the fallback the resolve and fetch routes already use.
        respond({ kind: "recognition", recognition: { ok: false, reason: "unknown-host" } });
      });
    return true;
  }
```

- [ ] **Step 7: Write and run the routing + guard tests**

Add to `test/unit/service-worker.test.ts`, following that file's existing
message-dispatch pattern:

```ts
it("routes a recognise request and answers with a recognition", async () => {
  const res = await dispatch({ kind: "recognise", pageUrl: "https://github.com/acme/web/pull/482" });
  expect(res).toMatchObject({ kind: "recognition", recognition: { ok: true, kind: "pr" } });
});
```

Add to `test/unit/messages.test.ts`:

```ts
describe("recognise message guards", () => {
  it("accepts a well-formed request and rejects a malformed one", () => {
    expect(isRecogniseRequest({ kind: "recognise", pageUrl: "https://x.test/" })).toBe(true);
    expect(isRecogniseRequest({ kind: "recognise" })).toBe(false);
    expect(isRecogniseRequest({ kind: "recognise", pageUrl: 42 })).toBe(false);
    expect(isRecogniseRequest({ kind: "resolve", pageUrl: "https://x.test/" })).toBe(false);
  });

  it("accepts both arms of a recognition response", () => {
    expect(
      isRecognitionResponse({
        kind: "recognition",
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
      isRecognitionResponse({ kind: "recognition", recognition: { ok: false, reason: "unknown-host" } }),
    ).toBe(true);
  });

  it("rejects a response with no or a malformed recognition", () => {
    expect(isRecognitionResponse({ kind: "recognition" })).toBe(false);
    expect(isRecognitionResponse({ kind: "recognition", recognition: { ok: true } })).toBe(false);
    expect(isRecognitionResponse({ kind: "resolve", recognition: { ok: false, reason: "x" } })).toBe(false);
  });
});
```

Run: `bunx vitest run test/unit/messages.test.ts test/unit/service-worker.test.ts`
Expected: PASS.

- [ ] **Step 8: Full gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test
git add src/shared/messages.ts src/background/handlers.ts src/background/service-worker.ts test/unit
git commit -m "feat(background): a recognise route — classify a url, nothing more"
```

---

### Task 6: The notice, in the pure view

**Files:**
- Modify: `src/panel/panel-view.ts` — `PanelState` (~line 187), a new
  `renderNavAway`, one append in `renderShell` (~line 663)
- Modify: `src/panel/panel-in-page.ts` — two CSS rules in `STYLES` (~line 245)
- Test: `test/unit/panel-view.test.ts`

**Interfaces:**
- Consumes: the file's existing private `line()` and `actionButton()` helpers.
- Produces: `PanelState.navAway?: { readonly pinnedRef: string | null; readonly onReread: () => void }`
  — set by Task 7.

**Why a field on `PanelState` and not a `HeaderState` arm:** the notice must
coexist with *every* header state — `resolved`, `chosen`, `ambiguous`,
`not-indexed`, `needs-scope`, `error`, `fetching`, `fetch-blocked`,
`fetch-retry` — rather than compete with them. A function on the state follows
`Lane.render`'s existing precedent in this same type, instead of making
`renderShell` take a fifth positional callback after `onChoose` and `onFetch`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/panel-view.test.ts` (that file already has a jsdom docblock and
imports `renderShell`):

```ts
describe("the navigated-away notice", () => {
  const LANES = [
    { id: "related", title: "Related", expanded: false, render: (d: Document) => d.createElement("div") },
  ];

  it("names the pinned item so every lane below it is attributed", () => {
    const shell = renderShell(document, {
      header: { kind: "loading" },
      lanes: LANES,
      navAway: { pinnedRef: "acme/web #482", onReread: () => undefined },
    });
    const notice = shell.querySelector(".nimbus-related__navaway");
    expect(notice?.textContent).toContain("You've moved on.");
    expect(notice?.textContent).toContain("This panel is still about acme/web #482.");
  });

  it("falls back to generic copy when the pinned page had no ref", () => {
    const shell = renderShell(document, {
      header: { kind: "unrecognised" },
      lanes: LANES,
      navAway: { pinnedRef: null, onReread: () => undefined },
    });
    expect(shell.querySelector(".nimbus-related__navaway")?.textContent).toContain(
      "This panel is still about the page you opened it on.",
    );
  });

  // A screen-reader user must learn that the panel's subject no longer matches
  // the tab; nothing else in the panel announces it.
  it("announces itself as a status region", () => {
    const shell = renderShell(document, {
      header: { kind: "loading" },
      lanes: LANES,
      navAway: { pinnedRef: "acme/web #482", onReread: () => undefined },
    });
    expect(shell.querySelector(".nimbus-related__navaway")?.getAttribute("role")).toBe("status");
  });

  it("calls onReread once per click", () => {
    const onReread = vi.fn();
    const shell = renderShell(document, {
      header: { kind: "loading" },
      lanes: LANES,
      navAway: { pinnedRef: "acme/web #482", onReread },
    });
    shell.querySelector<HTMLButtonElement>(".nimbus-related__navaway button")?.click();
    expect(onReread).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when navAway is absent", () => {
    const shell = renderShell(document, { header: { kind: "loading" }, lanes: LANES });
    expect(shell.querySelector(".nimbus-related__navaway")).toBeNull();
  });

  // The notice sits between the header and the lanes so it coexists with every
  // header state instead of replacing one.
  it("sits after the header and before the lanes, and leaves the lanes enabled", () => {
    const shell = renderShell(document, {
      header: { kind: "loading" },
      lanes: LANES,
      navAway: { pinnedRef: "acme/web #482", onReread: () => undefined },
    });
    const classes = [...shell.children].map((c) => c.className);
    expect(classes[0]).toContain("nimbus-related__header-state");
    expect(classes[1]).toContain("nimbus-related__navaway");
    expect(shell.querySelectorAll("[disabled]")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run test/unit/panel-view.test.ts -t "navigated-away"`
Expected: FAIL — `navAway` is not a property of `PanelState`.

- [ ] **Step 3: Extend `PanelState`**

```ts
export interface PanelState {
  readonly header: HeaderState;
  readonly lanes: readonly Lane[];
  /**
   * Set while the tab has navigated to a DIFFERENT indexed item than the one this
   * panel describes. Rendered between the header and the lanes, so it coexists
   * with every `HeaderState` arm rather than competing with them.
   *
   * `pinnedRef` names the item the panel is still about — one line that attributes
   * every lane below it, which is why the lanes stay live and unstyled: they
   * answer about the pinned item, exactly as the header says. Null when the
   * pinned page was unrecognised and so has no ref.
   *
   * A callback on the state follows `Lane.render` above, rather than growing
   * `renderShell` a fifth positional argument.
   */
  readonly navAway?: { readonly pinnedRef: string | null; readonly onReread: () => void };
}
```

- [ ] **Step 4: Add the renderer and wire it into `renderShell`**

Above `renderShell`:

```ts
function renderNavAway(
  doc: Document,
  navAway: { readonly pinnedRef: string | null; readonly onReread: () => void },
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-related__navaway";
  // The panel's subject no longer matches the tab, and nothing else announces it.
  box.setAttribute("role", "status");
  box.append(line(doc, "nimbus-related__navaway-lead", "You've moved on."));
  box.append(
    line(
      doc,
      "nimbus-related__status",
      navAway.pinnedRef === null
        ? "This panel is still about the page you opened it on."
        : `This panel is still about ${navAway.pinnedRef}.`,
    ),
  );
  box.append(actionButton(doc, "nimbus-related__action", "Re-read page", navAway.onReread));
  return box;
}
```

In `renderShell`, between the header append and the lane loop:

```ts
  shell.append(renderHeader(doc, state.header, onChoose, onFetch));
  if (state.navAway !== undefined) {
    shell.append(renderNavAway(doc, state.navAway));
  }
  for (const lane of state.lanes) {
```

- [ ] **Step 5: Add the styles**

In `src/panel/panel-in-page.ts`'s `STYLES`, after the
`.nimbus-related__header-state` rules:

```css
.nimbus-related__navaway { padding: 10px 16px 12px; border-bottom: 1px solid var(--nimbus-border); }
.nimbus-related__navaway .nimbus-related__status { padding: 2px 0 4px; }
.nimbus-related__navaway-lead { margin: 0; font-weight: 600; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/panel-view.test.ts`
Expected: PASS, whole file.

- [ ] **Step 7: Full gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test
git add src/panel/panel-view.ts src/panel/panel-in-page.ts test/unit/panel-view.test.ts
git commit -m "feat(panel): a notice that names the page the panel is still about"
```

---

### Task 7: Detect the navigation, and re-read on request

**Files:**
- Modify: `src/panel/panel-in-page.ts` — a `NAV_CHECK_MS` constant, watcher state
  and `checkNavigation` / `reread` in `createPanel`, the generation guard in six
  async functions, `paint()`'s `navAway` wiring, `stopAgentPolls`, `createPanel`'s
  return type, and two listeners in `mount`
- Test: `test/unit/panel-in-page.test.ts`

**Interfaces:**
- Consumes: `sameItem` (Task 1), `isRecognitionResponse` (Task 5),
  `PanelState.navAway` (Task 6), `pinnedUrl` / `pinnedRecognition` (Task 3).
- Produces: `createPanel` returns one more member,
  `checkNavigation: () => Promise<void>`, called by `mount`'s `popstate` and
  `visibilitychange` listeners.

**Why a timer at all:** no portable hook exists. `popstate` fires for
back/forward only and never for `pushState`; patching `history.pushState` is
invisible from the isolated world the panel is injected into; the Navigation API
is Chromium-only; and `chrome.webNavigation.onHistoryStateUpdated` would cost a
new broad-sounding permission on a client whose privacy story is the product.

**Two invariants this task must not break:**
1. **`paint()` is response-driven, never tick-driven.** `HeaderState.resolved`'s
   `nowMs` is frozen at response time and its doc comment (`panel-view.ts:107-124`)
   explicitly warns that a lane repainting *on a timer* must convert it to a
   render-time parameter first. The watcher therefore paints **only when
   `navAway` actually flips**, never once per tick.
2. **Ordering, not just volume.** "One request per distinct URL" bounds how many
   `recognise` messages go out and says nothing about the order they return in.
   Pinned `#482` → `/files` → `#517` puts two in flight; if `#517`'s answer
   (changed → show) lands before `/files`'s (unchanged → hide), the notice is
   cleared while the user is on `#517` — the exact bug this slice removes,
   reintroduced by its own detector. Hence `recogniseSeq`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/panel-in-page.test.ts`. Script `recognise` per URL, and drive
the watcher with fake timers via the file's existing `advanceTimers` helper:

```ts
describe("following a client-side navigation", () => {
  const PR482 = {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref: "acme/web #482",
    resolveUrl: "https://github.com/acme/web/pull/482",
  };
  const PR517 = { ...PR482, ref: "acme/web #517", resolveUrl: "https://github.com/acme/web/pull/517" };

  function resolvedFor(recognition: unknown): unknown {
    return {
      kind: "resolve",
      ok: true,
      recognition,
      outcome: {
        kind: "found",
        matchKind: "exact",
        item: {
          id: "it-1",
          service: "github",
          type: "pr",
          title: "Add retry budget",
          url: "https://github.com/acme/web/pull/482",
          modifiedAt: Date.now(),
        },
      },
    };
  }

  /** Mounts on #482 with `recognise` answered from a URL→recognition table. */
  async function mountWatching(table: Record<string, unknown>): Promise<ShadowRoot> {
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string; pageUrl?: string };
      if (m.kind === "resolve") return resolvedFor(PR482);
      if (m.kind === "recognise") {
        const hit = Object.entries(table).find(([path]) => (m.pageUrl ?? "").includes(path));
        return { kind: "recognition", recognition: hit?.[1] ?? { ok: false, reason: "unrecognised-path" } };
      }
      return { kind: "related", ok: true, items: [] };
    });
    window.history.pushState({}, "", "/acme/web/pull/482");
    await loadPanel();
    await vi.waitFor(() => expect(headerText()).not.toContain("Checking Nimbus"));
    const root = shadow();
    if (root === null) throw new Error("panel shadow root not found");
    return root;
  }

  function notice(root: ShadowRoot): Element | null {
    return root.querySelector(".nimbus-related__navaway");
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says nothing when only the sub-tab changed", async () => {
    const root = await mountWatching({ "/pull/482": PR482 });
    window.history.pushState({}, "", "/acme/web/pull/482/files");
    await advanceTimers(600);
    expect(notice(root)).toBeNull();
  });

  it("names the pinned item once the tab shows a different one", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    expect(notice(root)?.textContent).toContain("acme/web #482");
  });

  it("clears itself when the user comes back, with no re-read", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    expect(notice(root)).not.toBeNull();
    window.history.pushState({}, "", "/acme/web/pull/482/files");
    await advanceTimers(600);
    expect(notice(root)).toBeNull();
  });

  it("checks nothing while the tab is hidden, and immediately once it is visible", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(2000);
    expect(notice(root)).toBeNull();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(notice(root)).not.toBeNull();
  });

  // The ordering guard. A -> B(same item) -> C(different item) with B's answer
  // deliberately delivered LAST must leave the notice correct for C.
  it("ignores a stale recognition answer that lands after a newer one", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    let releaseStale: (() => void) | null = null;
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string; pageUrl?: string };
      if (m.kind !== "recognise") return { kind: "related", ok: true, items: [] };
      if ((m.pageUrl ?? "").includes("/files")) {
        await new Promise<void>((resolve) => {
          releaseStale = resolve;
        });
        return { kind: "recognition", recognition: PR482 };
      }
      return { kind: "recognition", recognition: PR517 };
    });
    window.history.pushState({}, "", "/acme/web/pull/482/files");
    await advanceTimers(600);
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    expect(notice(root)).not.toBeNull();
    releaseStale?.();
    await flush();
    expect(notice(root)).not.toBeNull();
  });

  it("re-reads on request: new header, lanes reset, nothing running", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);

    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string };
      if (m.kind === "resolve") return resolvedFor(PR517);
      if (m.kind === "recognise") return { kind: "recognition", recognition: PR517 };
      return { kind: "related", ok: true, items: [] };
    });
    root.querySelector<HTMLButtonElement>(".nimbus-related__navaway button")?.click();
    await flush();

    expect(notice(root)).toBeNull();
    expect(headerText()).toContain("acme/web #517");
    expect(harness.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent-run" }),
    );
    const lane = root.querySelector<HTMLDetailsElement>('[data-lane="impact"]');
    expect(lane?.open).toBe(false);
  });

  it("sends the NEW pinned url after a re-read", async () => {
    const root = await mountWatching({ "/pull/482": PR482, "/pull/517": PR517 });
    window.history.pushState({}, "", "/acme/web/pull/517");
    await advanceTimers(600);
    const newPin = window.location.href;

    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const m = message as { kind?: string };
      if (m.kind === "resolve") return resolvedFor(PR517);
      if (m.kind === "recognise") return { kind: "recognition", recognition: PR517 };
      if (m.kind === "agent-run") return { kind: "agent-state", lane: "impact", state: { kind: "done", brief: "b" } };
      return { kind: "related", ok: true, items: [] };
    });
    root.querySelector<HTMLButtonElement>(".nimbus-related__navaway button")?.click();
    await flush();
    root.querySelector<HTMLDetailsElement>('[data-lane="impact"]')?.dispatchEvent(new Event("toggle"));
    await flush();

    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent-run", pageUrl: newPin }),
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run test/unit/panel-in-page.test.ts -t "following a client-side navigation"`
Expected: FAIL — no notice ever appears.

- [ ] **Step 3: Add the constant and the watcher state**

Beside `AGENT_POLL_MS` (~line 100):

```ts
/** How often an OPEN, VISIBLE panel checks whether the tab has moved to a
 *  different indexed item. A string compare per tick; a `recognise` message goes
 *  out only when the URL has actually changed since the last check. */
const NAV_CHECK_MS = 500;
```

In `createPanel`, after `pinnedRecognition` (Task 3):

```ts
  /** The last URL `checkNavigation` looked at — so a tick on an unchanged URL
   *  costs a string compare and nothing else. */
  let lastCheckedUrl = pinnedUrl;
  /** Whether the tab is currently showing a DIFFERENT item than the pinned one.
   *  Not a latch: navigating back to the pinned item clears it. */
  let navAway = false;
  /**
   * Orders `recognise` answers. Rapid navigation puts several in flight, and a
   * LATE answer about an earlier URL would otherwise decide the notice — pinned
   * #482 -> /files -> #517 could clear the notice while the user sits on #517.
   * Each send takes a ticket; only the latest may act.
   */
  let recogniseSeq = 0;
  /**
   * Bumped by `reread()`. Every async function here resumes after a real round
   * trip, and a response belonging to the page the panel has stopped describing
   * must neither store nor paint — the same reasoning as `closed` below, for a
   * panel that stays mounted instead of going away.
   */
  let generation = 0;
  let navCheckTimer: ReturnType<typeof setInterval> | undefined;
```

- [ ] **Step 4: Add `checkNavigation`**

Place it next to `pollLane`:

```ts
  /**
   * Compare the tab's item identity against the pinned one, and flip `navAway`
   * when it differs. Identity, NOT the URL: `resolveUrl` keeps sub-tab segments
   * and the query string on purpose, so a PR's Files tab is a different URL and
   * the same item — announcing that would be a lie in the other direction.
   *
   * Paints ONLY when `navAway` actually changes. A `paint()` per tick would make
   * this panel's repaints timer-driven, which `HeaderState.resolved`'s `nowMs`
   * doc comment (panel-view.ts) explicitly rules out while that value is frozen
   * at response time.
   */
  async function checkNavigation(): Promise<void> {
    if (document.hidden) {
      // Nothing to be right about while the panel cannot be seen. The
      // visibilitychange listener in mount() runs one check on the way back, so
      // the notice is correct the moment the user looks at it.
      return;
    }
    const url = window.location.href;
    if (url === lastCheckedUrl) {
      return;
    }
    lastCheckedUrl = url;
    const seq = ++recogniseSeq;
    let res: unknown;
    try {
      res = await sendMessage({ kind: "recognise", pageUrl: url });
    } catch {
      // The worker is unreachable. Leaving the notice as it is beats guessing;
      // the next navigation asks again.
      return;
    }
    if (closed || seq !== recogniseSeq || !isRecognitionResponse(res)) {
      return;
    }
    // Before the first resolve lands there is no pinned identity to compare
    // against, so there is nothing honest to announce.
    const away = pinnedRecognition !== null && !sameItem(pinnedRecognition, res.recognition);
    if (away === navAway) {
      return;
    }
    navAway = away;
    paint();
  }
```

Add `sameItem` to the `../shared/recognise.ts` import and
`isRecognitionResponse` to the `../shared/messages.ts` import.

- [ ] **Step 5: Add `reread`**

Place it directly after `checkNavigation`:

```ts
  /**
   * Re-pin to the page the tab is on now and describe THAT page instead.
   *
   * Only reachable from the notice's own button — an explicit user action, which
   * is why it is allowed to spend two gateway calls when nothing else in this
   * panel re-reads on its own.
   *
   * `fetchSent` resets deliberately: the one-fetch-per-panel rule exists to stop
   * a second outbound provider request for the SAME item, and this is a different
   * item behind a click. A lane whose new item was already answered still replays
   * from the worker's store on first expand (`agent-run-store` keys by item id),
   * so resetting `laneState` here costs no re-run.
   */
  async function reread(): Promise<void> {
    generation += 1;
    pinnedUrl = window.location.href;
    lastCheckedUrl = pinnedUrl;
    pinnedRecognition = null;
    navAway = false;
    header = { kind: "loading" };
    chosen = null;
    fetchState = null;
    fetchSent = false;
    relatedBody = (doc) => renderError(doc, "Loading…");
    relatedExpanded = true;
    for (const lane of AGENT_LANES) {
      clearLanePoll(lane);
      laneState[lane] = { kind: "collapsed" };
      laneOpen[lane] = false;
      // A run genuinely in flight for the OLD item is not cancelled — there is
      // nothing upstream to cancel (ROADMAP C2.2) — but its answer is dropped by
      // the generation guard, and clearing the latch lets the new item's lane be
      // expanded straight away.
      laneInFlight.delete(lane);
    }
    paint();
    await Promise.all([loadHeader(), loadRelated()]);
  }
```

- [ ] **Step 6: Add the generation guard to every async function that paints**

In each of `loadHeader`, `loadRelated`, `sendFetch`, `sendAgentRun`, `pollLane`
and `checkNavigation`: capture the generation at entry, and check it everywhere
`closed` is already checked (including inside each `catch`, before it stores a
failure state).

```ts
    const gen = generation;
    // ... await sendMessage(...)
    if (closed || gen !== generation) {
      return;
    }
```

For `checkNavigation` the check folds into the condition added in Step 4:

```ts
    if (closed || gen !== generation || seq !== recogniseSeq || !isRecognitionResponse(res)) {
```

- [ ] **Step 7: Start the timer, stop it on teardown, and wire the notice**

At the end of `createPanel`'s body, before the returned object:

```ts
  navCheckTimer = setInterval(() => {
    checkNavigation().catch(() => undefined);
  }, NAV_CHECK_MS);
```

In `stopAgentPolls`, after `closed = true;`:

```ts
    if (navCheckTimer !== undefined) {
      clearInterval(navCheckTimer);
      navCheckTimer = undefined;
    }
```

In `paint()`, build the state and pass it — the optional property must be spread,
not set to `undefined` (`exactOptionalPropertyTypes`):

```ts
    const navAwayState = navAway
      ? {
          pinnedRef: pinnedRecognition?.ok === true ? pinnedRecognition.ref : null,
          onReread: () => {
            reread().catch(() => undefined);
          },
        }
      : undefined;
    body.replaceChildren(
      renderShell(
        document,
        {
          header: shown,
          lanes,
          ...(navAwayState === undefined ? {} : { navAway: navAwayState }),
        },
        // ... existing onChoose / onFetch callbacks unchanged
```

Widen `createPanel`'s return type and returned object with
`checkNavigation: () => Promise<void>`.

- [ ] **Step 8: Register the two listeners in `mount`**

After the existing `keydown` listener, using the same `signal`:

```ts
  // popstate covers back/forward, which the interval would otherwise only notice
  // up to NAV_CHECK_MS later. It does NOT cover pushState — that is what the
  // interval is for (see NAV_CHECK_MS).
  window.addEventListener(
    "popstate",
    () => {
      view.checkNavigation().catch(() => undefined);
    },
    { signal },
  );
  // The interval skips hidden tabs, so this is what makes the notice correct at
  // the moment the user switches back and looks at the panel.
  document.addEventListener(
    "visibilitychange",
    () => {
      view.checkNavigation().catch(() => undefined);
    },
    { signal },
  );
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/panel-in-page.test.ts`
Expected: PASS, whole file — the eight new cases plus every pre-existing one.

- [ ] **Step 10: Full gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test
git add src/panel/panel-in-page.ts test/unit/panel-in-page.test.ts
git commit -m "feat(panel): notice a navigation, and re-read on request"
```

---

### Task 8: Docs, changelog, and the roadmap corrections

**Files:**
- Modify: `docs/architecture.md` — the recognition-pipeline section (line 176) and
  the agent-lanes section (line 389)
- Modify: `CHANGELOG.md` — under `## [Unreleased]`
- Modify: `ROADMAP.md` — C1.3's status (line 371), C2.3 (line 501), C1.5 (line 408)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Verify the build and the packaged extension are still complete**

```bash
bun run build && bun run check-build
```
Expected: both succeed. (Run before writing docs so the claims below are true.)

- [ ] **Step 2: Document the pinned context in `docs/architecture.md`**

Add to the end of the **recognition pipeline** section:

```markdown
### One panel, one page

An injected panel captures `window.location.href` **once**, at mount, and sends
that URL with every message it makes — resolve, fetch, `agent-run` and
`agent-state`. It never re-reads `window.location.href` per send.

The reason is that the header is painted from one resolve response while the
lanes are expanded later, and GitHub, GitLab and Jira are all SPAs: reading the
live URL per send let a lane answer about the tab's current page under a header
naming the page the panel was opened on. Pinning makes that divergence
unrepresentable rather than unlikely.

A 500 ms watcher (plus `popstate`, and skipped while `document.hidden`) compares
the tab's **item identity** against the pin — `(product, kind, ref)` from
`recognise()`, not the URL, because `resolveUrl` keeps sub-tab segments and the
query string on purpose, so a pull request's Files tab is a different URL and the
same item. On a real change the panel renders a notice naming the item it is
still about, and **Re-read page** re-pins and resets the page-scoped state. It
never re-resolves on its own: nothing in this panel reaches the gateway without
being asked.

Two rules hold the mechanism together. The watcher paints **only when the notice
appears or disappears**, never per tick, because `HeaderState.resolved`'s `nowMs`
is frozen at response time and timer-driven repaints would hide real staleness.
And every `recognise` send takes a `recogniseSeq` ticket: rapid navigation puts
several in flight, and a late answer about an earlier URL would otherwise clear a
notice that a newer answer had just raised.

The classification itself rides on a dedicated `recognise` message
(`handleRecognise`) that runs the pure recogniser and makes **no gateway call and
no token read** — the panel cannot classify a URL itself, because the configured
origins live in the worker, and shipping that list into a content script would
expose the user's internal hostnames to save a message that costs no network.
```

- [ ] **Step 3: Document the lane gate in `docs/architecture.md`**

Add to the **agent lanes** section:

```markdown
### Which lanes appear where

`LANE_SURFACES` (`src/shared/types.ts`) maps each lane to the `SurfaceKind`s it
belongs on; the panel renders only the lanes matching the recognised kind. Both
shipped lanes are `["pr"]`.

They were previously gated on "the page resolved to an item" alone, so a resolved
Jira issue or Jenkins build offered *What breaks if it lands* and handed that
page's URL to `agents.impact` as its `fileOrPrUrl` — a question that does not
apply, from an input the agent was not built for.

The table is keyed by `AgentLane`, so adding a lane without declaring its
surfaces is a type error. It is gated on the recogniser's `kind` — a closed union
this repo owns — and not on `ResolvedItem.type`, which is a free-form string from
the wire.
```

- [ ] **Step 4: Add the changelog entries**

Under `## [Unreleased]` → `### Fixed`:

```markdown
- **The panel could describe one page and answer about another.** On sites that
  navigate without reloading — GitHub, GitLab and Jira all do — moving to a
  different pull request while the panel was open left the header naming the page
  you started on, while expanding a lane answered about the page you had moved to.
  The panel now sticks to the page you opened it on, says so when you navigate
  away — *"You've moved on. This panel is still about acme/web #482."* — and
  offers one button to re-read the page you are on now. Its lanes keep working on
  the item the header names the whole time, and the notice disappears by itself if
  you navigate back.
- **Agent lanes appeared on pages they could not answer about.** A Jira issue or a
  Jenkins build that Nimbus had indexed offered *What breaks if it lands* and *Who
  should review it*, which are questions about a change under review. Both lanes
  now appear on pull requests only.
```

- [ ] **Step 5: Correct C1.3's status in `ROADMAP.md`**

Replace the "Known gap" sentence in C1.3's **Status** (the one beginning "Known
gap: recognition does not follow client-side (SPA) navigation") with:

```markdown
> Closed: the panel pins the page it was opened on, so its header and its lanes
> can no longer describe different items, and it offers a deliberate re-read when
> you navigate away — see
> `docs/superpowers/specs/2026-08-11-panel-page-context-design.md`.
```

- [ ] **Step 6: Correct C2.3 in `ROADMAP.md`**

Add to the C2.3 brief, after its **What** line:

```markdown
> **Correction (2026-08-11), read from upstream source at `34601b24`+:** two of
> the agents named above are not reachable from a browser.
> `agents.preflight` is excluded from the HTTP surface deliberately —
> `HTTP_EXCLUDED_AGENT_METHODS` in `packages/gateway/src/ipc/agents-rpc.ts`,
> alongside `agents.premortem` and `agents.whyPeek` — because it has side effects
> on the owner's machine an external caller should not trigger unprompted. So the
> deploy/build lane above cannot be built as briefed. `agents.ghost` and
> `agents.conflicts` both take `{ file: string }` (`requireFileParam`), the same
> local-checkout requirement that sent "why" to C2.4. What *is* browser-viable is
> the service-scoped set — `agents.catchup`, `agents.decisions` and
> `agents.ownership` all accept `{ service }`, which the recogniser already knows
> — plus `agents.glossary` (`{ term }`), which a selection supplies. Same class of
> error C2.1 had to correct for `agents.why`/`whyPeek`; recorded rather than
> silently edited.
> **The rule is now written down.** `LANE_SURFACES` (`src/shared/types.ts`) is
> where a new lane declares the surfaces it belongs on; adding a lane without one
> is a type error. This phase's done-when asked for that, and it shipped early
> with the page-context slice.
```

- [ ] **Step 7: Correct C1.5's premise in `ROADMAP.md`**

Replace C1.5's **What** line with:

```markdown
> **What** Add a panel entry point the browser cannot silently withhold — a
> context-menu item, and Options surfacing whether the `show_related` shortcut is
> actually bound.
> **Correction (2026-08-11):** this brief claimed the panel had "exactly **one**
> entry point". It did not. The popup's *Show related* button has existed since
> Slice 2 (`src/popup/popup.html`, commit `e99749b`), which is also why the
> `Alt+Shift+R` failure below was survivable rather than fatal. What remains is
> the context-menu trigger and the shortcut's visibility — the keyboard-only risk
> is real, the "unreachable" framing was not.
```

- [ ] **Step 8: Full gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build
git add docs/architecture.md CHANGELOG.md ROADMAP.md
git commit -m "docs: record the pinned page context and correct three roadmap claims"
```

---

## Manual verification

`docs/development.md` is the dev-load checklist for the surfaces that unit tests
cannot reach (injected content scripts, SW glue). Run this pass in **both** Chrome
and Firefox after Task 8, against a paired gateway:

1. On a GitHub pull request, open the panel (`Alt+Shift+R` or the popup button).
   Expand *What breaks if it lands*; confirm the brief is about the PR named in
   the header.
2. Click the PR's **Files** tab. No notice appears, and the header is unchanged.
3. Navigate to a different pull request in the same tab. The notice appears within
   about a second and names the *first* PR. Expand *Who should review it* — the
   answer is about the first PR, matching the header.
4. Navigate back to the first PR. The notice disappears on its own.
5. Navigate away again, switch to another tab, and switch back. The notice is
   already correct when the panel comes into view.
6. Click **Re-read page**. The header names the new PR, both lanes are collapsed,
   and nothing ran until you expanded one.
7. Open the panel on an indexed Jira issue and an indexed Jenkins build. Each
   shows its header and **Related**, and no agent lane.

## Self-review

Checked against the spec.

**Spec coverage.** Pin the page at mount → Task 3. Identity not URL equality →
Task 1. URL-only recognition (evidence) → Task 5's rationale. The pin is the
resolve response's `recognition` → Task 3, Step 4. Banner clears on return →
Task 7, test 3. Detection mechanism and its rejected alternatives → Task 7.
Hidden-tab skip → Task 7, Steps 4 and 8. Out-of-order guard → Task 7,
`recogniseSeq`. The `recognise` message → Task 5. `navAway` on `PanelState` and
the notice between header and lanes → Task 6. Naming the pinned item, lanes stay
live → Task 6, Steps 1 and 4. Re-read reset, `fetchSent`, stored-answer replay,
generation counter → Task 7, Steps 5 and 6. `LANE_SURFACES` and the render-level
gate → Tasks 2 and 4. Docs, changelog, three roadmap corrections → Task 8. Every
test named in the spec's Tests section appears in a task.

**Deliberately not implemented** (the spec's out-of-scope list): new lanes,
auto-surfacing, abort, C2.5, and removing the dead `ResolveRequest.title` —
Task 3 keeps sending `title` exactly as today.

**Type consistency.** `sameItem(a: Recognition, b: Recognition): boolean`,
`LANE_SURFACES: Record<AgentLane, readonly SurfaceKind[]>`, `RecogniseRequest`
`{kind:"recognise", pageUrl}`, `RecognitionResponse` `{kind:"recognition",
recognition}`, `PanelState.navAway?: {pinnedRef: string | null; onReread: () =>
void}`, and `createPanel`'s added `checkNavigation: () => Promise<void>` are used
under those exact names and shapes in every task that consumes them.
