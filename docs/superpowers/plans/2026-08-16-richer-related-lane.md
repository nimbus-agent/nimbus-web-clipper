# Richer Related Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the panel's Related lane answer about the item the panel already resolved, and make each row say what it is and how fresh it is.

**Architecture:** Two repos. The gateway grows an `itemId` query mode plus two additive wire fields (`type`, `modified_at`) and fixes a snippet that has always extracted the wrong FTS column. The client sends the id it already resolved instead of `canonicalUrl`, and renders hits grouped by service with a kind chip and a freshness line. Every client-side decision lands in pure modules under unit test; the `chrome.*` seam is untouched.

**Tech Stack:** TypeScript (strict, no `any`), Bun + `bun:sqlite` + `bun:test` on the gateway, Vitest + jsdom on the client, Biome on both.

**Spec:** `docs/superpowers/specs/2026-08-16-richer-related-lane-design.md` (in the client worktree; read it before Task 1 — the plan argues from it)

## Global Constraints

- **Two worktrees, already created with green baselines.** Gateway: `C:\gitrep\Nimbus\.claude\worktrees\related-item-and-fields` on `dev/asaf/related-item-and-fields`. Client: `C:\gitrep\nimbus-web-clipper\.claude\worktrees\richer-related-lane` on `feat/richer-related-lane`. **Never edit the main checkouts.**
- **Order is fixed: Tasks 1–4 (gateway) merge before Tasks 5–9 (client) ship.** The client must still work against a gateway without them — Task 7 is where that is proven.
- **Wire naming mirrors `GET /v1/items/resolve`:** `type` plain, `modified_at` snake_case. The client renames to `modifiedAt` at its HTTP boundary only.
- **`modified_at` is epoch milliseconds.** No `* 1000` anywhere.
- **`RELATED_LIMIT` stays 10.** `MAX_LIMIT` on the gateway stays 25.
- **No `any`.** Cross-boundary data is `unknown`, narrowed by a guard.
- **No `console.*` anywhere in the client's `src/`.** Biome fails the build.
- **Never log the bearer token or the pairing code.**
- Client copy for the freshness line is exactly **`Updated <age>`**, where `<age>` comes from `formatAge` — identical to the panel header's wording.
- Client commits follow Conventional Commits and end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File Structure

**Gateway** (`C:\gitrep\Nimbus\.claude\worktrees\related-item-and-fields`)

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/clips/clip-related.ts` | Input precedence, item lookup dep, self-exclusion. Pure; DB injected. |
| `packages/gateway/src/clips/clip-related.test.ts` | Unit tests for the above, no DB. |
| `packages/gateway/src/ipc/http-server.ts` | The SQL: snippet column, the two new projected fields, the `lookupItem` dep. |
| `packages/gateway/src/clips/clip-e2e.test.ts` | Real-server proof: snippet comes from the body, NULL body coalesces. |
| `packages/gateway/src/glossary/glossary-project.ts` | Drive-by: one stale comment. |

**Client** (`C:\gitrep\nimbus-web-clipper\.claude\worktrees\richer-related-lane`)

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` | `RelatedHit` grows two optional fields. |
| `src/shared/related.ts` | The guard over both wire shapes; `buildRelatedQuery` learns `itemId`. |
| `src/background/gateway-client.ts` | The `modified_at` → `modifiedAt` boundary rename. |
| `src/shared/messages.ts` | `RelatedRequest` grows `itemId`; its guard. |
| `src/panel/related-groups.ts` | **New, pure.** Hits → ordered service groups; the `type` humaniser. |
| `src/panel/panel-view.ts` | `renderHit` / `renderHits` render the group heading, chip, age line. |
| `src/panel/panel-in-page.ts` | `loadRelated` supplies the resolved or chosen item id. |
| `test/unit/related.test.ts`, `related-groups.test.ts` (new), `messages.test.ts`, `gateway-client.test.ts`, `panel-view.test.ts`, `panel-in-page.test.ts` | Tests. |
| `CHANGELOG.md` | User-facing entries under `## [Unreleased]`. |
| `ROADMAP.md` | 4.1 status + the recorded corrections. |
| `docs/architecture.md` | The related lane's new query rule. |

---

## Task 1: Gateway — the snippet comes from the body

**Files:**
- Modify: `packages/gateway/src/ipc/http-server.ts:561-585`
- Test: `packages/gateway/src/clips/clip-e2e.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change. `RelatedHit.snippet` is still `string`, but is now an extract of `item.body` and is never `null`.

**Context you need.** Migration V48 re-pointed `item_fts` from `(title, body_preview)` to `(title, body)` (`packages/gateway/src/index/body-store-v48-sql.ts:44`). FTS5's `snippet()` takes an **integer column index**, so index `0` is `title` — which is what the route asks for today, meaning every snippet ever returned has been an extract of the title, printed by the client directly beneath that same title. Index `1` is `body`. A negative index auto-selects the best-matching column and is **not** the fix — for a title-matching query it re-selects the title. A `NULL` body makes `snippet()` return SQL `NULL`, which would serialise as `"snippet": null` and be rejected by the client's guard, silently dropping the hit.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/clips/clip-e2e.test.ts`, inside the existing top-level `describe`:

