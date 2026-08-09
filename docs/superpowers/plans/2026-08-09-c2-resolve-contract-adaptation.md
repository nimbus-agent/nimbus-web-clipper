# C2 — Resolve Contract Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the guessed `POST /v1/clips/resolve` client with the merged upstream contract `GET /v1/items/resolve?url=`, so the panel lights up correctly — including insufficient-scope guidance, the `ambiguous` chooser, and honest freshness/match-confidence.

**Architecture:** The wire shape is owned upstream and read from merged source, not inferred. It enters the extension at exactly one place — a parser in `gateway-client.ts` that turns `unknown` into a client-domain `ResolveOutcome` (camelCase, `modifiedAt`). Everything downstream — `handlers.ts`, the message guards, `panel-view.ts` — speaks the domain type only. The panel header gains three new arms (`needs-scope`, `ambiguous`, `chosen`) and never renders a claim stronger than the evidence supports.

**Tech Stack:** TypeScript (strict, no `any`), Vitest (node env; jsdom via docblock for DOM tests), esbuild, Biome, bun.

## Global Constraints

Copied from `CLAUDE.md`; every task's requirements implicitly include these.

- TypeScript **strict**; **no `any`** — cross-boundary data is `unknown`, narrowed by a guard.
- **No `console.*` in `src/`.** Tests and `scripts/` may log.
- **Never log the bearer token or the pairing code.**
- **Loopback only** — no network destination beyond `127.0.0.1` / `localhost`. `optional_host_permissions` is PAGE access and a separate axis; it never widens the network destination.
- **Every gateway-provided string renders via `textContent`**, never `innerHTML`.
- Green bar is: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`.
- `CHANGELOG.md` entry under `## [Unreleased]` for anything user-visible.

**Green bar timing — read before reviewing any single task.** Changing
`ResolvedItem` has a blast radius that cannot be closed in one commit:
`messages.ts`, `gateway-client.ts`, `handlers.ts` and the panel all consume it.
Tasks 2-5 therefore commit with `bun run typecheck` RED by design, and each of
those tasks states the expected failure explicitly. **Task 8 restores the green
bar, and Task 9 runs all five checks.**

