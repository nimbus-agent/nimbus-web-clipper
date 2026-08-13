# Ambient Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a host the user granted page access to and switched on, landing on a page that resolves to exactly one indexed item mounts a quiet corner cue naming that item; clicking it opens the existing panel.

**Architecture:** The service worker listens to tab navigation, filters with the pure recogniser, resolves through the existing `handleResolve`, and only on `found` injects a new `cue.js` (the two-step inject-then-call pattern `toast.js` already uses). All decision logic lives in one pure module, `src/background/ambient.ts`, with injected deps; the service worker supplies the real ones. No new manifest permission.

**Tech Stack:** TypeScript (strict, no `any`), Vitest (node env; jsdom via a `// @vitest-environment jsdom` docblock), esbuild IIFE bundles, Biome, Bun as the runner. MV3 WebExtension APIs via the `src/browser/` seam only.

**Spec:** [`docs/superpowers/specs/2026-08-13-ambient-surfacing-design.md`](../specs/2026-08-13-ambient-surfacing-design.md) — and its review responses, folded into that same file. Read it before Task 1.

## Global Constraints

Every task's requirements implicitly include all of these.

- **TypeScript strict, no `any`.** Cross-boundary data is `unknown`, narrowed by a type guard. Biome enforces `noExplicitAny`, `noNonNullAssertion`.
- **No `console.*` anywhere in `src/`** (Biome `noConsole`). Tests and `scripts/` may log.
- **Never log or render the bearer token or the pairing code.** Neither appears anywhere in this feature.
- **Loopback only.** This feature adds no fetch and no host permission. The only network destination remains the gateway on `127.0.0.1` / `localhost`.
- **No new manifest permission.** `optional_host_permissions` already covers every pattern this feature requests. Task 4 adds a test asserting this.
- **`chrome.*` only inside `src/browser/`.** Pure modules take injected deps. A pure view module never touches `chrome.*` or `innerHTML`.
- **Page text is written with `textContent`, never `innerHTML`.** Page-derived strings (titles, refs) are untrusted.
- **Commands:** `bun run test`, `bun run typecheck`, `bun run lint`, `bun run build`, `bun run check-build`. Run `bun run test` after every task; run the full four before the last commit of each task that touches the build.
- **Commit style:** Conventional Commits, and every user-facing change gets a `CHANGELOG.md` entry under `## [Unreleased]` (Task 11 does the changelog once, deliberately).
- **Branch:** `feat/ambient-surfacing` (already created; the spec commits are on it).

---

### Task 1: Pattern matching + the built-in surface table

**Files:**
- Modify: `src/shared/origins.ts` (append `patternMatchesUrl`)
- Modify: `src/shared/recognise.ts` (append `BuiltInSurface`, `JIRA_CLOUD_PATTERN`, `BUILT_IN_SURFACES` after `BUILT_IN_ORIGINS` at line 13)
- Test: `test/unit/origins.test.ts`, `test/unit/recognise.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `patternMatchesUrl(pattern: string, url: string): boolean` — from `src/shared/origins.ts`
  - `interface BuiltInSurface { readonly label: string; readonly product: Product; readonly pattern: string }` — from `src/shared/recognise.ts`
  - `BUILT_IN_SURFACES: readonly BuiltInSurface[]`, `JIRA_CLOUD_PATTERN: string` — from `src/shared/recognise.ts`

Why both live here: the ambient gate must answer "is this URL on a host the user switched on?", and prefs are keyed by host permission pattern (Task 2). Jira Cloud's pattern is a subdomain wildcard, so a plain string compare against a URL's host is not enough.

- [ ] **Step 1: Write the failing tests for `patternMatchesUrl`**

Append to `test/unit/origins.test.ts`:

```ts
describe("patternMatchesUrl", () => {
  test("exact host pattern matches its own host, any port and any path", () => {
    expect(patternMatchesUrl("https://github.com/*", "https://github.com/acme/web/pull/1")).toBe(
      true,
    );
    expect(patternMatchesUrl("http://corp.example/*", "http://corp.example:8080/jenkins/job/x")).toBe(
      true,
    );
  });

  test("exact host pattern does not match a subdomain", () => {
    expect(patternMatchesUrl("https://github.com/*", "https://gist.github.com/x")).toBe(false);
  });

  test("scheme must match", () => {
    expect(patternMatchesUrl("https://github.com/*", "http://github.com/x")).toBe(false);
  });

  test("subdomain wildcard matches any tenant and the bare host", () => {
    expect(
      patternMatchesUrl("https://*.atlassian.net/*", "https://acme.atlassian.net/browse/ABC-1"),
    ).toBe(true);
    expect(patternMatchesUrl("https://*.atlassian.net/*", "https://atlassian.net/x")).toBe(true);
  });

  test("subdomain wildcard does not match a lookalike suffix", () => {
    expect(patternMatchesUrl("https://*.atlassian.net/*", "https://evilatlassian.net/x")).toBe(
      false,
    );
  });

  test("host comparison is case-insensitive", () => {
    expect(patternMatchesUrl("https://github.com/*", "https://GitHub.com/x")).toBe(true);
  });

  test("rejects anything that is not a plain host pattern", () => {
    expect(patternMatchesUrl("<all_urls>", "https://github.com/x")).toBe(false);
    expect(patternMatchesUrl("*://github.com/*", "https://github.com/x")).toBe(false);
    expect(patternMatchesUrl("https://github.com/acme/*", "https://github.com/acme/x")).toBe(false);
  });

  test("a non-URL never matches", () => {
    expect(patternMatchesUrl("https://github.com/*", "not a url")).toBe(false);
  });
});
```

Add `patternMatchesUrl` to that file's existing import from `../../src/shared/origins.ts`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun run test -- origins`
Expected: FAIL — `patternMatchesUrl is not a function` / TS error that it is not exported.

- [ ] **Step 3: Implement `patternMatchesUrl`**

Append to `src/shared/origins.ts`:

```ts
/**
 * Does a host permission pattern cover this URL?
 *
 * Deliberately NOT a general match-pattern implementation. The only patterns
 * this extension can produce are `scheme://host/*` (hostPermissionPattern
 * above) and the ONE subdomain-wildcard form Jira Cloud needs, because its
 * tenant hosts are not enumerable. `<all_urls>`, scheme wildcards and path
 * components are rejected rather than interpreted: nothing here may create
 * them, so accepting them could only ever widen a match by accident.
 *
 * The PORT is ignored, exactly as the browser does — a pattern's host may not
 * carry one (see hostPermissionPattern), so a granted host is granted on every
 * port it serves.
 */