```ts
  test("related snippet is an extract of the BODY, not an echo of the title", async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    const { code } = pairing.open("e2e-snippet-column", ["clip"]);
    const confirmRes = await fetch(`${base}/v1/clips/pair/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const { token } = (await confirmRes.json()) as { token: string };

    // Title and body share NO tokens, so the snippet's source column is provable.
    await fetch(`${base}/v1/clips`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        url: "https://example.com/snippet-column",
        title: "Zzalphatitleword",
        mode: "article",
        body: "Zzbetabodyword one two three four five six seven eight nine ten.",
        capturedAt: Date.now(),
      }),
    });

    const relRes = await fetch(`${base}/v1/clips/related`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Zzalphatitleword" }),
    });
    expect(relRes.status).toBe(200);
    const rel = (await relRes.json()) as { items: Array<{ snippet: string }> };
    const hit = rel.items.find((i) => i.snippet.includes("Zzbetabodyword"));
    expect(hit).toBeDefined();
    // The defect this pins: the snippet must not be the title read back.
    expect(hit?.snippet).not.toContain("Zzalphatitleword");
  });

  test("an item with no body yields an empty-string snippet, never null", async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    const { code } = pairing.open("e2e-null-body", ["clip"]);
    const confirmRes = await fetch(`${base}/v1/clips/pair/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const { token } = (await confirmRes.json()) as { token: string };

    // Write a title-only row directly: the clip route always supplies a body.
    const writeDb = new Database(dbPath, { readonly: false, create: false });
    try {
      writeDb.run(
        `INSERT INTO item (id, service, type, external_id, title, url, modified_at, synced_at)
         VALUES ('t:nullbody', 'test', 'page', 'nullbody', 'Zzgammatitleword', NULL, 1, 1)`,
      );
    } finally {
      writeDb.close();
    }

    const relRes = await fetch(`${base}/v1/clips/related`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Zzgammatitleword" }),
    });
    const rel = (await relRes.json()) as { items: Array<{ id: string; snippet: unknown }> };
    const hit = rel.items.find((i) => i.id === "t:nullbody");
    expect(hit).toBeDefined();
    expect(hit?.snippet).toBe("");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/gitrep/Nimbus/.claude/worktrees/related-item-and-fields && bun test packages/gateway/src/clips/clip-e2e.test.ts`
Expected: FAIL. The first test fails because the snippet contains `Zzalphatitleword` (the title echo). The second fails because `snippet` is `null`, not `""`.

- [ ] **Step 3: Fix the projection**

In `packages/gateway/src/ipc/http-server.ts`, in the `search` adapter, replace the snippet expression:

```ts
        const rows = db
          .query(
            // Column 1 is `body`. V48 re-pointed item_fts from (title, body_preview)
            // to (title, body); index 0 is the TITLE, which this asked for until
            // 2026-08 and which made every snippet an echo of the line above it.
            // COALESCE is load-bearing: snippet() over a NULL body returns NULL,
            // and the browser client's isRelatedHit requires a string — a null
            // would drop the hit from the panel entirely rather than blank a line.
            `SELECT i.id, i.title, i.service, i.url,
                    COALESCE(snippet(item_fts, 1, '', '', '…', 24), '') AS snippet
             FROM item i
             INNER JOIN item_fts ON i.rowid = item_fts.rowid
             WHERE item_fts MATCH ?
             ORDER BY rank
             LIMIT ?`,
          )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd C:/gitrep/Nimbus/.claude/worktrees/related-item-and-fields && bun test packages/gateway/src/clips/`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/related-item-and-fields
git add packages/gateway/src/ipc/http-server.ts packages/gateway/src/clips/clip-e2e.test.ts
git commit -m "fix(clips): related snippets came from the title, not the body

snippet()'s second argument is an FTS5 column index, and V48 re-pointed
item_fts from (title, body_preview) to (title, body). The related route
still asked for index 0, so every snippet it has ever returned was a
ten-token extract of the title — which the browser panel renders
directly beneath that same title.

Index 1 with a wider token budget, and COALESCE because snippet() over
a NULL body returns NULL, which the browser client's guard rejects."
```

---

## Task 2: Gateway — `type` and `modified_at` on the wire

**Files:**
- Modify: `packages/gateway/src/clips/clip-related.ts:8-14`
- Modify: `packages/gateway/src/ipc/http-server.ts` (the `search` adapter)
- Test: `packages/gateway/src/clips/clip-e2e.test.ts`

**Interfaces:**
- Consumes: Task 1's projection.
- Produces: `RelatedHit` is now
  `{ id: string; title: string; service: string; type: string; snippet: string; url: string | null; modified_at: number }`.
  Task 5 consumes this shape.

- [ ] **Step 1: Write the failing test**

Add to `clip-e2e.test.ts`:

```ts
  test("related hits carry type and modified_at (epoch ms)", async () => {
    const base = `http://127.0.0.1:${handle.port}`;
    const { code } = pairing.open("e2e-new-fields", ["clip"]);
    const confirmRes = await fetch(`${base}/v1/clips/pair/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const { token } = (await confirmRes.json()) as { token: string };

    const before = Date.now();
    await fetch(`${base}/v1/clips`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        url: "https://example.com/new-fields",
        title: "Zzdeltatitleword",
        mode: "article",
        body: "Zzdeltabody prose here.",
        capturedAt: Date.now(),
      }),
    });

    const relRes = await fetch(`${base}/v1/clips/related`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Zzdeltatitleword" }),
    });
    const rel = (await relRes.json()) as {
      items: Array<{ type: string; modified_at: number }>;
    };
    expect(rel.items.length).toBeGreaterThan(0);
    const hit = rel.items[0];
    expect(typeof hit?.type).toBe("string");
    expect(hit?.type.length).toBeGreaterThan(0);
    // Milliseconds, not seconds: a seconds value would sit in 1970 in JS.
    expect(hit?.modified_at).toBeGreaterThanOrEqual(before - 60_000);
    expect(hit?.modified_at).toBeLessThan(before + 60 * 60_000);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/clips/clip-e2e.test.ts`
Expected: FAIL — `typeof hit?.type` is `"undefined"`.

- [ ] **Step 3: Widen the interface**

In `packages/gateway/src/clips/clip-related.ts`:

```ts
export interface RelatedHit {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  /** The connector's item kind — `pr`, `issue`, `ci_run`, … An OPEN vocabulary:
   *  every connector may add one, so consumers must not switch exhaustively. */
  readonly type: string;
  readonly snippet: string;
  readonly url: string | null;
  /** Epoch MILLISECONDS, matching `GET /v1/items/resolve`'s `item.modified_at`. */
  readonly modified_at: number;
}
```

- [ ] **Step 4: Project the two columns**

In `http-server.ts`'s `search` adapter, extend the SELECT, the row cast and the mapping:

```ts
            `SELECT i.id, i.title, i.service, i.type, i.url, i.modified_at,
                    COALESCE(snippet(item_fts, 1, '', '', '…', 24), '') AS snippet
             FROM item i
             INNER JOIN item_fts ON i.rowid = item_fts.rowid
             WHERE item_fts MATCH ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(fts, limit) as Array<{
          id: string;
          title: string;
          service: string;
          type: string;
          url: string | null;
          modified_at: number;
          snippet: string;
        }>;
        return rows.map((r) => ({
          id: r.id,
          title: r.title,
          service: r.service,
          type: r.type,
          snippet: r.snippet,
          url: r.url,
          modified_at: r.modified_at,
        }));
```

- [ ] **Step 5: Fix the now-failing unit tests**

`clip-related.test.ts` builds `RelatedHit` literals that no longer typecheck. Add the two fields to each — in `runClipRelated`'s "delegates to the injected search" test and the "filters out hits whose url host matches excludeHost" test:

```ts
          return [
            {
              id: "drive:1",
              title: "Hit",
              service: "drive",
              type: "page",
              snippet: "s",
              url: "u",
              modified_at: 1,
            },
          ];
```

and

```ts
        search: async () => [
          {
            id: "a",
            title: "self",
            service: "nimbus",
            type: "page",
            snippet: "",
            url: "https://ex.com/self",
            modified_at: 1,
          },
          {
            id: "b",
            title: "other",
            service: "drive",
            type: "page",
            snippet: "",
            url: "https://other.com/x",
            modified_at: 2,
          },
        ],
```

- [ ] **Step 6: Run the tests and the typechecker**

Run: `bun test packages/gateway/src/clips/ && bun run typecheck:no-docs`
Expected: PASS on both.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/clips/ packages/gateway/src/ipc/http-server.ts
git commit -m "feat(clips): related hits carry their kind and their freshness

type and modified_at are columns on the item table the related query
already reads, and both are indexed. Projecting them lets a browser
client say what a hit IS and how stale it is, instead of rendering an
undifferentiated list of titles.

Additive: a client that does not know the fields ignores them. Named
as GET /v1/items/resolve names them — type plain, modified_at snake —
so one boundary parser serves both routes."
```

---

## Task 3: Gateway — relatedness by item id

**Files:**
- Modify: `packages/gateway/src/clips/clip-related.ts`
- Modify: `packages/gateway/src/ipc/http-server.ts` (wire the new dep)
- Test: `packages/gateway/src/clips/clip-related.test.ts`

**Interfaces:**
- Consumes: Task 2's `RelatedHit`.
- Produces:
  - `RelatedInput` grows `readonly itemId?: string`.
  - `ClipRelatedDeps` grows `readonly lookupItem: (id: string) => { title: string } | null` — **required**, one production call site.
  - `buildRelatedQuery(input, lookupItem)` — note the **second parameter**; its return type grows `excludeId?: string`.

**Context you need.** `ftsMatchQuery` maps every token to `(title : "tok"* OR body : "tok"*)` and joins with **`AND`** (`packages/gateway/src/search/hybrid-internal.ts:58-63`). So the query text must be the item's **title**, never its body — a 16 KiB body would build an AND-chain of thousands of required terms and match nothing. Precedence for the *query text* is `selection` → `itemId` → `title`; self-exclusion is keyed on `itemId` being **present**, independent of which won.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/clips/clip-related.test.ts`. Put a shared helper at the top of the file, under the imports:

```ts
const NO_ITEMS = (): null => null;
function hit(id: string, service = "github"): RelatedHit {
  return {
    id,
    title: id,
    service,
    type: "pr",
    snippet: "",
    url: `https://ex.com/${id}`,
    modified_at: 1,
  };
}
```

Then add a new describe block:

```ts
describe("buildRelatedQuery with itemId", () => {
  const lookup = (id: string): { title: string } | null =>
    id === "gh:1" ? { title: "Fix the flaky retry" } : null;

  test("itemId supplies the query text when there is no selection", () => {
    const q = buildRelatedQuery({ title: "Fix … · Pull Request #482 · acme/web", itemId: "gh:1" }, lookup);
    expect(q.query).toBe("Fix the flaky retry");
  });

  test("selection still beats itemId for the query text", () => {
    const q = buildRelatedQuery({ selection: "vector index", itemId: "gh:1" }, lookup);
    expect(q.query).toBe("vector index");
  });

  test("selection wins the query, and the item is STILL excluded", () => {
    const q = buildRelatedQuery({ selection: "vector index", itemId: "gh:1" }, lookup);
    expect(q.excludeId).toBe("gh:1");
  });

  test("an unknown itemId falls through to title rather than erroring", () => {
    const q = buildRelatedQuery({ title: "Page title", itemId: "gh:missing" }, lookup);
    expect(q.query).toBe("Page title");
    expect(q.excludeId).toBeUndefined();
  });

  test("no itemId → no exclusion", () => {
    expect(buildRelatedQuery({ title: "x" }, NO_ITEMS).excludeId).toBeUndefined();
  });

  test("a non-string itemId is coerced away, not thrown on", () => {
    const q = buildRelatedQuery({ title: "x", itemId: 7 } as unknown as RelatedInput, NO_ITEMS);
    expect(q.query).toBe("x");
    expect(q.excludeId).toBeUndefined();
  });
});

describe("runClipRelated self-exclusion", () => {
  test("the item excludes itself from its own related list", async () => {
    const out = await runClipRelated(
      {
        search: async () => [hit("gh:1"), hit("gh:2")],
        lookupItem: (id) => (id === "gh:1" ? { title: "Fix the flaky retry" } : null),
      },
      { itemId: "gh:1" },
    );
    expect(out.items.map((i) => i.id)).toEqual(["gh:2"]);
  });

  test("self-exclusion applies even when a selection drove the query", async () => {
    const out = await runClipRelated(
      {
        search: async () => [hit("gh:1"), hit("gh:2")],
        lookupItem: (id) => (id === "gh:1" ? { title: "Fix the flaky retry" } : null),
      },
      { selection: "flaky", itemId: "gh:1" },
    );
    expect(out.items.map((i) => i.id)).toEqual(["gh:2"]);
  });

  test("a selection on an unresolved page searches normally and excludes nothing", async () => {
    const out = await runClipRelated(
      { search: async () => [hit("gh:1"), hit("gh:2")], lookupItem: NO_ITEMS },
      { selection: "flaky" },
    );
    expect(out.items.map((i) => i.id)).toEqual(["gh:1", "gh:2"]);
  });
});
```

Update the existing `runClipRelated` tests to pass the new required dep — add `lookupItem: NO_ITEMS` beside each `search:` in the five existing cases.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/clips/clip-related.test.ts`
Expected: FAIL — `buildRelatedQuery` takes one argument and returns no `excludeId`.

- [ ] **Step 3: Implement**

Replace the top of `packages/gateway/src/clips/clip-related.ts` through `runClipRelated`:

```ts
export interface RelatedInput {
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly selection?: string;
  /** An indexed item id — the page the caller has already resolved. When it
   *  names a real row, its title becomes the query and the item is dropped from
   *  its own results. */
  readonly itemId?: string;
  readonly limit?: number;
}

export interface ClipRelatedDeps {
  /** Injected hybrid-search adapter (text query + limit → ranked hits). */
  readonly search: (query: string, limit: number) => Promise<RelatedHit[]>;
  /** Injected metadata read for `itemId`. Null when the id names no row. */
  readonly lookupItem: (id: string) => { title: string } | null;
}
```

and

```ts
export function buildRelatedQuery(
  input: RelatedInput,
  lookupItem: (id: string) => { title: string } | null,
): { query: string; excludeHost?: string; excludeId?: string } {
  const o = (input ?? {}) as RelatedInput;
  const itemId = asStr(o.itemId)?.trim();
  // Looked up BEFORE precedence is applied: a selection wins the query text, but
  // the item you are standing on is still the one answer that cannot tell you
  // anything new, so the exclusion is keyed on the id existing — not on it having
  // won. Keeping these two rules independent is the whole point.
  const item = itemId === undefined || itemId === "" ? null : lookupItem(itemId);
  // The item's TITLE, never its body: ftsMatchQuery AND-joins every token, so a
  // 16 KiB body becomes thousands of required terms and matches nothing.
  const query = (asStr(o.selection) ?? item?.title ?? asStr(o.title) ?? "").trim();
  const excludeHost = hostOf(asStr(o.canonicalUrl));
  return {
    query,
    ...(excludeHost === undefined ? {} : { excludeHost }),
    ...(item === null || itemId === undefined ? {} : { excludeId: itemId }),
  };
}

export async function runClipRelated(
  deps: ClipRelatedDeps,
  input: RelatedInput,
): Promise<{ items: RelatedHit[] }> {
  const { query, excludeHost, excludeId } = buildRelatedQuery(input, deps.lookupItem);
  if (query === "") return { items: [] };
  const rawLimit =
    typeof input?.limit === "number" && Number.isFinite(input.limit) ? input.limit : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));
  const hits = await deps.search(query, limit);
  const items = hits.filter(
    (h) =>
      (excludeHost === undefined || hostOf(h.url) !== excludeHost) &&
      (excludeId === undefined || h.id !== excludeId),
  );
  return { items };
}
```

- [ ] **Step 4: Wire the dep at the route**

In `http-server.ts`'s `handleClipRelated`, add `lookupItem` beside `search` in the deps object:

```ts
      lookupItem: (id: string): { title: string } | null => {
        // Inline single-row read, the house pattern — see decisions.ts:33 and
        // decision-corroborate.ts:49. Metadata only; never a body.
        const row = db.query("SELECT title FROM item WHERE id = ?").get(id) as
          | { title: string }
          | null;
        return row === null ? null : { title: row.title };
      },
```

- [ ] **Step 5: Run the tests and the typechecker**

Run: `bun test packages/gateway/src/clips/ && bun run typecheck:no-docs`
Expected: PASS on both.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/clips/ packages/gateway/src/ipc/http-server.ts
git commit -m "feat(clips): answer related against a resolved item, not a page title

A browser client that has already resolved the page knows exactly which
indexed item it is looking at, and was reduced to sending document.title
— which on a pull request is mostly chrome and on Jenkins is 'build #42
[Jenkins]'.

itemId takes the item's own title as the query and drops the item from
its own results. Its title, never its body: ftsMatchQuery AND-joins
every token, so a 16 KiB body matches nothing.

Precedence governs the query text only. Self-exclusion is keyed on the
id being present, so a selection on a resolved page cannot return that
page as its own top hit. An unknown id falls through rather than
erroring — the row may have been deleted between resolve and related."
```

---

## Task 4: Gateway — the stale comment, and ship it

**Files:**
- Modify: `packages/gateway/src/glossary/glossary-project.ts:21`

- [ ] **Step 1: Correct the comment**

V48 re-pointed `item_fts` to `(title, body)`, so this line is untrue:

```ts
 * `item_fts` indexes only `title` and `body` — metadata JSON is
```

(The rest of the sentence is unchanged.)

- [ ] **Step 2: Run the full gateway clip + glossary suites**

Run: `bun test packages/gateway/src/clips/ packages/gateway/src/glossary/`
Expected: PASS.

- [ ] **Step 3: Lint and typecheck the whole worktree**

Run: `bun run typecheck:no-docs && bunx biome check packages/gateway/src/clips packages/gateway/src/ipc/http-server.ts packages/gateway/src/glossary`
Expected: clean.

- [ ] **Step 4: Commit and push**

```bash
git add packages/gateway/src/glossary/glossary-project.ts
git commit -m "docs(glossary): item_fts indexes body, not body_preview, since V48"
git push -u origin dev/asaf/related-item-and-fields
```

- [ ] **Step 5: Open the gateway PR**

```bash
gh pr create --title "feat(clips): related answers about the resolved item, and its snippets come from the body" --body "$(cat <<'EOF'
Three changes to `POST /v1/clips/related`, driven by the browser client's
Related lane.

**The snippet has always been an extract of the title.** `snippet()`'s second
argument is an FTS5 column index, and V48 re-pointed `item_fts` from
`(title, body_preview)` to `(title, body)` — index `0` is the title. The
browser panel renders that snippet directly beneath the same title, which is
why the lane reads thin. Now index `1`, `COALESCE`d because `snippet()` over a
`NULL` body returns `NULL` and the client's guard requires a string.

**`type` and `modified_at` are projected.** Both are indexed columns on the
table the query already reads. Additive; named as `GET /v1/items/resolve` names
them.

**`itemId` makes relatedness about the item, not the page title.** Its title is
the query (never its body — `ftsMatchQuery` AND-joins every token), and the
item is dropped from its own results. Precedence governs query text only;
self-exclusion is keyed on the id being present.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Task 5: Client — the wire shape, guarded and renamed

**Files:**
- Modify: `src/shared/types.ts:48-54`
- Modify: `src/shared/related.ts:38-47`
- Modify: `src/background/gateway-client.ts:259-265`
- Test: `test/unit/related.test.ts`, `test/unit/gateway-client.test.ts`

**Interfaces:**
- Consumes: Task 2's wire shape.
- Produces: `RelatedHit` = `{ id, title, service, snippet, url, type?: string, modifiedAt?: number }`; `parseRelatedHit(v: unknown): RelatedHit | null` exported from `src/shared/related.ts`.

**Context you need.** The wire says `modified_at`; this repo renames to `modifiedAt` at the HTTP boundary so the wire shape stops at the parser — the same thing `parseCandidate` already does for resolve. Both new fields are **optional on the client**, because a user's gateway and their extension update on unrelated schedules: a hit lacking them must render as today's row, not be rejected.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/related.test.ts`:

```ts
import { parseRelatedHit } from "../../src/shared/related.ts";

describe("parseRelatedHit", () => {
  const base = { id: "gh:1", title: "T", service: "github", snippet: "s", url: null };

  test("accepts the old five-field shape and leaves the new fields absent", () => {
    const hit = parseRelatedHit(base);
    expect(hit).not.toBeNull();
    expect("type" in (hit ?? {})).toBe(false);
    expect("modifiedAt" in (hit ?? {})).toBe(false);
  });

  test("renames modified_at to modifiedAt and keeps type", () => {
    expect(parseRelatedHit({ ...base, type: "pr", modified_at: 1_700_000_000_000 })).toEqual({
      ...base,
      type: "pr",
      modifiedAt: 1_700_000_000_000,
    });
  });

  test("a non-numeric modified_at is dropped, not carried through", () => {
    const hit = parseRelatedHit({ ...base, modified_at: "yesterday" });
    expect(hit).not.toBeNull();
    expect("modifiedAt" in (hit ?? {})).toBe(false);
  });

  test("a non-string type is dropped", () => {
    const hit = parseRelatedHit({ ...base, type: 7 });
    expect(hit).not.toBeNull();
    expect("type" in (hit ?? {})).toBe(false);
  });

  test("a null snippet is rejected outright — the gateway must coalesce", () => {
    expect(parseRelatedHit({ ...base, snippet: null })).toBeNull();
  });

  test("a missing required field is rejected", () => {
    expect(parseRelatedHit({ id: "x", title: "T", service: "github" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/gitrep/nimbus-web-clipper/.claude/worktrees/richer-related-lane && bunx vitest run test/unit/related.test.ts`
Expected: FAIL — `parseRelatedHit` is not exported.

- [ ] **Step 3: Widen the type**

In `src/shared/types.ts`, replace the `RelatedHit` interface:

```ts
export interface RelatedHit {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly snippet: string;
  readonly url: string | null;
  /**
   * The connector's item kind — `pr`, `issue`, `ci_run`, … OPTIONAL because a
   * gateway older than the projection sends none, and an extension updates on a
   * different schedule than the gateway it talks to. Absent renders no chip; it
   * is never a reason to reject the hit.
   *
   * An OPEN vocabulary: connectors add kinds freely, so nothing may switch
   * exhaustively over it. See `humaniseType` in `panel/related-groups.ts`.
   */
  readonly type?: string;
  /** Epoch ms, renamed from the wire's `modified_at` at the HTTP boundary
   *  (`gateway-client.ts`) so the wire shape stops at the parser — the same
   *  treatment `ResolvedItem.modifiedAt` already gets. Optional for the same
   *  reason as `type`. */
  readonly modifiedAt?: number;
}
```

- [ ] **Step 4: Implement the parser**

In `src/shared/related.ts`, replace `isRelatedHit` with a parser plus a guard that delegates to it:

```ts
/**
 * Parse one wire hit, renaming `modified_at` → `modifiedAt`.
 *
 * The two new fields are dropped rather than fatal when malformed or missing:
 * an older gateway sends neither, and rejecting the hit would empty the lane for
 * anyone who has not updated. A malformed REQUIRED field is still fatal.
 */
export function parseRelatedHit(v: unknown): RelatedHit | null {
  if (
    !isObject(v) ||
    typeof v["id"] !== "string" ||
    typeof v["title"] !== "string" ||
    typeof v["service"] !== "string" ||
    typeof v["snippet"] !== "string" ||
    (v["url"] !== null && typeof v["url"] !== "string")
  ) {
    return null;
  }
  const type = v["type"];
  const modifiedAt = v["modified_at"];
  return {
    id: v["id"],
    title: v["title"],
    service: v["service"],
    snippet: v["snippet"],
    url: v["url"],
    ...(typeof type === "string" && type !== "" ? { type } : {}),
    ...(typeof modifiedAt === "number" && Number.isFinite(modifiedAt) ? { modifiedAt } : {}),
  };
}

export function isRelatedHit(v: unknown): v is RelatedHit {
  return parseRelatedHit(v) !== null;
}
```

- [ ] **Step 5: Apply the rename at the HTTP boundary**

In `src/background/gateway-client.ts`, `postRelated`'s 200 branch currently casts the raw array. Replace it so the parsed objects — not the wire objects — are what leave the boundary:

```ts
  if (res.status === 200) {
    const data = await readJson(res);
    if (isObject(data) && Array.isArray(data["items"])) {
      const parsed = data["items"].map(parseRelatedHit);
      if (parsed.every((h): h is RelatedHit => h !== null)) {
        return { ok: true, items: parsed };
      }
    }
    return { ok: false, reason: "server_error" };
  }
```

Update the import at the top of the file from `isRelatedHit` to `parseRelatedHit` (keep `isRelatedHit` imported only if still used elsewhere in the file — it is not).

- [ ] **Step 6: Add the boundary test**

Add to `test/unit/gateway-client.test.ts`, inside the same `describe` as the existing `postRelated` tests. There is no shared fetch stub in this file — the neighbouring tests inline an `async (url, init) => new Response(...)`, and this follows them. `query` is the existing module-level fixture:

```ts
  test("200 → modified_at is renamed to modifiedAt at the boundary", async () => {
    const out = await postRelated(
      "http://127.0.0.1:8765",
      "t",
      query,
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: "gh:1",
                title: "T",
                service: "github",
                snippet: "s",
                url: null,
                type: "pr",
                modified_at: 1_700_000_000_000,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    expect(out).toEqual({
      ok: true,
      items: [
        {
          id: "gh:1",
          title: "T",
          service: "github",
          snippet: "s",
          url: null,
          type: "pr",
          modifiedAt: 1_700_000_000_000,
        },
      ],
    });
  });

  test("200 → a hit from a gateway with neither new field still parses", async () => {
    const out = await postRelated(
      "http://127.0.0.1:8765",
      "t",
      query,
      async () =>
        new Response(
          JSON.stringify({
            items: [{ id: "gh:2", title: "T", service: "github", snippet: "s", url: null }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    expect(out).toEqual({
      ok: true,
      items: [{ id: "gh:2", title: "T", service: "github", snippet: "s", url: null }],
    });
  });
```

Note: the file's existing `hit` fixture is a five-field hit reused by several assertions. Leave it alone — the second test above is what pins the old shape.

- [ ] **Step 7: Run the tests and the typechecker**

Run: `bunx vitest run test/unit/related.test.ts test/unit/gateway-client.test.ts test/unit/messages.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/shared/related.ts src/background/gateway-client.ts test/unit/
git commit -m "feat(related): parse the hit's kind and freshness at the boundary

The gateway now projects type and modified_at. Both land as OPTIONAL
client fields and are dropped rather than fatal when absent or
malformed: an extension and the gateway it talks to update on unrelated
schedules, and rejecting a hit for a field an older gateway never sends
would empty the lane instead of degrading it.

modified_at is renamed to modifiedAt in postRelated, so the wire shape
stops at the parser — the same treatment parseCandidate gives resolve.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Client — `related-groups.ts`, the pure rendering decisions

**Files:**
- Create: `src/panel/related-groups.ts`
- Test: `test/unit/related-groups.test.ts` (new)

**Interfaces:**
- Consumes: `RelatedHit` from Task 5.
- Produces:
  - `export interface RelatedGroup { readonly service: string; readonly hits: readonly RelatedHit[] }`
  - `export function groupHits(hits: readonly RelatedHit[]): RelatedGroup[]`
  - `export function humaniseType(type: string | undefined): string | null`
  Task 7 renders both.

**Context you need.** The wire carries no relevance score — only position, from the gateway's `ORDER BY rank`. So a service's rank *is* the position of its best hit: groups appear in order of first appearance, and hits keep their ranked order inside a group. Grouping must never reorder relevance. `item.type` is an open vocabulary (23+ literals across connectors, any new connector adds more), so the chip is a mechanical humaniser over a three-entry override table — never an exhaustive map.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/related-groups.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { groupHits, humaniseType } from "../../src/panel/related-groups.ts";
import type { RelatedHit } from "../../src/shared/types.ts";

function hit(id: string, service: string): RelatedHit {
  return { id, title: id, service, snippet: "", url: null };
}

describe("groupHits", () => {
  test("no hits → no groups", () => {
    expect(groupHits([])).toEqual([]);
  });

  test("one service → one group, order preserved", () => {
    const hits = [hit("a", "github"), hit("b", "github")];
    expect(groupHits(hits)).toEqual([{ service: "github", hits }]);
  });

  test("groups follow the rank position of their FIRST hit, not size", () => {
    // jira appears once and early; github appears twice but later. Rank wins.
    const hits = [hit("j1", "jira"), hit("g1", "github"), hit("g2", "github")];
    expect(groupHits(hits).map((g) => g.service)).toEqual(["jira", "github"]);
  });

  test("interleaved services collapse without reordering within a group", () => {
    const hits = [hit("g1", "github"), hit("j1", "jira"), hit("g2", "github")];
    const groups = groupHits(hits);
    expect(groups.map((g) => g.service)).toEqual(["github", "jira"]);
    expect(groups[0]?.hits.map((h) => h.id)).toEqual(["g1", "g2"]);
  });
});

describe("humaniseType", () => {
  test("overrides win where the mechanical rule reads wrong", () => {
    expect(humaniseType("pr")).toBe("Pull request");
    expect(humaniseType("ci_run")).toBe("CI run");
    expect(humaniseType("api_endpoint")).toBe("API endpoint");
  });

  test("an unknown type is humanised, never flattened to a generic word", () => {
    expect(humaniseType("code_symbol")).toBe("Code symbol");
    expect(humaniseType("obsidian_note")).toBe("Obsidian note");
    expect(humaniseType("issue")).toBe("Issue");
  });

  test("absent or blank → no chip", () => {
    expect(humaniseType(undefined)).toBeNull();
    expect(humaniseType("")).toBeNull();
    expect(humaniseType("   ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/related-groups.test.ts`
Expected: FAIL — cannot resolve `../../src/panel/related-groups.ts`.

- [ ] **Step 3: Implement**

Create `src/panel/related-groups.ts`:

```ts
// src/panel/related-groups.ts
// How the Related lane's hits are arranged and labelled. Pure — no DOM, no
// messaging — so the two rules that decide what the reader sees are testable on
// their own, and so neither grows inside panel-view.ts or panel-in-page.ts.
import type { RelatedHit } from "../shared/types.ts";

/** One service's hits, in the order the gateway ranked them. */
export interface RelatedGroup {
  readonly service: string;
  readonly hits: readonly RelatedHit[];
}

/**
 * Collapse ranked hits into per-service groups WITHOUT reordering relevance.
 *
 * The wire carries no score — only position, from the gateway's `ORDER BY rank`.
 * So a service's rank is the position of its best hit: groups appear in order of
 * first appearance, and hits keep their ranked order inside each group. Sorting
 * groups by size instead would promote a big pile of weak hits over the single
 * best answer, which is the one thing this lane must not do.
 */
export function groupHits(hits: readonly RelatedHit[]): RelatedGroup[] {
  const order: string[] = [];
  const byService = new Map<string, RelatedHit[]>();
  for (const h of hits) {
    const existing = byService.get(h.service);
    if (existing === undefined) {
      order.push(h.service);
      byService.set(h.service, [h]);
    } else {
      existing.push(h);
    }
  }
  return order.map((service) => ({ service, hits: byService.get(service) ?? [] }));
}

/**
 * The handful of kinds whose mechanical humanisation reads wrong. Deliberately
 * TINY, and deliberately not a complete map: `item.type` is an open vocabulary —
 * the connectors already write 23+ distinct values and every new connector may
 * add another — so a closed table would go stale and start mislabelling real,
 * nameable kinds as something generic.
 */
const TYPE_OVERRIDES: Record<string, string> = {
  pr: "Pull request",
  ci_run: "CI run",
  api_endpoint: "API endpoint",
};

/**
 * A short human label for an item kind, or null when there is nothing to say.
 *
 * Null — not "Item" — because a chip that says nothing specific is furniture: it
 * costs a row of space and tells the reader something they already knew.
 */
export function humaniseType(type: string | undefined): string | null {
  if (type === undefined) {
    return null;
  }
  const key = type.trim();
  if (key === "") {
    return null;
  }
  const override = TYPE_OVERRIDES[key];
  if (override !== undefined) {
    return override;
  }
  const words = key.replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/related-groups.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/panel/related-groups.ts test/unit/related-groups.test.ts
git commit -m "feat(panel): pure grouping and kind labels for the related lane

Groups follow the rank position of their first hit, so grouping only
inserts headings into a list that was already ordered correctly — it
never promotes a big pile of weak hits over the single best answer.

The kind chip is a mechanical humaniser over three overrides rather
than a lookup table: item.type is an open vocabulary of 23+ values that
grows with every connector, so a closed map would go stale and start
labelling real kinds as something generic.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Client — render the richer row

**Files:**
- Modify: `src/panel/panel-view.ts:59-102`
- Modify: `src/panel/panel-in-page.ts` (the `STYLES` constant — add the new classes)
- Test: `test/unit/panel-view.test.ts`

**Interfaces:**
- Consumes: `groupHits`, `humaniseType` (Task 6); `formatAge` from `src/shared/freshness.ts`.
- Produces: `renderHits(doc: Document, items: RelatedHit[], nowMs: number): HTMLElement` — **note the new third parameter**. Task 8 supplies it.

**Context you need.** Every gateway-provided string goes through `textContent`, never `innerHTML` — indexed content is attacker-influenceable and plain-text rendering is the XSS backstop. `formatAge(modifiedAtMs, nowMs)` takes an injected clock so one repaint uses one timestamp. The copy is `Updated <age>`, identical to the header's line, so two freshness claims in one panel cannot word the same fact differently.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/panel-view.test.ts` (it already has a jsdom docblock and a `doc` helper — reuse them):

```ts
describe("renderHits — the richer row", () => {
  const NOW = 1_700_000_000_000;
  function hit(over: Partial<RelatedHit> = {}): RelatedHit {
    return { id: "gh:1", title: "T", service: "github", snippet: "body words", url: null, ...over };
  }

  test("a hit with a type renders a chip with the humanised label", () => {
    const el = renderHits(doc, [hit({ type: "pr" })], NOW);
    expect(el.querySelector(".nimbus-related__kind")?.textContent).toBe("Pull request");
  });

  test("a hit without a type renders no chip at all", () => {
    const el = renderHits(doc, [hit()], NOW);
    expect(el.querySelector(".nimbus-related__kind")).toBeNull();
  });

  test("modifiedAt renders as 'Updated …', the header's wording", () => {
    const el = renderHits(doc, [hit({ modifiedAt: NOW - 3 * 24 * 60 * 60 * 1000 })], NOW);
    expect(el.querySelector(".nimbus-related__age")?.textContent).toBe("Updated 3 days ago");
  });

  test("no modifiedAt renders no age line", () => {
    const el = renderHits(doc, [hit()], NOW);
    expect(el.querySelector(".nimbus-related__age")).toBeNull();
  });

  test("an empty snippet omits the paragraph rather than rendering it blank", () => {
    const el = renderHits(doc, [hit({ snippet: "" })], NOW);
    expect(el.querySelector(".nimbus-related__snippet")).toBeNull();
  });

  test("a group heading names the service and counts its hits", () => {
    const el = renderHits(doc, [hit({ id: "a" }), hit({ id: "b" })], NOW);
    const heads = [...el.querySelectorAll(".nimbus-related__group-head")].map(
      (h) => h.textContent,
    );
    expect(heads).toEqual(["github · 2"]);
  });

  test("two services produce two headings in rank order", () => {
    const el = renderHits(
      doc,
      [hit({ id: "j", service: "jira" }), hit({ id: "g", service: "github" })],
      NOW,
    );
    const heads = [...el.querySelectorAll(".nimbus-related__group-head")].map(
      (h) => h.textContent,
    );
    expect(heads).toEqual(["jira · 1", "github · 1"]);
  });

  test("gateway strings are never treated as markup", () => {
    const el = renderHits(doc, [hit({ title: "<img src=x onerror=alert(1)>" })], NOW);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("no hits still renders the empty state", () => {
    const el = renderHits(doc, [], NOW);
    expect(el.textContent).toBe("No related items found.");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/panel-view.test.ts`
Expected: FAIL — `renderHits` takes two arguments; no `.nimbus-related__kind` exists.

- [ ] **Step 3: Implement the render**

In `src/panel/panel-view.ts`, add the import and replace `renderHit`/`renderHits`:

```ts
import { groupHits, humaniseType } from "./related-groups.ts";
```

```ts
export function renderHit(doc: Document, hit: RelatedHit, nowMs: number): HTMLElement {
  const item = doc.createElement("li");
  item.className = "nimbus-related__item";

  const href = hit.url !== null ? safeHttpUrl(hit.url) : null;

  let title: HTMLElement;
  if (href !== null) {
    const link = doc.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = hit.title;
    title = link;
  } else {
    const span = doc.createElement("span");
    span.textContent = hit.title;
    title = span;
  }
  title.classList.add("nimbus-related__title");
  item.append(title);

  // The kind chip and the age line are both OPTIONAL by design: a gateway older
  // than the projection sends neither, and an absent chip is quieter than a chip
  // that says nothing. The service badge is gone from the row — the group
  // heading above already names it once, and repeating it per row was the
  // clutter that made this list hard to scan.
  const kind = humaniseType(hit.type);
  if (kind !== null) {
    const chip = doc.createElement("span");
    chip.className = "nimbus-related__kind";
    chip.textContent = kind;
    item.append(chip);
  }

  if (hit.snippet !== "") {
    const snippet = doc.createElement("p");
    snippet.className = "nimbus-related__snippet";
    snippet.textContent = hit.snippet;
    item.append(snippet);
  }

  if (hit.modifiedAt !== undefined) {
    const age = doc.createElement("p");
    age.className = "nimbus-related__age";
    // "Updated", never "Indexed" — this is the item's own last-modified time as
    // its source reports it. Same word the header uses, deliberately.
    age.textContent = `Updated ${formatAge(hit.modifiedAt, nowMs)}`;
    item.append(age);
  }

  return item;
}

export function renderHits(doc: Document, items: RelatedHit[], nowMs: number): HTMLElement {
  if (items.length === 0) {
    return renderError(doc, "No related items found.");
  }
  const wrapper = doc.createElement("div");
  wrapper.className = "nimbus-related__groups";
  for (const group of groupHits(items)) {
    const head = doc.createElement("p");
    head.className = "nimbus-related__group-head";
    // The count is what makes an all-one-service result read as a real answer
    // rather than as a truncation.
    head.textContent = `${group.service} · ${String(group.hits.length)}`;
    const list = doc.createElement("ul");
    list.className = "nimbus-related__list";
    for (const hit of group.hits) {
      list.append(renderHit(doc, hit, nowMs));
    }
    wrapper.append(head, list);
  }
  return wrapper;
}
```

- [ ] **Step 4: Add the styles**

In `src/panel/panel-in-page.ts`, find the `STYLES` template literal and add these rules next to the existing `.nimbus-related__snippet` rule. Match the surrounding declaration style:

```css
.nimbus-related__group-head { margin: 10px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
.nimbus-related__kind { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 3px; font-size: 10px; background: rgba(127,127,127,.18); }
.nimbus-related__age { margin: 2px 0 0; font-size: 11px; opacity: .55; }
```

The old `.nimbus-related__badge` rule is now unused — delete it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/panel-view.test.ts && bun run typecheck`
Expected: PASS. If `typecheck` flags other `renderHits` call sites, leave them — Task 8 fixes the one real caller.

- [ ] **Step 6: Commit**

```bash
git add src/panel/panel-view.ts src/panel/panel-in-page.ts test/unit/panel-view.test.ts
git commit -m "feat(panel): a related row that says what it is and how fresh

Each hit gains a kind chip and an 'Updated …' line, and hits group under
a per-service heading carrying a count. The per-row service badge is
gone: the heading names the service once, and repeating it on every row
was the clutter that made the list hard to scan.

Both new lines are omitted rather than rendered empty when the gateway
does not supply them, so the lane degrades to its previous shape instead
of showing furniture. 'Updated' matches the header's wording so two
freshness claims in one panel cannot word the same fact differently.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Client — send the item the panel already resolved

**Files:**
- Modify: `src/shared/messages.ts:59-64` and `:327-335`
- Modify: `src/shared/related.ts:19-32`
- Modify: `src/background/handlers.ts:135`
- Modify: `src/panel/panel-in-page.ts` (`loadRelated`, and its `renderHits` call)
- Test: `test/unit/related.test.ts`, `test/unit/messages.test.ts`, `test/unit/panel-in-page.test.ts`

**Interfaces:**
- Consumes: Task 3's `itemId` wire field; Task 7's three-argument `renderHits`.
- Produces: `RelatedRequest` and `RelatedQuery` both grow `readonly itemId?: string`.

**Context you need.** `buildRelatedQuery` must **keep sending `title` even when it sends `itemId`**. A gateway older than Task 3 ignores `itemId`; if `title` were dropped too, the query text would be empty and `runClipRelated` returns `{items: []}` — a permanently blank lane for anyone who has not updated their gateway. `canonicalUrl` is the only field withheld, and withholding it against an old gateway merely disables the host filter, which is the outcome we want. The panel's item id comes from the header state: `resolved` carries `item: ResolvedItem`, `chosen` carries `candidate: ResolveCandidate` — both have `.id`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/related.test.ts`:

```ts
describe("buildRelatedQuery with itemId", () => {
  test("an itemId is sent, and title is STILL sent beside it", () => {
    const q = buildRelatedQuery({ title: "Page title", itemId: "gh:1" });
    expect(q.itemId).toBe("gh:1");
    // Load-bearing: a gateway that does not know itemId falls back to title. If
    // title were dropped, that gateway would receive an empty query and the lane
    // would go permanently blank.
    expect(q.title).toBe("Page title");
  });

  test("canonicalUrl is withheld once an itemId is present", () => {
    const q = buildRelatedQuery({
      title: "T",
      canonicalUrl: "https://github.com/acme/web/pull/482",
      itemId: "gh:1",
    });
    expect("canonicalUrl" in q).toBe(false);
  });

  test("without an itemId, canonicalUrl is sent exactly as before", () => {
    const q = buildRelatedQuery({ title: "T", canonicalUrl: "https://ex.com/p" });
    expect(q.canonicalUrl).toBe("https://ex.com/p");
    expect("itemId" in q).toBe(false);
  });

  test("a blank itemId is treated as absent", () => {
    const q = buildRelatedQuery({ title: "T", canonicalUrl: "https://ex.com/p", itemId: "  " });
    expect("itemId" in q).toBe(false);
    expect(q.canonicalUrl).toBe("https://ex.com/p");
  });
});
```

Add to `test/unit/messages.test.ts`:

```ts
  test("isRelatedRequest accepts an itemId and rejects a non-string one", () => {
    expect(isRelatedRequest({ kind: "related", itemId: "gh:1" })).toBe(true);
    expect(isRelatedRequest({ kind: "related" })).toBe(true);
    expect(isRelatedRequest({ kind: "related", itemId: 7 })).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/related.test.ts test/unit/messages.test.ts`
Expected: FAIL — `itemId` is not a known property.

- [ ] **Step 3: Grow the message and its guard**

In `src/shared/messages.ts`:

```ts
export interface RelatedRequest {
  readonly kind: "related";
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly selection?: string;
  /** The indexed item the panel has already resolved this page to. Untrusted —
   *  it arrives from a content script — so it is guarded here like every other
   *  cross-boundary value. */
  readonly itemId?: string;
}
```

and in `isRelatedRequest`, add one clause before the closing paren:

```ts
    (v["itemId"] === undefined || typeof v["itemId"] === "string") &&
```

- [ ] **Step 4: Teach `buildRelatedQuery` the rule**

In `src/shared/related.ts`:

```ts
/** The gateway request body for POST /v1/clips/related. */
export interface RelatedQuery {
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly selection?: string;
  readonly itemId?: string;
  readonly limit: number;
}
```

```ts
export function buildRelatedQuery(
  ctx: { title?: string; canonicalUrl?: string; selection?: string; itemId?: string },
  limit: number = RELATED_LIMIT,
): RelatedQuery {
  const title = ctx.title?.trim();
  const canonicalUrl = ctx.canonicalUrl?.trim();
  const selection = ctx.selection?.trim();
  const itemId = ctx.itemId?.trim();
  const haveItem = itemId !== undefined && itemId !== "";
  return {
    // `title` is sent even alongside `itemId`, and that is load-bearing: a
    // gateway older than the itemId query ignores the id, and dropping the title
    // would leave it with an empty query — which it answers with zero hits. The
    // lane would go permanently blank for anyone who had not updated.
    ...(title !== undefined && title !== "" ? { title } : {}),
    // `canonicalUrl` is the one field withheld once we can name the item. The
    // gateway uses it to exclude the whole HOST, which on a pull request throws
    // away every other item from the one host holding all your context. With an
    // id, the item excludes itself precisely instead.
    ...(!haveItem && canonicalUrl !== undefined && canonicalUrl !== "" ? { canonicalUrl } : {}),
    ...(selection !== undefined && selection !== "" ? { selection } : {}),
    ...(haveItem ? { itemId } : {}),
    limit,
  };
}
```

- [ ] **Step 5: Pass the id through the handler**

In `src/background/handlers.ts:135`, `buildRelatedQuery(req)` already spreads the request. Confirm `req` is typed `RelatedRequest` so `itemId` flows through with no change. If the handler destructures fields explicitly instead, add `itemId` to that list.

- [ ] **Step 6: Supply the id from the panel**

In `src/panel/panel-in-page.ts`, inside `loadRelated`, replace the `sendMessage` call:

```ts
      const context = readContext();
      // The item this panel's header names — `resolved`, or the candidate the
      // user picked out of an ambiguous answer. Reusing `shownHeader()` means
      // the lane can never be about a different item than the header above it.
      const shown = shownHeader();
      const itemId =
        shown.kind === "resolved"
          ? shown.item.id
          : shown.kind === "chosen"
            ? shown.candidate.id
            : undefined;
      res = await sendMessage({
        kind: "related",
        ...context,
        ...(itemId === undefined ? {} : { itemId }),
        ...(selection === undefined ? {} : { selection }),
      });
```

`shownHeader()` is the existing accessor (`src/panel/panel-in-page.ts:669`) — the same one `laneContext()` already derives `pickedItemId` from. **Do not add a second source of truth.** Note it returns `fetchState` first when a fetch is in flight; that state's `kind` is neither `resolved` nor `chosen`, so the branch above correctly yields `undefined` and the lane falls back to the title query while a fetch is pending.

Then update the `renderHits` call in the same function to pass the clock:

```ts
    } else if (res.ok) {
      const items: RelatedHit[] = res.items;
      const nowMs = Date.now();
      relatedBody = (doc) => renderHits(doc, items, nowMs);
```

`nowMs` is captured once, outside the closure, so repaints do not make the ages drift under a stationary panel — the same rule the header's frozen age already follows.

- [ ] **Step 7: Run the full suite and the typechecker**

Run: `bunx vitest run && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 8: Commit**

```bash
git add src/shared/messages.ts src/shared/related.ts src/panel/panel-in-page.ts src/background/handlers.ts test/unit/
git commit -m "feat(related): ask about the item, not about document.title

Since C1.1 the panel knows which indexed item the page is; the related
lane was still full-text searching the browser tab's title, which on a
pull request is mostly chrome and on Jenkins is 'build #42 [Jenkins]'.
It now sends that item's id, taken from the same header state the panel
renders, so the lane cannot be about a different item than the header
above it.

canonicalUrl is withheld once an id is available. The gateway uses it to
exclude the whole HOST, which on a GitHub pull request threw away every
other github.com item — the one host holding all your context. title is
still sent beside the id, deliberately: a gateway that does not know
itemId falls back to it, and dropping it would blank the lane.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Client — docs, changelog, roadmap, and ship

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md` (item 4.1)
- Modify: `docs/architecture.md`
- Modify: `docs/development.md`

- [ ] **Step 1: Add the changelog entries**

Under `## [Unreleased]` → `### Fixed`, add:

```markdown
- **Related items showed you the title twice.** Every related result's preview
  line was an extract of its own title, printed directly beneath that title, so
  the lane repeated itself instead of telling you anything about the item. It now
  previews the item's actual content.
- **Related hid the results most likely to help.** On a page whose site Nimbus
  recognised — a GitHub pull request, say — every other item from that same site
  was filtered out of Related, which on a working surface is exactly where all
  your context lives. Related now excludes only the page you are on.
```

Under `### Added`:

```markdown
- **Related is about the item, not the tab title.** On a page Nimbus has resolved,
  Related now asks about that indexed item rather than searching for whatever the
  browser tab happens to be called — so a Jenkins page stops searching for
  "build #42 [Jenkins]".
- **Related results say what they are and how fresh they are.** Each result now
  carries its kind — pull request, issue, CI run — and when it was last updated,
  and results are grouped under the service they came from with a count.
```

- [ ] **Step 2: Update the roadmap**

In `ROADMAP.md`, replace the 4.1 brief's tag line and append a status block. Change the heading to:

```markdown
### 4.1 Richer related panel · 🟢/🟡 · M — ✅ shipped (open-in-Nimbus dropped)
```

and append, after the existing `**Reframe**` line:

```markdown
> **Status** Shipped, and two thirds of the brief turned out to be a correction
> rather than an addition. The **snippet was an extract of the title** —
> `snippet()`'s second argument is an FTS5 column index and V48 re-pointed
> `item_fts` to `(title, body)`, so index `0` returned the title the client was
> already printing above it. And the lane **excluded its own best results**: the
> gateway drops every hit sharing the host of the `canonicalUrl` sent, which on a
> GitHub pull request is every other github.com item. Both shipped as defects,
> not as gaps awaiting polish.
> `type` and `date` were **not buildable against the locked contract** — the wire
> hit was five fields — so this item is retagged 🟢 → 🟢/🟡: the projection was
> proposed and landed upstream, and the client consumes it.
> **`open-in-Nimbus` is dropped, not deferred.** It presumes a way to address an
> indexed item from outside the gateway and there is none: no route, and
> `grep -rn "nimbus://" packages` returns zero matches. The link to the item's
> source, which the lane already renders, is the only "open" that exists. If a
> deep-link primitive is ever proposed upstream this becomes a one-line client
> change.
> Design: `docs/superpowers/specs/2026-08-16-richer-related-lane-design.md`.
```

- [ ] **Step 3: Document the query rule**

In `docs/architecture.md`, add this as a new `####` subsection at the end of **`### One panel, one page`** (starts at line 446), immediately before the `## A second way into the panel (Phase C1.5)` heading at line 714:

```markdown
#### What the related lane asks about

The lane sends `itemId` whenever the panel's header names an item — `resolved`,
or the candidate the user picked on an `ambiguous` page — read from the same
header state the panel renders, so the lane cannot describe a different item than
the header above it. The gateway then queries on that item's own title and drops
it from its own results.

Two rules are deliberately independent. **Precedence for the query text** is
`selection` → `itemId` → `title`, so *What's related to this?* keeps working on a
resolved page. **Self-exclusion** is keyed on the id being *present*, not on it
having won — otherwise selecting a phrase on a pull request would return that
pull request as its own top hit.

`title` is sent even alongside `itemId`: a gateway predating the `itemId` query
ignores the id and falls back to the title, and dropping it would leave that
gateway with an empty query, which it answers with zero hits. `canonicalUrl` is
the one field withheld once an id exists — the gateway uses it to exclude the
whole *host*, which on a working surface throws away exactly the items worth
showing.
```

- [ ] **Step 4: Add the manual check**

In `docs/development.md`, append to the manual-verification checklist:

```markdown
- **Related lane (richer rows).** On a resolved GitHub pull request, open the
  panel: Related must show items *from github.com* (the host filter is what used
  to hide them), each with a kind chip and an "Updated …" line, grouped under a
  service heading with a count. Check the preview line is prose from the item,
  not its title repeated. Then select a phrase and run *What's related to this?* —
  the results must change, and the PR you are on must not appear among them.
  Finally, note whether the groups are mostly one row each: if they are, the
  headings are noise and grouping should be dropped from the lane (see the spec's
  "Not in this slice").
```

- [ ] **Step 5: Run every gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all green. `check-build` must be run after `build`, not before.

- [ ] **Step 6: Commit and push**

```bash
git add CHANGELOG.md ROADMAP.md docs/
git commit -m "docs: record the related lane's two defects and its new query rule

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/richer-related-lane
```

- [ ] **Step 7: Open the client PR**

```bash
gh pr create --title "feat(panel): related that knows what it is related to (4.1)" --body "$(cat <<'EOF'
Implements roadmap **4.1**, and corrects two defects the brief did not know were
there.

**The snippet was the title, again.** `snippet()`'s second argument is an FTS5
column index; V48 re-pointed `item_fts` to `(title, body)`, so index `0` returned
the title the panel was already printing directly above it.

**The lane excluded its own best results.** The gateway drops every hit sharing
the host of the `canonicalUrl` sent — on a GitHub pull request, every other
github.com item. Now the client sends the resolved item's id instead, and the
item excludes itself precisely.

**Rows say what they are.** A kind chip, an "Updated …" line, and per-service
grouping with counts. All of it degrades to the previous row shape against a
gateway without the new fields — `title` is still sent beside `itemId` so an
older gateway answers rather than going blank.

`open-in-Nimbus` is dropped from 4.1 with the reason recorded: no such primitive
exists upstream.

Gateway half: nimbus-agent/Nimbus `dev/asaf/related-item-and-fields`.
Design: `docs/superpowers/specs/2026-08-16-richer-related-lane-design.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage.** Decision 1 → Task 1 (both halves: column index and the `NULL` coalesce). Decision 2 → Task 3 (title-not-body, precedence, exclusion independence, unknown-id fallthrough) and Task 8 (client sends the id). Decision 3 → Task 2 (projection, naming, ms). Decision 4 → Task 8 (`canonicalUrl` withheld; no gateway change, as specified). Decision 5 → Task 5 (optional fields, both wire shapes) and Task 8 (`title` always sent). Decision 6 → Task 6 (grouping order, humaniser) and Task 7 (render). "Not in this slice" → Task 9 records the grouping review checkpoint in `development.md`. The drive-by comment fix → Task 4.

**Type consistency.** `parseRelatedHit` is defined in Task 5 and used in Task 5 only. `groupHits` / `humaniseType` / `RelatedGroup` are defined in Task 6 and consumed in Task 7. `renderHits` gains its third parameter in Task 7 and every caller is updated in Task 8. `buildRelatedQuery` exists in **both** repos with different signatures — gateway `(input, lookupItem)` in Task 3, client `(ctx, limit)` in Task 8; they are unrelated functions in unrelated packages and neither task touches the other's.

**Known judgement call.** Task 7 removes the per-row service badge, which the spec implies (the group heading names the service) but does not state outright. It is called out in the commit message and is reversible in one block if review disagrees.