This is a deliberate sequencing choice, not an oversight, and it is safe here
because this repo squash-merges (every PR is one commit on `main` — see #35,
#36, #37), so no red commit ever lands. The alternative — one giant commit
spanning types, client, guards, recogniser and panel — would be unreviewable.

The unit test suite stays GREEN throughout; only `tsc` is red, and only in the
files a later task rewrites. A task that leaves a test failing, or leaves
`tsc` red in a file outside the stated set, is a genuine defect.

**The actual red set after Task 2, measured (not predicted):**

```
scripts/screenshots/gateway-fixtures.ts   -> fixed by Task 9
test/unit/handlers.test.ts                -> fixed by Task 4
test/unit/mock-gateway.test.ts            -> fixed by Task 9
test/unit/panel-view.test.ts              -> fixed by Task 7
```

### A hazard this uncovered — read before Task 4

Task 2 predicted `messages.ts`, `gateway-client.ts` and `panel-view.ts` would go
red. **They did not, and the reason matters.**

`isResolvedItem` in `src/shared/messages.ts` is a user-defined type predicate
(`v is ResolvedItem`). **TypeScript never checks a predicate's body against the type
it claims.** So after Task 2 the guard still requires `canonicalUrl` and still never
checks `modifiedAt`, while asserting the value is a `ResolvedItem` — it is now a
guard that lies, and `tsc` is structurally incapable of noticing. The consumers
(`gateway-client.ts`, `panel-view.ts`) only ever reach `ResolvedItem` *through* that
guard, so they inherit the lie and compile clean.

Consequences, both load-bearing:

1. **A green `tsc` is NOT evidence that the guards in `messages.ts` are correct.**
   The guards are the only thing between `unknown` wire data and the domain types.
   Their correctness is established by the tests in Task 4 and nowhere else.
2. Had Task 4 not rewritten `isResolvedItem`, this would have shipped as a silent
   runtime hole: an object with no `modifiedAt` accepted as a `ResolvedItem`, then
   `formatAge(undefined, now)` producing `NaN` and the header rendering
   "NaN days ago". Task 4's guard rewrite is what closes it — treat that task's
   tests as the safety net, not the compiler.

The same reasoning applies to every `is*` predicate in `messages.ts`. When a task
changes a domain type, the matching guard body must be changed in the same plan, and
only a test can prove it was.

## Gateway version prerequisite — read before manual verification

The contract below is merged upstream, and **as of 2026-08-09 it is also installed**.

History, kept because it explains why this section exists: the machine was on
**v1.24.0**, which predates the resolve route. It was upgraded to **v1.26.0** during
this work — the winget manifest was stale (stuck at 1.19.1), so the same
`nimbus-headless-windows-x64.msi` artifact was installed directly from the v1.26.0
release after verifying its SHA256 against the release's `SHA256SUMS` (and
independently against the GitHub API's asset digest). The detached GPG signature was
**not** verified — `gpg` is not installed on this machine.

Verified present in the installed `nimbus-gateway.exe` by string search, rather than
inferred from the version number: `/v1/items/resolve`, `/v1/items/fetch`,
`/v1/agents/runs`, `resolve_disabled`, `insufficient_scope`, `unresolvable_url`.
`nimbus clip --help` on v1.26.0 still reports `nimbus clip scopes <label> --set <a,b>`
and `Scopes: clip, briefs, agents, resolve, fetch`.

Which release each dependency first appears in (`git tag --contains <adding commit>`):

| Dependency | Adding commit | First release | Present in installed v1.24.0 |
| --- | --- | --- | --- |
| Token scopes, incl. `resolve`/`fetch` in `API_SCOPES` | `826b76a1` (#1062) | v1.23.0 | **yes** |
| `nimbus clip scopes <label> --set` | `826b76a1` (#1062) | v1.23.0 | **yes** |
| Agents over HTTP (`POST /v1/agents/{agent}`) | `4b4bedb4` (#1063) | v1.23.0 | **yes** |
| `GET /v1/items/resolve` | `0a32751f` (#1070) | **v1.25.0** | **no** |
| `POST /v1/items/fetch` | `369f9af1` (#1072) | **v1.25.0** | **no** |

**Consequence for this plan.** Every task here is unit-tested and needs no running
gateway, so none of this blocks implementation. End-to-end manual verification is now
possible: the gateway must be **started** (nothing was listening on loopback when this
was written), and the paired browser must be granted the scope:

```
nimbus clip scopes <label> --set clip,briefs,resolve
```

`nimbus clip status` lists the labels and their current scopes.

**Expected on a browser paired before the upgrade:** its token carries only
`LEGACY_SCOPES` (`clip,briefs`), so resolve returns 403 and the panel shows the
`needs-scope` state built in Task 7 — naming the command above. That is the correct
behaviour and the single most valuable thing to verify by hand, because it is the
state every pre-existing pairing hits first.

## The contract, verified against merged upstream source

Read from `C:/gitrep/Nimbus` at `b8ded950` (main). **Not** from the design doc, and not from this repo's ROADMAP.

Source files:
- `packages/gateway/src/index/resolve-by-url.ts` — the response union and the match ladder
- `packages/gateway/src/ipc/http-server.ts:592-630` — the route handler (`handleItemsResolve`)
- `packages/gateway/src/ipc/http-route-auth.ts` — scope table + `insufficientScopeBody`
- `packages/gateway/src/clips/api-scopes.ts` — `API_SCOPES`, `LEGACY_SCOPES`

```
GET /v1/items/resolve?url=<raw url>
Authorization: Bearer <token>          // requires the `resolve` scope
```

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{found:true, item:{id,service,type,title,url,modified_at}, matchKind}` | resolved |
| 200 | `{found:false, reason:"not_indexed"\|"unresolvable_url", service, fetchable}` | miss |
| 200 | `{found:false, reason:"ambiguous", service, fetchable, candidates[], truncated}` | ambiguous |
| 400 | `{error:"missing_url"}` | client bug — empty/absent `url` |
| 401 | `{error:"unauthorized"}` | token unknown |
| 403 | `{error:"insufficient_scope", required, granted[]}` | **the state every existing pairing hits** |
| 404 | `{error:"resolve_disabled"}` | clips seam not mounted on this gateway |

**Five facts the brief did not have, all verified in source. They change the design:**

1. **`matchKind` has THREE values**, not two: `"exact" | "query_stripped" | "path_trimmed"` (`resolve-by-url.ts:11`). The middle rung exists because rung 2 of the ladder strips all query params.

2. **`truncated: true` ⇒ `candidates` is EMPTY, not sliced** (`resolve-by-url.ts:78-90`, comment: *"Over the cap the list is EMPTY, not sliced: a truncated choice menu implies the right answer is among those shown when it may not be."*). So "respect the ≤5 cap" does **not** mean render 5 of N — it means render *no* chooser and say why. A chooser built on a sliced list would be the exact dishonesty upstream refused.

3. **Scopes are named by the OWNER at pairing-window open, never requested by the client** (`pairing-window.ts:40-48`: *"It is recorded HERE, at the moment the OWNER … could name its own scopes would simply grant itself the set"*). The extension cannot ask for `resolve`. **And upstream shipped a command that re-grants scopes on an existing device without re-pairing.** So the guidance is **not** "re-pair" as the brief assumed — that would send users through an unnecessary unpair/pair cycle. It is:

   ```
   nimbus clip scopes <label> --set clip,briefs,resolve
   ```

   **This exact string is verified against the installed binary** (`nimbus clip --help`, v1.24.0) and against `packages/cli/src/commands/clip.ts:12` at main — `git diff v1.24.0 HEAD -- packages/cli/src/commands/clip.ts` is empty, so the syntax is stable across every version a user might have.

   Do **not** derive this string from `clip.test.ts`. That file asserts the *IPC* call's params (`{label, scopes}`), which are not the CLI's flags; reading argv syntax off it yields `--label/--scopes`, a command that does not parse. The usage string in `CLIP_USAGE` is the source of truth.

4. **`canonicalizeUrl` is case-preserving on the path** (`packages/gateway/src/util/url-canonical.ts`) — it strips only the fragment, `utm_*`/click-ids, and a non-root trailing slash. This is why change #5 ("send the address-bar URL") **cannot be applied literally**: today's recogniser uppercases Jira issue keys (`recognise.ts:130-133`, *"Jira treats issue keys as upper-case; normalising here means one issue has exactly one resolveUrl"*). Sending a raw lowercase `/browse/abc-1` would miss rungs 1 and 2 on case, then rung 3 would trim to `/browse` — a regression against today's behaviour. Identity-preserving normalisation stays client-side; *canonicalisation* moves to the gateway. Task 5 draws that line precisely.

5. **`not_indexed` always carries `service: null`** (`resolve-by-url.ts:169`); only the `ambiguous` arm carries a real service string. So the header must not promise a service name on a miss.

## File Structure

**Modified:**
- `src/shared/gateway.ts` — collapse `CLIP_PATHS` + `PROPOSED_PATHS` into one `GATEWAY_PATHS`; resolve is contracted now, so the proposed/locked split has lost its reason to exist.
- `src/shared/types.ts` — `ResolveMatchKind`, `ResolveCandidate`, `ResolvedItem` (+`modifiedAt`), `ResolveOutcome`, `ResolveError` (+`insufficient_scope`).
- `src/shared/messages.ts` — guards over the *domain* types for the SW→panel boundary.
- `src/shared/recognise.ts` — `resolveUrl` keeps identity normalisation, stops canonicalising.
- `src/background/gateway-client.ts` — `getJson` helper; `resolveItem()` replaces `postResolve()`; the wire→domain parser lives here and nowhere else.
- `src/background/handlers.ts` — `handleResolve` carries the outcome through.
- `src/panel/panel-view.ts` — new header arms + candidate chooser.
- `src/panel/panel-in-page.ts` — `headerFrom` maps outcome→header; chooser wiring.
- `scripts/screenshots/mock-gateway.ts`, `scripts/screenshots/gateway-fixtures.ts` — GET + new shape.
- `CHANGELOG.md`, `docs/architecture.md`, `ROADMAP.md`.

**Created:**
- `src/shared/freshness.ts` — pure `formatAge(modifiedAtMs, nowMs)`. Injected clock; no `Date.now()` inside.
- `test/unit/freshness.test.ts`

---

### Task 1: One contracted path map

**Files:**
- Modify: `src/shared/gateway.ts:6-35`
- Modify: `test/unit/gateway.test.ts:1-30`
- Modify: `scripts/screenshots/mock-gateway.ts:6,45-60`

**Interfaces:**
- Produces: `GATEWAY_PATHS` (`{ingest, pairConfirm, related, resolve}`), `type GatewayEndpoint = keyof typeof GATEWAY_PATHS`, `endpointUrl(origin, endpoint)` unchanged in signature.

- [ ] **Step 1: Write the failing test**

Replace the `CLIP_PATHS`/`PROPOSED_PATHS` cases in `test/unit/gateway.test.ts`:

```ts
import { endpointUrl, GATEWAY_PATHS, isLoopbackOrigin } from "../../src/shared/gateway.ts";

describe("GATEWAY_PATHS", () => {
  it("is the four contracted gateway paths", () => {
    expect(GATEWAY_PATHS).toEqual({
      ingest: "/v1/clips",
      pairConfirm: "/v1/clips/pair/confirm",
      related: "/v1/clips/related",
      resolve: "/v1/items/resolve",
    });
  });

  it("builds a resolve URL under a trailing-slash origin", () => {
    expect(endpointUrl("http://127.0.0.1:8765/", "resolve")).toBe(
      "http://127.0.0.1:8765/v1/items/resolve",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/gateway.test.ts`
Expected: FAIL — `GATEWAY_PATHS` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/shared/gateway.ts`, replace lines 6-29 with:

```ts
/**
 * Every path this extension calls, all of them contracted and shipped upstream.
 *
 * `ingest` / `pairConfirm` / `related` shipped in the Nimbus monorepo PR #718.
 * `resolve` shipped later, under its own `resolve` token scope — see
 * packages/gateway/src/ipc/http-server.ts#handleItemsResolve. It was briefly
 * modelled here as PROPOSED while this client was built against a guessed shape;
 * that split is gone because the guess is gone.
 */
export const GATEWAY_PATHS = {
  ingest: "/v1/clips",
  pairConfirm: "/v1/clips/pair/confirm",
  related: "/v1/clips/related",
  resolve: "/v1/items/resolve",
} as const;

export type GatewayEndpoint = keyof typeof GATEWAY_PATHS;
```

Then change line 29's `ALL_PATHS` usage — `endpointUrl` now indexes `GATEWAY_PATHS` directly:

```ts
export function endpointUrl(origin: string, endpoint: GatewayEndpoint): string {
  const trimmed = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return `${trimmed}${GATEWAY_PATHS[endpoint]}`;
}
```

In `scripts/screenshots/mock-gateway.ts` change the import to `GATEWAY_PATHS` and the two case labels to `GATEWAY_PATHS.pairConfirm` / `.ingest` / `.related` / `.resolve`. (The GET/method change for resolve lands in Task 6 — here, only the identifier renames.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bunx vitest run test/unit/gateway.test.ts`
Expected: typecheck clean, tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/gateway.ts test/unit/gateway.test.ts scripts/screenshots/mock-gateway.ts
git commit -m "refactor(gateway): fold the resolve path into one contracted path map"
```

---

### Task 2: The domain types

**Files:**
- Modify: `src/shared/types.ts:88-105`
- Test: exercised via Tasks 3-4 (types alone carry no runtime behaviour; a test asserting a type compiles is noise).

**Interfaces:**
- Produces:

```ts
export type ResolveMatchKind = "exact" | "query_stripped" | "path_trimmed";
export interface ResolveCandidate { id; service; type; title; url: string | null }
export interface ResolvedItem extends ResolveCandidate { modifiedAt: number }
export type ResolveOutcome =
  | { kind: "found"; item: ResolvedItem; matchKind: ResolveMatchKind }
  | { kind: "not-indexed"; fetchable: boolean }
  | { kind: "unresolvable"; fetchable: boolean }
  | { kind: "ambiguous"; service: string | null; fetchable: boolean;
      candidates: readonly ResolveCandidate[]; truncated: boolean };
export type ResolveError =
  | "not_paired" | "unauthorized" | "insufficient_scope"
  | "unsupported" | "unreachable" | "server_error";
```

- [ ] **Step 1: Write the implementation** (no test cycle — pure type declarations)

Replace `src/shared/types.ts:88-105` with:

```ts
/**
 * How confidently the gateway matched our URL — its match ladder, in order:
 * exact key, then the key with all query params dropped, then up to three
 * trimmed trailing path segments (packages/gateway/src/index/resolve-by-url.ts).
 *
 * `path_trimmed` is a WEAKER claim than the other two and must never be rendered
 * with equal confidence: the ladder reached it by discarding part of the URL.
 */
export type ResolveMatchKind = "exact" | "query_stripped" | "path_trimmed";

/** One indexed item, metadata only. Resolve is a resolver — reading is a separate route. */
export interface ResolveCandidate {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
}

/**
 * A resolved item. `modifiedAt` is epoch ms, renamed from the wire's `modified_at`
 * at the HTTP boundary (gateway-client.ts) so the wire shape stops at the parser.
 *
 * A CANDIDATE has no `modifiedAt` — the gateway does not send one for candidates.
 * That asymmetry is deliberate and load-bearing: it is why choosing a candidate
 * cannot render as `resolved` (see HeaderState's `chosen` arm).
 */
export interface ResolvedItem extends ResolveCandidate {
  readonly modifiedAt: number;
}

/**
 * A successful call to the resolve route. All four arms are HTTP 200 — a miss is
 * an answer, not a failure.
 *
 * `not-indexed` carries no service: upstream always sends `service: null` on that
 * arm (resolve-by-url.ts:169), so modelling one would invite the header to promise
 * a name we do not have.
 */
export type ResolveOutcome =
  | { readonly kind: "found"; readonly item: ResolvedItem; readonly matchKind: ResolveMatchKind }
  | { readonly kind: "not-indexed"; readonly fetchable: boolean }
  | { readonly kind: "unresolvable"; readonly fetchable: boolean }
  | {
      readonly kind: "ambiguous";
      readonly service: string | null;
      readonly fetchable: boolean;
      /** EMPTY whenever `truncated` — upstream sends no list rather than a sliced one. */
      readonly candidates: readonly ResolveCandidate[];
      readonly truncated: boolean;
    };

/**
 * `unsupported` is a 404 — this gateway has no resolve route (or the clips seam
 * is off). `insufficient_scope` is a 403 and is the state EVERY browser paired
 * before token scopes hits first: LEGACY_SCOPES is ["clip","briefs"], so an
 * existing token carries no `resolve`. It is separate from `unauthorized`
 * because the fix is different — the owner re-grants the scope, the user does
 * not re-authenticate.
 */
export type ResolveError =
  | "not_paired"
  | "unauthorized"
  | "insufficient_scope"
  | "unsupported"
  | "unreachable"
  | "server_error";
```

- [ ] **Step 2: Run typecheck to see the expected breakage**

Run: `bun run typecheck`
Expected: FAIL — `canonicalUrl` no longer exists on `ResolvedItem`; `messages.ts`, `gateway-client.ts`, `panel-view.ts` all error. This is the intended blast radius; Tasks 3-5 close it. Do not "fix" it here.

- [ ] **Step 3: Commit** (a red typecheck is acceptable *only* on this types-only commit; the next task restores green)

```bash
git add src/shared/types.ts
git commit -m "types: model the merged resolve contract's four outcomes"
```

---

### Task 3: Parse the wire shape at the HTTP boundary

**Files:**
- Modify: `src/background/gateway-client.ts:1-19` (imports/timeouts), `:40-60` (add `getJson`), `:176-222` (replace `postResolve`)
- Test: `test/unit/gateway-client.test.ts`

**Interfaces:**
- Consumes: `GATEWAY_PATHS`/`GatewayEndpoint` (Task 1), `ResolveOutcome`/`ResolveError`/`ResolveMatchKind`/`ResolveCandidate`/`ResolvedItem` (Task 2).
- Produces:
  ```ts
  export async function resolveItem(
    origin: string, token: string, pageUrl: string, doFetch?: FetchLike,
  ): Promise<{ ok: true; outcome: ResolveOutcome } | { ok: false; reason: ResolveError }>
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/gateway-client.test.ts`. `fetchStub` should follow the file's existing helper style — if the file already has one, reuse it rather than adding a second.

```ts
describe("resolveItem", () => {
  function jsonRes(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("GETs /v1/items/resolve with the url as a query param and a bearer header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const doFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonRes({ found: false, reason: "not_indexed", service: null, fetchable: false });
    };
    await resolveItem("http://127.0.0.1:8765", "tok", "https://github.com/a/b/pull/1?w=1", doFetch);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.init?.method).toBe("GET");
    // The URL is a query PARAM, so it must be percent-encoded, not concatenated raw.
    expect(call?.url).toBe(
      "http://127.0.0.1:8765/v1/items/resolve?url=" +
        encodeURIComponent("https://github.com/a/b/pull/1?w=1"),
    );
    expect((call?.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
    // A GET carries no body and must not advertise one.
    expect(call?.init?.body).toBeUndefined();
  });

  it("maps a hit, renaming modified_at to modifiedAt", async () => {
    const doFetch = async () =>
      jsonRes({
        found: true,
        matchKind: "exact",
        item: {
          id: "i1", service: "github", type: "pr", title: "Fix it",
          url: "https://github.com/a/b/pull/1", modified_at: 1_700_000_000_000,
        },
      });
    const r = await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch);

    expect(r).toEqual({
      ok: true,
      outcome: {
        kind: "found",
        matchKind: "exact",
        item: {
          id: "i1", service: "github", type: "pr", title: "Fix it",
          url: "https://github.com/a/b/pull/1", modifiedAt: 1_700_000_000_000,
        },
      },
    });
  });

  it("accepts every matchKind the ladder can return", async () => {
    for (const kind of ["exact", "query_stripped", "path_trimmed"] as const) {
      const doFetch = async () =>
        jsonRes({
          found: true, matchKind: kind,
          item: { id: "i", service: "s", type: "t", title: "T", url: null, modified_at: 1 },
        });
      const r = await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch);
      expect(r.ok && r.outcome.kind === "found" && r.outcome.matchKind).toBe(kind);
    }
  });

  it("rejects an unknown matchKind rather than widening the union", async () => {
    const doFetch = async () =>
      jsonRes({
        found: true, matchKind: "vibes",
        item: { id: "i", service: "s", type: "t", title: "T", url: null, modified_at: 1 },
      });
    expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: false, reason: "server_error",
    });
  });

  it("maps not_indexed and carries fetchable through for C3.1", async () => {
    const doFetch = async () =>
      jsonRes({ found: false, reason: "not_indexed", service: null, fetchable: true });
    expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: true, outcome: { kind: "not-indexed", fetchable: true },
    });
  });

  it("maps unresolvable_url", async () => {
    const doFetch = async () =>
      jsonRes({ found: false, reason: "unresolvable_url", service: null, fetchable: false });
    expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: true, outcome: { kind: "unresolvable", fetchable: false },
    });
  });

  it("maps ambiguous with its candidates", async () => {
    const doFetch = async () =>
      jsonRes({
        found: false, reason: "ambiguous", service: "jira", fetchable: false, truncated: false,
        candidates: [
          { id: "a", service: "jira", type: "issue", title: "One", url: "https://j.test/a" },
          { id: "b", service: "jira", type: "issue", title: "Two", url: null },
        ],
      });
    const r = await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch);
    expect(r).toEqual({
      ok: true,
      outcome: {
        kind: "ambiguous", service: "jira", fetchable: false, truncated: false,
        candidates: [
          { id: "a", service: "jira", type: "issue", title: "One", url: "https://j.test/a" },
          { id: "b", service: "jira", type: "issue", title: "Two", url: null },
        ],
      },
    });
  });

  it("keeps a truncated ambiguous list EMPTY — upstream sends no list, and a sliced one would lie", async () => {
    const doFetch = async () =>
      jsonRes({
        found: false, reason: "ambiguous", service: "jira",
        fetchable: false, truncated: true, candidates: [],
      });
    const r = await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch);
    expect(r.ok && r.outcome.kind === "ambiguous" && r.outcome.truncated).toBe(true);
    expect(r.ok && r.outcome.kind === "ambiguous" && r.outcome.candidates).toEqual([]);
  });

  it("maps 403 to insufficient_scope, NOT server_error — it is the every-existing-pairing case", async () => {
    const doFetch = async () =>
      jsonRes({ error: "insufficient_scope", required: "resolve", granted: ["clip", "briefs"] }, 403);
    expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: false, reason: "insufficient_scope",
    });
  });

  it("maps 401 / 404 / 500 / transport failure", async () => {
    const cases: Array<[() => Promise<Response>, string]> = [
      [async () => jsonRes({ error: "unauthorized" }, 401), "unauthorized"],
      [async () => jsonRes({ error: "resolve_disabled" }, 404), "unsupported"],
      [async () => jsonRes({ error: "missing_url" }, 400), "server_error"],
      [async () => jsonRes({}, 500), "server_error"],
    ];
    for (const [doFetch, reason] of cases) {
      expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
        ok: false, reason,
      });
    }
    const boom = async () => { throw new Error("offline"); };
    expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", boom)).toEqual({
      ok: false, reason: "unreachable",
    });
  });

  it("treats a malformed 200 as a server error rather than a silent miss", async () => {
    for (const body of [null, {}, { found: true }, { found: false, reason: "nope" }]) {
      const doFetch = async () => jsonRes(body);
      expect(await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
        ok: false, reason: "server_error",
      });
    }
  });
});
```

Add `resolveItem` to the file's import from `../../src/background/gateway-client.ts` and delete any existing `postResolve` describe block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/gateway-client.test.ts`
Expected: FAIL — `resolveItem` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/background/gateway-client.ts`: update the type import to pull `ResolveCandidate`, `ResolveMatchKind`, `ResolveOutcome`, `ResolvedItem`, `ResolveError` from `../shared/types.ts`, and **drop the `isResolvedItem` import from `../shared/messages.ts`** (the HTTP boundary parses the wire shape itself; `messages.ts` now guards the domain shape only).

Add a GET helper next to `postJson`:

```ts
async function getJson(
  doFetch: FetchLike,
  origin: string,
  endpoint: GatewayEndpoint,
  query: Record<string, string>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const qs = new URLSearchParams(query).toString();
  try {
    return await doFetch(`${endpointUrl(origin, endpoint)}?${qs}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
```

Replace `postResolve` (lines ~176-222) with the parser + call:

```ts
const MATCH_KINDS: readonly ResolveMatchKind[] = ["exact", "query_stripped", "path_trimmed"];

function isMatchKind(v: unknown): v is ResolveMatchKind {
  return typeof v === "string" && (MATCH_KINDS as readonly string[]).includes(v);
}

/** The wire's candidate shape. Metadata only — resolve never returns a body. */
function parseCandidate(v: unknown): ResolveCandidate | null {
  if (
    !isObject(v) ||
    typeof v["id"] !== "string" ||
    typeof v["service"] !== "string" ||
    typeof v["type"] !== "string" ||
    typeof v["title"] !== "string" ||
    !(v["url"] === null || typeof v["url"] === "string")
  ) {
    return null;
  }
  return {
    id: v["id"],
    service: v["service"],
    type: v["type"],
    title: v["title"],
    url: v["url"],
  };
}

/** A candidate plus freshness. `modified_at` is the ONLY snake_case field on the
 *  wire, and this is the only place it is spelled that way. */
function parseItem(v: unknown): ResolvedItem | null {
  const base = parseCandidate(v);
  if (base === null || !isObject(v) || typeof v["modified_at"] !== "number") {
    return null;
  }
  return { ...base, modifiedAt: v["modified_at"] };
}

/**
 * Narrows a 200 body into one of the four outcomes, or null when the gateway sent
 * something this client does not model.
 *
 * Returning null (=> server_error) rather than a "miss" is deliberate: an
 * unrecognised body must never render as a confident "not indexed".
 */
function parseResolveBody(data: unknown): ResolveOutcome | null {
  if (!isObject(data)) {
    return null;
  }
  if (data["found"] === true) {
    const item = parseItem(data["item"]);
    return item !== null && isMatchKind(data["matchKind"])
      ? { kind: "found", item, matchKind: data["matchKind"] }
      : null;
  }
  if (data["found"] !== false || typeof data["fetchable"] !== "boolean") {
    return null;
  }
  const fetchable = data["fetchable"];
  const reason = data["reason"];
  if (reason === "not_indexed") {
    return { kind: "not-indexed", fetchable };
  }
  if (reason === "unresolvable_url") {
    return { kind: "unresolvable", fetchable };
  }
  if (reason !== "ambiguous" || typeof data["truncated"] !== "boolean") {
    return null;
  }
  const raw = data["candidates"];
  if (!Array.isArray(raw)) {
    return null;
  }
  const candidates: ResolveCandidate[] = [];
  for (const c of raw) {
    const parsed = parseCandidate(c);
    if (parsed === null) {
      return null;
    }
    candidates.push(parsed);
  }
  const service = data["service"];
  return {
    kind: "ambiguous",
    service: typeof service === "string" ? service : null,
    fetchable,
    candidates,
    truncated: data["truncated"],
  };
}

/**
 * `GET /v1/items/resolve?url=` — a bearer read under the `resolve` scope.
 *
 * Sends the page URL as the recogniser normalised it and lets the gateway's
 * canonicalizeUrl + match ladder do the rest; this client does no canonicalisation
 * of its own (see shared/recognise.ts).
 *
 * The 403 mapping is the load-bearing one: LEGACY_SCOPES is ["clip","briefs"], so
 * every browser paired before scopes lacks `resolve` and lands here first. Folding
 * it into server_error would blame the gateway for a grant the owner simply has
 * not made yet.
 */
export async function resolveItem(
  origin: string,
  token: string,
  pageUrl: string,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true; outcome: ResolveOutcome } | { ok: false; reason: ResolveError }> {
  let res: Response;
  try {
    res = await getJson(
      doFetch,
      origin,
      "resolve",
      { url: pageUrl },
      { authorization: `Bearer ${token}` },
      RESOLVE_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const outcome = parseResolveBody(await readJson(res));
    return outcome === null ? { ok: false, reason: "server_error" } : { ok: true, outcome };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 403) {
    return { ok: false, reason: "insufficient_scope" };
  }
  if (res.status === 404) {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: false, reason: "server_error" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/gateway-client.test.ts`
Expected: PASS. (`bun run typecheck` still fails in `messages.ts`/panel — Task 4 and 5 close it.)

- [ ] **Step 5: Commit**

```bash
git add src/background/gateway-client.ts test/unit/gateway-client.test.ts
git commit -m "feat(gateway): call GET /v1/items/resolve and parse its four outcomes"
```

---

### Task 4: Carry the outcome across the message boundary

**Files:**
- Modify: `src/shared/messages.ts:216-254`
- Modify: `src/background/handlers.ts:129-147`
- Test: `test/unit/messages.test.ts`, `test/unit/handlers.test.ts`

**Interfaces:**
- Consumes: `ResolveOutcome`, `ResolveCandidate`, `ResolvedItem` (Task 2); `resolveItem` (Task 3).
- Produces: `ResolveResponse` whose ok arm is `{ kind:"resolve"; ok:true; recognition; outcome: ResolveOutcome }`; guard `isResolveResponse`; `ResolveDeps.resolveItem`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/messages.test.ts`, replace the resolve-guard cases:

```ts
describe("isResolveResponse", () => {
  const recognition = {
    ok: true, product: "github", kind: "pr",
    label: "GitHub PR", ref: "a/b #1", resolveUrl: "https://github.com/a/b/pull/1",
  };

  it("accepts a found outcome", () => {
    expect(
      isResolveResponse({
        kind: "resolve", ok: true, recognition,
        outcome: {
          kind: "found", matchKind: "path_trimmed",
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
        kind: "ambiguous", service: "jira", fetchable: false, truncated: false,
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
        kind: "resolve", ok: false, recognition, reason: "insufficient_scope",
      }),
    ).toBe(true);
  });

  it("rejects an item missing modifiedAt, an unknown outcome kind, and a bad candidate", () => {
    for (const outcome of [
      { kind: "found", matchKind: "exact",
        item: { id: "i", service: "s", type: "t", title: "T", url: null } },
      { kind: "found", matchKind: "guessed",
        item: { id: "i", service: "s", type: "t", title: "T", url: null, modifiedAt: 5 } },
      { kind: "elsewhere", fetchable: true },
      { kind: "ambiguous", service: null, fetchable: false, truncated: false,
        candidates: [{ id: "a" }] },
    ]) {
      expect(isResolveResponse({ kind: "resolve", ok: true, recognition, outcome })).toBe(false);
    }
  });
});
```

In `test/unit/handlers.test.ts`, replace the `postResolve` cases (keep the existing "unrecognised page makes no gateway call" and "not paired" cases, updating them to the new dep name and response shape):

```ts
it("passes the recogniser's resolveUrl to the gateway and returns the outcome", async () => {
  const seen: string[] = [];
  const res = await handleResolve(
    {
      getOrigins: async () => [],
      getConnection: async () => ({ origin: "http://127.0.0.1:8765", token: "t" }),
      resolveItem: async (_o, _t, url) => {
        seen.push(url);
        return { ok: true, outcome: { kind: "not-indexed", fetchable: true } };
      },
    },
    { kind: "resolve", pageUrl: "https://github.com/a/b/pull/1?files=1" },
  );

  expect(seen).toEqual(["https://github.com/a/b/pull/1?files=1"]);
  expect(res).toEqual({
    kind: "resolve", ok: true,
    recognition: expect.objectContaining({ ok: true, label: "GitHub PR" }),
    outcome: { kind: "not-indexed", fetchable: true },
  });
});

it("keeps the recognition on an insufficient_scope failure", async () => {
  const res = await handleResolve(
    {
      getOrigins: async () => [],
      getConnection: async () => ({ origin: "http://127.0.0.1:8765", token: "t" }),
      resolveItem: async () => ({ ok: false, reason: "insufficient_scope" }),
    },
    { kind: "resolve", pageUrl: "https://github.com/a/b/pull/1" },
  );

  expect(res).toEqual({
    kind: "resolve", ok: false,
    recognition: expect.objectContaining({ ok: true, ref: "a/b #1" }),
    reason: "insufficient_scope",
  });
});

it("makes no gateway call for an unrecognised page", async () => {
  let called = false;
  const res = await handleResolve(
    {
      getOrigins: async () => [],
      getConnection: async () => ({ origin: "http://127.0.0.1:8765", token: "t" }),
      resolveItem: async () => { called = true; return { ok: false, reason: "server_error" }; },
    },
    { kind: "resolve", pageUrl: "https://example.com/whatever" },
  );

  expect(called).toBe(false);
  expect(res).toEqual({
    kind: "resolve", ok: true,
    recognition: { ok: false, reason: "unknown-host" },
    outcome: { kind: "not-indexed", fetchable: false },
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/messages.test.ts test/unit/handlers.test.ts`
Expected: FAIL — the guard still expects `item`, and `ResolveDeps` has no `resolveItem`.

- [ ] **Step 3: Write the implementation**

In `src/shared/messages.ts`, replace `isResolvedItem` and `isResolveResponse` (lines 216-254):

```ts
function isCandidate(v: unknown): v is ResolveCandidate {
  return (
    isObject(v) &&
    typeof v["id"] === "string" &&
    typeof v["service"] === "string" &&
    typeof v["type"] === "string" &&
    typeof v["title"] === "string" &&
    (v["url"] === null || typeof v["url"] === "string")
  );
}

export function isResolvedItem(v: unknown): v is ResolvedItem {
  return isCandidate(v) && typeof (v as Record<string, unknown>)["modifiedAt"] === "number";
}

const MATCH_KINDS = new Set(["exact", "query_stripped", "path_trimmed"]);

/**
 * Guards the DOMAIN outcome crossing the SW→panel boundary — not the wire shape.
 * The wire's `modified_at` is renamed in gateway-client.ts and never reaches here.
 */
function isResolveOutcome(v: unknown): v is ResolveOutcome {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "found") {
    return isResolvedItem(v["item"]) && MATCH_KINDS.has(v["matchKind"] as string);
  }
  if (v["kind"] === "not-indexed" || v["kind"] === "unresolvable") {
    return typeof v["fetchable"] === "boolean";
  }
  if (v["kind"] !== "ambiguous") {
    return false;
  }
  return (
    typeof v["fetchable"] === "boolean" &&
    typeof v["truncated"] === "boolean" &&
    (v["service"] === null || typeof v["service"] === "string") &&
    Array.isArray(v["candidates"]) &&
    v["candidates"].every(isCandidate)
  );
}

/** The recognition is required on BOTH arms: a gateway failure must not erase
 *  the fact that the client knows what page this is. */
export function isResolveResponse(v: unknown): v is ResolveResponse {
  if (!isObject(v) || v["kind"] !== "resolve" || !isRecognition(v["recognition"])) {
    return false;
  }
  if (v["ok"] === true) {
    return isResolveOutcome(v["outcome"]);
  }
  return v["ok"] === false && typeof v["reason"] === "string";
}
```

Update the `ResolveResponse` type wherever it is declared (it is in `messages.ts` alongside the other envelope types) so its ok arm is `readonly outcome: ResolveOutcome` in place of `readonly item: ResolvedItem | null`, and add `ResolveCandidate` / `ResolveOutcome` to the type imports from `./types.ts`.

In `src/background/handlers.ts`, rename the dep and thread the outcome:

```ts
export interface ResolveDeps {
  readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]>;
  readonly getConnection: () => Promise<{ origin: string; token: string } | null>;
  readonly resolveItem: (
    origin: string,
    token: string,
    pageUrl: string,
  ) => Promise<{ ok: true; outcome: ResolveOutcome } | { ok: false; reason: ResolveError }>;
}

export async function handleResolve(
  deps: ResolveDeps,
  req: ResolveRequest,
): Promise<ResolveResponse> {
  const recognition = recognise(req.pageUrl, await deps.getOrigins());
  if (!recognition.ok) {
    // Nothing to ask the gateway about — and no request is made. `fetchable:false`
    // because an unrecognised page is not a fetch candidate either.
    return {
      kind: "resolve",
      ok: true,
      recognition,
      outcome: { kind: "not-indexed", fetchable: false },
    };
  }
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "resolve", ok: false, recognition, reason: "not_paired" };
  }
  const r = await deps.resolveItem(conn.origin, conn.token, recognition.resolveUrl);
  if (!r.ok) {
    return { kind: "resolve", ok: false, recognition, reason: r.reason };
  }
  return { kind: "resolve", ok: true, recognition, outcome: r.outcome };
}
```

Update `src/background/service-worker.ts` where `handleResolve` is wired: the injected dep key becomes `resolveItem` and the imported function becomes `resolveItem`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/messages.test.ts test/unit/handlers.test.ts test/unit/service-worker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/messages.ts src/background/handlers.ts src/background/service-worker.ts test/unit/messages.test.ts test/unit/handlers.test.ts
git commit -m "feat(background): carry the resolve outcome across the message boundary"
```

---

### Task 5: Stop canonicalising client-side — keep only identity normalisation

**Files:**
- Modify: `src/shared/recognise.ts:180-193`
- Test: `test/unit/recognise.test.ts`

**Interfaces:**
- Produces: `Recognition.resolveUrl` = the address-bar URL with the matched path prefix replaced by the matcher's normalised form (preserving trailing sub-tab segments and the query string).

**Why not simply "send the address-bar URL":** `canonicalizeUrl` upstream is case-preserving on the path, and `matchJira` uppercases issue keys so one issue has one key. Sending a raw lowercase `/browse/abc-1` would miss ladder rungs 1 and 2 on case and trim to `/browse` on rung 3 — a regression. Identity normalisation stays here; canonicalisation (fragment, `utm_*`, trailing slash, query-stripping, path-trimming) moves entirely to the gateway.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/recognise.test.ts`:

```ts
describe("resolveUrl keeps identity, not canonicalisation", () => {
  const origins = [{ origin: "https://github.com", product: "github" as const }];

  it("preserves the query string — the gateway's ladder strips it, not us", () => {
    const r = recognise("https://github.com/a/b/pull/1?w=1&diff=split", origins);
    expect(r.ok && r.resolveUrl).toBe("https://github.com/a/b/pull/1?w=1&diff=split");
  });

  it("preserves a sub-tab path segment — rung 3 trims it upstream", () => {
    const r = recognise("https://github.com/a/b/pull/1/files", origins);
    expect(r.ok && r.resolveUrl).toBe("https://github.com/a/b/pull/1/files");
    // The header still reads off the matched ref, not the full path.
    expect(r.ok && r.ref).toBe("a/b #1");
  });

  it("still uppercases a Jira key — that is identity, not canonicalisation", () => {
    const jira = [{ origin: "https://acme.atlassian.net", product: "jira" as const }];
    const r = recognise("https://acme.atlassian.net/browse/abc-1?filter=42", jira);
    expect(r.ok && r.resolveUrl).toBe("https://acme.atlassian.net/browse/ABC-1?filter=42");
  });

  it("preserves a configured path prefix on a self-hosted instance", () => {
    const jenkins = [{ origin: "https://corp.example/jenkins", product: "jenkins" as const }];
    const r = recognise("https://corp.example/jenkins/job/build/42/console", jenkins);
    expect(r.ok && r.resolveUrl).toBe("https://corp.example/jenkins/job/build/42/console");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/recognise.test.ts`
Expected: FAIL — `resolveUrl` currently drops the query and the sub-tab segment.

- [ ] **Step 3: Write the implementation**

In `src/shared/recognise.ts`, replace the `resolveUrl` construction at the end of `recognise` (around lines 180-193):

```ts
  // The URL we hand the gateway. It is the ADDRESS-BAR URL with one narrow
  // change: the matched path prefix is swapped for the matcher's normalised form
  // (today only Jira does this, upper-casing the issue key). Everything else —
  // sub-tab segments, query string — is preserved deliberately.
  //
  // Canonicalisation is the GATEWAY's job: canonicalizeUrl drops the fragment,
  // utm_*/click-ids and a trailing slash, then the ladder tries the exact key, the
  // query-stripped key, and up to three trimmed path segments. Doing any of that
  // here would be work the gateway redoes under different rules — and its rules
  // are load-bearing, because externalIdFor hashes canonicalizeUrl's output.
  //
  // Identity normalisation is NOT canonicalisation and stays here: the ladder is
  // case-sensitive, so a lower-cased Jira key would miss rungs 1 and 2 and then
  // trim away the key entirely on rung 3.
  const matchedPrefix = `${split.base}${split.prefix}${split.matchedPath}`;
  const rest = pageUrl.slice(matchedPrefix.length);
  const resolveUrl = `${split.base}${split.prefix}${match.path}${rest}`;
```

The snippet above is the SHAPE; it needs one more input to be correct, defined next. Write the final form given at the end of this step — not the snippet above.

This needs the *raw* matched slice to know how much of `pageUrl` the matcher consumed. Extend the matchers' `Match` type with the verbatim slice they matched:

```ts
interface Match {
  readonly kind: SurfaceKind;
  readonly ref: string;
  /** The normalised path — Jira upper-cases here; every other matcher echoes the input. */
  readonly path: string;
  /** The same path exactly as it appeared in the URL, so the caller knows how many
   *  characters of the incoming path were consumed. */
  readonly matchedPath: string;
}
```

Each matcher returns `matchedPath` as the verbatim join of the segments it consumed. For every matcher except Jira, `matchedPath === path`; `matchJira` returns `` `/browse/${key}` `` (verbatim) as `matchedPath` and `` `/browse/${upper}` `` as `path`.

**This is the final form to write** — it reads `matchedPath` off `match` (not `split`), and falls back to `pageUrl` unchanged if the prefix does not line up (a defensive case, e.g. a percent-encoded path the splitter decoded) rather than emitting a mis-spliced string:

```ts
  const matchedPrefix = `${split.base}${split.prefix}${match.matchedPath}`;
  const resolveUrl = pageUrl.startsWith(matchedPrefix)
    ? `${split.base}${split.prefix}${match.path}${pageUrl.slice(matchedPrefix.length)}`
    : pageUrl;
```

Update the `Recognition.resolveUrl` doc comment in `src/shared/types.ts`:

```ts
    /**
     * The URL sent to the gateway as the resolution key: the address-bar URL with
     * identity normalisation only. The gateway owns canonicalisation — see
     * shared/recognise.ts.
     */
    readonly resolveUrl: string;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/recognise.test.ts && bun run typecheck`
Expected: recogniser tests PASS. Typecheck still fails in `panel-view.ts` / `panel-in-page.ts` — Task 7 closes it.

- [ ] **Step 5: Commit**

```bash
git add src/shared/recognise.ts src/shared/types.ts test/unit/recognise.test.ts
git commit -m "fix(recognise): send the address-bar URL and let the gateway canonicalise"
```

---

### Task 6: Freshness formatting

**Files:**
- Create: `src/shared/freshness.ts`
- Test: `test/unit/freshness.test.ts`

**Interfaces:**
- Produces: `export function formatAge(modifiedAtMs: number, nowMs: number): string`

- [ ] **Step 1: Write the failing test**

Create `test/unit/freshness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatAge } from "../../src/shared/freshness.ts";

describe("formatAge", () => {
  const now = 1_700_000_000_000;
  const s = 1000;
  const m = 60 * s;
  const h = 60 * m;
  const d = 24 * h;

  it("formats each bucket", () => {
    expect(formatAge(now, now)).toBe("just now");
    expect(formatAge(now - 30 * s, now)).toBe("just now");
    expect(formatAge(now - 1 * m, now)).toBe("1 min ago");
    expect(formatAge(now - 45 * m, now)).toBe("45 min ago");
    expect(formatAge(now - 1 * h, now)).toBe("1 hour ago");
    expect(formatAge(now - 5 * h, now)).toBe("5 hours ago");
    expect(formatAge(now - 1 * d, now)).toBe("1 day ago");
    expect(formatAge(now - 30 * d, now)).toBe("30 days ago");
  });

  it("does not claim the future when a clock skews", () => {
    expect(formatAge(now + 60 * m, now)).toBe("just now");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/freshness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/shared/freshness.ts`:

```ts
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * How stale an indexed item is, in words.
 *
 * `nowMs` is injected rather than read from the clock so this stays pure and
 * testable — and so the panel takes one timestamp per repaint instead of a
 * different one per line.
 *
 * A future `modifiedAtMs` reads as "just now": the gateway's clock and the
 * browser's can disagree by a little, and "in 3 minutes" would be a nonsense
 * answer to "how fresh is this?".
 */
export function formatAge(modifiedAtMs: number, nowMs: number): string {
  const age = nowMs - modifiedAtMs;
  if (age < MINUTE_MS) {
    return "just now";
  }
  if (age < HOUR_MS) {
    return `${Math.floor(age / MINUTE_MS)} min ago`;
  }
  if (age < DAY_MS) {
    return plural(Math.floor(age / HOUR_MS), "hour");
  }
  return plural(Math.floor(age / DAY_MS), "day");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run test/unit/freshness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/freshness.ts test/unit/freshness.test.ts
git commit -m "feat(panel): add pure relative-age formatting for indexed items"
```

---

### Task 7: The header — freshness, match confidence, scope guidance, and the chooser

**Files:**
- Modify: `src/panel/panel-view.ts:80-183`
- Test: `test/unit/panel-view.test.ts`

**Interfaces:**
- Consumes: `ResolvedItem`, `ResolveCandidate`, `ResolveMatchKind` (Task 2); `formatAge` (Task 6).
- Produces:
  ```ts
  export type HeaderState =
    | { kind: "loading" }
    | { kind: "unrecognised" }
    | { kind: "resolved"; surface: string; item: ResolvedItem;
        matchKind: ResolveMatchKind; nowMs: number }
    | { kind: "chosen"; surface: string; candidate: ResolveCandidate }
    | { kind: "ambiguous"; surface: string; candidates: readonly ResolveCandidate[];
        truncated: boolean }
    | { kind: "not-indexed"; surface: string }
    | { kind: "needs-scope"; surface: string }
    | { kind: "error"; surface: string | null; message: string };

  export function renderHeader(
    doc: Document, state: HeaderState, onChoose?: (c: ResolveCandidate) => void,
  ): HTMLElement;
  export function renderShell(
    doc: Document, state: PanelState, onChoose?: (c: ResolveCandidate) => void,
  ): HTMLElement;
  ```
  `renderShell`'s existing signature gains one optional trailing parameter and its
  lane loop is untouched — adding C2 lanes must still not touch it.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/panel-view.test.ts` (it already carries the jsdom docblock):

```ts
const ITEM = {
  id: "i1", service: "github", type: "pr", title: "Fix the flake",
  url: "https://github.com/a/b/pull/1", modifiedAt: 1_700_000_000_000,
};
const NOW = ITEM.modifiedAt + 3 * 60_000;

describe("renderHeader — freshness and match confidence", () => {
  it("shows the surface, a linked title and the indexed age on an exact match", () => {
    const el = renderHeader(document, {
      kind: "resolved", surface: "GitHub PR · a/b #1",
      item: ITEM, matchKind: "exact", nowMs: NOW,
    });
    expect(el.textContent).toContain("GitHub PR · a/b #1");
    expect(el.textContent).toContain("Fix the flake");
    expect(el.textContent).toContain("Indexed 3 min ago");
    // An exact match makes no hedge.
    expect(el.textContent).not.toContain("Closest match");
    const link = el.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/a/b/pull/1");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("does not hedge a query_stripped match — the query is not identity here", () => {
    const el = renderHeader(document, {
      kind: "resolved", surface: "S", item: ITEM, matchKind: "query_stripped", nowMs: NOW,
    });
    expect(el.textContent).not.toContain("Closest match");
  });

  it("marks a path_trimmed match as the weaker claim it is", () => {
    const el = renderHeader(document, {
      kind: "resolved", surface: "S", item: ITEM, matchKind: "path_trimmed", nowMs: NOW,
    });
    expect(el.textContent).toContain("Closest match");
  });

  it("renders a title-only line when the item has no url", () => {
    const el = renderHeader(document, {
      kind: "resolved", surface: "S", item: { ...ITEM, url: null },
      matchKind: "exact", nowMs: NOW,
    });
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Fix the flake");
  });

  it("renders gateway strings as text, never as markup", () => {
    const el = renderHeader(document, {
      kind: "resolved", surface: "S",
      item: { ...ITEM, title: "<img src=x onerror=alert(1)>" },
      matchKind: "exact", nowMs: NOW,
    });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("renderHeader — needs-scope", () => {
  it("names the command that grants the scope instead of blaming the gateway", () => {
    const el = renderHeader(document, { kind: "needs-scope", surface: "GitHub PR · a/b #1" });
    expect(el.textContent).toContain("GitHub PR · a/b #1");
    // The exact CLI syntax, verified against `nimbus clip --help` and CLIP_USAGE.
    // `--label`/`--scopes` is the IPC param shape, NOT the CLI's flags.
    expect(el.textContent).toContain("nimbus clip scopes <label> --set");
    expect(el.textContent).toContain("resolve");
    // It is a grant the owner has not made — not an error, and not a re-pair.
    expect(el.textContent).not.toContain("error");
    expect(el.textContent?.toLowerCase()).not.toContain("re-pair");
  });
});

describe("renderHeader — ambiguous", () => {
  const candidates = [
    { id: "a", service: "jira", type: "issue", title: "One", url: "https://j.test/a" },
    { id: "b", service: "jira", type: "issue", title: "Two", url: null },
  ];

  it("offers one button per candidate and reports the choice", () => {
    const chosen: string[] = [];
    const el = renderHeader(
      document,
      { kind: "ambiguous", surface: "Jira issue · ABC-1", candidates, truncated: false },
      (c) => chosen.push(c.id),
    );
    const buttons = el.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toContain("One");
    (buttons[1] as HTMLButtonElement).click();
    expect(chosen).toEqual(["b"]);
  });

  it("shows NO chooser when truncated — upstream sends no list, so there is nothing honest to offer", () => {
    const el = renderHeader(document, {
      kind: "ambiguous", surface: "Jira issue · ABC-1", candidates: [], truncated: true,
    });
    expect(el.querySelectorAll("button")).toHaveLength(0);
    expect(el.textContent).toContain("Too many matches");
  });
});

describe("renderHeader — chosen", () => {
  it("shows the chosen candidate without claiming a freshness it does not have", () => {
    const el = renderHeader(document, {
      kind: "chosen", surface: "Jira issue · ABC-1",
      candidate: { id: "a", service: "jira", type: "issue", title: "One", url: "https://j.test/a" },
    });
    expect(el.textContent).toContain("One");
    expect(el.textContent).not.toContain("Indexed");
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/panel-view.test.ts`
Expected: FAIL — `HeaderState` has no `needs-scope` / `ambiguous` / `chosen` arms and `renderHeader` takes no callback.

- [ ] **Step 3: Write the implementation**

In `src/panel/panel-view.ts`, import `formatAge` from `../shared/freshness.ts` and `ResolveCandidate` / `ResolveMatchKind` from `../shared/types.ts`, then replace `HeaderState` (lines 80-85) and `renderHeader` (lines 123-160):

```ts
export type HeaderState =
  | { readonly kind: "loading" }
  | { readonly kind: "unrecognised" }
  | {
      readonly kind: "resolved";
      readonly surface: string;
      readonly item: ResolvedItem;
      readonly matchKind: ResolveMatchKind;
      /** Taken once per repaint so every line agrees on "now". */
      readonly nowMs: number;
    }
  /**
   * A candidate the USER picked out of an ambiguous answer. Distinct from
   * `resolved` because a candidate carries no `modified_at`: rendering it as
   * resolved would mean inventing a freshness, which is precisely the invisible
   * staleness this header exists to avoid.
   */
  | { readonly kind: "chosen"; readonly surface: string; readonly candidate: ResolveCandidate }
  | {
      readonly kind: "ambiguous";
      readonly surface: string;
      readonly candidates: readonly ResolveCandidate[];
      readonly truncated: boolean;
    }
  | { readonly kind: "not-indexed"; readonly surface: string }
  /** A 403. The token predates the `resolve` scope; the OWNER grants it. */
  | { readonly kind: "needs-scope"; readonly surface: string }
  | { readonly kind: "error"; readonly surface: string | null; readonly message: string };
```

```ts
/** `title` for a candidate; `title` + freshness for a resolved item. */
function candidateLine(doc: Document, c: ResolveCandidate): HTMLElement {
  const href = c.url !== null ? safeHttpUrl(c.url) : null;
  if (href === null) {
    return line(doc, "nimbus-related__header-item", c.title);
  }
  const wrapper = doc.createElement("p");
  wrapper.className = "nimbus-related__header-item";
  const link = doc.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = c.title;
  wrapper.append(link);
  return wrapper;
}

function chooser(
  doc: Document,
  candidates: readonly ResolveCandidate[],
  onChoose: ((c: ResolveCandidate) => void) | undefined,
): HTMLElement {
  const list = doc.createElement("ul");
  list.className = "nimbus-related__candidates";
  for (const c of candidates) {
    const li = doc.createElement("li");
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "nimbus-related__candidate";
    // textContent, never innerHTML — this string comes from the gateway.
    button.textContent = c.title;
    if (onChoose !== undefined) {
      button.addEventListener("click", () => onChoose(c));
    }
    li.append(button);
    list.append(li);
  }
  return list;
}

export function renderHeader(
  doc: Document,
  state: HeaderState,
  onChoose?: (c: ResolveCandidate) => void,
): HTMLElement {
  const box = doc.createElement("div");
  box.className = "nimbus-related__header-state";

  if (state.kind === "loading") {
    box.append(line(doc, "nimbus-related__status", "Checking Nimbus…"));
    return box;
  }
  if (state.kind === "unrecognised") {
    box.append(
      line(doc, "nimbus-related__surface", "Not a recognised Nimbus surface"),
      line(
        doc,
        "nimbus-related__status",
        "Add this site under Recognised surfaces in Options to recognise it.",
      ),
    );
    return box;
  }
  // Handled whole rather than folded into the shared tail below: `surface` is
  // nullable only on this arm, and splitting it would leave the tail unable to
  // narrow it to a string.
  if (state.kind === "error") {
    if (state.surface !== null) {
      box.append(line(doc, "nimbus-related__surface", state.surface));
    }
    box.append(line(doc, "nimbus-related__status", state.message));
    return box;
  }

  box.append(line(doc, "nimbus-related__surface", state.surface));

  if (state.kind === "resolved") {
    box.append(candidateLine(doc, state.item));
    box.append(
      line(
        doc,
        "nimbus-related__status",
        `Indexed ${formatAge(state.item.modifiedAt, state.nowMs)}`,
      ),
    );
    // Only rung 3 gets a hedge. Rungs 1 and 2 differ by query params, which carry
    // no identity on any surface the recogniser matches; rung 3 got here by
    // discarding path segments, so it may be the parent of the page, not the page.
    if (state.matchKind === "path_trimmed") {
      box.append(
        line(
          doc,
          "nimbus-related__status",
          "Closest match — this page's exact URL isn't indexed.",
        ),
      );
    }
    return box;
  }

  if (state.kind === "chosen") {
    box.append(candidateLine(doc, state.candidate));
    return box;
  }

  if (state.kind === "ambiguous") {
    if (state.truncated) {
      // Upstream deliberately sends an EMPTY list when it would have to truncate:
      // a shortened menu implies the right answer is on it. Say so instead.
      box.append(
        line(
          doc,
          "nimbus-related__status",
          "Too many matches to choose from — open the item in Nimbus.",
        ),
      );
      return box;
    }
    box.append(line(doc, "nimbus-related__status", "Several indexed items match this page:"));
    box.append(chooser(doc, state.candidates, onChoose));
    return box;
  }

  if (state.kind === "needs-scope") {
    box.append(
      line(doc, "nimbus-related__status", "This pairing can't resolve pages yet."),
      line(
        doc,
        "nimbus-related__status",
        "Grant it on the gateway: nimbus clip scopes <label> --set clip,briefs,resolve",
      ),
    );
    return box;
  }

  box.append(line(doc, "nimbus-related__status", "Not indexed."));
  return box;
}
```

Thread the callback through `renderShell` without touching its lane loop:

```ts
export function renderShell(
  doc: Document,
  state: PanelState,
  onChoose?: (c: ResolveCandidate) => void,
): HTMLElement {
  const shell = doc.createElement("div");
  shell.className = "nimbus-related__shell";
  shell.append(renderHeader(doc, state.header, onChoose));
  for (const lane of state.lanes) {
    shell.append(renderLane(doc, lane));
  }
  return shell;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/panel-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel/panel-view.ts test/unit/panel-view.test.ts
git commit -m "feat(panel): show freshness, match confidence, scope guidance and a candidate chooser"
```

---

### Task 8: Wire the panel

**Files:**
- Modify: `src/panel/panel-in-page.ts:20-30` (messages), `:120-190` (headerFrom + load), plus the stylesheet block for `.nimbus-related__candidates` / `__candidate`
- Test: `test/unit/panel-in-page.test.ts`

**Interfaces:**
- Consumes: `HeaderState` + `renderShell` (Task 7), `isResolveResponse` (Task 4).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/panel-in-page.test.ts`, following the file's existing harness for stubbing `chrome.runtime.sendMessage` and mounting the panel:

```ts
it("renders scope guidance for an insufficient_scope reason", async () => {
  const panel = await mountPanelWithResolve({
    kind: "resolve", ok: false, reason: "insufficient_scope",
    recognition: {
      ok: true, product: "github", kind: "pr", label: "GitHub PR",
      ref: "a/b #1", resolveUrl: "https://github.com/a/b/pull/1",
    },
  });
  expect(panel.textContent).toContain("nimbus clip scopes");
  expect(panel.textContent).not.toContain("had an error");
});

it("renders the chooser for an ambiguous outcome and settles on the clicked candidate", async () => {
  const panel = await mountPanelWithResolve({
    kind: "resolve", ok: true,
    recognition: {
      ok: true, product: "jira", kind: "issue", label: "Jira issue",
      ref: "ABC-1", resolveUrl: "https://acme.atlassian.net/browse/ABC-1",
    },
    outcome: {
      kind: "ambiguous", service: "jira", fetchable: false, truncated: false,
      candidates: [
        { id: "a", service: "jira", type: "issue", title: "One", url: null },
        { id: "b", service: "jira", type: "issue", title: "Two", url: null },
      ],
    },
  });

  const buttons = panel.querySelectorAll("button.nimbus-related__candidate");
  expect(buttons).toHaveLength(2);
  (buttons[1] as HTMLButtonElement).click();

  expect(panel.textContent).toContain("Two");
  expect(panel.querySelectorAll("button.nimbus-related__candidate")).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/panel-in-page.test.ts`
Expected: FAIL — `headerFrom` still reads `res.item`.

- [ ] **Step 3: Write the implementation**

In `src/panel/panel-in-page.ts`, extend the message map and replace `headerFrom`:

```ts
const RESOLVE_MESSAGES: Record<string, string> = {
  not_paired: "Pair with Nimbus in Options to see what it knows about this page.",
  unauthorized: "Nimbus rejected this pairing. Re-pair in Options.",
  unsupported: "This Nimbus gateway can't resolve pages yet.",
  unreachable: "Couldn't connect to Nimbus.",
  server_error: "Nimbus had an error resolving this page.",
};

function headerFrom(res: unknown, nowMs: number): HeaderState {
  if (!isResolveResponse(res)) {
    return { kind: "error", surface: null, message: "Couldn't read Nimbus's answer." };
  }
  const surface = surfaceLine(res.recognition);
  if (!res.ok) {
    // `insufficient_scope` is NOT an error: the route works, the owner just has
    // not granted this device the scope. It gets its own state so the panel can
    // say what to run instead of blaming Nimbus.
    if (res.reason === "insufficient_scope" && surface !== null) {
      return { kind: "needs-scope", surface };
    }
    return {
      kind: "error",
      surface,
      message: RESOLVE_MESSAGES[res.reason] ?? "Couldn't resolve this page.",
    };
  }
  if (surface === null) {
    return { kind: "unrecognised" };
  }
  const outcome = res.outcome;
  if (outcome.kind === "found") {
    return { kind: "resolved", surface, item: outcome.item, matchKind: outcome.matchKind, nowMs };
  }
  if (outcome.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      surface,
      candidates: outcome.candidates,
      truncated: outcome.truncated,
    };
  }
  // `unresolvable` means the gateway could not parse the URL we sent — a client
  // bug, not a user-facing distinction. It reads as "not indexed" either way.
  return { kind: "not-indexed", surface };
}
```

In the load/repaint function, take one `nowMs` per repaint, hold a chosen candidate, and pass the chooser callback:

```ts
  let header: HeaderState = { kind: "loading" };
  let chosen: ResolveCandidate | null = null;

  const repaint = (): void => {
    const shown: HeaderState =
      chosen !== null && header.kind === "ambiguous"
        ? { kind: "chosen", surface: header.surface, candidate: chosen }
        : header;
    body.replaceChildren(
      renderShell(document, { header: shown, lanes }, (c) => {
        chosen = c;
        repaint();
      }),
    );
  };
```

Replace the existing `body.replaceChildren(renderShell(...))` calls with `repaint()`, and change the resolve landing site to `header = headerFrom(res, Date.now());`.

Add to the stylesheet block:

```css
.nimbus-related__candidates { list-style: none; margin: 4px 0 0; padding: 0; }
.nimbus-related__candidate {
  background: none; border: none; padding: 4px 0; cursor: pointer;
  color: var(--nimbus-accent); font: inherit; text-align: left;
}
.nimbus-related__candidate:hover { text-decoration: underline; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/panel-in-page.test.ts && bun run typecheck`
Expected: PASS and typecheck clean — this is where the tree goes green again.

- [ ] **Step 5: Commit**

```bash
git add src/panel/panel-in-page.ts test/unit/panel-in-page.test.ts
git commit -m "feat(panel): wire the resolve outcomes into the header"
```

---

### Task 9: Mock gateway, docs, and the green bar

**Files:**
- Modify: `scripts/screenshots/mock-gateway.ts`, `scripts/screenshots/gateway-fixtures.ts`
- Modify: `CHANGELOG.md`, `docs/architecture.md`, `ROADMAP.md`
- Test: `test/unit/mock-gateway.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/unit/mock-gateway.test.ts`, update the resolve case to a GET returning the new shape:

```ts
it("serves GET /v1/items/resolve with a found outcome", async () => {
  const res = await handleRequest(
    new Request("http://127.0.0.1:8765/v1/items/resolve?url=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fpull%2F1", {
      method: "GET",
      headers: { authorization: "Bearer test-token" },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body["found"]).toBe(true);
  expect(body["matchKind"]).toBe("exact");
  expect((body["item"] as Record<string, unknown>)["modified_at"]).toEqual(expect.any(Number));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/mock-gateway.test.ts`
Expected: FAIL — the mock still serves resolve on POST with `{item}`.

- [ ] **Step 3: Write the implementation**

In `scripts/screenshots/gateway-fixtures.ts`, replace the resolve fixture (the comment at line 32 calling it "the PROPOSED resolve route" is now wrong):

```ts
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
    // Fixed, not Date.now() — screenshots must be reproducible.
    modified_at: 1_700_000_000_000,
  },
} as const;
```

In `scripts/screenshots/mock-gateway.ts`, move the resolve case out of the POST switch into a GET branch keyed on `GATEWAY_PATHS.resolve`, returning `RESOLVE_FIXTURE`.

- [ ] **Step 4: Run the full green bar**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all five PASS. Fix any Biome findings (`bun run format` applies the safe ones) before continuing.

- [ ] **Step 5: Update the docs**

`CHANGELOG.md`, under `## [Unreleased]`:

```markdown
### Changed

- The panel now resolves pages against the gateway's shipped
  `GET /v1/items/resolve` route instead of the guessed shape Phase C1 was built
  against. It shows how fresh the indexed item is, marks a closest-match result
  as weaker than an exact one, and lets you pick when several indexed items match
  the page.
- A pairing made before the gateway gained token scopes now says so, and names the
  command that grants it (`nimbus clip scopes`), instead of reporting a Nimbus error.
```

In `docs/architecture.md`, update the resolve section: the route, the four outcomes, who owns canonicalisation (the gateway), and why `chosen` is a separate header state from `resolved`.

In `ROADMAP.md`, mark C1.1's contract adaptation done and note that `fetchable` is now carried through for C3.1.

- [ ] **Step 6: Commit**

```bash
git add scripts/screenshots CHANGELOG.md docs/architecture.md ROADMAP.md test/unit/mock-gateway.test.ts
git commit -m "docs+fixtures: track the shipped resolve contract"
```

---

## Self-Review

**Spec coverage** — the reconciliation note's six changes:

| # | Change | Task |
| --- | --- | --- |
| 1 | 403 → `insufficient_scope` + re-grant guidance | 3 (map), 7 (`needs-scope` render), 8 (wire) |
| 2 | `ambiguous` arm + HeaderState + chooser, ≤5 cap, honest `truncated` | 2, 3, 7, 8 |
| 3 | `modified_at` → freshness; `exact` vs `path_trimmed` confidence | 2, 6, 7 |
| 4 | Route/method/param change; `PROPOSED_PATHS` becomes real | 1 |
| 5 | Stop stripping query params client-side | 5 |
| 6 | Carry `fetchable` through for C3.1 | 2, 3, 4 |

**Deviations from the brief, and why** — all four are corrections forced by reading merged source, recorded here so a reviewer can check them against the gateway rather than against this plan:

1. Guidance is `nimbus clip scopes`, **not** re-pair. Scopes are owner-named at window open; upstream shipped a re-grant command that avoids an unpair/pair cycle.
2. `truncated` renders **no chooser at all**, not five of N. Upstream sends an empty list precisely so a client cannot imply the answer is on a shortened menu.
3. `matchKind` has three values; only `path_trimmed` is hedged. Hedging `query_stripped` would flag the common case of a `?w=1` diff view as low-confidence.
4. Change #5 is applied as *canonicalisation moves to the gateway, identity normalisation stays here*. A literal "send the address-bar URL" would regress lower-cased Jira keys, because the ladder is case-sensitive.

**Placeholder scan:** none — every code step carries the actual code.

**Type consistency:** `resolveItem` (Task 3) is the name used by `ResolveDeps` (Task 4) and the service-worker wiring. `ResolvedItem.modifiedAt` is camelCase everywhere past the parser; `modified_at` appears only in `parseItem` (Task 3) and the screenshot fixture (Task 9). `renderShell`'s third parameter is optional in Tasks 7 and 8 alike.

**Out of scope, deliberately:** the C2 lanes (why · impact · expert) and C3.1 targeted fetch. `fetchable` is carried to the message boundary and intentionally not yet rendered — its consumer is C3.1.