export function patternMatchesUrl(pattern: string, url: string): boolean {
  const parts = /^(https?):\/\/(\*\.)?([^/*:]+)\/\*$/.exec(pattern);
  if (parts === null) {
    return false;
  }
  const [, scheme, wildcard, host] = parts;
  if (scheme === undefined || host === undefined) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== `${scheme}:`) {
    return false;
  }
  const found = parsed.hostname.toLowerCase();
  const want = host.toLowerCase();
  if (wildcard === undefined) {
    return found === want;
  }
  // The `.` boundary is what stops "*.atlassian.net" matching
  // "evilatlassian.net"; the bare host itself is included, matching how the
  // browser reads the same pattern.
  return found === want || found.endsWith(`.${want}`);
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun run test -- origins`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for the built-in surface table**

Append to `test/unit/recognise.test.ts`:

```ts
describe("BUILT_IN_SURFACES", () => {
  test("every built-in origin has a surface row carrying its host pattern", () => {
    for (const entry of BUILT_IN_ORIGINS) {
      const pattern = hostPermissionPattern(entry.origin);
      const row = BUILT_IN_SURFACES.find((s) => s.product === entry.product);
      expect(row).toBeDefined();
      expect(row?.pattern).toBe(pattern);
    }
  });

  test("Jira Cloud is a subdomain wildcard, since tenant hosts are not enumerable", () => {
    const jira = BUILT_IN_SURFACES.find((s) => s.product === "jira");
    expect(jira?.pattern).toBe("https://*.atlassian.net/*");
  });

  test("every surface pattern matches a real page URL on that product", () => {
    const pages: Record<string, string> = {
      bitbucket: "https://bitbucket.org/acme/web/pull-requests/7",
      github: "https://github.com/acme/web/pull/482",
      gitlab: "https://gitlab.com/acme/web/-/merge_requests/9",
      jira: "https://acme.atlassian.net/browse/ABC-1",
    };
    for (const surface of BUILT_IN_SURFACES) {
      const page = pages[surface.product];
      expect(page).toBeDefined();
      expect(patternMatchesUrl(surface.pattern, page ?? "")).toBe(true);
    }
  });
});
```

Add to that file's imports:

```ts
import { BUILT_IN_ORIGINS, BUILT_IN_SURFACES, recognise, sameItem, surfaceLine } from "../../src/shared/recognise.ts";
import { hostPermissionPattern, patternMatchesUrl } from "../../src/shared/origins.ts";
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `bun run test -- recognise`
Expected: FAIL — `BUILT_IN_SURFACES` is not exported.

- [ ] **Step 7: Implement the table**

In `src/shared/recognise.ts`, immediately after the `BUILT_IN_ORIGINS` declaration (line 13-17):

```ts
/** The host permission pattern for all of Jira Cloud. Tenant hosts are per-customer
 *  (`acme.atlassian.net`) and cannot be enumerated, so the row offers the wildcard
 *  and says so — see the design spec's built-in-rows section. */
export const JIRA_CLOUD_PATTERN = "https://*.atlassian.net/*";

/**
 * A built-in surface as the Options page shows it: a host the extension
 * recognises without configuration, and the permission pattern its page-access
 * grant is keyed by.
 *
 * Separate from BUILT_IN_ORIGINS above because Jira Cloud has no single origin —
 * it is matched by host suffix — so it can appear here and not there. The drift
 * guard is a test: every BUILT_IN_ORIGINS entry must have a row whose pattern is
 * exactly hostPermissionPattern(origin).
 */
export interface BuiltInSurface {
  /** Shown in Options. Not an origin: Jira Cloud's is a host pattern. */
  readonly label: string;
  readonly product: Product;
  readonly pattern: string;
}

export const BUILT_IN_SURFACES: readonly BuiltInSurface[] = [
  { label: "bitbucket.org", product: "bitbucket", pattern: "https://bitbucket.org/*" },
  { label: "github.com", product: "github", pattern: "https://github.com/*" },
  { label: "gitlab.com", product: "gitlab", pattern: "https://gitlab.com/*" },
  { label: "*.atlassian.net", product: "jira", pattern: JIRA_CLOUD_PATTERN },
];
```

- [ ] **Step 8: Run the tests and make sure they pass**

Run: `bun run test -- recognise` then `bun run test`
Expected: PASS, no regressions.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
bun run typecheck && bun run lint
git add src/shared/origins.ts src/shared/recognise.ts test/unit/origins.test.ts test/unit/recognise.test.ts
git commit -m "feat(shared): host-pattern matching and the built-in surface table"
```

---

### Task 2: The ambient preferences store

**Files:**
- Create: `src/background/ambient-prefs.ts`
- Test: `test/unit/ambient-prefs.test.ts`

**Interfaces:**
- Consumes: `patternMatchesUrl` (Task 1).
- Produces:
  - `getAmbientHosts(): Promise<string[]>`
  - `setAmbientHost(pattern: string, on: boolean): Promise<void>`
  - `isAmbientUrl(url: string, patterns: readonly string[]): boolean`

Keyed by host permission pattern — the same identifier the grant is keyed by — so the toggle and the grant can never describe different hosts. `isAmbientUrl` is pure and exported separately so the ambient gate (Task 9) can be tested without storage.

- [ ] **Step 1: Write the failing test**

Create `test/unit/ambient-prefs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getAmbientHosts,
  isAmbientUrl,
  setAmbientHost,
} from "../../src/background/ambient-prefs.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

let harness: ChromeHarness;
beforeEach(() => {
  harness = installChromeMock();
});
afterEach(() => {
  harness.restore();
});

describe("ambient prefs store", () => {
  test("no stored value reads as no enabled hosts", async () => {
    expect(await getAmbientHosts()).toEqual([]);
  });

  test("a non-array stored value reads as empty rather than throwing", async () => {
    harness.storage.set("ambient-hosts", { nope: true });
    expect(await getAmbientHosts()).toEqual([]);
  });

  test("non-string members are filtered out — stored data is external input", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*", 7, null]);
    expect(await getAmbientHosts()).toEqual(["https://github.com/*"]);
  });

  test("switching a host on stores it, and again is idempotent", async () => {
    await setAmbientHost("https://github.com/*", true);
    await setAmbientHost("https://github.com/*", true);
    expect(await getAmbientHosts()).toEqual(["https://github.com/*"]);
  });

  test("switching a host off removes only that host", async () => {
    await setAmbientHost("https://github.com/*", true);
    await setAmbientHost("https://gitlab.com/*", true);
    await setAmbientHost("https://github.com/*", false);
    expect(await getAmbientHosts()).toEqual(["https://gitlab.com/*"]);
  });

  test("switching off a host that was never on is a no-op", async () => {
    await setAmbientHost("https://github.com/*", false);
    expect(await getAmbientHosts()).toEqual([]);
  });
});

describe("isAmbientUrl", () => {
  test("true when any enabled pattern covers the url", () => {
    expect(
      isAmbientUrl("https://acme.atlassian.net/browse/ABC-1", [
        "https://github.com/*",
        "https://*.atlassian.net/*",
      ]),
    ).toBe(true);
  });

  test("false when no pattern covers it", () => {
    expect(isAmbientUrl("https://example.com/x", ["https://github.com/*"])).toBe(false);
  });

  test("false with no enabled patterns at all — off is the default", () => {
    expect(isAmbientUrl("https://github.com/acme/web/pull/1", [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun run test -- ambient-prefs`
Expected: FAIL — cannot resolve `src/background/ambient-prefs.ts`.

- [ ] **Step 3: Implement the store**

Create `src/background/ambient-prefs.ts`:

```ts
// Which hosts have the ambient cue switched on.
//
// Keyed by HOST PERMISSION PATTERN — the same identifier the page-access grant
// is keyed by (shared/origins.ts#hostPermissionPattern, and the Jira Cloud
// wildcard) — so the toggle and the grant can never end up describing different
// hosts. Carries no secret, like origin-store.ts and unlike connection-store.ts,
// so the Options page reads and writes it directly.
//
// There is deliberately no in-memory cache. See the design spec's "Deferred,
// with reasons": the read sits behind three filters already, and a cache's
// failure mode is a cue appearing on a host the user just switched off.
import { storageGet, storageSet } from "../browser/storage.ts";
import { patternMatchesUrl } from "../shared/origins.ts";

const AMBIENT_KEY = "ambient-hosts";

/** Stored data is external input: filter through the guard, never cast. */
export async function getAmbientHosts(): Promise<string[]> {
  const value = await storageGet(AMBIENT_KEY);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
}

export async function setAmbientHost(pattern: string, on: boolean): Promise<void> {
  const current = await getAmbientHosts();
  const next = on
    ? [...new Set([...current, pattern])]
    : current.filter((existing) => existing !== pattern);
  await storageSet(AMBIENT_KEY, next);
}

/** Pure: is this page URL on a host the user switched the cue on for? */
export function isAmbientUrl(url: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => patternMatchesUrl(pattern, url));
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun run test -- ambient-prefs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run typecheck && bun run lint
git add src/background/ambient-prefs.ts test/unit/ambient-prefs.test.ts
git commit -m "feat(background): store which hosts have the ambient cue switched on"
```

---

### Task 3: Surface rows — built-ins and the toggle (pure view)

**Files:**
- Modify: `src/options/surfaces-view.ts` (the `SurfaceRow` interface at line 6, `renderSurfaceList` at line 30)
- Test: `test/unit/surfaces-view.test.ts`

**Interfaces:**
- Consumes: `Product` from `src/shared/types.ts`.
- Produces: the widened `SurfaceRow`:
  ```ts
  export interface SurfaceRow {
    readonly origin: string;
    readonly product: Product;
    readonly granted: boolean;
    /** Built-in rows are not the user's entries: no Remove button. */
    readonly builtIn: boolean;
    /** Host permission pattern this row's grant and toggle are keyed by. */
    readonly pattern: string | null;
    /** Whether the ambient cue is switched on for this row's host. */
    readonly ambient: boolean;
  }
  ```
  `renderSurfaceList(doc: Document, rows: readonly SurfaceRow[]): HTMLElement` keeps its signature.

This module stays pure: no `chrome.*`, no permission queries. Task 4 supplies `granted`/`ambient`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/surfaces-view.test.ts` (the file already has `// @vitest-environment jsdom` at line 1 — keep it):

```ts
const STORED: SurfaceRow = {
  origin: "https://corp.example/jira",
  product: "jira",
  granted: true,
  builtIn: false,
  pattern: "https://corp.example/*",
  ambient: false,
};

const BUILT_IN: SurfaceRow = {
  origin: "github.com",
  product: "github",
  granted: true,
  builtIn: true,
  pattern: "https://github.com/*",
  ambient: true,
};

function actions(el: HTMLElement): string[] {
  return [...el.querySelectorAll("[data-action]")].map(
    (node) => (node as HTMLElement).dataset["action"] ?? "",
  );
}

describe("built-in rows", () => {
  test("a built-in row offers grant/revoke and the toggle but never Remove", () => {
    const el = renderSurfaceList(document, [BUILT_IN]);
    expect(actions(el)).toEqual(["ambient", "revoke"]);
    expect(el.textContent).toContain("github.com");
  });

  test("a stored row keeps Remove", () => {
    const el = renderSurfaceList(document, [STORED]);
    expect(actions(el)).toEqual(["ambient", "revoke", "remove"]);
  });

  test("an ungranted row offers Grant instead of Revoke", () => {
    const el = renderSurfaceList(document, [{ ...BUILT_IN, granted: false }]);
    expect(actions(el)).toContain("grant");
    expect(actions(el)).not.toContain("revoke");
  });
});

describe("the ambient toggle", () => {
  test("reflects the stored state and carries the pattern, not the origin", () => {
    const el = renderSurfaceList(document, [BUILT_IN]);
    const toggle = el.querySelector('[data-action="ambient"]');
    expect(toggle).toBeInstanceOf(HTMLInputElement);
    const input = toggle as HTMLInputElement;
    expect(input.type).toBe("checkbox");
    expect(input.checked).toBe(true);
    expect(input.dataset["pattern"]).toBe("https://github.com/*");
  });

  test("is disabled without page access — the cue cannot see a host it may not read", () => {
    const el = renderSurfaceList(document, [{ ...BUILT_IN, granted: false, ambient: false }]);
    const input = el.querySelector('[data-action="ambient"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  test("is disabled when the row has no usable pattern", () => {
    const el = renderSurfaceList(document, [{ ...STORED, pattern: null }]);
    const input = el.querySelector('[data-action="ambient"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  test("never renders ticked-but-disabled — a tick means the cue is happening", () => {
    // Reachable when page access is revoked from the browser's own extension
    // settings, which never passes through our revoke handler.
    const el = renderSurfaceList(document, [{ ...BUILT_IN, granted: false, ambient: true }]);
    const input = el.querySelector('[data-action="ambient"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.checked).toBe(false);
  });

  test("origin text is written as text, never parsed as markup", () => {
    const el = renderSurfaceList(document, [
      { ...STORED, origin: "https://corp.example/<img src=x onerror=alert(1)>" },
    ]);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
```

Update the file's existing imports and any existing `SurfaceRow` literals in it to include the three new fields (`builtIn: false`, `pattern: "…"`, `ambient: false`) — the compiler will point at every one.

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun run test -- surfaces-view`
Expected: FAIL — TS errors on the new `SurfaceRow` fields, and no `[data-action="ambient"]` element.

- [ ] **Step 3: Implement the widened row**

In `src/options/surfaces-view.ts`, replace the `SurfaceRow` interface with the one in **Interfaces** above, and add this builder above `renderSurfaceList`:

```ts
/**
 * The per-host ambient switch. Keyed by PATTERN, not origin: two configured
 * origins can share a host (a /jira and a /jenkins on one box), and the cue —
 * like the grant — is a per-host decision, so both rows drive the same switch.
 *
 * Disabled without page access, because the cue is exactly the capability the
 * grant buys: offering the switch on a host we may not read would be offering
 * something that cannot happen.
 */
function ambientToggle(doc: Document, row: SurfaceRow): HTMLLabelElement {
  const label = doc.createElement("label");
  label.className = "surfaces__ambient";

  const disabled = !row.granted || row.pattern === null;

  const input = doc.createElement("input");
  input.type = "checkbox";
  input.dataset["action"] = "ambient";
  input.dataset["pattern"] = row.pattern ?? "";
  // Ticked means "this is happening", never "this is stored". A disabled tick
  // would be ambiguous exactly when it matters — after page access is revoked,
  // is the cue still on? It is not, so it does not show as on. The stored
  // preference is separately cleared on the revoke path (options.ts), so the two
  // cannot disagree; this rule additionally covers a revoke made from the
  // browser's own extension settings, which never reaches our click handler.
  input.checked = row.ambient && !disabled;
  input.disabled = disabled;

  const text = doc.createElement("span");
  text.textContent = "Surface automatically";

  label.append(input, text);
  return label;
}
```

Then, inside the `for` loop of `renderSurfaceList`, replace the `item.append(...)` call with:

```ts
    item.append(
      origin,
      product,
      ambientToggle(doc, row),
      row.granted
        ? button(doc, "revoke", row.origin, "Revoke page access")
        : button(doc, "grant", row.origin, "Grant page access"),
    );
    // Built-in surfaces are recognised without configuration — they are not the
    // user's entries to delete, only to grant or silence.
    if (!row.builtIn) {
      item.append(button(doc, "remove", row.origin, "Remove"));
    }
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun run test -- surfaces-view`
Expected: PASS.

- [ ] **Step 5: Add the row styles**

In `src/options/options.css`, next to the existing `.surfaces__row` rule:

```css
.surfaces__ambient {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.surfaces__ambient input:disabled + span {
  opacity: 0.55;
}
```

- [ ] **Step 6: Run the full suite and commit**

```bash
bun run test && bun run typecheck && bun run lint
git add src/options/surfaces-view.ts src/options/options.css test/unit/surfaces-view.test.ts
git commit -m "feat(options): built-in surface rows and a per-host ambient toggle"
```

---

### Task 4: Wire Options — merged rows, grants for built-ins, the toggle handler

**Files:**
- Modify: `src/options/options.ts` (`surfaceRows` at line 176, `onSurfaceClick` at line 219, the listener registration at line 255)
- Modify: `src/options/options.html` (the copy in `#surfaces-section`, lines 30 and 44)
- Test: `test/unit/options.test.ts`, `test/unit/manifest.test.ts`

**Interfaces:**
- Consumes: `SurfaceRow` (Task 3), `BUILT_IN_SURFACES` (Task 1), `getAmbientHosts` / `setAmbientHost` (Task 2), the existing `hasOrigin` / `requestOrigin` / `removeOrigin` (`src/browser/permissions.ts`).
- Produces: nothing consumed by later tasks. This task closes the C1.4 gap — after it, `github.com` can be granted page access for the first time.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/options.test.ts`:

```ts
describe("built-in surfaces in the list", () => {
  test("built-ins are listed even with no stored origins, so they can be granted at all", async () => {
    harness = installChromeMock();
    document.body.innerHTML = OPTIONS_HTML;
    await bootOptions();
    const text = document.getElementById("surface-list")?.textContent ?? "";
    expect(text).toContain("github.com");
    expect(text).toContain("gitlab.com");
    expect(text).toContain("bitbucket.org");
    expect(text).toContain("*.atlassian.net");
  });

  test("granting a built-in requests exactly its host pattern", async () => {
    harness = installChromeMock();
    document.body.innerHTML = OPTIONS_HTML;
    await bootOptions();
    const grant = [...document.querySelectorAll('[data-action="grant"]')].find((el) =>
      (el as HTMLElement).dataset["origin"]?.includes("github.com"),
    ) as HTMLButtonElement;
    grant.click();
    await flush();
    expect(harness.permissionsRequest).toHaveBeenCalledWith({
      origins: ["https://github.com/*"],
    });
  });

  test("the Jira Cloud row asks for the tenant wildcard", async () => {
    harness = installChromeMock();
    document.body.innerHTML = OPTIONS_HTML;
    await bootOptions();
    const grant = [...document.querySelectorAll('[data-action="grant"]')].find((el) =>
      (el as HTMLElement).dataset["origin"]?.includes("atlassian.net"),
    ) as HTMLButtonElement;
    grant.click();
    await flush();
    expect(harness.permissionsRequest).toHaveBeenCalledWith({
      origins: ["https://*.atlassian.net/*"],
    });
  });
});

describe("the ambient toggle", () => {
  test("checking it stores the pattern", async () => {
    harness = installChromeMock();
    harness.grantedOrigins.add("https://github.com/*");
    document.body.innerHTML = OPTIONS_HTML;
    await bootOptions();
    const toggle = [...document.querySelectorAll('[data-action="ambient"]')].find(
      (el) => (el as HTMLInputElement).dataset["pattern"] === "https://github.com/*",
    ) as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(harness.storage.get("ambient-hosts")).toEqual(["https://github.com/*"]);
  });

  test("revoking page access switches the cue off for that host", async () => {
    harness = installChromeMock();
    harness.grantedOrigins.add("https://github.com/*");
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    document.body.innerHTML = OPTIONS_HTML;
    await bootOptions();
    const revoke = [...document.querySelectorAll('[data-action="revoke"]')].find((el) =>
      (el as HTMLElement).dataset["origin"]?.includes("github.com"),
    ) as HTMLButtonElement;
    revoke.click();
    await flush();
    expect(harness.storage.get("ambient-hosts")).toEqual([]);
  });

  test("a revoke that failed leaves the preference alone", async () => {
    harness = installChromeMock();
    harness.grantedOrigins.add("https://github.com/*");
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.permissionsRemove.mockResolvedValueOnce(false);
    document.body.innerHTML = OPTIONS_HTML;
    await bootOptions();
    const revoke = [...document.querySelectorAll('[data-action="revoke"]')].find((el) =>
      (el as HTMLElement).dataset["origin"]?.includes("github.com"),
    ) as HTMLButtonElement;
    revoke.click();
    await flush();
    expect(harness.storage.get("ambient-hosts")).toEqual(["https://github.com/*"]);
  });

  test("unchecking it removes the pattern", async () => {
    harness = installChromeMock();
    harness.grantedOrigins.add("https://github.com/*");
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    document.body.innerHTML = OPTIONS_HTML;
    await bootOptions();
    const toggle = [...document.querySelectorAll('[data-action="ambient"]')].find(
      (el) => (el as HTMLInputElement).dataset["pattern"] === "https://github.com/*",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(harness.storage.get("ambient-hosts")).toEqual([]);
  });
});
```

Reuse this file's existing bootstrap helpers rather than inventing new ones — it already has a way to load `options.html` into jsdom and fire `DOMContentLoaded` (named `OPTIONS_HTML` / `bootOptions` / `flush` above; match whatever the file actually calls them, and add a small `flush` = `await Promise.resolve()` loop only if none exists).

And add to `test/unit/manifest.test.ts`:

```ts
test("ambient surfacing adds no permission — it rides the existing optional grants", () => {
  const m = composeManifest("chrome", "1.0.0");
  expect(m.permissions).toEqual(["activeTab", "scripting", "storage", "alarms", "contextMenus"]);
  expect(m.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
  expect(m.host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun run test -- options`
Expected: FAIL — built-in hosts are not in the list, no `[data-action="ambient"]` handler.

- [ ] **Step 3: Merge built-ins into the row list**

In `src/options/options.ts`, replace `surfaceRows` (line 176):

```ts
/**
 * Storage is the source of truth for the user's own entries; the browser is the
 * source of truth for grants; the prefs store is for the ambient toggle.
 *
 * Built-ins come FIRST and are always present. Until this existed there was no
 * row for github.com, gitlab.com, bitbucket.org or Jira Cloud — and since the
 * Grant button lives on a row, there was no way to grant page access to them at
 * all. See the design spec's "The prerequisite this slice discovered".
 */
async function surfaceRows(): Promise<SurfaceRow[]> {
  const ambient = await getAmbientHosts();
  const rows: SurfaceRow[] = [];
  for (const surface of BUILT_IN_SURFACES) {
    rows.push({
      origin: surface.label,
      product: surface.product,
      granted: await hasOrigin(surface.pattern),
      builtIn: true,
      pattern: surface.pattern,
      ambient: ambient.includes(surface.pattern),
    });
  }
  for (const entry of await getOrigins()) {
    const pattern = hostPermissionPattern(entry.origin);
    rows.push({
      origin: entry.origin,
      product: entry.product,
      granted: pattern !== null && (await hasOrigin(pattern)),
      builtIn: false,
      pattern,
      ambient: pattern !== null && ambient.includes(pattern),
    });
  }
  return rows;
}
```

Add to the imports at the top of the file:

```ts
import { BUILT_IN_SURFACES } from "../shared/recognise.ts";
import { getAmbientHosts, setAmbientHost } from "../background/ambient-prefs.ts";
```

- [ ] **Step 4: Make grant/revoke work for a built-in row**

`onSurfaceClick` derives its pattern with `hostPermissionPattern(origin)`, which returns `null` for a built-in row's label (`github.com` is not an absolute origin, and `*.atlassian.net` never could be). Replace the pattern lookup at line 229:

```ts
  // A built-in row's `origin` is a display label, not a URL — its pattern comes
  // from the table, not from parsing. Fall back to parsing for the user's own
  // entries, which are always absolute origins.
  const builtIn = BUILT_IN_SURFACES.find((s) => s.label === origin);
  const pattern = builtIn?.pattern ?? hostPermissionPattern(origin);
```

and guard Remove so a built-in can never be deleted, replacing the `if (action === "remove")` branch's first line:

```ts
  if (action === "remove" && builtIn === undefined) {
```

In the `revoke` branch, switch the cue off for that host once the revoke actually
succeeds — inside the existing `if (await removeOrigin(pattern))`, before the
status line:

```ts
      // Page access is what the cue runs on, so revoking it turns the cue off
      // rather than leaving a stored "on" that cannot happen. Without this, a
      // later re-grant would silently resurrect a preference the user last saw
      // being withdrawn.
      await setAmbientHost(pattern, false);
```

- [ ] **Step 5: Handle the toggle**

Add to `src/options/options.ts`, next to `mutateOrigins`:

```ts
/** Serialise prefs writes for the same reason origin writes are serialised: two
 *  toggles flipped in quick succession both read the pre-change list, and the
 *  second write would silently drop the first one's edit. */
let ambientWrites: Promise<void> = Promise.resolve();

function onAmbientChange(event: Event): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.dataset["action"] !== "ambient") {
    return Promise.resolve();
  }
  const pattern = target.dataset["pattern"] ?? "";
  if (pattern === "") {
    return Promise.resolve();
  }
  const on = target.checked;
  ambientWrites = ambientWrites
    .catch(() => undefined)
    .then(async () => {
      await setAmbientHost(pattern, on);
    });
  return ambientWrites;
}
```

and register it in the `DOMContentLoaded` block (line 255), alongside the existing click listener:

```ts
  document
    .getElementById("surface-list")
    ?.addEventListener("change", (event) => void onAmbientChange(event));
```

- [ ] **Step 6: Update the Options copy**

In `src/options/options.html`, replace the paragraph at line 30:

```html
        <p>Nimbus recognises Bitbucket Cloud, GitHub, GitLab and Jira Cloud out of the box — grant page access below to use them. Add self-hosted instances too: include the full URL and any sub-path, e.g. <code>https://corp.example/jira</code>.</p>
```

and the one at line 44:

```html
        <p class="options__status">Granting page access lets Nimbus recognise pages on that site without you opening the panel first. It never changes where Nimbus can send data — that stays your local gateway only. <strong>Surface automatically</strong> goes one step further: on a page Nimbus has indexed, a small cue appears in the corner so you don't have to open the panel to find out. Nothing runs until you click it.</p>
```

- [ ] **Step 7: Run the tests and make sure they pass**

Run: `bun run test -- options` then `bun run test`
Expected: PASS, including the manifest assertion.

- [ ] **Step 8: Commit**

```bash
bun run typecheck && bun run lint
git add src/options/ test/unit/options.test.ts test/unit/manifest.test.ts
git commit -m "fix(options): let the built-in surfaces be granted page access at all"
```

---

### Task 5: The cue view (pure DOM)

**Files:**
- Create: `src/panel/cue-view.ts`
- Modify: `src/shared/types.ts` (add `CueState` near `ToastState`, around line 45)
- Test: `test/unit/cue-view.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface CueState { readonly label: string; readonly ref: string }` — from `src/shared/types.ts`
  - `renderCue(doc: Document, state: CueState): HTMLElement` — from `src/panel/cue-view.ts`

The rendered element carries `[data-action="open"]` and `[data-action="dismiss"]`; Task 6 attaches behaviour.

- [ ] **Step 1: Write the failing test**

Create `test/unit/cue-view.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { renderCue } from "../../src/panel/cue-view.ts";

const STATE = { label: "GitHub PR", ref: "acme/web #482" };

describe("renderCue", () => {
  test("names the surface and the item", () => {
    const el = renderCue(document, STATE);
    expect(el.textContent).toContain("GitHub PR");
    expect(el.textContent).toContain("acme/web #482");
  });

  test("offers exactly one open target and one dismiss target", () => {
    const el = renderCue(document, STATE);
    expect(el.querySelectorAll('[data-action="open"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-action="dismiss"]')).toHaveLength(1);
  });

  test("both controls are real buttons, so keyboard users reach them", () => {
    const el = renderCue(document, STATE);
    for (const node of el.querySelectorAll("[data-action]")) {
      expect(node).toBeInstanceOf(HTMLButtonElement);
      expect((node as HTMLButtonElement).type).toBe("button");
    }
  });

  test("announces politely without stealing focus", () => {
    const el = renderCue(document, STATE);
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.hasAttribute("autofocus")).toBe(false);
  });

  test("the dismiss control has an accessible name, not just a glyph", () => {
    const el = renderCue(document, STATE);
    const dismiss = el.querySelector('[data-action="dismiss"]') as HTMLButtonElement;
    expect(dismiss.getAttribute("aria-label")).toBe("Dismiss");
  });

  test("page-derived text is written as text, never parsed as markup", () => {
    const el = renderCue(document, {
      label: "GitHub PR",
      ref: "<img src=x onerror=alert(1)>",
    });
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun run test -- cue-view`
Expected: FAIL — cannot resolve `src/panel/cue-view.ts`.

- [ ] **Step 3: Add the type**

In `src/shared/types.ts`, after the `ToastState` interface:

```ts
/**
 * What the ambient cue says. Both fields come from the pure recogniser
 * (`Recognition.label` / `.ref`), never from page-controlled DOM — but they are
 * rendered with textContent regardless, because the ref is derived from a URL
 * the page's own history API can write.
 */
export interface CueState {
  readonly label: string;
  readonly ref: string;
}
```

- [ ] **Step 4: Implement the view**

Create `src/panel/cue-view.ts`:

```ts
// Pure DOM builder for the ambient cue. No chrome.*, no listeners, no innerHTML —
// panel-in-page.ts's sibling for a much smaller surface, and the same rule as
// capture/toast-view.ts: build the shell here, attach behaviour at the caller.
import type { CueState } from "../shared/types.ts";

export function renderCue(doc: Document, state: CueState): HTMLElement {
  const el = doc.createElement("div");
  el.className = "nimbus-cue";
  // Polite, so a screen reader mentions it at the next opportunity rather than
  // interrupting — an ambient cue that grabs the announcement queue is no longer
  // ambient.
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");

  const open = doc.createElement("button");
  open.type = "button";
  open.className = "nimbus-cue__open";
  open.dataset["action"] = "open";
  open.setAttribute("aria-label", `Open Nimbus for ${state.label} ${state.ref}`);

  const label = doc.createElement("span");
  label.className = "nimbus-cue__label";
  label.textContent = state.label;

  const ref = doc.createElement("span");
  ref.className = "nimbus-cue__ref";
  ref.textContent = state.ref;

  open.append(label, ref);

  const dismiss = doc.createElement("button");
  dismiss.type = "button";
  dismiss.className = "nimbus-cue__dismiss";
  dismiss.dataset["action"] = "dismiss";
  dismiss.textContent = "✕";
  dismiss.setAttribute("aria-label", "Dismiss");

  el.append(open, dismiss);
  return el;
}
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `bun run test -- cue-view`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run typecheck && bun run lint
git add src/panel/cue-view.ts src/shared/types.ts test/unit/cue-view.test.ts
git commit -m "feat(panel): the ambient cue's pure view"
```

---

### Task 6: The injected cue + build wiring

**Files:**
- Create: `src/panel/cue-in-page.ts`
- Modify: `esbuild.mjs` (the `ENTRIES` array, line 24-31)
- Modify: `scripts/check-build.mjs` (`REQUIRED_FILES`, line 14-27)
- Test: `test/unit/cue-in-page.test.ts`, `test/unit/store-tooling.test.ts` (only if it asserts the entry list — check first)

**Interfaces:**
- Consumes: `renderCue`, `CueState` (Task 5).
- Produces: `globalThis.__nimbusCue(state: CueState): void`, injected as `dist/<target>/cue.js`. Task 10 calls it.

The cue script sends `{ kind: "cue-open" }` when opened — that message is added in Task 7; this task can be written against it because `ExtensionRequest` grows there. **Do Task 7 first if the compiler complains**; the two are ordered this way only because the DOM behaviour is easier to review on its own.

- [ ] **Step 1: Write the failing test**

Create `test/unit/cue-in-page.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CueState } from "../../src/shared/types.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

const STATE: CueState = { label: "GitHub PR", ref: "acme/web #482" };

interface CueGlobal {
  __nimbusCue?: (state: CueState) => void;
}

let harness: ChromeHarness;

async function loadCue(): Promise<(state: CueState) => void> {
  vi.resetModules();
  await import("../../src/panel/cue-in-page.ts");
  const fn = (globalThis as CueGlobal).__nimbusCue;
  if (fn === undefined) {
    throw new Error("cue script did not define __nimbusCue");
  }
  return fn;
}

function cueEl(): Element | null {
  const host = document.getElementById("nimbus-cue-host");
  return host?.shadowRoot?.querySelector(".nimbus-cue") ?? null;
}

beforeEach(() => {
  harness = installChromeMock();
  document.body.innerHTML = "";
  document.documentElement.querySelectorAll("#nimbus-cue-host").forEach((n) => n.remove());
});
afterEach(() => {
  harness.restore();
  vi.useRealTimers();
});

describe("the injected cue", () => {
  test("mounts inside a shadow root and names the item", async () => {
    const show = await loadCue();
    show(STATE);
    expect(cueEl()?.textContent).toContain("acme/web #482");
  });

  test("does not mount while the panel is already open on this page", async () => {
    const panel = document.createElement("div");
    panel.id = "nimbus-related-host";
    document.documentElement.append(panel);
    const show = await loadCue();
    show(STATE);
    expect(document.getElementById("nimbus-cue-host")).toBeNull();
  });

  test("clicking it asks the worker to open the panel, then removes itself", async () => {
    const show = await loadCue();
    show(STATE);
    const open = cueEl()?.querySelector('[data-action="open"]') as HTMLButtonElement;
    open.click();
    await Promise.resolve();
    expect(harness.sendMessage).toHaveBeenCalledWith({ kind: "cue-open" });
    expect(document.getElementById("nimbus-cue-host")).toBeNull();
  });

  test("dismissing removes it without messaging the worker — the tab memory already holds", async () => {
    const show = await loadCue();
    show(STATE);
    const dismiss = cueEl()?.querySelector('[data-action="dismiss"]') as HTMLButtonElement;
    dismiss.click();
    expect(document.getElementById("nimbus-cue-host")).toBeNull();
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  test("retracts itself when the page navigates to something else", async () => {
    vi.useFakeTimers();
    const show = await loadCue();
    show(STATE);
    expect(cueEl()).not.toBeNull();
    window.history.pushState({}, "", "/acme/web/pull/517");
    vi.advanceTimersByTime(600);
    expect(document.getElementById("nimbus-cue-host")).toBeNull();
  });

  test("retracts itself when the panel is opened by any other route", async () => {
    vi.useFakeTimers();
    const show = await loadCue();
    show(STATE);
    expect(cueEl()).not.toBeNull();
    // The hotkey, the popup button and the context menu all inject the panel
    // without going through the cue — from in here, all three look like this.
    const panel = document.createElement("div");
    panel.id = "nimbus-related-host";
    document.documentElement.append(panel);
    vi.advanceTimersByTime(600);
    expect(document.getElementById("nimbus-cue-host")).toBeNull();
  });

  test("a second call replaces the first cue rather than stacking a second one", async () => {
    const show = await loadCue();
    show(STATE);
    show({ label: "GitHub PR", ref: "acme/web #517" });
    expect(document.querySelectorAll("#nimbus-cue-host")).toHaveLength(1);
    expect(cueEl()?.textContent).toContain("#517");
  });

  test("a host planted by the page is replaced, never written into", async () => {
    const planted = document.createElement("div");
    planted.id = "nimbus-cue-host";
    planted.attachShadow({ mode: "open" });
    document.documentElement.append(planted);
    const show = await loadCue();
    show(STATE);
    const host = document.getElementById("nimbus-cue-host");
    expect(host).not.toBe(planted);
    expect(host?.shadowRoot?.querySelector(".nimbus-cue")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun run test -- cue-in-page`
Expected: FAIL — cannot resolve `src/panel/cue-in-page.ts`.

- [ ] **Step 3: Implement the injected cue**

Create `src/panel/cue-in-page.ts`:

```ts
// Injected as dist/<target>/cue.js. Defines globalThis.__nimbusCue(state); the
// SW calls it after injecting this file (two-step, like toast.js and capture.js).
//
// Host trust, same rule as toast-in-page.ts: a hostile page can pre-plant a
// <div id="nimbus-cue-host">, with no shadow root or with its own open one, so we
// only ever reuse a host THIS module created. Anything else found there is
// removed and replaced.
import { sendMessage } from "../browser/runtime.ts";
import type { CueState } from "../shared/types.ts";
import { renderCue } from "./cue-view.ts";

const HOST_ID = "nimbus-cue-host";
/** The panel's own host. If it is mounted, the cue has nothing to add. */
const PANEL_HOST_ID = "nimbus-related-host";
/** How often the mounted cue checks whether the tab moved on. Matches the
 *  panel's NAV_CHECK_MS: SPA navigations fire no load event, and a cue left
 *  naming the page you just left is the defect the panel-page-context slice
 *  (2026-08-11) existed to fix. */
const NAV_CHECK_MS = 500;

const STYLES = `
/* The host sits in the page's flow; only the cue inside it is interactive, so
   the page underneath stays clickable everywhere the cue is not. */
:host { all: initial; pointer-events: none; }
.nimbus-cue {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2147483647;
  pointer-events: auto;
  display: flex;
  align-items: stretch;
  max-width: 320px;
  border-radius: 10px;
  overflow: hidden;
  font-family: system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.3;
  color: #ffffff;
  background: #275fd4;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
}
.nimbus-cue__open,
.nimbus-cue__dismiss {
  appearance: none;
  border: 0;
  margin: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.nimbus-cue__open {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  padding: 9px 12px;
  text-align: left;
  min-width: 0;
}
.nimbus-cue__label { opacity: 0.85; font-size: 12px; }
.nimbus-cue__ref { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
.nimbus-cue__dismiss { padding: 0 12px; opacity: 0.8; }
.nimbus-cue__dismiss:hover { opacity: 1; }
`;

interface CueHost extends HTMLElement {
  __nimbusNavTimer?: ReturnType<typeof setInterval>;
}

// The one host this module created (module scope — unreachable from the page).
let ownHost: CueHost | null = null;

function teardown(): void {
  if (ownHost === null) {
    return;
  }
  if (ownHost.__nimbusNavTimer !== undefined) {
    clearInterval(ownHost.__nimbusNavTimer);
  }
  ownHost.remove();
  ownHost = null;
}

function show(state: CueState): void {
  // The panel is the fuller answer to the same question. If it is already open,
  // a cue pointing at it is noise.
  if (document.getElementById(PANEL_HOST_ID) !== null) {
    return;
  }
  teardown();
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement("div") as CueHost;
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  root.append(style);

  const el = renderCue(document, state);
  el.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const action = target.closest("[data-action]");
    if (!(action instanceof HTMLElement)) {
      return;
    }
    if (action.dataset["action"] === "open") {
      // Fire-and-forget: the worker injects the panel, and a rejection here has
      // nowhere to be reported (noConsole, and this is someone else's page).
      void sendMessage({ kind: "cue-open" }).catch(() => undefined);
    }
    // Both actions retire the cue. Dismissal needs no message: the worker
    // already recorded this item as cued for this tab when it mounted, which is
    // exactly the suppression the design asks for — "quiet for this item, in
    // this tab, until you navigate to a different item".
    teardown();
  });
  root.append(el);

  document.documentElement.append(host);
  ownHost = host;

  const mountedAt = window.location.href;
  host.__nimbusNavTimer = setInterval(() => {
    // Two ways the cue stops being the right thing on screen. The page moved on
    // — a cue naming the page you just left is the 2026-08-11 defect. Or the
    // panel opened without us: the hotkey, the popup button and the context menu
    // all inject it directly, and the mount-time check above cannot see a panel
    // that arrives later. Leaving both up would be two surfaces answering the
    // same question, one of them redundantly.
    if (window.location.href !== mountedAt || document.getElementById(PANEL_HOST_ID) !== null) {
      teardown();
    }
  }, NAV_CHECK_MS);
}

(globalThis as unknown as { __nimbusCue?: (s: CueState) => void }).__nimbusCue = show;
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun run test -- cue-in-page`
Expected: PASS. If `sendMessage({ kind: "cue-open" })` fails to typecheck, do Task 7 now and come back.

- [ ] **Step 5: Register the new bundle**

In `esbuild.mjs`, add to `ENTRIES`:

```js
  { in: "src/panel/cue-in-page.ts", out: "cue" },
```

In `scripts/check-build.mjs`, add to `REQUIRED_FILES` after `"panel.js"`:

```js
  "cue.js",
```

- [ ] **Step 6: Verify the build produces it**

Run: `bun run build && bun run check-build`
Expected: PASS, and `dist/chrome/cue.js` + `dist/firefox/cue.js` exist.

- [ ] **Step 7: Commit**

```bash
bun run test && bun run typecheck && bun run lint
git add src/panel/cue-in-page.ts esbuild.mjs scripts/check-build.mjs test/unit/cue-in-page.test.ts
git commit -m "feat(panel): the injected ambient cue"
```

---

### Task 7: The `cue-open` message

**Files:**
- Modify: `src/shared/messages.ts` (add the interface near `ResolveRequest` at line 65, the union member at line 126, and the guard near `isResolveRequest` at line 295)
- Test: `test/unit/messages.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface CueOpenRequest { readonly kind: "cue-open" }`
  - `isCueOpenRequest(v: unknown): v is CueOpenRequest`
  - `CueOpenRequest` joins the `ExtensionRequest` union.

No response type: the worker answers with the existing panel injection, and the cue does not wait on it.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/messages.test.ts`:

```ts
describe("isCueOpenRequest", () => {
  test("accepts the envelope the cue sends", () => {
    expect(isCueOpenRequest({ kind: "cue-open" })).toBe(true);
  });

  test("rejects other kinds, non-objects and null", () => {
    expect(isCueOpenRequest({ kind: "resolve", pageUrl: "https://x/" })).toBe(false);
    expect(isCueOpenRequest("cue-open")).toBe(false);
    expect(isCueOpenRequest(null)).toBe(false);
    expect(isCueOpenRequest(undefined)).toBe(false);
  });

  test("carries no page-supplied payload — there is nothing for a hostile page to forge", () => {
    expect(Object.keys({ kind: "cue-open" } satisfies CueOpenRequest)).toEqual(["kind"]);
  });
});
```

Add `isCueOpenRequest` and `type CueOpenRequest` to that file's existing imports.

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun run test -- messages`
Expected: FAIL — `isCueOpenRequest` is not exported.

- [ ] **Step 3: Implement**

In `src/shared/messages.ts`, after `ResolveRequest`:

```ts
/**
 * The ambient cue asking for the panel on the tab it is mounted in.
 *
 * Carries NO payload on purpose. The cue runs in the page, so anything it sent
 * would be attacker-controllable on a hostile site; the worker instead uses the
 * sender's own tab, which the browser supplies and the page cannot forge.
 */
export interface CueOpenRequest {
  readonly kind: "cue-open";
}
```

Add `| CueOpenRequest` to the `ExtensionRequest` union, and next to `isResolveRequest`:

```ts
export function isCueOpenRequest(v: unknown): v is CueOpenRequest {
  return isObject(v) && v["kind"] === "cue-open";
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun run test -- messages` then `bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run typecheck && bun run lint
git add src/shared/messages.ts test/unit/messages.test.ts
git commit -m "feat(shared): a cue-open message with no page-supplied payload"
```

---

### Task 8: The tab navigation seam

**Files:**
- Modify: `src/browser/tabs.ts`
- Modify: `test/unit/helpers/chrome-mock.ts` (add tabs listeners, `tabsGet`, and emitters)
- Test: `test/unit/browser-seam.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/browser/tabs.ts`:
  - `interface TabNavigation { readonly tabId: number; readonly url: string; readonly active: boolean }`
  - `addNavigationListener(fn: (nav: TabNavigation) => void): void`
  - `addTabClosedListener(fn: (tabId: number) => void): void`
  - `tabUrl(tabId: number): Promise<string | null>` — `null` when the tab is gone or its URL is not visible to us

New harness members: `tabsGet`, `tabsUpdatedListeners`, `tabsRemovedListeners`, `emitTabUpdated(tabId, changeInfo, tab)`, `emitTabRemoved(tabId)`.

- [ ] **Step 1: Extend the chrome mock**

In `test/unit/helpers/chrome-mock.ts`, add to the `ChromeHarness` interface:

```ts
  readonly tabsGet: ReturnType<typeof vi.fn>;
  readonly tabsUpdatedListeners: Array<
    (tabId: number, changeInfo: { url?: string }, tab: { active?: boolean }) => void
  >;
  readonly tabsRemovedListeners: Array<(tabId: number) => void>;
  /** Fire a tab update through every registered listener. */
  emitTabUpdated(tabId: number, changeInfo: { url?: string }, tab: { active?: boolean }): void;
  /** Fire a tab removal through every registered listener. */
  emitTabRemoved(tabId: number): void;
```

and, in the fake `chrome.tabs` object, alongside the existing `query`:

```ts
      get: tabsGet,
      onUpdated: { addListener: (fn: never) => void tabsUpdatedListeners.push(fn) },
      onRemoved: { addListener: (fn: never) => void tabsRemovedListeners.push(fn) },
```

backed by, next to the other `vi.fn()` declarations:

```ts
  const tabsUpdatedListeners: ChromeHarness["tabsUpdatedListeners"] = [];
  const tabsRemovedListeners: ChromeHarness["tabsRemovedListeners"] = [];
  const tabsGet = vi.fn(async (_id: number) => ({ url: "https://github.com/acme/web/pull/482" }));
```

and the emitters on the returned harness:

```ts
    emitTabUpdated: (tabId, changeInfo, tab) => {
      for (const fn of tabsUpdatedListeners) fn(tabId, changeInfo, tab);
    },
    emitTabRemoved: (tabId) => {
      for (const fn of tabsRemovedListeners) fn(tabId);
    },
```

Match the file's existing declaration style; the shape above is what later tasks call.

- [ ] **Step 2: Write the failing test**

Add to `test/unit/browser-seam.test.ts`:

```ts
describe("browser/tabs navigation seam", () => {
  test("a URL change on an active tab reaches the listener", () => {
    harness = installChromeMock();
    const seen: TabNavigation[] = [];
    addNavigationListener((nav) => seen.push(nav));
    harness.emitTabUpdated(7, { url: "https://github.com/acme/web/pull/482" }, { active: true });
    expect(seen).toEqual([
      { tabId: 7, url: "https://github.com/acme/web/pull/482", active: true },
    ]);
  });

  test("an update with no url is not a navigation and is dropped", () => {
    harness = installChromeMock();
    const seen: TabNavigation[] = [];
    addNavigationListener((nav) => seen.push(nav));
    // The browser omits changeInfo.url for hosts we hold no permission on — the
    // permission boundary is enforced here, by the browser, not by our own check.
    harness.emitTabUpdated(7, {}, { active: true });
    harness.emitTabUpdated(7, { url: undefined }, { active: true });
    expect(seen).toEqual([]);
  });

  test("an inactive tab is reported as inactive rather than dropped here", () => {
    harness = installChromeMock();
    const seen: TabNavigation[] = [];
    addNavigationListener((nav) => seen.push(nav));
    harness.emitTabUpdated(7, { url: "https://github.com/x" }, { active: false });
    expect(seen[0]?.active).toBe(false);
  });

  test("a missing active flag is treated as inactive, never assumed active", () => {
    harness = installChromeMock();
    const seen: TabNavigation[] = [];
    addNavigationListener((nav) => seen.push(nav));
    harness.emitTabUpdated(7, { url: "https://github.com/x" }, {});
    expect(seen[0]?.active).toBe(false);
  });

  test("tab closure reaches its listener", () => {
    harness = installChromeMock();
    const closed: number[] = [];
    addTabClosedListener((tabId) => closed.push(tabId));
    harness.emitTabRemoved(7);
    expect(closed).toEqual([7]);
  });

  test("tabUrl returns the tab's url", async () => {
    harness = installChromeMock();
    harness.tabsGet.mockResolvedValueOnce({ url: "https://github.com/acme/web/pull/517" });
    expect(await tabUrl(7)).toBe("https://github.com/acme/web/pull/517");
  });

  test("tabUrl is null for a tab that has gone away", async () => {
    harness = installChromeMock();
    harness.tabsGet.mockRejectedValueOnce(new Error("No tab with id: 7"));
    expect(await tabUrl(7)).toBeNull();
  });

  test("tabUrl is null when the url is not visible to us", async () => {
    harness = installChromeMock();
    harness.tabsGet.mockResolvedValueOnce({});
    expect(await tabUrl(7)).toBeNull();
  });
});
```

Import `addNavigationListener`, `addTabClosedListener`, `tabUrl` and `type TabNavigation` from `../../src/browser/tabs.ts`.

- [ ] **Step 3: Run it to make sure it fails**

Run: `bun run test -- browser-seam`
Expected: FAIL — those exports do not exist.

- [ ] **Step 4: Implement the seam**

Append to `src/browser/tabs.ts`:

```ts
/** A tab arriving at a new URL. `active` is the tab's own flag at event time. */
export interface TabNavigation {
  readonly tabId: number;
  readonly url: string;
  readonly active: boolean;
}

/**
 * Every navigation the extension is ALLOWED to see.
 *
 * The permission boundary is the browser's, not ours: `changeInfo.url` is
 * populated only for tabs we hold host permission on, so a page on an ungranted
 * host never reaches this callback at all. The ambient gate's own granted-check
 * is the second lock, not the first.
 *
 * Fires for history-API navigations too, which is what makes an SPA (GitHub,
 * GitLab, Jira) reach the callback without a page load.
 */
export function addNavigationListener(fn: (nav: TabNavigation) => void): void {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo.url;
    if (typeof url !== "string" || url === "") {
      return;
    }
    fn({ tabId, url, active: tab.active === true });
  });
}

export function addTabClosedListener(fn: (tabId: number) => void): void {
  chrome.tabs.onRemoved.addListener((tabId) => fn(tabId));
}

/**
 * The tab's CURRENT url, or null when the tab is gone or its url is not visible
 * to us. Null is a normal answer, not an error: it is exactly what a tab closed
 * mid-resolve looks like.
 */
export async function tabUrl(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return typeof tab.url === "string" && tab.url !== "" ? tab.url : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `bun run test -- browser-seam`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run typecheck && bun run lint
git add src/browser/tabs.ts test/unit/helpers/chrome-mock.ts test/unit/browser-seam.test.ts
git commit -m "feat(browser): a tab navigation seam over chrome.tabs"
```

---

### Task 9: The ambient decision module

**Files:**
- Create: `src/background/ambient.ts`
- Test: `test/unit/ambient.test.ts`

**Interfaces:**
- Consumes: `recognise`, `sameItem` (`src/shared/recognise.ts`), `ResolveResponse` (`src/shared/messages.ts`), `Recognition`, `CueState`, `ConfiguredOrigin` (`src/shared/types.ts`), `TabNavigation` (Task 8), `isAmbientUrl` (Task 2).
- Produces:
  ```ts
  export type AmbientSkip =
    | "inactive-tab" | "not-enabled" | "unrecognised" | "already-cued"
    | "tab-gone" | "navigated" | "no-item";

  export type AmbientDecision =
    | { readonly kind: "show"; readonly cue: CueState; readonly recognition: Recognition }
    | { readonly kind: "none"; readonly why: AmbientSkip };

  export interface AmbientDeps {
    readonly enabledHosts: () => Promise<string[]>;
    readonly getOrigins: () => Promise<ConfiguredOrigin[]>;
    readonly lastCued: (tabId: number) => Recognition | undefined;
    readonly resolve: (pageUrl: string) => Promise<ResolveResponse>;
    readonly currentUrl: (tabId: number) => Promise<string | null>;
  }

  export function decideAmbient(
    deps: AmbientDeps,
    nav: TabNavigation,
  ): Promise<AmbientDecision>;
  ```

`why` exists for the tests, not for logging — `noConsole` applies in `src/`. This is where the feature's behaviour lives; Task 10 is only wiring.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/ambient.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { type AmbientDeps, decideAmbient } from "../../src/background/ambient.ts";
import type { ResolveResponse } from "../../src/shared/messages.ts";
import { recognise } from "../../src/shared/recognise.ts";
import type { Recognition } from "../../src/shared/types.ts";

const PR = "https://github.com/acme/web/pull/482";
const PR_FILES = "https://github.com/acme/web/pull/482/files";
const OTHER_PR = "https://github.com/acme/web/pull/517";
const GITHUB = "https://github.com/*";

const FOUND: ResolveResponse = {
  kind: "resolve",
  ok: true,
  recognition: recognise(PR, []),
  outcome: {
    kind: "found",
    item: {
      id: "gh:acme/web#482",
      service: "github",
      type: "pr",
      title: "Fix the flush",
      url: PR,
      modifiedAt: 1_700_000_000_000,
    },
    matchKind: "exact",
  },
};

function deps(over: Partial<AmbientDeps> = {}): AmbientDeps {
  return {
    enabledHosts: async () => [GITHUB],
    getOrigins: async () => [],
    lastCued: () => undefined,
    resolve: async () => FOUND,
    currentUrl: async () => PR,
    ...over,
  };
}

const NAV = { tabId: 7, url: PR, active: true };

describe("the gate before the gateway call", () => {
  test("a resolved page on an enabled host shows the cue", async () => {
    const d = await decideAmbient(deps(), NAV);
    expect(d).toEqual({
      kind: "show",
      cue: { label: "GitHub PR", ref: "acme/web #482" },
      recognition: recognise(PR, []),
    });
  });

  test("an inactive tab never costs a resolve", async () => {
    const resolve = vi.fn();
    const d = await decideAmbient(deps({ resolve }), { ...NAV, active: false });
    expect(d).toEqual({ kind: "none", why: "inactive-tab" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("a host that is not switched on never costs a resolve", async () => {
    const resolve = vi.fn();
    const d = await decideAmbient(deps({ enabledHosts: async () => [], resolve }), NAV);
    expect(d).toEqual({ kind: "none", why: "not-enabled" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("an unrecognised path on an enabled host never costs a resolve", async () => {
    const resolve = vi.fn();
    const d = await decideAmbient(deps({ resolve }), {
      ...NAV,
      url: "https://github.com/acme/web/issues",
    });
    expect(d).toEqual({ kind: "none", why: "unrecognised" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("a self-hosted instance is recognised from the user's own origins", async () => {
    const d = await decideAmbient(
      deps({
        enabledHosts: async () => ["https://corp.example/*"],
        getOrigins: async () => [{ origin: "https://corp.example/jira", product: "jira" }],
        currentUrl: async () => "https://corp.example/jira/browse/ABC-1",
      }),
      { tabId: 7, url: "https://corp.example/jira/browse/ABC-1", active: true },
    );
    expect(d.kind).toBe("show");
  });
});

describe("the per-tab dedupe", () => {
  test("the same item already cued in this tab is not cued again", async () => {
    const resolve = vi.fn();
    const d = await decideAmbient(deps({ lastCued: () => recognise(PR, []), resolve }), NAV);
    expect(d).toEqual({ kind: "none", why: "already-cued" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("a different sub-tab of the same PR is the same item, not a new one", async () => {
    const d = await decideAmbient(deps({ lastCued: () => recognise(PR, []) }), {
      ...NAV,
      url: PR_FILES,
    });
    expect(d).toEqual({ kind: "none", why: "already-cued" });
  });

  test("a different PR in the same tab is cued", async () => {
    const d = await decideAmbient(
      deps({ lastCued: () => recognise(OTHER_PR, []), currentUrl: async () => PR }),
      NAV,
    );
    expect(d.kind).toBe("show");
  });
});

describe("the resolve outcomes", () => {
  const outcomes: Array<[string, ResolveResponse]> = [
    [
      "not indexed",
      { kind: "resolve", ok: true, recognition: recognise(PR, []), outcome: { kind: "not-indexed", fetchable: true } },
    ],
    [
      "unresolvable",
      { kind: "resolve", ok: true, recognition: recognise(PR, []), outcome: { kind: "unresolvable", fetchable: false } },
    ],
    [
      "ambiguous",
      {
        kind: "resolve",
        ok: true,
        recognition: recognise(PR, []),
        outcome: { kind: "ambiguous", fetchable: false, candidates: [], truncated: false },
      },
    ],
    ["not paired", { kind: "resolve", ok: false, recognition: recognise(PR, []), reason: "not_paired" }],
    ["unauthorized", { kind: "resolve", ok: false, recognition: recognise(PR, []), reason: "unauthorized" }],
    [
      "insufficient scope",
      { kind: "resolve", ok: false, recognition: recognise(PR, []), reason: "insufficient_scope" },
    ],
    ["unsupported", { kind: "resolve", ok: false, recognition: recognise(PR, []), reason: "unsupported" }],
    ["unreachable", { kind: "resolve", ok: false, recognition: recognise(PR, []), reason: "unreachable" }],
    ["server error", { kind: "resolve", ok: false, recognition: recognise(PR, []), reason: "server_error" }],
  ];

  for (const [name, response] of outcomes) {
    test(`${name} is silence, never a cue and never an error surface`, async () => {
      const d = await decideAmbient(deps({ resolve: async () => response }), NAV);
      expect(d).toEqual({ kind: "none", why: "no-item" });
    });
  }

  test("a resolve that throws is silence too", async () => {
    const d = await decideAmbient(
      deps({
        resolve: async () => {
          throw new Error("storage exploded");
        },
      }),
      NAV,
    );
    expect(d).toEqual({ kind: "none", why: "no-item" });
  });
});

describe("the preconditions re-checked after the resolve", () => {
  test("a tab closed mid-resolve is not cued", async () => {
    const d = await decideAmbient(deps({ currentUrl: async () => null }), NAV);
    expect(d).toEqual({ kind: "none", why: "tab-gone" });
  });

  test("a tab moved to a different item mid-resolve is not cued", async () => {
    const d = await decideAmbient(deps({ currentUrl: async () => OTHER_PR }), NAV);
    expect(d).toEqual({ kind: "none", why: "navigated" });
  });

  test("a move to a different sub-tab of the SAME item still cues", async () => {
    const d = await decideAmbient(deps({ currentUrl: async () => PR_FILES }), NAV);
    expect(d.kind).toBe("show");
  });

  test("a tab that went somewhere unrecognised mid-resolve is not cued", async () => {
    const d = await decideAmbient(deps({ currentUrl: async () => "https://example.com/" }), NAV);
    expect(d).toEqual({ kind: "none", why: "navigated" });
  });

  test("active is NOT re-checked — a cue waiting in a tab you return to is the point", async () => {
    // The tab was active when the navigation fired; whether it still is when the
    // resolve lands is deliberately not consulted.
    const d = await decideAmbient(deps(), NAV);
    expect(d.kind).toBe("show");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun run test -- ambient.test`
Expected: FAIL — cannot resolve `src/background/ambient.ts`.

- [ ] **Step 3: Implement the decision module**

Create `src/background/ambient.ts`:

```ts
// The ambient cue's whole decision, in one pure module with injected deps.
//
// Pure so the behaviour is testable without a browser: every branch below is a
// row in ambient.test.ts. service-worker.ts supplies the real deps and does the
// injecting; it makes no decisions of its own.
//
// THE RULE THIS MODULE ENFORCES: the cue appears only when there is a real
// answer behind it. Every other path is silence — never an error surface, never
// a cue that leads nowhere. See the design spec's "Error handling".
import type { ResolveResponse } from "../shared/messages.ts";
import { recognise, sameItem } from "../shared/recognise.ts";
import type { ConfiguredOrigin, CueState, Recognition } from "../shared/types.ts";
import type { TabNavigation } from "../browser/tabs.ts";
import { isAmbientUrl } from "./ambient-prefs.ts";

/** Why no cue. Exists for the tests; never logged (noConsole applies in src/). */
export type AmbientSkip =
  | "inactive-tab"
  | "not-enabled"
  | "unrecognised"
  | "already-cued"
  | "tab-gone"
  | "navigated"
  | "no-item";

export type AmbientDecision =
  | { readonly kind: "show"; readonly cue: CueState; readonly recognition: Recognition }
  | { readonly kind: "none"; readonly why: AmbientSkip };

export interface AmbientDeps {
  /** Host permission patterns the user switched the cue on for. */
  readonly enabledHosts: () => Promise<string[]>;
  readonly getOrigins: () => Promise<ConfiguredOrigin[]>;
  /** The item last cued in this tab, if any — the per-tab dedupe memory. */
  readonly lastCued: (tabId: number) => Recognition | undefined;
  readonly resolve: (pageUrl: string) => Promise<ResolveResponse>;
  /** The tab's url RIGHT NOW; null when it is gone or invisible to us. */
  readonly currentUrl: (tabId: number) => Promise<string | null>;
}

const NONE = (why: AmbientSkip): AmbientDecision => ({ kind: "none", why });

export async function decideAmbient(
  deps: AmbientDeps,
  nav: TabNavigation,
): Promise<AmbientDecision> {
  // Cheapest gates first, and every one of them ahead of the gateway call: the
  // ordering is the cost model. A background tab or a switched-off host must
  // never reach the network.
  if (!nav.active) {
    return NONE("inactive-tab");
  }
  if (!isAmbientUrl(nav.url, await deps.enabledHosts())) {
    return NONE("not-enabled");
  }
  const origins = await deps.getOrigins();
  const recognition = recognise(nav.url, origins);
  if (!recognition.ok) {
    return NONE("unrecognised");
  }
  const previous = deps.lastCued(nav.tabId);
  if (previous !== undefined && sameItem(previous, recognition)) {
    // Same item, this tab — whether it was clicked, dismissed or ignored. It
    // stays quiet until the tab moves to a DIFFERENT item, which is what
    // `sameItem` (product + kind + ref) measures: a PR's Files sub-tab is the
    // same item as its Conversation sub-tab, and re-cueing on a sub-tab switch
    // is exactly the nagging this rule exists to prevent.
    return NONE("already-cued");
  }

  let response: ResolveResponse;
  try {
    response = await deps.resolve(recognition.resolveUrl);
  } catch {
    // A throw here is the route's own failure (a storage read, a malformed
    // reply). The ambient path treats it like any other non-answer.
    return NONE("no-item");
  }
  if (!response.ok || response.outcome.kind !== "found") {
    // not-indexed, unresolvable, ambiguous, and every ResolveError — all
    // silence. An ambient surface has no standing to report our problems on a
    // page the user is reading; the panel, which they opened, is where errors
    // get spoken.
    return NONE("no-item");
  }

  // The resolve took up to RESOLVE_TIMEOUT_MS. `found` is not on its own
  // permission to mount — re-check the page is still the one we asked about.
  const nowUrl = await deps.currentUrl(nav.tabId);
  if (nowUrl === null) {
    return NONE("tab-gone");
  }
  if (!sameItem(recognise(nowUrl, origins), recognition)) {
    return NONE("navigated");
  }
  // Deliberately NOT re-checked: whether the tab is still active. That test's
  // job is to stop background tabs costing resolves, and it already did it
  // above; re-applying it here would turn "switched tabs for four seconds" into
  // no cue at all, permanently.
  return {
    kind: "show",
    cue: { label: recognition.label, ref: recognition.ref },
    recognition,
  };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun run test -- ambient.test`
Expected: PASS — all of them, including every resolve-outcome row.

- [ ] **Step 5: Commit**

```bash
bun run typecheck && bun run lint
git add src/background/ambient.ts test/unit/ambient.test.ts
git commit -m "feat(background): the ambient cue's decision, pure and tested"
```

---

### Task 10: Wire the service worker

**Files:**
- Modify: `src/background/service-worker.ts` (imports at lines 6-70, the message listener at line 398, and a new ambient block near the command listener at line 543)
- Modify: `src/browser/scripting.ts` (add `showCue`)
- Test: `test/unit/service-worker.test.ts`, `test/unit/browser-seam.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-9.
- Produces: no new exports. After this task the feature works end to end.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/browser-seam.test.ts`:

```ts
test("showCue injects cue.js then calls its global with the state", async () => {
  harness = installChromeMock();
  await showCue(7, { label: "GitHub PR", ref: "acme/web #482" });
  expect(harness.executeScript).toHaveBeenNthCalledWith(1, {
    target: { tabId: 7 },
    files: ["cue.js"],
  });
  const second = harness.executeScript.mock.calls[1]?.[0] as { args?: unknown[] };
  expect(second.args).toEqual([{ label: "GitHub PR", ref: "acme/web #482" }]);
});
```

Add to `test/unit/service-worker.test.ts`:

```ts
describe("ambient surfacing", () => {
  test("a navigation to a resolved page on an enabled host mounts the cue", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.grantedOrigins.add("https://github.com/*");
    await loadWorker();
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    const files = harness.executeScript.mock.calls.map((c) => (c[0] as { files?: string[] }).files);
    expect(files).toContainEqual(["cue.js"]);
  });

  test("a navigation on a host that is not switched on injects nothing", async () => {
    await loadWorker();
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    expect(harness.executeScript).not.toHaveBeenCalled();
  });

  test("the same item twice in one tab injects the cue once", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    await loadWorker();
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    harness.emitTabUpdated(7, { url: `${PR_URL}/files` }, { active: true });
    await settleAmbient();
    const cueInjections = harness.executeScript.mock.calls.filter(
      (c) => (c[0] as { files?: string[] }).files?.[0] === "cue.js",
    );
    expect(cueInjections).toHaveLength(1);
  });

  test("closing the tab forgets it, so returning to the same PR cues again", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    await loadWorker();
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    harness.emitTabRemoved(7);
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    const cueInjections = harness.executeScript.mock.calls.filter(
      (c) => (c[0] as { files?: string[] }).files?.[0] === "cue.js",
    );
    expect(cueInjections).toHaveLength(2);
  });

  test("a run overtaken by a newer navigation in the same tab drops its result", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    await loadWorker();
    // Hold the first resolve open past the second navigation, so the two runs
    // genuinely overlap rather than merely being scheduled apart.
    let release: (() => void) | undefined;
    harness.holdNextResolve(new Promise<void>((r) => (release = r)));
    harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    await settleAmbient();
    harness.emitTabUpdated(7, { url: OTHER_PR_URL }, { active: true });
    await settleAmbient();
    release?.();
    await settleAmbient();
    const cued = harness.executeScript.mock.calls.filter(
      (c) => (c[0] as { files?: string[] }).files?.[0] === "cue.js",
    );
    // Exactly one cue, and it is the newer page's.
    expect(cued).toHaveLength(1);
  });

  test("an injection failure on a restricted page is swallowed, not thrown", async () => {
    harness.storage.set("ambient-hosts", ["https://github.com/*"]);
    harness.executeScript.mockRejectedValue(new Error("Cannot access contents of the page"));
    await loadWorker();
    expect(() => {
      harness.emitTabUpdated(7, { url: PR_URL }, { active: true });
    }).not.toThrow();
    await settleAmbient();
  });

  test("cue-open injects the panel into the sender's own tab", async () => {
    await loadWorker();
    await harness.emitMessageFromTab({ kind: "cue-open" }, 7);
    expect(harness.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["panel.js"],
    });
  });
});
```

This test file already stubs the gateway; make the resolve return a `found` outcome for both `PR_URL` (`https://github.com/acme/web/pull/482`) and `OTHER_PR_URL` (`https://github.com/acme/web/pull/517`) the same way its existing resolve tests do, and have `tabsGet` report whichever URL was last navigated to, so the post-resolve precondition sees the real page.

Three helpers this task needs:

- `settleAmbient()`, in the test file — advance past the debounce and flush: `vi.useFakeTimers()` in setup, then `await vi.advanceTimersByTimeAsync(700)`.
- `emitMessageFromTab(message, tabId)`, in `chrome-mock.ts` — fires the message listener with a `sender` of `{ tab: { id: tabId } }`. Keep the existing `emitMessage` and have it delegate with `undefined`, so the popup and options paths still exercise the no-tab case.
- `holdNextResolve(gate: Promise<void>)`, in `chrome-mock.ts` — makes the next gateway resolve wait on `gate` before returning its stubbed response. Only the overtaken-run test needs it; without a way to hold a response open, two runs cannot be made to genuinely overlap and the test would pass whether or not the generation check exists.

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun run test -- service-worker`
Expected: FAIL — no cue injection, `cue-open` unhandled.

- [ ] **Step 3: Add the `showCue` seam**

Append to `src/browser/scripting.ts`:

```ts
/** Inject cue.js then call its global with the state (two-step, like showToast). */
export async function showCue(tabId: number, state: CueState): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["cue.js"] });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (s: CueState) =>
      (globalThis as unknown as { __nimbusCue: (x: CueState) => void }).__nimbusCue(s),
    args: [state],
  });
}
```

and add `CueState` to its type import from `../shared/types.ts`.

- [ ] **Step 4: Route `cue-open`**

In `src/background/service-worker.ts`, the message listener currently ignores the sender. Change `addMessageListener` in `src/browser/runtime.ts` to pass it through:

```ts
export function addMessageListener(
  fn: (
    message: unknown,
    respond: (response: unknown) => void,
    sender: { readonly tabId?: number },
  ) => boolean,
): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
    fn(message, sendResponse, { tabId: sender.tab?.id }),
  );
}
```

Then in the worker's listener, before the final `return false;`:

```ts
  if (isCueOpenRequest(message)) {
    // The tab comes from the BROWSER's sender, never from the message: the cue
    // runs in the page, so a payload-supplied tab id would be forgeable on a
    // hostile site. No response — the cue does not wait, and the panel appearing
    // is the answer.
    const tabId = sender.tabId;
    if (tabId !== undefined) {
      injectPanel(tabId).catch(() => undefined);
    }
    return false;
  }
```

Update the listener's callback signature to `(message, respond, sender)`, and add `isCueOpenRequest` to the imports from `../shared/messages.ts`.

The `addMessageListener` signature change is additive — the worker is its only caller, and every existing branch ignores the third argument. `test/unit/runtime.test.ts` asserts how this seam forwards its arguments, so it needs a case for the new one: a listener registered through `addMessageListener` receives `{ tabId: 7 }` when `chrome.runtime.onMessage` fires with `sender.tab.id === 7`, and `{ tabId: undefined }` when the message came from the popup or options page (no `sender.tab` at all). Add both.

- [ ] **Step 5: Wire the ambient path**

Add to `src/background/service-worker.ts`, after the command listener:

```ts
/**
 * The item last cued per tab — the dedupe memory decision 4 asks for: quiet for
 * this item, in this tab, until you navigate to a different one.
 *
 * Deliberately NOT persisted. A service-worker eviction re-cues you once, which
 * is a better failure than a suppression that outlives the reason for it.
 */
const lastCuedByTab = new Map<number, Recognition>();
const ambientTimers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * One in-flight ambient run per tab, as the design spec states — enforced by
 * generation, not by cancellation.
 *
 * The debounce coalesces bursts, but it cannot help once a run has STARTED: a
 * navigation 700ms after another leaves two runs overlapping, and the older one
 * can still land last. Bumping a counter per navigation and checking it after
 * the await means the stale run drops its result instead of racing the fresh one
 * to `showCue`.
 *
 * This is deliberately NOT an AbortController. See the spec's "Deferred, with
 * reasons": caller-side cancellation means threading a signal through
 * `resolveItem` and `handleResolve` — a seam the panel shares — to save a
 * request to 127.0.0.1 whose work the gateway has already begun. Correctness is
 * what matters here, and this is what buys it.
 */
const ambientGeneration = new Map<number, number>();

/** SPA URL rewrites arrive in bursts; one navigation should cost one resolve. */
const AMBIENT_DEBOUNCE_MS = 600;

const ambientDeps: AmbientDeps = {
  enabledHosts: getAmbientHosts,
  getOrigins,
  lastCued: (tabId) => lastCuedByTab.get(tabId),
  resolve: (pageUrl) =>
    handleResolve({ getConnection, getOrigins, resolveItem }, { kind: "resolve", pageUrl }),
  currentUrl: tabUrl,
};

async function runAmbient(nav: TabNavigation, generation: number): Promise<void> {
  const decision = await decideAmbient(ambientDeps, nav);
  // A newer navigation in this tab supersedes this one, whatever it concluded.
  if (ambientGeneration.get(nav.tabId) !== generation) {
    return;
  }
  if (decision.kind !== "show") {
    return;
  }
  // Inject FIRST, remember second: an attempt abandoned by a restricted page
  // must not suppress the cue the next time the user lands on this item.
  await showCue(nav.tabId, decision.cue);
  lastCuedByTab.set(nav.tabId, decision.recognition);
}

addNavigationListener((nav) => {
  const generation = (ambientGeneration.get(nav.tabId) ?? 0) + 1;
  ambientGeneration.set(nav.tabId, generation);
  const pending = ambientTimers.get(nav.tabId);
  if (pending !== undefined) {
    clearTimeout(pending);
  }
  ambientTimers.set(
    nav.tabId,
    setTimeout(() => {
      ambientTimers.delete(nav.tabId);
      // Fails closed like every other listener here: the user-visible result is
      // a cue or nothing, and a rejection has nowhere to be reported.
      runAmbient(nav, generation).catch(() => undefined);
    }, AMBIENT_DEBOUNCE_MS),
  );
});

addTabClosedListener((tabId) => {
  lastCuedByTab.delete(tabId);
  ambientGeneration.delete(tabId);
  const pending = ambientTimers.get(tabId);
  if (pending !== undefined) {
    clearTimeout(pending);
    ambientTimers.delete(tabId);
  }
});
```

Add the imports this needs:

```ts
import { addNavigationListener, addTabClosedListener, activeTab, tabUrl, type TabNavigation } from "../browser/tabs.ts";
import { injectPanel, runCapture, showCue, showToast } from "../browser/scripting.ts";
import { type AmbientDeps, decideAmbient } from "./ambient.ts";
import { getAmbientHosts } from "./ambient-prefs.ts";
import type { AgentError, AgentLane, LaneState, Recognition } from "../shared/types.ts";
import { isCueOpenRequest, ... } from "../shared/messages.ts";
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `bun run test -- service-worker` then `bun run test`
Expected: PASS, no regressions in the existing worker tests.

- [ ] **Step 7: Build and check**

Run: `bun run typecheck && bun run lint && bun run build && bun run check-build`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/background/service-worker.ts src/browser/scripting.ts src/browser/runtime.ts test/unit/
git commit -m "feat(background): surface the cue on a resolved page you landed on"
```

---

### Task 11: Docs, changelog, roadmap

**Files:**
- Modify: `docs/architecture.md` (new section)
- Modify: `docs/development.md` (manual verification checklist)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Modify: `ROADMAP.md` (C1.3 status, 3.4 status, C1.4 status)
- Test: `test/unit/store-listing.test.ts` — check whether it asserts Options copy; if it does, update the expectation to match Task 4's new paragraph.

**Interfaces:**
- Consumes: the shipped feature.
- Produces: nothing consumed by code.

- [ ] **Step 1: Document the ambient path in architecture.md**

Add a section after the targeted-fetch one, covering: the trigger chain (`chrome.tabs.onUpdated` → debounce → `decideAmbient` → `showCue`); why the decision lives in a pure module while the worker only wires; that the browser's own `changeInfo.url` gating is the first permission lock and `isAmbientUrl` the second; why the dedupe map is in memory and keyed by `sameItem` rather than URL; and why every non-`found` outcome is silence. Link the design spec.

- [ ] **Step 2: Add the manual pass to development.md**

Add these checks, in the file's existing style:

```markdown
### Ambient surfacing (Phase C1.3)

Nothing here is unit-testable end to end — the cue is injected into a real page.

1. Options → grant page access to `github.com` (this row exists as of this
   release), then tick **Surface automatically**.
2. Open an indexed pull request. Within a second a cue appears top-right naming
   it. Click it: the panel opens on that same item, and the cue disappears.
3. Reload the same PR. No cue — same item, same tab.
4. Navigate (in the same tab) to a different indexed PR. A cue appears.
5. Switch to that PR's **Files** tab. No second cue: same item.
6. Open a PR Nimbus has never indexed. Nothing appears at all.
7. Untick **Surface automatically**, reload an indexed PR. Nothing appears.
8. Re-tick it, then revoke page access. The toggle greys out and no cue appears.
9. Middle-click three PRs into background tabs. No cue in any of them until you
   focus one and navigate.
10. Open a PR, then quickly switch tabs and back. The cue is there when you
    return (it is not re-checked for focus once the answer is in).
11. On `chrome://extensions` or another restricted page: nothing appears, and no
    error surfaces anywhere.
12. With the gateway stopped: nothing appears. Silence, not an error toast.
13. Repeat 1-4 in Firefox.
```

- [ ] **Step 3: Write the changelog entry**

Under `## [Unreleased]` → `### Added`, in the file's user-facing voice:

```markdown
- **Nimbus can now tell you it knows this page, before you ask.** On a site you
  have granted page access to and switched **Surface automatically** on for,
  landing on a pull request, build or issue that Nimbus has already indexed puts
  a small cue in the corner naming it. Click it and the panel opens on that item;
  dismiss it and it stays quiet for that item in that tab. Nothing runs until you
  click — no agent, no lane. And the cue only appears when there is a real answer
  behind it: a page Nimbus has not indexed, a page it cannot pin to one item, or
  a gateway that is not running all produce silence rather than a cue that leads
  nowhere.
```

Under `### Fixed`:

```markdown
- **The built-in sites could not be granted page access at all.** Options listed
  only the self-hosted instances you had added, and the Grant button lives on a
  row — so `github.com`, `gitlab.com`, `bitbucket.org` and Jira Cloud, which
  Nimbus recognises without any setup, had no row and no way to be granted. They
  are now listed alongside your own entries, each with its own page-access
  control (and no Remove — they are not yours to delete).
```

- [ ] **Step 4: Update the roadmap**

- **C1.3** — change "shipped (user-summoned)" to record that ambient surfacing has now landed as an opt-in per-host cue, and link the design spec.
- **3.4** — mark superseded-and-shipped, built as the reframe directed: on C1.4's per-origin permission, as part of the panel rather than a standalone cue.
- **C1.4** — append to its status that the grant now buys something concrete, and record the row gap this slice closed.

- [ ] **Step 5: Verify and commit**

```bash
bun run test && bun run typecheck && bun run lint && bun run build && bun run check-build
git add docs/ CHANGELOG.md ROADMAP.md test/unit/
git commit -m "docs: record the ambient path, its manual pass and what shipped"
```

---

## Verification before calling this done

Run all five, and paste the output rather than summarising it:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
bun run check-build
```

Then do the `docs/development.md` manual pass added in Task 11 — in **both** Chrome and Firefox. The injected surfaces are not covered end to end by unit tests, which is exactly why that checklist exists.
