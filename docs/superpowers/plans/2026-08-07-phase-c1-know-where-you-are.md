# Phase C1 — Know Where You Are — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension recognise what page the user is on (Bitbucket/GitHub/GitLab PR, Jenkins build, Jira issue), resolve it to a single indexed item via a proposed gateway route, and render that in a lane-based panel shell that Phase C2 can hang agent lanes on.

**Architecture:** All classification is pure code in `src/shared/` (`origins.ts`, `recognise.ts`), driven from the background service worker — the injected panel stays a dumb renderer that sends one `resolve` message and renders the discriminated state it gets back. The gateway route (`POST /v1/clips/resolve`) does not exist upstream yet; the client is written against the proposed shape and maps a `404` to a first-class `unsupported` state, so it ships useful today and flips to live with no code change.

**Tech Stack:** TypeScript (strict), Vitest (node env; jsdom via docblock), esbuild, Biome, MV3 (Chrome + Firefox), bun as the runner.

**Spec:** [`docs/superpowers/specs/2026-08-07-phase-c1-know-where-you-are-design.md`](../specs/2026-08-07-phase-c1-know-where-you-are-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **TypeScript strict, no `any`.** `tsconfig.json` also sets `noUncheckedIndexedAccess: true` (array/index access yields `T | undefined` — destructure and check explicitly) and `exactOptionalPropertyTypes: true` (an optional field must be *omitted*, never set to `undefined`; use conditional spread).
- **No `console.*` anywhere in `src/`** — Biome `noConsole` fails the build. Tests and `scripts/` may log.
- **Never log or render the bearer token or the pairing code.** The token never crosses into the panel, the Options page, or a page DOM.
- **Loopback-only network destination.** The only origin the extension `fetch`es is the paired gateway on `127.0.0.1` / `localhost`. Nothing in this phase adds a network destination. `host_permissions` stays exactly `["http://127.0.0.1/*", "http://localhost/*"]`.
- **`optional_host_permissions` is page access, not network access.** It is inert at install; nothing is granted until the user clicks Grant.
- **No runtime dependencies.** Nothing new in `dependencies` in `package.json`.
- **Cross-boundary data is `unknown` until narrowed** by a type guard in `src/shared/messages.ts`.
- **All gateway-provided strings render via `textContent`,** never `innerHTML`.
- **Do not modify `CLIP_PATHS`** in `src/shared/gateway.ts` — those three paths are the locked contract. The proposed resolve path goes in a separate constant.
- **Cross-module types live in `src/shared/types.ts`;** logic and guards live in the module that owns them (mirrors how `RelatedHit` lives in `types.ts` while `isRelatedHit` lives in `related.ts`).
- **Firefox `strict_min_version` stays `121.0`** and `FIREFOX_ADDON_ID` stays `web-clipper@nimbus-agent.dev` — changing the gecko id orphans every existing Firefox install.

**Verification commands** (run from the repo root):

```bash
bun run typecheck     # tsc --noEmit
bun run lint          # biome check .
bun run test          # bunx vitest run
bun run build         # esbuild → dist/chrome + dist/firefox
bun run check-build   # assert each target is a complete MV3 extension
```

A single test file: `bunx vitest run test/unit/<file>.test.ts`.
A single test by name: `bunx vitest run test/unit/<file>.test.ts -t "<name>"`.

---

### Task 1: Shared types + the configured-origin model

The user declares self-hosted instances as `{ origin, product }`, where `origin` may carry a path prefix (`https://corp.example/jira`) because self-hosted Jira/Jenkins commonly sit behind a reverse proxy on a sub-path. This task builds the pure model: parse/normalise, upsert/remove, and **longest-prefix-wins** lookup.

**Files:**
- Modify: `src/shared/types.ts` (append — do not reorder existing exports)
- Create: `src/shared/origins.ts`
- Test: `test/unit/origins.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `Product = "bitbucket" | "github" | "gitlab" | "jenkins" | "jira"`
  - `SurfaceKind = "pr" | "build" | "issue"`
  - `ConfiguredOrigin = { readonly origin: string; readonly product: Product }`
  - `Recognition`, `ResolvedItem`, `ResolveError` (types only here; used from Task 2 onward)
  - `splitOrigin(origin: string): { base: string; prefix: string } | null`
  - `parseConfiguredOrigin(raw: string, product: Product): ConfiguredOrigin | null`
  - `upsertOrigin(list: readonly ConfiguredOrigin[], entry: ConfiguredOrigin): ConfiguredOrigin[]`
  - `removeConfiguredOrigin(list: readonly ConfiguredOrigin[], origin: string): ConfiguredOrigin[]`
  - `matchOrigin(list: readonly ConfiguredOrigin[], url: URL): ConfiguredOrigin | null`
  - `hostPermissionPattern(origin: string): string | null`
  - `isProduct(v: unknown): v is Product`, `isConfiguredOrigin(v: unknown): v is ConfiguredOrigin`

- [ ] **Step 1: Add the shared types**

Append to `src/shared/types.ts`:

```ts
/** A product whose pages the client can recognise. */
export type Product = "bitbucket" | "github" | "gitlab" | "jenkins" | "jira";

/** What kind of item a recognised page is. */
export type SurfaceKind = "pr" | "build" | "issue";

/**
 * An origin whose pages may be recognised, declared by the user (or built in for
 * the SaaS hosts). `origin` is scheme + host [+ port] plus an OPTIONAL path
 * prefix — "https://bitbucket.org" or "https://corp.example/jenkins" — because
 * self-hosted instances commonly sit behind a reverse proxy on a sub-path.
 *
 * NOTE: this is a PAGE origin, unrelated to the loopback gateway origin validated
 * by shared/gateway.ts. The two must never share a validator.
 */
export interface ConfiguredOrigin {
  readonly origin: string;
  readonly product: Product;
}

/** The result of classifying a page URL. Resolution is at most one item. */
export type Recognition =
  | {
      readonly ok: true;
      readonly product: Product;
      readonly kind: SurfaceKind;
      /** Human header text, e.g. "Bitbucket PR". */
      readonly label: string;
      /** Short identity for the header, e.g. "acme/web #482". */
      readonly ref: string;
      /** The canonicalised URL sent to the gateway as the resolution key. */
      readonly resolveUrl: string;
    }
  | { readonly ok: false; readonly reason: "unknown-host" | "unrecognised-path" };

/** The gateway's resolved item. PROPOSED shape — see the C1 design spec. */
export interface ResolvedItem {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly url: string | null;
}

/** `unsupported` is a 404 — this gateway has no resolve route yet. */
export type ResolveError =
  | "not_paired"
  | "unauthorized"
  | "unsupported"
  | "unreachable"
  | "server_error";
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/origins.test.ts`:

```ts
// test/unit/origins.test.ts
import { describe, expect, test } from "vitest";
import {
  hostPermissionPattern,
  isConfiguredOrigin,
  matchOrigin,
  parseConfiguredOrigin,
  removeConfiguredOrigin,
  splitOrigin,
  upsertOrigin,
} from "../../src/shared/origins.ts";
import type { ConfiguredOrigin } from "../../src/shared/types.ts";

describe("parseConfiguredOrigin", () => {
  test("normalises case, drops the trailing slash, keeps the port", () => {
    expect(parseConfiguredOrigin("HTTPS://Corp.Example:8443/", "jira")).toEqual({
      origin: "https://corp.example:8443",
      product: "jira",
    });
  });
  test("keeps a path prefix and strips its trailing slash", () => {
    expect(parseConfiguredOrigin("https://corp.example/jenkins/", "jenkins")).toEqual({
      origin: "https://corp.example/jenkins",
      product: "jenkins",
    });
  });
  test("drops query and fragment", () => {
    expect(parseConfiguredOrigin("https://corp.example/jira?a=1#top", "jira")?.origin).toBe(
      "https://corp.example/jira",
    );
  });
  test("rejects a non-http(s) scheme", () => {
    expect(parseConfiguredOrigin("ftp://corp.example", "jira")).toBeNull();
  });
  test("rejects input with no scheme (the UI must ask for a full URL)", () => {
    expect(parseConfiguredOrigin("corp.example/jira", "jira")).toBeNull();
  });
});

describe("splitOrigin", () => {
  test("a bare host has an empty prefix", () => {
    expect(splitOrigin("https://github.com")).toEqual({ base: "https://github.com", prefix: "" });
  });
  test("a default port is dropped by the URL parser", () => {
    expect(splitOrigin("https://corp.example:443/jira")).toEqual({
      base: "https://corp.example",
      prefix: "/jira",
    });
  });
});

describe("upsertOrigin / removeConfiguredOrigin", () => {
  const jira: ConfiguredOrigin = { origin: "https://corp.example/jira", product: "jira" };
  const jenkins: ConfiguredOrigin = { origin: "https://corp.example/jenkins", product: "jenkins" };

  test("two prefixed entries coexist on one host", () => {
    const list = upsertOrigin(upsertOrigin([], jira), jenkins);
    expect(list).toHaveLength(2);
  });
  test("re-adding the same origin+prefix replaces its product", () => {
    const list = upsertOrigin(upsertOrigin([], jira), {
      origin: "https://corp.example/jira",
      product: "jenkins",
    });
    expect(list).toEqual([{ origin: "https://corp.example/jira", product: "jenkins" }]);
  });
  test("remove drops only the matching entry", () => {
    const list = removeConfiguredOrigin([jira, jenkins], "https://corp.example/jira");
    expect(list).toEqual([jenkins]);
  });
});

describe("matchOrigin", () => {
  const bare: ConfiguredOrigin = { origin: "https://corp.example", product: "github" };
  const jira: ConfiguredOrigin = { origin: "https://corp.example/jira", product: "jira" };
  const jenkins: ConfiguredOrigin = { origin: "https://corp.example/jenkins", product: "jenkins" };

  test("longest prefix wins over a bare host entry", () => {
    const m = matchOrigin([bare, jira], new URL("https://corp.example/jira/browse/ABC-1"));
    expect(m?.product).toBe("jira");
  });
  test("picks the right product among sibling prefixes on one host", () => {
    const m = matchOrigin([jira, jenkins], new URL("https://corp.example/jenkins/job/web/42"));
    expect(m?.product).toBe("jenkins");
  });
  test("a prefix does not match a lookalike sibling path", () => {
    expect(matchOrigin([jira], new URL("https://corp.example/jiraffe/browse/ABC-1"))).toBeNull();
  });
  test("the prefix itself matches with no trailing path", () => {
    expect(matchOrigin([jira], new URL("https://corp.example/jira"))?.product).toBe("jira");
  });
  test("a different port is a different origin", () => {
    expect(matchOrigin([bare], new URL("https://corp.example:8443/x"))).toBeNull();
  });
});

describe("hostPermissionPattern", () => {
  test("the grant is host-scoped even when the origin carries a prefix", () => {
    expect(hostPermissionPattern("https://corp.example/jira")).toBe("https://corp.example/*");
  });
  test("invalid input has no pattern", () => {
    expect(hostPermissionPattern("not a url")).toBeNull();
  });
});

describe("isConfiguredOrigin", () => {
  test("accepts a valid entry", () => {
    expect(isConfiguredOrigin({ origin: "https://github.com", product: "github" })).toBe(true);
  });
  test("rejects an unknown product", () => {
    expect(isConfiguredOrigin({ origin: "https://github.com", product: "svn" })).toBe(false);
  });
  test("rejects a non-object", () => {
    expect(isConfiguredOrigin("https://github.com")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bunx vitest run test/unit/origins.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/shared/origins.ts"`.

- [ ] **Step 4: Write the implementation**

Create `src/shared/origins.ts`:

```ts
// The configured-origin model: which page origins may be recognised, and which
// product each one is running.
//
// DELIBERATELY SEPARATE from shared/gateway.ts. That module validates the ONE
// loopback origin the extension may talk to, and its rule is a security
// invariant (I6). This module validates origins whose PAGES may be recognised —
// a different axis entirely. Sharing a helper between the two would invite a
// change that quietly relaxes one by editing the other.
import type { ConfiguredOrigin, Product } from "./types.ts";

const PRODUCTS: readonly string[] = ["bitbucket", "github", "gitlab", "jenkins", "jira"];

export function isProduct(v: unknown): v is Product {
  return typeof v === "string" && PRODUCTS.includes(v);
}

export function isConfiguredOrigin(v: unknown): v is ConfiguredOrigin {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const rec = v as Record<string, unknown>;
  return typeof rec["origin"] === "string" && isProduct(rec["product"]);
}

/**
 * Split a stored origin into its URL origin and its path prefix ("" when none).
 * The URL parser does the normalising: it lowercases scheme and host and drops a
 * default port, so two spellings of the same origin cannot diverge here.
 */
export function splitOrigin(origin: string): { base: string; prefix: string } | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return { base: url.origin, prefix: path };
}

/** Parse user input into a stored entry, or null when it isn't a usable origin. */
export function parseConfiguredOrigin(raw: string, product: Product): ConfiguredOrigin | null {
  const split = splitOrigin(raw.trim());
  if (split === null) {
    return null;
  }
  return { origin: `${split.base}${split.prefix}`, product };
}

/** Add or replace by origin+prefix — one product per entry, not per host. */
export function upsertOrigin(
  list: readonly ConfiguredOrigin[],
  entry: ConfiguredOrigin,
): ConfiguredOrigin[] {
  return [...list.filter((o) => o.origin !== entry.origin), entry];
}

export function removeConfiguredOrigin(
  list: readonly ConfiguredOrigin[],
  origin: string,
): ConfiguredOrigin[] {
  return list.filter((o) => o.origin !== origin);
}

/**
 * Longest-prefix-wins lookup for a page URL. This is what lets one host carry
 * several products (/jira and /jenkins) and what settles a bare host entry
 * sitting alongside a prefixed one. The `${prefix}/` boundary check stops
 * "/jira" from matching "/jiraffe".
 */
export function matchOrigin(
  list: readonly ConfiguredOrigin[],
  url: URL,
): ConfiguredOrigin | null {
  let best: ConfiguredOrigin | null = null;
  let bestLength = -1;
  for (const entry of list) {
    const split = splitOrigin(entry.origin);
    if (split === null || split.base !== url.origin) {
      continue;
    }
    const path = url.pathname;
    const hit =
      split.prefix === "" || path === split.prefix || path.startsWith(`${split.prefix}/`);
    if (hit && split.prefix.length > bestLength) {
      best = entry;
      bestLength = split.prefix.length;
    }
  }
  return best;
}

/**
 * The match pattern requested for a configured origin. HOST-SCOPED on purpose,
 * even when the origin carries a path prefix: the browser's permission warning is
 * per-host either way, so a path-scoped pattern buys no privacy while costing
 * exact-pattern bookkeeping in `permissions.contains` and revocation.
 */
export function hostPermissionPattern(origin: string): string | null {
  const split = splitOrigin(origin);
  return split === null ? null : `${split.base}/*`;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bunx vitest run test/unit/origins.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 6: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/shared/origins.ts test/unit/origins.test.ts
git commit -m "feat(shared): configured-origin model with path prefixes"
```

---

### Task 2: The surface recogniser

Classify a page URL into a product, an item kind, a human ref, and a canonicalised `resolveUrl`. Pure, no I/O, no `chrome`.

**Files:**
- Create: `src/shared/recognise.ts`
- Test: `test/unit/recognise.test.ts`

**Interfaces:**
- Consumes: `matchOrigin`, `splitOrigin` from `src/shared/origins.ts`; `ConfiguredOrigin`, `Product`, `Recognition`, `SurfaceKind` from `src/shared/types.ts` (Task 1).
- Produces:
  - `recognise(url: string, origins: readonly ConfiguredOrigin[]): Recognition`
  - `BUILT_IN_ORIGINS: readonly ConfiguredOrigin[]`
  - `surfaceLine(r: Recognition): string | null` — `"Bitbucket PR · acme/web #482"`, or null when unrecognised.

- [ ] **Step 1: Write the failing test**

Create `test/unit/recognise.test.ts`:

```ts
// test/unit/recognise.test.ts
import { describe, expect, test } from "vitest";
import { recognise, surfaceLine } from "../../src/shared/recognise.ts";
import type { ConfiguredOrigin } from "../../src/shared/types.ts";

const NONE: readonly ConfiguredOrigin[] = [];
const SELF_HOSTED: readonly ConfiguredOrigin[] = [
  { origin: "https://corp.example/jira", product: "jira" },
  { origin: "https://corp.example/jenkins", product: "jenkins" },
  { origin: "https://stash.corp.example:8443", product: "bitbucket" },
];

/** Assert the happy path compactly: product, kind, ref and the exact resolveUrl. */
function expectItem(
  url: string,
  origins: readonly ConfiguredOrigin[],
  want: { product: string; kind: string; ref: string; resolveUrl: string },
): void {
  const r = recognise(url, origins);
  expect(r.ok).toBe(true);
  if (!r.ok) {
    return;
  }
  expect({ product: r.product, kind: r.kind, ref: r.ref, resolveUrl: r.resolveUrl }).toEqual(want);
}

describe("built-in SaaS hosts", () => {
  test("GitHub PR", () => {
    expectItem("https://github.com/acme/web/pull/482", NONE, {
      product: "github",
      kind: "pr",
      ref: "acme/web #482",
      resolveUrl: "https://github.com/acme/web/pull/482",
    });
  });
  test("GitHub PR sub-tab collapses onto the PR", () => {
    expectItem("https://github.com/acme/web/pull/482/files", NONE, {
      product: "github",
      kind: "pr",
      ref: "acme/web #482",
      resolveUrl: "https://github.com/acme/web/pull/482",
    });
  });
  test("GitLab MR under a nested group", () => {
    expectItem("https://gitlab.com/acme/team/web/-/merge_requests/7/diffs", NONE, {
      product: "gitlab",
      kind: "pr",
      ref: "acme/team/web !7",
      resolveUrl: "https://gitlab.com/acme/team/web/-/merge_requests/7",
    });
  });
  test("Bitbucket Cloud PR", () => {
    expectItem("https://bitbucket.org/acme/web/pull-requests/12/diff", NONE, {
      product: "bitbucket",
      kind: "pr",
      ref: "acme/web #12",
      resolveUrl: "https://bitbucket.org/acme/web/pull-requests/12",
    });
  });
  test("Jira Cloud issue on any *.atlassian.net host", () => {
    expectItem("https://acme.atlassian.net/browse/PLAT-91", NONE, {
      product: "jira",
      kind: "issue",
      ref: "PLAT-91",
      resolveUrl: "https://acme.atlassian.net/browse/PLAT-91",
    });
  });
});

describe("self-hosted instances", () => {
  test("Jira behind a /jira prefix keeps the prefix in resolveUrl", () => {
    expectItem("https://corp.example/jira/browse/PLAT-91", SELF_HOSTED, {
      product: "jira",
      kind: "issue",
      ref: "PLAT-91",
      resolveUrl: "https://corp.example/jira/browse/PLAT-91",
    });
  });
  test("Jenkins build under nested folders", () => {
    expectItem("https://corp.example/jenkins/job/web/job/deploy/42/console", SELF_HOSTED, {
      product: "jenkins",
      kind: "build",
      ref: "web/deploy #42",
      resolveUrl: "https://corp.example/jenkins/job/web/job/deploy/42",
    });
  });
  test("Bitbucket Server PR on a non-default port", () => {
    expectItem(
      "https://stash.corp.example:8443/projects/PLAT/repos/web/pull-requests/9/overview",
      SELF_HOSTED,
      {
        product: "bitbucket",
        kind: "pr",
        ref: "PLAT/web #9",
        resolveUrl: "https://stash.corp.example:8443/projects/PLAT/repos/web/pull-requests/9",
      },
    );
  });
  test("a sibling path on a prefixed host is NOT the configured product", () => {
    const r = recognise("https://corp.example/wiki/Home", SELF_HOSTED);
    expect(r).toEqual({ ok: false, reason: "unknown-host" });
  });
});

describe("canonicalisation", () => {
  test("strips query parameters, fragment and trailing slash", () => {
    expectItem("https://github.com/acme/web/pull/482/?utm_source=slack#note-3", NONE, {
      product: "github",
      kind: "pr",
      ref: "acme/web #482",
      resolveUrl: "https://github.com/acme/web/pull/482",
    });
  });
  test("is idempotent — recognising a resolveUrl reproduces it exactly", () => {
    const first = recognise("https://github.com/acme/web/pull/482/commits", NONE);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = recognise(first.resolveUrl, NONE);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.resolveUrl).toBe(first.resolveUrl);
  });
  test("a Jira key is upper-cased, so one issue has one resolveUrl", () => {
    expectItem("https://acme.atlassian.net/browse/plat-91", NONE, {
      product: "jira",
      kind: "issue",
      ref: "PLAT-91",
      resolveUrl: "https://acme.atlassian.net/browse/PLAT-91",
    });
  });
});

describe("misses", () => {
  test("an unconfigured host is unknown-host", () => {
    expect(recognise("https://example.com/acme/web/pull/1", NONE)).toEqual({
      ok: false,
      reason: "unknown-host",
    });
  });
  test("a known host with a non-item path is unrecognised-path", () => {
    expect(recognise("https://github.com/acme/web/issues", NONE)).toEqual({
      ok: false,
      reason: "unrecognised-path",
    });
  });
  test("a PR number that is not a number does not match", () => {
    expect(recognise("https://github.com/acme/web/pull/new", NONE).ok).toBe(false);
  });
  test("a non-http scheme is unknown-host", () => {
    expect(recognise("file:///tmp/x.html", NONE)).toEqual({ ok: false, reason: "unknown-host" });
    expect(recognise("chrome://extensions", NONE)).toEqual({ ok: false, reason: "unknown-host" });
  });
  test("unparseable input is unknown-host, not a throw", () => {
    expect(recognise("not a url", NONE)).toEqual({ ok: false, reason: "unknown-host" });
  });
});

describe("surfaceLine", () => {
  test("joins the label and the ref", () => {
    expect(surfaceLine(recognise("https://github.com/acme/web/pull/482", NONE))).toBe(
      "GitHub PR · acme/web #482",
    );
  });
  test("GitLab reads MR, not PR", () => {
    expect(
      surfaceLine(recognise("https://gitlab.com/acme/web/-/merge_requests/7", NONE)),
    ).toBe("GitLab MR · acme/web !7");
  });
  test("an unrecognised page has no surface line", () => {
    expect(surfaceLine({ ok: false, reason: "unknown-host" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/recognise.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/shared/recognise.ts"`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/recognise.ts`:

```ts
// Pure page classification: URL + the user's configured origins → what item this
// page is. No I/O, no chrome.*, no DOM — the service worker calls this before it
// asks the gateway anything.
//
// The product is NEVER guessed from the path. A proxied or path-prefixed
// self-hosted instance would produce a confidently wrong header, and on a surface
// whose whole job is recognition, a wrong header is worse than no header.
import { matchOrigin, splitOrigin } from "./origins.ts";
import type { ConfiguredOrigin, Product, Recognition, SurfaceKind } from "./types.ts";

/** SaaS hosts that need no configuration. Jira Cloud is handled separately —
 *  every tenant has its own *.atlassian.net host, which is not enumerable. */
export const BUILT_IN_ORIGINS: readonly ConfiguredOrigin[] = [
  { origin: "https://bitbucket.org", product: "bitbucket" },
  { origin: "https://github.com", product: "github" },
  { origin: "https://gitlab.com", product: "gitlab" },
];

const ATLASSIAN_SUFFIX = ".atlassian.net";

const PRODUCT_NAMES: Record<Product, string> = {
  bitbucket: "Bitbucket",
  github: "GitHub",
  gitlab: "GitLab",
  jenkins: "Jenkins",
  jira: "Jira",
};

const KIND_NAMES: Record<SurfaceKind, string> = {
  pr: "PR",
  build: "build",
  issue: "issue",
};

const NUMBER = /^\d+$/;
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

interface Match {
  readonly kind: SurfaceKind;
  readonly ref: string;
  /** The item's own path, relative to the configured prefix. */
  readonly path: string;
}

function matchGithub(s: readonly string[]): Match | null {
  const [owner, repo, section, num] = s;
  if (owner === undefined || repo === undefined || section !== "pull") {
    return null;
  }
  if (num === undefined || !NUMBER.test(num)) {
    return null;
  }
  return { kind: "pr", ref: `${owner}/${repo} #${num}`, path: `/${owner}/${repo}/pull/${num}` };
}

function matchGitlab(s: readonly string[]): Match | null {
  const dash = s.indexOf("-");
  // At least group/project before the "-" separator.
  if (dash < 2 || s[dash + 1] !== "merge_requests") {
    return null;
  }
  const num = s[dash + 2];
  if (num === undefined || !NUMBER.test(num)) {
    return null;
  }
  const project = s.slice(0, dash).join("/");
  return {
    kind: "pr",
    ref: `${project} !${num}`,
    path: `/${project}/-/merge_requests/${num}`,
  };
}

function matchBitbucket(s: readonly string[]): Match | null {
  // Bitbucket Server: /projects/{KEY}/repos/{slug}/pull-requests/{n}
  if (s[0] === "projects" && s[2] === "repos") {
    const [, key, , slug, section, num] = s;
    if (key === undefined || slug === undefined || section !== "pull-requests") {
      return null;
    }
    if (num === undefined || !NUMBER.test(num)) {
      return null;
    }
    return {
      kind: "pr",
      ref: `${key}/${slug} #${num}`,
      path: `/projects/${key}/repos/${slug}/pull-requests/${num}`,
    };
  }
  // Bitbucket Cloud: /{workspace}/{repo}/pull-requests/{n}
  const [workspace, repo, section, num] = s;
  if (workspace === undefined || repo === undefined || section !== "pull-requests") {
    return null;
  }
  if (num === undefined || !NUMBER.test(num)) {
    return null;
  }
  return {
    kind: "pr",
    ref: `${workspace}/${repo} #${num}`,
    path: `/${workspace}/${repo}/pull-requests/${num}`,
  };
}

function matchJenkins(s: readonly string[]): Match | null {
  // Folder-organised Jenkins is the norm, so /job/<name> repeats.
  const names: string[] = [];
  let i = 0;
  while (s[i] === "job") {
    const name = s[i + 1];
    if (name === undefined) {
      return null;
    }
    names.push(name);
    i += 2;
  }
  const num = s[i];
  if (names.length === 0 || num === undefined || !NUMBER.test(num)) {
    return null;
  }
  const path = names.map((n) => `job/${n}`).join("/");
  return { kind: "build", ref: `${names.join("/")} #${num}`, path: `/${path}/${num}` };
}

function matchJira(s: readonly string[]): Match | null {
  const [section, key] = s;
  if (section !== "browse" || key === undefined || !JIRA_KEY.test(key)) {
    return null;
  }
  // Jira treats issue keys as upper-case; normalising here means one issue has
  // exactly one resolveUrl regardless of how the link was typed.
  const upper = key.toUpperCase();
  return { kind: "issue", ref: upper, path: `/browse/${upper}` };
}

const MATCHERS: Record<Product, (s: readonly string[]) => Match | null> = {
  bitbucket: matchBitbucket,
  github: matchGithub,
  gitlab: matchGitlab,
  jenkins: matchJenkins,
  jira: matchJira,
};

function labelFor(product: Product, kind: SurfaceKind): string {
  if (product === "gitlab" && kind === "pr") {
    return "GitLab MR";
  }
  return `${PRODUCT_NAMES[product]} ${KIND_NAMES[kind]}`;
}

/** Every Jira Cloud tenant is its own host, so it can't live in a fixed table. */
function atlassianEntry(url: URL): ConfiguredOrigin | null {
  return url.hostname.endsWith(ATLASSIAN_SUFFIX) ? { origin: url.origin, product: "jira" } : null;
}

export function recognise(url: string, origins: readonly ConfiguredOrigin[]): Recognition {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "unknown-host" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unknown-host" };
  }
  // User entries first so a configured prefix can win over a built-in bare host.
  const entry =
    matchOrigin([...origins, ...BUILT_IN_ORIGINS], parsed) ?? atlassianEntry(parsed);
  if (entry === null) {
    return { ok: false, reason: "unknown-host" };
  }
  const split = splitOrigin(entry.origin);
  if (split === null) {
    return { ok: false, reason: "unknown-host" };
  }
  const rest = parsed.pathname.slice(split.prefix.length);
  const segments = rest.split("/").filter((part) => part !== "");
  const match = MATCHERS[entry.product](segments);
  if (match === null) {
    return { ok: false, reason: "unrecognised-path" };
  }
  // Canonicalisation falls out of reconstruction: the URL parser already
  // lowercased scheme+host and dropped a default port, and rebuilding from the
  // matched item path drops query, fragment, trailing slash and sub-tabs. The
  // configured prefix is preserved — it is what the connector indexed.
  return {
    ok: true,
    product: entry.product,
    kind: match.kind,
    label: labelFor(entry.product, match.kind),
    ref: match.ref,
    resolveUrl: `${split.base}${split.prefix}${match.path}`,
  };
}

/** "Bitbucket PR · acme/web #482" — the panel header's first line. */
export function surfaceLine(r: Recognition): string | null {
  return r.ok ? `${r.label} · ${r.ref}` : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/recognise.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/recognise.ts test/unit/recognise.test.ts
git commit -m "feat(shared): surface recogniser for PR/build/issue pages"
```

---

### Task 3: Persist configured origins

**Files:**
- Create: `src/background/origin-store.ts`
- Test: `test/unit/origin-store.test.ts`

**Interfaces:**
- Consumes: `storageGet`/`storageSet` from `src/browser/storage.ts`; `isConfiguredOrigin` from `src/shared/origins.ts`; `ConfiguredOrigin` from `src/shared/types.ts`.
- Produces:
  - `getOrigins(): Promise<ConfiguredOrigin[]>`
  - `setOrigins(list: readonly ConfiguredOrigin[]): Promise<void>`

Note this store lives in `src/background/` beside `connection-store.ts`, but unlike that one it is **imported directly by the Options page too** (Task 5). That is deliberate and safe: `chrome.storage.local` is shared across extension contexts and this store holds no secret. `connection-store.ts` stays background-only because it holds the token.

- [ ] **Step 1: Write the failing test**

Create `test/unit/origin-store.test.ts`:

```ts
// test/unit/origin-store.test.ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getOrigins, setOrigins } from "../../src/background/origin-store.ts";
import type { ConfiguredOrigin } from "../../src/shared/types.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

let harness: ChromeHarness;

beforeEach(() => {
  harness = installChromeMock();
});

afterEach(() => {
  harness.restore();
});

const jira: ConfiguredOrigin = { origin: "https://corp.example/jira", product: "jira" };

describe("origin store", () => {
  test("an empty store reads as an empty list", async () => {
    await expect(getOrigins()).resolves.toEqual([]);
  });
  test("round-trips a list", async () => {
    await setOrigins([jira]);
    await expect(getOrigins()).resolves.toEqual([jira]);
  });
  test("drops entries that fail the guard rather than trusting storage", async () => {
    harness.storage.set("origins", [jira, { origin: "https://x", product: "svn" }, 42]);
    await expect(getOrigins()).resolves.toEqual([jira]);
  });
  test("a non-array value reads as an empty list", async () => {
    harness.storage.set("origins", { nope: true });
    await expect(getOrigins()).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/origin-store.test.ts`
Expected: FAIL — cannot resolve `../../src/background/origin-store.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/background/origin-store.ts`:

```ts
// Persistence for the user's recognised-surface origins.
//
// Unlike connection-store.ts (which holds the bearer token and is background-only),
// this store carries no secret and is read directly by the Options page as well —
// chrome.storage.local is shared across extension contexts.
import { storageGet, storageSet } from "../browser/storage.ts";
import { isConfiguredOrigin } from "../shared/origins.ts";
import type { ConfiguredOrigin } from "../shared/types.ts";

const ORIGINS_KEY = "origins";

/** Stored data is external input: filter through the guard, never cast. */
export async function getOrigins(): Promise<ConfiguredOrigin[]> {
  const value = await storageGet(ORIGINS_KEY);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isConfiguredOrigin);
}

export async function setOrigins(list: readonly ConfiguredOrigin[]): Promise<void> {
  await storageSet(ORIGINS_KEY, [...list]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/origin-store.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/background/origin-store.ts test/unit/origin-store.test.ts
git commit -m "feat(background): persist recognised-surface origins"
```

---

### Task 4: The permissions seam and the optional host permission

**Files:**
- Create: `src/browser/permissions.ts`
- Modify: `src/manifest/manifest.ts`
- Modify: `test/unit/helpers/chrome-mock.ts` (add a `permissions` fake)
- Test: `test/unit/permissions.test.ts`, `test/unit/manifest.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `hasOrigin(pattern: string): Promise<boolean>`
  - `requestOrigin(pattern: string): Promise<boolean>`
  - `removeOrigin(pattern: string): Promise<boolean>`
  - `WebClipperManifest.optional_host_permissions: readonly string[]`
  - `ChromeHarness.permissionsContains` / `.permissionsRequest` / `.permissionsRemove` / `.grantedOrigins`

- [ ] **Step 1: Add a `permissions` fake to the chrome mock**

In `test/unit/helpers/chrome-mock.ts`, add to the `ChromeHarness` interface (after `contextMenusRemoveAll`):

```ts
  readonly permissionsContains: ReturnType<typeof vi.fn>;
  readonly permissionsRequest: ReturnType<typeof vi.fn>;
  readonly permissionsRemove: ReturnType<typeof vi.fn>;
  /** Backing set of granted origin patterns; seed or inspect it directly. */
  readonly grantedOrigins: Set<string>;
```

Add the implementations next to `contextMenusRemoveAll`:

```ts
  const grantedOrigins = new Set<string>();
  const permissionsContains = vi.fn(
    async (p: { origins?: string[] }): Promise<boolean> =>
      (p.origins ?? []).every((o) => grantedOrigins.has(o)),
  );
  const permissionsRequest = vi.fn(async (p: { origins?: string[] }): Promise<boolean> => {
    for (const o of p.origins ?? []) {
      grantedOrigins.add(o);
    }
    return true;
  });
  const permissionsRemove = vi.fn(async (p: { origins?: string[] }): Promise<boolean> => {
    for (const o of p.origins ?? []) {
      grantedOrigins.delete(o);
    }
    return true;
  });
```

Add to `fakeChrome`:

```ts
    permissions: {
      contains: permissionsContains,
      request: permissionsRequest,
      remove: permissionsRemove,
    },
```

And to the returned object:

```ts
    permissionsContains,
    permissionsRequest,
    permissionsRemove,
    grantedOrigins,
```

- [ ] **Step 2: Write the failing tests**

Create `test/unit/permissions.test.ts`:

```ts
// test/unit/permissions.test.ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hasOrigin, removeOrigin, requestOrigin } from "../../src/browser/permissions.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

let harness: ChromeHarness;

beforeEach(() => {
  harness = installChromeMock();
});

afterEach(() => {
  harness.restore();
});

describe("permissions seam", () => {
  test("an ungranted pattern is absent", async () => {
    await expect(hasOrigin("https://corp.example/*")).resolves.toBe(false);
  });
  test("request grants, and the grant is then visible", async () => {
    await expect(requestOrigin("https://corp.example/*")).resolves.toBe(true);
    expect(harness.permissionsRequest).toHaveBeenCalledWith({
      origins: ["https://corp.example/*"],
    });
    await expect(hasOrigin("https://corp.example/*")).resolves.toBe(true);
  });
  test("remove revokes", async () => {
    await requestOrigin("https://corp.example/*");
    await expect(removeOrigin("https://corp.example/*")).resolves.toBe(true);
    await expect(hasOrigin("https://corp.example/*")).resolves.toBe(false);
  });
  test("a rejected request resolves false rather than throwing", async () => {
    harness.permissionsRequest.mockRejectedValueOnce(new Error("user gesture required"));
    await expect(requestOrigin("https://corp.example/*")).resolves.toBe(false);
  });
});
```

Add to `test/unit/manifest.test.ts` (inside the existing top-level `describe`, matching its style):

```ts
  test("optional_host_permissions is declared for both targets and is page-access only", () => {
    for (const target of BROWSER_TARGETS) {
      const m = composeManifest(target, "1.0.0");
      expect(m.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
      // The NETWORK destination is unchanged: loopback only, and never optional.
      expect(m.host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
    }
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/permissions.test.ts test/unit/manifest.test.ts`
Expected: FAIL — `src/browser/permissions.ts` unresolved; manifest test fails on `optional_host_permissions` being `undefined`.

- [ ] **Step 4: Write the permissions seam**

Create `src/browser/permissions.ts`:

```ts
// The only place chrome.permissions is touched.
//
// Patterns handed to these functions are HOST-scoped (see
// shared/origins.ts#hostPermissionPattern). `request` must run inside a user
// gesture, so it is only ever called from an Options page click handler — never
// from the service worker, where it would reject.
export async function hasOrigin(pattern: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [pattern] });
}

/** Resolves false when the user declines or the call rejects (no gesture). */
export async function requestOrigin(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

export async function removeOrigin(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Declare the optional permission in the manifest**

In `src/manifest/manifest.ts`, add to the `WebClipperManifest` interface, directly after `host_permissions`:

```ts
  readonly optional_host_permissions: readonly string[];
```

And in `composeManifest`'s `base` object, directly after the `host_permissions` entry:

```ts
    // PAGE access, a different axis from the network destination above: it lets
    // recognition read a tab's URL without a user gesture (Phase C2). Inert at
    // install — nothing is granted until the user grants a specific origin in
    // Options. Broad patterns are unavoidable because self-hosted Bitbucket /
    // Jenkins / Jira hostnames cannot be enumerated in advance.
    optional_host_permissions: ["http://*/*", "https://*/*"],
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/permissions.test.ts test/unit/manifest.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify the built manifests**

Run: `bun run build && bun run check-build`
Expected: build succeeds, `check-build` passes. Confirm the key landed:

```bash
node -e "console.log(JSON.stringify(require('./dist/chrome/manifest.json').optional_host_permissions))"
node -e "console.log(JSON.stringify(require('./dist/firefox/manifest.json').optional_host_permissions))"
```

Expected: `["http://*/*","https://*/*"]` for both.

- [ ] **Step 8: Commit**

```bash
git add src/browser/permissions.ts src/manifest/manifest.ts test/unit/permissions.test.ts test/unit/manifest.test.ts test/unit/helpers/chrome-mock.ts
git commit -m "feat(browser): permissions seam + optional host permissions"
```

---

### Task 5: The "Recognised surfaces" Options UI

Add + remove origins, and grant/revoke page access per host.

**Files:**
- Create: `src/options/surfaces-view.ts` (pure render)
- Modify: `src/options/options.html`, `src/options/options.ts`, `src/options/options.css`
- Test: `test/unit/surfaces-view.test.ts`, `test/unit/options.test.ts` (extend)

**Interfaces:**
- Consumes: `parseConfiguredOrigin`, `upsertOrigin`, `removeConfiguredOrigin`, `hostPermissionPattern` (Task 1); `getOrigins`/`setOrigins` (Task 3); `hasOrigin`/`requestOrigin`/`removeOrigin` (Task 4).
- Produces:
  - `SurfaceRow = { readonly origin: string; readonly product: Product; readonly granted: boolean }`
  - `renderSurfaceList(doc: Document, rows: readonly SurfaceRow[]): HTMLElement`
  - `sharedHostNote(rows: readonly SurfaceRow[], origin: string): string | null`

- [ ] **Step 1: Write the failing view test**

Create `test/unit/surfaces-view.test.ts`:

```ts
// @vitest-environment jsdom
// test/unit/surfaces-view.test.ts
import { describe, expect, test } from "vitest";
import { renderSurfaceList, sharedHostNote, type SurfaceRow } from "../../src/options/surfaces-view.ts";

const jira: SurfaceRow = {
  origin: "https://corp.example/jira",
  product: "jira",
  granted: false,
};
const jenkins: SurfaceRow = {
  origin: "https://corp.example/jenkins",
  product: "jenkins",
  granted: true,
};

describe("renderSurfaceList", () => {
  test("empty state explains what the list is for", () => {
    expect(renderSurfaceList(document, []).textContent).toContain("No self-hosted surfaces");
  });
  test("one row per entry, showing origin and product", () => {
    const list = renderSurfaceList(document, [jira, jenkins]);
    expect(list.querySelectorAll(".surfaces__row")).toHaveLength(2);
    expect(list.textContent).toContain("https://corp.example/jira");
    expect(list.textContent).toContain("Jira");
  });
  test("an ungranted row offers Grant; a granted row offers Revoke", () => {
    const list = renderSurfaceList(document, [jira, jenkins]);
    const buttons = [...list.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toContain("Grant page access");
    expect(buttons).toContain("Revoke page access");
  });
  test("rows carry their origin so click delegation can identify them", () => {
    const list = renderSurfaceList(document, [jira]);
    const button = list.querySelector<HTMLButtonElement>("button[data-action='remove']");
    expect(button?.dataset["origin"]).toBe("https://corp.example/jira");
  });
  test("XSS backstop — an origin string is inert text", () => {
    const list = renderSurfaceList(document, [
      { origin: "https://x/<img src=x onerror=alert(1)>", product: "jira", granted: false },
    ]);
    expect(list.querySelector("img")).toBeNull();
    expect(list.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("sharedHostNote", () => {
  test("warns when revoking a host would silence a sibling prefix", () => {
    expect(sharedHostNote([jira, jenkins], "https://corp.example/jira")).toContain(
      "https://corp.example/jenkins",
    );
  });
  test("no note when the host carries a single entry", () => {
    expect(sharedHostNote([jira], "https://corp.example/jira")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run test/unit/surfaces-view.test.ts`
Expected: FAIL — `src/options/surfaces-view.ts` unresolved.

- [ ] **Step 3: Write the pure view**

Create `src/options/surfaces-view.ts`:

```ts
// Pure DOM builders for the Options "Recognised surfaces" list. Origin strings
// are user input; every one is written with textContent, never innerHTML.
import { splitOrigin } from "../shared/origins.ts";
import type { Product } from "../shared/types.ts";

export interface SurfaceRow {
  readonly origin: string;
  readonly product: Product;
  /** Whether page access has been granted for this row's HOST. */
  readonly granted: boolean;
}

const PRODUCT_NAMES: Record<Product, string> = {
  bitbucket: "Bitbucket",
  github: "GitHub",
  gitlab: "GitLab",
  jenkins: "Jenkins",
  jira: "Jira",
};

function button(
  doc: Document,
  action: string,
  origin: string,
  text: string,
): HTMLButtonElement {
  const el = doc.createElement("button");
  el.type = "button";
  el.dataset["action"] = action;
  el.dataset["origin"] = origin;
  el.textContent = text;
  return el;
}

export function renderSurfaceList(doc: Document, rows: readonly SurfaceRow[]): HTMLElement {
  if (rows.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "options__status";
    empty.textContent =
      "No self-hosted surfaces added. Bitbucket Cloud, GitHub, GitLab and Jira Cloud are recognised without setup.";
    return empty;
  }
  const list = doc.createElement("ul");
  list.className = "surfaces__list";
  for (const row of rows) {
    const item = doc.createElement("li");
    item.className = "surfaces__row";

    const origin = doc.createElement("span");
    origin.className = "surfaces__origin";
    origin.textContent = row.origin;

    const product = doc.createElement("span");
    product.className = "surfaces__product";
    product.textContent = PRODUCT_NAMES[row.product];

    item.append(
      origin,
      product,
      row.granted
        ? button(doc, "revoke", row.origin, "Revoke page access")
        : button(doc, "grant", row.origin, "Grant page access"),
      button(doc, "remove", row.origin, "Remove"),
    );
    list.append(item);
  }
  return list;
}

/**
 * Page access is granted per HOST, so revoking one entry silences every other
 * entry on the same host. Name them rather than surprising the user.
 */
export function sharedHostNote(
  rows: readonly SurfaceRow[],
  origin: string,
): string | null {
  const base = splitOrigin(origin)?.base;
  if (base === undefined) {
    return null;
  }
  const siblings = rows
    .filter((r) => r.origin !== origin && splitOrigin(r.origin)?.base === base)
    .map((r) => r.origin);
  if (siblings.length === 0) {
    return null;
  }
  return `Page access is granted per host, so this also affects: ${siblings.join(", ")}.`;
}
```

- [ ] **Step 4: Run the view test to verify it passes**

Run: `bunx vitest run test/unit/surfaces-view.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the Options markup**

In `src/options/options.html`, insert a new `<section>` after the `connection-section` element and before `</main>`:

```html
      <section id="surfaces-section">
        <h2>Recognised surfaces</h2>
        <p>Nimbus recognises Bitbucket Cloud, GitHub, GitLab and Jira Cloud out of the box. Add self-hosted instances here — include the full URL and any sub-path, e.g. <code>https://corp.example/jira</code>.</p>
        <label for="surface-origin">Instance URL</label>
        <input id="surface-origin" type="text" placeholder="https://corp.example/jira" />
        <label for="surface-product">What is it?</label>
        <select id="surface-product">
          <option value="bitbucket">Bitbucket</option>
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab</option>
          <option value="jenkins">Jenkins</option>
          <option value="jira">Jira</option>
        </select>
        <button id="surface-add" type="button">Add surface</button>
        <output id="surface-status" class="options__status"></output>
        <div id="surface-list"></div>
        <p class="options__status">Granting page access lets Nimbus recognise pages on that site without you opening the panel first. It never changes where Nimbus can send data — that stays your local gateway only.</p>
      </section>
```

Append to `src/options/options.css`:

```css
.surfaces__list { list-style: none; margin: 0; padding: 0; }
.surfaces__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
}
.surfaces__origin { flex: 1; font-family: ui-monospace, monospace; font-size: 13px; }
.surfaces__product { font-size: 12px; opacity: 0.75; }
```

- [ ] **Step 6: Write the failing Options wiring test**

Append to `test/unit/options.test.ts`. Extend its `FIXTURE` constant with the new section:

```ts
  <section id="surfaces-section">
    <input id="surface-origin" type="text" />
    <select id="surface-product">
      <option value="jenkins">Jenkins</option>
      <option value="jira">Jira</option>
    </select>
    <button id="surface-add" type="button">Add surface</button>
    <output id="surface-status"></output>
    <div id="surface-list"></div>
  </section>
```

Then add a new `describe` block (use the file's existing `flush`, `el`, `input`, `button` helpers and its established set-up pattern for installing the fixture and the chrome mock):

```ts
describe("recognised surfaces", () => {
  test("adding a valid origin stores it and renders a row", async () => {
    input("surface-origin").value = "https://corp.example/jenkins";
    (el("surface-product") as HTMLSelectElement).value = "jenkins";
    button("surface-add").click();
    await flush();
    expect(harness.storage.get("origins")).toEqual([
      { origin: "https://corp.example/jenkins", product: "jenkins" },
    ]);
    expect(el("surface-list").textContent).toContain("https://corp.example/jenkins");
  });

  test("an origin with no scheme is rejected with guidance, and nothing is stored", async () => {
    input("surface-origin").value = "corp.example/jenkins";
    button("surface-add").click();
    await flush();
    expect(el("surface-status").textContent).toContain("full URL");
    expect(harness.storage.get("origins")).toBeUndefined();
  });

  test("Grant requests the HOST pattern, not the path-scoped one", async () => {
    input("surface-origin").value = "https://corp.example/jenkins";
    button("surface-add").click();
    await flush();
    el("surface-list")
      .querySelector<HTMLButtonElement>("button[data-action='grant']")
      ?.click();
    await flush();
    expect(harness.permissionsRequest).toHaveBeenCalledWith({
      origins: ["https://corp.example/*"],
    });
  });

  test("Remove drops the entry from storage", async () => {
    input("surface-origin").value = "https://corp.example/jenkins";
    button("surface-add").click();
    await flush();
    el("surface-list")
      .querySelector<HTMLButtonElement>("button[data-action='remove']")
      ?.click();
    await flush();
    expect(harness.storage.get("origins")).toEqual([]);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `bunx vitest run test/unit/options.test.ts`
Expected: FAIL — the new tests fail (nothing is wired to `#surface-add`).

- [ ] **Step 8: Wire the Options page**

In `src/options/options.ts`, add these imports at the top:

```ts
import { hasOrigin, removeOrigin, requestOrigin } from "../browser/permissions.ts";
import { getOrigins, setOrigins } from "../background/origin-store.ts";
import {
  hostPermissionPattern,
  isProduct,
  parseConfiguredOrigin,
  removeConfiguredOrigin,
  upsertOrigin,
} from "../shared/origins.ts";
import { renderSurfaceList, sharedHostNote, type SurfaceRow } from "./surfaces-view.ts";
```

Add this block above the existing `document.addEventListener("DOMContentLoaded", …)` call:

```ts
function setSurfaceStatus(text: string): void {
  const el = document.getElementById("surface-status");
  if (el !== null) {
    el.textContent = text;
  }
}

/** Storage is the source of truth for entries; the browser is for grants. */
async function surfaceRows(): Promise<SurfaceRow[]> {
  const stored = await getOrigins();
  const rows: SurfaceRow[] = [];
  for (const entry of stored) {
    const pattern = hostPermissionPattern(entry.origin);
    rows.push({
      origin: entry.origin,
      product: entry.product,
      granted: pattern !== null && (await hasOrigin(pattern)),
    });
  }
  return rows;
}

async function refreshSurfaces(): Promise<void> {
  const list = document.getElementById("surface-list");
  if (list === null) {
    return;
  }
  list.replaceChildren(renderSurfaceList(document, await surfaceRows()));
}

async function addSurface(): Promise<void> {
  const originEl = document.getElementById("surface-origin");
  const productEl = document.getElementById("surface-product");
  if (!(originEl instanceof HTMLInputElement) || !(productEl instanceof HTMLSelectElement)) {
    return;
  }
  if (!isProduct(productEl.value)) {
    setSurfaceStatus("Pick what this instance is running.");
    return;
  }
  const entry = parseConfiguredOrigin(originEl.value, productEl.value);
  if (entry === null) {
    setSurfaceStatus("Enter the full URL, including https://");
    return;
  }
  await setOrigins(upsertOrigin(await getOrigins(), entry));
  originEl.value = "";
  setSurfaceStatus("");
  await refreshSurfaces();
}

async function onSurfaceClick(event: Event): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const action = target.dataset["action"];
  const origin = target.dataset["origin"];
  if (action === undefined || origin === undefined) {
    return;
  }
  const pattern = hostPermissionPattern(origin);
  if (action === "remove") {
    await setOrigins(removeConfiguredOrigin(await getOrigins(), origin));
    setSurfaceStatus("");
  } else if (action === "grant" && pattern !== null) {
    // Must run inside this click handler — chrome.permissions.request needs the gesture.
    const granted = await requestOrigin(pattern);
    setSurfaceStatus(granted ? "" : "Page access was not granted.");
  } else if (action === "revoke" && pattern !== null) {
    await removeOrigin(pattern);
    setSurfaceStatus(sharedHostNote(await surfaceRows(), origin) ?? "");
  }
  await refreshSurfaces();
}
```

Extend the `DOMContentLoaded` handler with three more lines, keeping the existing ones:

```ts
  document.getElementById("surface-add")?.addEventListener("click", () => void addSurface());
  document
    .getElementById("surface-list")
    ?.addEventListener("click", (event) => void onSurfaceClick(event));
  void refreshSurfaces();
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/options.test.ts test/unit/surfaces-view.test.ts`
Expected: PASS.

- [ ] **Step 10: Full check**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all clean.

- [ ] **Step 11: Commit**

```bash
git add src/options/ test/unit/surfaces-view.test.ts test/unit/options.test.ts
git commit -m "feat(options): recognised-surfaces list with per-host page access"
```

---

### Task 6: The resolve wire — endpoint, message types, guards, fetch

**Files:**
- Modify: `src/shared/gateway.ts`, `src/shared/messages.ts`, `src/background/gateway-client.ts`
- Test: `test/unit/gateway.test.ts` (extend), `test/unit/messages.test.ts` (extend), `test/unit/gateway-client.test.ts` (extend)

**Interfaces:**
- Consumes: `ResolvedItem`, `ResolveError`, `Recognition` (Task 1).
- Produces:
  - `PROPOSED_PATHS = { resolve: "/v1/clips/resolve" }`, `GatewayEndpoint`
  - `ResolveRequest`, `ResolveResponse`, `isResolveRequest`, `isResolveResponse`, `isResolvedItem`
  - `postResolve(origin: string, token: string, canonicalUrl: string, doFetch?: FetchLike): Promise<{ ok: true; item: ResolvedItem | null } | { ok: false; reason: ResolveError }>`

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/gateway.test.ts`:

```ts
  test("the locked contract still contains exactly its three paths", () => {
    expect(Object.keys(CLIP_PATHS).sort()).toEqual(["ingest", "pairConfirm", "related"]);
  });
  test("the proposed resolve path builds a URL like the locked ones", () => {
    expect(endpointUrl("http://127.0.0.1:7474/", "resolve")).toBe(
      "http://127.0.0.1:7474/v1/clips/resolve",
    );
  });
```

(Extend the file's existing import of `CLIP_PATHS`/`endpointUrl` if needed.)

Add to `test/unit/messages.test.ts`:

```ts
describe("resolve guards", () => {
  const recognition = {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref: "acme/web #1",
    resolveUrl: "https://github.com/acme/web/pull/1",
  } as const;
  const item = {
    id: "i1",
    service: "github",
    type: "pr",
    title: "Add thing",
    canonicalUrl: "https://github.com/acme/web/pull/1",
    url: "https://github.com/acme/web/pull/1",
  } as const;

  test("isResolveRequest accepts a well-formed request", () => {
    expect(isResolveRequest({ kind: "resolve", pageUrl: "https://x/y" })).toBe(true);
  });
  test("isResolveRequest rejects a missing pageUrl", () => {
    expect(isResolveRequest({ kind: "resolve" })).toBe(false);
  });
  test("isResolveResponse accepts a resolved item", () => {
    expect(isResolveResponse({ kind: "resolve", ok: true, recognition, item })).toBe(true);
  });
  test("isResolveResponse accepts an explicit miss", () => {
    expect(isResolveResponse({ kind: "resolve", ok: true, recognition, item: null })).toBe(true);
  });
  test("isResolveResponse accepts a failure that still carries the recognition", () => {
    expect(
      isResolveResponse({ kind: "resolve", ok: false, recognition, reason: "unsupported" }),
    ).toBe(true);
  });
  test("isResolveResponse rejects an item missing a field", () => {
    const { title: _title, ...partial } = item;
    expect(isResolveResponse({ kind: "resolve", ok: true, recognition, item: partial })).toBe(
      false,
    );
  });
  test("isResolveResponse rejects a response with no recognition", () => {
    expect(isResolveResponse({ kind: "resolve", ok: true, item: null })).toBe(false);
  });
});
```

Add to `test/unit/gateway-client.test.ts` (match the file's existing stub-`fetch` style):

```ts
describe("postResolve", () => {
  const item = {
    id: "i1",
    service: "github",
    type: "pr",
    title: "Add thing",
    canonicalUrl: "https://github.com/acme/web/pull/1",
    url: "https://github.com/acme/web/pull/1",
  };

  test("200 with an item resolves it", async () => {
    const doFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ item }), { status: 200 });
    await expect(postResolve("http://127.0.0.1:7474", "t", "u", doFetch)).resolves.toEqual({
      ok: true,
      item,
    });
  });
  test("200 with item:null is a miss, not an error", async () => {
    const doFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ item: null }), { status: 200 });
    await expect(postResolve("http://127.0.0.1:7474", "t", "u", doFetch)).resolves.toEqual({
      ok: true,
      item: null,
    });
  });
  test("404 means this gateway has no resolve route — distinct from a miss", async () => {
    const doFetch = async (): Promise<Response> => new Response("", { status: 404 });
    await expect(postResolve("http://127.0.0.1:7474", "t", "u", doFetch)).resolves.toEqual({
      ok: false,
      reason: "unsupported",
    });
  });
  test("401 is unauthorized", async () => {
    const doFetch = async (): Promise<Response> => new Response("", { status: 401 });
    await expect(postResolve("http://127.0.0.1:7474", "t", "u", doFetch)).resolves.toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });
  test("a network failure is unreachable", async () => {
    const doFetch = async (): Promise<Response> => {
      throw new Error("boom");
    };
    await expect(postResolve("http://127.0.0.1:7474", "t", "u", doFetch)).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
  test("a malformed item is a server_error, never rendered as an item", async () => {
    const doFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ item: { id: 1 } }), { status: 200 });
    await expect(postResolve("http://127.0.0.1:7474", "t", "u", doFetch)).resolves.toEqual({
      ok: false,
      reason: "server_error",
    });
  });
  test("sends the bearer token and the canonical URL", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const doFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      seen = { url, ...(init !== undefined ? { init } : {}) };
      return new Response(JSON.stringify({ item: null }), { status: 200 });
    };
    await postResolve("http://127.0.0.1:7474", "tok", "https://github.com/a/b/pull/1", doFetch);
    expect(seen?.url).toBe("http://127.0.0.1:7474/v1/clips/resolve");
    expect(seen?.init?.body).toBe(
      JSON.stringify({ canonicalUrl: "https://github.com/a/b/pull/1" }),
    );
    expect((seen?.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run test/unit/gateway.test.ts test/unit/messages.test.ts test/unit/gateway-client.test.ts`
Expected: FAIL — `postResolve`, `isResolveRequest`, `isResolveResponse` are not exported.

- [ ] **Step 3: Add the proposed endpoint**

In `src/shared/gateway.ts`, below `CLIP_PATHS` / `ClipEndpoint` (leave both untouched):

```ts
/**
 * PROPOSED, not contracted. `POST /v1/clips/resolve` does not exist on the
 * shipped gateway; it is designed in
 * docs/superpowers/specs/2026-08-07-phase-c1-know-where-you-are-design.md and
 * owned upstream. A 404 from this path is a first-class "this gateway can't
 * resolve pages yet", never an error — which is why it is kept OUT of
 * CLIP_PATHS, the locked three.
 */
export const PROPOSED_PATHS = {
  resolve: "/v1/clips/resolve",
} as const;

export type GatewayEndpoint = ClipEndpoint | keyof typeof PROPOSED_PATHS;

const ALL_PATHS: Record<GatewayEndpoint, string> = { ...CLIP_PATHS, ...PROPOSED_PATHS };
```

Then change `endpointUrl` to take the wider type and read from `ALL_PATHS`:

```ts
/** Join a gateway origin with an endpoint path, tolerating a trailing slash. */
export function endpointUrl(origin: string, endpoint: GatewayEndpoint): string {
  const trimmed = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return `${trimmed}${ALL_PATHS[endpoint]}`;
}
```

- [ ] **Step 4: Add the message types and guards**

In `src/shared/messages.ts`, extend the type import to include `Recognition`, `ResolvedItem` and `ResolveError`, then add:

```ts
export interface ResolveRequest {
  readonly kind: "resolve";
  readonly pageUrl: string;
  readonly title?: string;
}

export type ResolveResponse =
  | {
      readonly kind: "resolve";
      readonly ok: true;
      readonly recognition: Recognition;
      readonly item: ResolvedItem | null;
    }
  | {
      readonly kind: "resolve";
      readonly ok: false;
      readonly recognition: Recognition;
      readonly reason: ResolveError;
    };
```

Add `ResolveRequest` to the `ExtensionRequest` union and `ResolveResponse` to `ExtensionResponse`.

Add the guards next to the related ones:

```ts
export function isResolveRequest(v: unknown): v is ResolveRequest {
  return (
    isObject(v) &&
    v["kind"] === "resolve" &&
    typeof v["pageUrl"] === "string" &&
    (v["title"] === undefined || typeof v["title"] === "string")
  );
}

export function isResolvedItem(v: unknown): v is ResolvedItem {
  return (
    isObject(v) &&
    typeof v["id"] === "string" &&
    typeof v["service"] === "string" &&
    typeof v["type"] === "string" &&
    typeof v["title"] === "string" &&
    typeof v["canonicalUrl"] === "string" &&
    (v["url"] === null || typeof v["url"] === "string")
  );
}

function isRecognition(v: unknown): v is Recognition {
  if (!isObject(v)) {
    return false;
  }
  if (v["ok"] === true) {
    return (
      typeof v["product"] === "string" &&
      typeof v["kind"] === "string" &&
      typeof v["label"] === "string" &&
      typeof v["ref"] === "string" &&
      typeof v["resolveUrl"] === "string"
    );
  }
  return v["ok"] === false && typeof v["reason"] === "string";
}

export function isResolveResponse(v: unknown): v is ResolveResponse {
  if (!isObject(v) || v["kind"] !== "resolve" || !isRecognition(v["recognition"])) {
    return false;
  }
  if (v["ok"] === true) {
    return v["item"] === null || isResolvedItem(v["item"]);
  }
  return v["ok"] === false && typeof v["reason"] === "string";
}
```

- [ ] **Step 5: Add `postResolve`**

In `src/background/gateway-client.ts`, extend the type import with `ResolvedItem` and `ResolveError`, import `isResolvedItem` from `../shared/messages.ts`, add the timeout constant next to the others:

```ts
const RESOLVE_TIMEOUT_MS = 8_000;
```

and append:

```ts
/**
 * Resolve a canonical URL to at most one indexed item.
 *
 * PROPOSED route — see shared/gateway.ts#PROPOSED_PATHS. The 404 mapping is
 * load-bearing: a MISS is a 200 with `item: null`, while an ABSENT ROUTE is a
 * 404. Keeping them distinct is what lets this ship before the gateway has the
 * route and flip to live with no code change.
 */
export async function postResolve(
  origin: string,
  token: string,
  canonicalUrl: string,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true; item: ResolvedItem | null } | { ok: false; reason: ResolveError }> {
  let res: Response;
  try {
    res = await postJson(
      doFetch,
      origin,
      "resolve",
      { canonicalUrl },
      { authorization: `Bearer ${token}` },
      RESOLVE_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    if (!isObject(data)) {
      return { ok: false, reason: "server_error" };
    }
    if (data["item"] === null) {
      return { ok: true, item: null };
    }
    if (isResolvedItem(data["item"])) {
      return { ok: true, item: data["item"] };
    }
    return { ok: false, reason: "server_error" };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 404) {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: false, reason: "server_error" };
}
```

Widen `postJson`'s `endpoint` parameter from `ClipEndpoint` to `GatewayEndpoint` and update its import.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/gateway.test.ts test/unit/messages.test.ts test/unit/gateway-client.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, full test**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/shared/gateway.ts src/shared/messages.ts src/background/gateway-client.ts test/unit/gateway.test.ts test/unit/messages.test.ts test/unit/gateway-client.test.ts
git commit -m "feat(gateway): proposed resolve route with 404 as a first-class unsupported"
```

---

### Task 7: `handleResolve` + service-worker routing + mock gateway

**Files:**
- Modify: `src/background/handlers.ts`, `src/background/service-worker.ts`
- Modify: `scripts/screenshots/mock-gateway.ts`, `scripts/screenshots/gateway-fixtures.ts`
- Test: `test/unit/handlers.test.ts` (extend), `test/unit/service-worker.test.ts` (extend), `test/unit/mock-gateway.test.ts` (extend)

**Interfaces:**
- Consumes: `recognise` (Task 2), `getOrigins` (Task 3), `postResolve` (Task 6), `ResolveRequest`/`ResolveResponse` (Task 6).
- Produces:
  - `ResolveDeps = { getConnection; getOrigins; postResolve }`
  - `handleResolve(deps: ResolveDeps, req: ResolveRequest): Promise<ResolveResponse>`

- [ ] **Step 1: Write the failing handler test**

Add to `test/unit/handlers.test.ts`:

```ts
describe("handleResolve", () => {
  const conn = {
    origin: "http://127.0.0.1:7474",
    token: "tok",
    label: "MacBook",
    pairedAt: 0,
  };
  const item = {
    id: "i1",
    service: "github",
    type: "pr",
    title: "Add thing",
    canonicalUrl: "https://github.com/acme/web/pull/1",
    url: "https://github.com/acme/web/pull/1",
  };
  const PR = "https://github.com/acme/web/pull/1/files";

  test("an unrecognised page never touches the gateway", async () => {
    let called = false;
    const res = await handleResolve(
      {
        getConnection: async () => conn,
        getOrigins: async () => [],
        postResolve: async () => {
          called = true;
          return { ok: true, item: null };
        },
      },
      { kind: "resolve", pageUrl: "https://example.com/whatever" },
    );
    expect(called).toBe(false);
    expect(res).toEqual({
      kind: "resolve",
      ok: true,
      recognition: { ok: false, reason: "unknown-host" },
      item: null,
    });
  });

  test("sends the CANONICALISED url, not the page url", async () => {
    let sent: string | null = null;
    await handleResolve(
      {
        getConnection: async () => conn,
        getOrigins: async () => [],
        postResolve: async (_o, _t, url) => {
          sent = url;
          return { ok: true, item };
        },
      },
      { kind: "resolve", pageUrl: PR },
    );
    expect(sent).toBe("https://github.com/acme/web/pull/1");
  });

  test("a resolved item comes back with its recognition", async () => {
    const res = await handleResolve(
      {
        getConnection: async () => conn,
        getOrigins: async () => [],
        postResolve: async () => ({ ok: true, item }),
      },
      { kind: "resolve", pageUrl: PR },
    );
    expect(res.ok).toBe(true);
    expect(res.recognition.ok).toBe(true);
    if (res.ok) {
      expect(res.item).toEqual(item);
    }
  });

  test("not paired short-circuits before the gateway call", async () => {
    let called = false;
    const res = await handleResolve(
      {
        getConnection: async () => null,
        getOrigins: async () => [],
        postResolve: async () => {
          called = true;
          return { ok: true, item: null };
        },
      },
      { kind: "resolve", pageUrl: PR },
    );
    expect(called).toBe(false);
    expect(res).toMatchObject({ ok: false, reason: "not_paired" });
  });

  test("a gateway failure still carries the recognition — we know the page", async () => {
    const res = await handleResolve(
      {
        getConnection: async () => conn,
        getOrigins: async () => [],
        postResolve: async () => ({ ok: false, reason: "unsupported" as const }),
      },
      { kind: "resolve", pageUrl: PR },
    );
    expect(res).toMatchObject({ ok: false, reason: "unsupported" });
    expect(res.recognition.ok).toBe(true);
  });

  test("a configured self-hosted origin is used for recognition", async () => {
    let sent: string | null = null;
    await handleResolve(
      {
        getConnection: async () => conn,
        getOrigins: async () => [{ origin: "https://corp.example/jira", product: "jira" as const }],
        postResolve: async (_o, _t, url) => {
          sent = url;
          return { ok: true, item: null };
        },
      },
      { kind: "resolve", pageUrl: "https://corp.example/jira/browse/plat-9?x=1" },
    );
    expect(sent).toBe("https://corp.example/jira/browse/PLAT-9");
  });
});
```

Add to `test/unit/service-worker.test.ts` (following the file's existing message-routing test style):

```ts
  test("routes a resolve message and answers with a resolve response", async () => {
    const res = await harness.emitMessage({
      kind: "resolve",
      pageUrl: "https://example.com/nope",
    });
    expect(res).toMatchObject({ kind: "resolve" });
  });
```

Add to `test/unit/mock-gateway.test.ts`:

```ts
  test("serves the proposed resolve route", async () => {
    const res = await fetch(`${base}/v1/clips/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canonicalUrl: "https://github.com/acme/web/pull/1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { title: string } | null };
    expect(body.item?.title).toBeTypeOf("string");
  });
```

(Use whatever base-URL/server fixture the existing file already sets up.)

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run test/unit/handlers.test.ts test/unit/service-worker.test.ts test/unit/mock-gateway.test.ts`
Expected: FAIL — `handleResolve` not exported; the SW returns `undefined` for an unknown message; the mock 404s.

- [ ] **Step 3: Implement `handleResolve`**

In `src/background/handlers.ts`, add the imports (`recognise` from `../shared/recognise.ts`; `ResolveRequest`, `ResolveResponse` from `../shared/messages.ts`; `ConfiguredOrigin`, `ResolvedItem`, `ResolveError` from `../shared/types.ts`) and append:

```ts
export interface ResolveDeps {
  readonly getConnection: () => Promise<Connection | null>;
  readonly getOrigins: () => Promise<ConfiguredOrigin[]>;
  readonly postResolve: (
    origin: string,
    token: string,
    canonicalUrl: string,
  ) => Promise<{ ok: true; item: ResolvedItem | null } | { ok: false; reason: ResolveError }>;
}

/**
 * Recognise the page, then resolve it to at most one indexed item.
 *
 * The recognition rides on BOTH arms of the response on purpose: a gateway
 * failure must not erase the fact that we know what page this is, or the panel
 * would drop back to "unrecognised" the moment the gateway hiccups.
 */
export async function handleResolve(
  deps: ResolveDeps,
  req: ResolveRequest,
): Promise<ResolveResponse> {
  const recognition = recognise(req.pageUrl, await deps.getOrigins());
  if (!recognition.ok) {
    // Nothing to ask the gateway about — and no request is made.
    return { kind: "resolve", ok: true, recognition, item: null };
  }
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "resolve", ok: false, recognition, reason: "not_paired" };
  }
  const r = await deps.postResolve(conn.origin, conn.token, recognition.resolveUrl);
  if (!r.ok) {
    return { kind: "resolve", ok: false, recognition, reason: r.reason };
  }
  return { kind: "resolve", ok: true, recognition, item: r.item };
}
```

- [ ] **Step 4: Route it in the service worker**

In `src/background/service-worker.ts`: add `isResolveRequest` to the `../shared/messages.ts` import, `handleResolve` to the `./handlers.ts` import, `postResolve` to the `./gateway-client.ts` import, and `getOrigins` from `./origin-store.ts`.

Add this branch inside `addMessageListener`, directly after the `isRelatedRequest` branch:

```ts
  if (isResolveRequest(message)) {
    handleResolve({ getConnection, getOrigins, postResolve }, message)
      .then(respond)
      .catch(() => {
        respond({
          kind: "resolve",
          ok: false,
          recognition: { ok: false, reason: "unknown-host" },
          reason: "server_error",
        });
      });
    return true;
  }
```

- [ ] **Step 5: Add the mock-gateway route**

In `scripts/screenshots/gateway-fixtures.ts`, append:

```ts
/** Fixture for the PROPOSED resolve route — dev/screenshot harness only. */
export const RESOLVE = {
  item: {
    id: "pr-482",
    service: "bitbucket",
    type: "pr",
    title: "Cache the index between runs",
    canonicalUrl: "https://bitbucket.org/acme/web/pull-requests/482",
    url: "https://bitbucket.org/acme/web/pull-requests/482",
  },
};
```

In `scripts/screenshots/mock-gateway.ts`, add `PROPOSED_PATHS` to the `../../src/shared/gateway.ts` import, `RESOLVE` to the fixtures import, and a case to the switch:

```ts
      case PROPOSED_PATHS.resolve:
        json(RESOLVE);
        return;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/handlers.test.ts test/unit/service-worker.test.ts test/unit/mock-gateway.test.ts`
Expected: PASS.

- [ ] **Step 7: Full check**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/background/handlers.ts src/background/service-worker.ts scripts/screenshots/ test/unit/handlers.test.ts test/unit/service-worker.test.ts test/unit/mock-gateway.test.ts
git commit -m "feat(background): resolve handler, SW routing and mock-gateway route"
```

---

### Task 8: The panel shell — header + lanes

**Files:**
- Modify: `src/panel/panel-view.ts`
- Test: `test/unit/panel-view.test.ts` (extend)

**Interfaces:**
- Consumes: `ResolvedItem` (Task 1); the existing `renderHits`/`renderError` in the same file.
- Produces:
  - `HeaderState` (union below), `Lane`, `PanelState`
  - `renderHeader(doc: Document, state: HeaderState): HTMLElement`
  - `renderLane(doc: Document, lane: Lane): HTMLElement`
  - `renderShell(doc: Document, state: PanelState): HTMLElement`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/panel-view.test.ts`:

```ts
import {
  type HeaderState,
  type Lane,
  renderHeader,
  renderLane,
  renderShell,
} from "../../src/panel/panel-view.ts";
import type { ResolvedItem } from "../../src/shared/types.ts";

const item: ResolvedItem = {
  id: "i1",
  service: "bitbucket",
  type: "pr",
  title: "Cache the index between runs",
  canonicalUrl: "https://bitbucket.org/acme/web/pull-requests/482",
  url: "https://bitbucket.org/acme/web/pull-requests/482",
};

describe("renderHeader", () => {
  test("unrecognised — says so and points at Options", () => {
    const el = renderHeader(document, { kind: "unrecognised" });
    expect(el.textContent).toContain("Not a recognised Nimbus surface");
    expect(el.textContent).toContain("Options");
  });
  test("loading — the state before the one resolve round trip returns", () => {
    const el = renderHeader(document, { kind: "loading" });
    expect(el.textContent).toContain("Checking Nimbus");
  });
  test("resolved — names the indexed item and links it", () => {
    const el = renderHeader(document, {
      kind: "resolved",
      surface: "Bitbucket PR · acme/web #482",
      item,
    });
    expect(el.textContent).toContain("Cache the index between runs");
    expect(el.querySelector("a")?.getAttribute("href")).toBe(item.url);
    expect(el.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  });
  test("resolved with a javascript: url renders no anchor", () => {
    const el = renderHeader(document, {
      kind: "resolved",
      surface: "s",
      item: { ...item, url: "javascript:alert(1)" },
    });
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("Cache the index between runs");
  });
  test("not-indexed — honest miss, no loose hits implied", () => {
    const el = renderHeader(document, { kind: "not-indexed", surface: "Jira issue · PLAT-9" });
    expect(el.textContent).toContain("Not indexed");
  });
  test("error — shows the message and keeps the surface line", () => {
    const el = renderHeader(document, {
      kind: "error",
      surface: "GitHub PR · acme/web #1",
      message: "This Nimbus gateway can't resolve pages yet.",
    });
    expect(el.textContent).toContain("GitHub PR · acme/web #1");
    expect(el.textContent).toContain("can't resolve pages yet");
  });
  test("error with no surface still renders the message", () => {
    const el = renderHeader(document, { kind: "error", surface: null, message: "Boom" });
    expect(el.textContent).toContain("Boom");
  });
  test("XSS backstop — an item title is inert text", () => {
    const el = renderHeader(document, {
      kind: "resolved",
      surface: "s",
      item: { ...item, url: null, title: "<img src=x onerror=alert(1)>" },
    });
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("renderLane", () => {
  const lane: Lane = {
    id: "related",
    title: "Related",
    expanded: true,
    render: (doc) => {
      const p = doc.createElement("p");
      p.textContent = "lane body";
      return p;
    },
  };

  test("renders a native collapsible with the title in the summary", () => {
    const el = renderLane(document, lane);
    expect(el.tagName).toBe("DETAILS");
    expect(el.querySelector("summary")?.textContent).toBe("Related");
    expect(el.textContent).toContain("lane body");
  });
  test("expanded:false renders collapsed", () => {
    const el = renderLane(document, { ...lane, expanded: false });
    expect((el as HTMLDetailsElement).open).toBe(false);
  });
});

describe("renderShell", () => {
  const header: HeaderState = { kind: "unrecognised" };
  const lane = (id: string): Lane => ({
    id,
    title: id,
    expanded: true,
    render: (doc) => doc.createElement("p"),
  });

  test("renders the header and one node per lane, in order", () => {
    const el = renderShell(document, { header, lanes: [lane("a"), lane("b")] });
    const lanes = el.querySelectorAll("details");
    expect(lanes).toHaveLength(2);
    expect(lanes[0]?.querySelector("summary")?.textContent).toBe("a");
    expect(el.querySelector(".nimbus-related__header-state")).not.toBeNull();
  });
  test("a shell with no lanes still renders its header", () => {
    const el = renderShell(document, { header, lanes: [] });
    expect(el.textContent).toContain("Not a recognised Nimbus surface");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run test/unit/panel-view.test.ts`
Expected: FAIL — `renderHeader`, `renderLane`, `renderShell` are not exported.

- [ ] **Step 3: Implement the shell**

Append to `src/panel/panel-view.ts` (keep `safeHttpUrl`, `renderError`, `renderHit`, `renderHits` exactly as they are — `renderHits` is reused verbatim as the first lane's body):

```ts
/**
 * What the panel header says. One state per outcome — never a silent blank.
 *
 * NOTE: `loading` carries no surface line. The spec's header table lists a
 * "recognised, resolving" state, but that state cannot occur on the client:
 * recognition and resolution are decided together in the service worker and
 * arrive in ONE response, so the panel goes straight from `loading` to a settled
 * state. This is a direct consequence of the spec's own one-round-trip decision.
 */
export type HeaderState =
  | { readonly kind: "loading" }
  | { readonly kind: "unrecognised" }
  | { readonly kind: "resolved"; readonly surface: string; readonly item: ResolvedItem }
  | { readonly kind: "not-indexed"; readonly surface: string }
  | { readonly kind: "error"; readonly surface: string | null; readonly message: string };

/** A collapsible section of the panel. Phase C2 adds why/impact/expert here. */
export interface Lane {
  readonly id: string;
  readonly title: string;
  readonly expanded: boolean;
  readonly render: (doc: Document) => HTMLElement;
}

export interface PanelState {
  readonly header: HeaderState;
  readonly lanes: readonly Lane[];
}

function line(doc: Document, className: string, text: string): HTMLElement {
  const el = doc.createElement("p");
  el.className = className;
  el.textContent = text;
  return el;
}

function itemLine(doc: Document, item: ResolvedItem): HTMLElement {
  const href = item.url !== null ? safeHttpUrl(item.url) : null;
  if (href === null) {
    return line(doc, "nimbus-related__header-item", item.title);
  }
  const wrapper = doc.createElement("p");
  wrapper.className = "nimbus-related__header-item";
  const link = doc.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = item.title;
  wrapper.append(link);
  return wrapper;
}

export function renderHeader(doc: Document, state: HeaderState): HTMLElement {
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
  if (state.kind === "error" && state.surface === null) {
    box.append(line(doc, "nimbus-related__status", state.message));
    return box;
  }

  box.append(line(doc, "nimbus-related__surface", state.surface));
  if (state.kind === "resolved") {
    box.append(itemLine(doc, state.item));
  } else if (state.kind === "not-indexed") {
    box.append(line(doc, "nimbus-related__status", "Not indexed."));
  } else {
    box.append(line(doc, "nimbus-related__status", state.message));
  }
  return box;
}

export function renderLane(doc: Document, lane: Lane): HTMLElement {
  const details = doc.createElement("details");
  details.className = "nimbus-related__lane";
  details.dataset["lane"] = lane.id;
  details.open = lane.expanded;
  const summary = doc.createElement("summary");
  summary.className = "nimbus-related__lane-title";
  summary.textContent = lane.title;
  details.append(summary, lane.render(doc));
  return details;
}

export function renderShell(doc: Document, state: PanelState): HTMLElement {
  const shell = doc.createElement("div");
  shell.className = "nimbus-related__shell";
  shell.append(renderHeader(doc, state.header));
  for (const lane of state.lanes) {
    shell.append(renderLane(doc, lane));
  }
  return shell;
}
```

Extend the file's type import to `import type { RelatedHit, ResolvedItem } from "../shared/types.ts";`

- [ ] **Step 4: Run it to verify it passes**

Run: `bunx vitest run test/unit/panel-view.test.ts`
Expected: PASS — the pre-existing tests plus 12 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/panel/panel-view.ts test/unit/panel-view.test.ts
git commit -m "feat(panel): header + lane shell for the recognition panel"
```

---

### Task 9: Wire the panel to resolve

The panel sends `resolve` and `related` **in parallel** and re-renders as each settles, so a slow or failing resolve never blocks related items.

**Files:**
- Modify: `src/panel/panel-in-page.ts`
- Test: `test/unit/panel-in-page.test.ts` (extend)

**Interfaces:**
- Consumes: `renderShell`, `HeaderState`, `Lane`, `PanelState`, `renderHits`, `renderError` (Task 8); `isResolveResponse` (Task 6); `surfaceLine` (Task 2).
- Produces: nothing importable (entry point).

- [ ] **Step 1: Write the failing test**

Append to `test/unit/panel-in-page.test.ts`, following the file's existing `loadPanel()` / `harness.sendMessage.mockImplementation(...)` pattern. Route by message kind, since two messages now go out:

```ts
describe("recognition header", () => {
  const item = {
    id: "i1",
    service: "github",
    type: "pr",
    title: "Add thing",
    canonicalUrl: "https://github.com/acme/web/pull/1",
    url: "https://github.com/acme/web/pull/1",
  };
  const recognition = {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref: "acme/web #1",
    resolveUrl: "https://github.com/acme/web/pull/1",
  } as const;

  /** Answer both messages the panel sends, by kind. */
  function respond(resolveResponse: unknown, relatedItems: RelatedHit[] = [hit]): void {
    harness.sendMessage.mockImplementation(async (message: unknown) => {
      const kind = (message as { kind?: string }).kind;
      if (kind === "resolve") {
        return resolveResponse;
      }
      return { kind: "related", ok: true, items: relatedItems };
    });
  }

  test("sends the page url for resolution", async () => {
    respond({ kind: "resolve", ok: true, recognition, item });
    await loadPanel();
    await flush();
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resolve", pageUrl: window.location.href }),
    );
  });

  test("a resolved item is named in the header", async () => {
    respond({ kind: "resolve", ok: true, recognition, item });
    await loadPanel();
    await flush();
    expect(shadow()?.textContent).toContain("GitHub PR · acme/web #1");
    expect(shadow()?.textContent).toContain("Add thing");
  });

  test("a miss says not indexed, and does NOT imply the related hits are the page", async () => {
    respond({ kind: "resolve", ok: true, recognition, item: null });
    await loadPanel();
    await flush();
    expect(shadow()?.textContent).toContain("Not indexed");
  });

  test("an unsupported gateway is a first-class state, not an error", async () => {
    respond({ kind: "resolve", ok: false, recognition, reason: "unsupported" });
    await loadPanel();
    await flush();
    expect(shadow()?.textContent).toContain("can't resolve pages yet");
  });

  test("the related lane still renders when resolve fails", async () => {
    respond({ kind: "resolve", ok: false, recognition, reason: "unreachable" });
    await loadPanel();
    await flush();
    expect(shadow()?.querySelectorAll(".nimbus-related__item")).toHaveLength(1);
  });

  test("an unrecognised page still renders the related lane", async () => {
    respond({
      kind: "resolve",
      ok: true,
      recognition: { ok: false, reason: "unknown-host" },
      item: null,
    });
    await loadPanel();
    await flush();
    expect(shadow()?.textContent).toContain("Not a recognised Nimbus surface");
    expect(shadow()?.querySelectorAll(".nimbus-related__item")).toHaveLength(1);
  });

  test("a malformed resolve response degrades to an error header, never a crash", async () => {
    respond({ kind: "resolve", ok: true });
    await loadPanel();
    await flush();
    expect(shadow()?.textContent).toContain("Unexpected response");
  });
});
```

Add `flush` to the file if it isn't already defined:

```ts
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run test/unit/panel-in-page.test.ts`
Expected: FAIL — no `resolve` message is sent; no header text.

- [ ] **Step 3: Rewire the panel**

In `src/panel/panel-in-page.ts`:

Replace the imports at the top with:

```ts
import { sendMessage } from "../browser/runtime.ts";
import { isRelatedResponse, isResolveResponse } from "../shared/messages.ts";
import { surfaceLine } from "../shared/recognise.ts";
import type { RelatedHit } from "../shared/types.ts";
import {
  type HeaderState,
  type Lane,
  renderError,
  renderHits,
  renderShell,
} from "./panel-view.ts";
```

Add the resolve message table next to `RELATED_MESSAGES`:

```ts
const RESOLVE_MESSAGES: Record<string, string> = {
  not_paired: "Pair a browser first (Options).",
  unauthorized: "Pairing expired — re-pair in Options.",
  unsupported: "This Nimbus gateway can't resolve pages yet.",
  unreachable: "Can't reach Nimbus — is the gateway running?",
  server_error: "Nimbus had an error resolving this page.",
};
```

Add these styles to the `STYLES` template literal:

```css
.nimbus-related__shell { display: flex; flex-direction: column; }
.nimbus-related__header-state { padding: 12px 16px; border-bottom: 1px solid var(--nimbus-border); }
.nimbus-related__surface { margin: 0; font-weight: 600; }
.nimbus-related__header-item { margin: 4px 0 0; }
.nimbus-related__header-item a { color: var(--nimbus-accent); text-decoration: none; }
.nimbus-related__lane { border-bottom: 1px solid var(--nimbus-border); }
.nimbus-related__lane-title { cursor: pointer; padding: 10px 16px; font-weight: 600; }
```

Replace the `query` function with the state-plus-rerender pair below, and keep `readContext` as it is (the related query still uses the DOM canonical link — a different question from recognition):

```ts
// The panel holds one state and re-renders it. Resolve and related are fetched in
// PARALLEL and land independently: a slow or failing resolve must never keep the
// related lane from appearing.
let header: HeaderState = { kind: "loading" };
let relatedBody: (doc: Document) => HTMLElement = (doc) => renderError(doc, "Loading…");

function paint(body: HTMLElement): void {
  const lanes: Lane[] = [
    { id: "related", title: "Related", expanded: true, render: relatedBody },
  ];
  body.replaceChildren(renderShell(document, { header, lanes }));
}

function headerFrom(res: unknown): HeaderState {
  if (!isResolveResponse(res)) {
    return { kind: "error", surface: null, message: "Unexpected response." };
  }
  const surface = surfaceLine(res.recognition);
  if (surface === null) {
    return { kind: "unrecognised" };
  }
  if (!res.ok) {
    return {
      kind: "error",
      surface,
      message: RESOLVE_MESSAGES[res.reason] ?? "Couldn't resolve this page.",
    };
  }
  return res.item === null
    ? { kind: "not-indexed", surface }
    : { kind: "resolved", surface, item: res.item };
}

async function loadHeader(body: HTMLElement): Promise<void> {
  let res: unknown;
  try {
    res = await sendMessage({ kind: "resolve", pageUrl: window.location.href, title: document.title });
  } catch {
    header = { kind: "error", surface: null, message: "Couldn't connect to Nimbus." };
    paint(body);
    return;
  }
  header = headerFrom(res);
  paint(body);
}

async function loadRelated(body: HTMLElement): Promise<void> {
  let res: unknown;
  try {
    res = await sendMessage({ kind: "related", ...readContext() });
  } catch {
    relatedBody = (doc) => renderError(doc, "Couldn't connect to Nimbus.");
    paint(body);
    return;
  }
  if (!isRelatedResponse(res)) {
    relatedBody = (doc) => renderError(doc, "Unexpected response.");
  } else if (res.ok) {
    const items: RelatedHit[] = res.items;
    relatedBody = (doc) => renderHits(doc, items);
  } else {
    const message = RELATED_MESSAGES[res.reason] ?? "Couldn't fetch related items.";
    relatedBody = (doc) => renderError(doc, message);
  }
  paint(body);
}
```

In `mount()`, replace the initial body content and the single `void query(body)` call with:

```ts
  const body = document.createElement("div");
  body.className = "nimbus-related__body";
  paint(body);
```

and, at the end of `mount()` where `void query(body)` used to be:

```ts
  // Parallel on purpose — neither request gates the other.
  void loadHeader(body);
  void loadRelated(body);
```

Reset the module state at the **top** of `mount()` — before the `paint(body)` call above — so a re-injection starts clean rather than flashing the previous page's header:

```ts
  header = { kind: "loading" };
  relatedBody = (doc) => renderError(doc, "Loading…");
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/panel-in-page.test.ts`
Expected: PASS — the pre-existing panel tests plus 7 new ones.

- [ ] **Step 5: Full check + build**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all clean.

- [ ] **Step 6: Manual verification**

In one terminal: `bun run mock-gateway`. Load `dist/chrome` via `chrome://extensions` → Load unpacked. Pair against `http://127.0.0.1:8765` with any 6-digit code. Then:

1. Open `https://github.com/acme/web/pull/482` (any real GitHub PR URL) and press `Alt+Shift+R`.
   Expected: header reads `GitHub PR · acme/web #482` and names the mock's resolved item.
2. Open any non-code page and press `Alt+Shift+R`.
   Expected: "Not a recognised Nimbus surface", and the Related lane still renders.
3. Stop the mock gateway and repeat step 1.
   Expected: the surface line still shows; the header says the gateway is unreachable.

- [ ] **Step 7: Commit**

```bash
git add src/panel/panel-in-page.ts test/unit/panel-in-page.test.ts
git commit -m "feat(panel): resolve the current page and lead with what it is"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/architecture.md`, `docs/development.md`, `CHANGELOG.md`, `ROADMAP.md`, `store/listing.md` (or the equivalent listing-copy file in `store/`)
- Test: `test/unit/store-listing.test.ts` may assert listing content — run the suite and update it if it fails.

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Document the recognition layer in `docs/architecture.md`**

Add a section after the clip-pipeline section, matching the file's existing tone and depth:

- The recognition layer: `shared/origins.ts` (configured origins, longest-prefix-wins) → `shared/recognise.ts` (pure classification + canonicalisation) → `background/handlers.ts#handleResolve` → `POST /v1/clips/resolve`.
- Why recognition runs in the SW, not the injected panel (storage + token + node-testable purity).
- Why `location.href` is the recognition input while the related query keeps using the DOM canonical link.
- That `POST /v1/clips/resolve` is **proposed, not contracted**, and that `404 → unsupported` is deliberate and distinct from a `200 { item: null }` miss.
- That page access (`optional_host_permissions`) is a different axis from the loopback network destination, and grants are host-scoped.

- [ ] **Step 2: Add the manual checklist to `docs/development.md`**

Append to the manual-verification checklist:

- Add a self-hosted surface with a path prefix in Options; confirm a matching page is recognised and a sibling path on the same host is not.
- Confirm the panel recognises pages **before** any grant (the `Alt+Shift+R` gesture supplies `activeTab`).
- Grant page access for a host, then revoke it; confirm the shared-host note appears when the host carries more than one prefix.
- Confirm the panel's Related lane renders in every header state, including with the gateway stopped.

- [ ] **Step 3: Add the CHANGELOG entry**

Under `## [Unreleased]`, add an `### Added` section:

```markdown
### Added

- **The panel knows what page you're on.** On a Bitbucket, GitHub or GitLab pull
  request, a Jenkins build or a Jira issue, the related-items panel now leads with
  what the page is — "GitHub PR · acme/web #482" — and, where the gateway supports
  it, the exact indexed item it resolves to. Resolution is at most one item: on a
  miss the panel says "Not indexed" rather than passing loose search hits off as
  the page. The panel is still opened by you (`Alt+Shift+R` or the popup button);
  nothing appears on its own.
- **Self-hosted instances are configurable.** Bitbucket Cloud, GitHub, GitLab and
  Jira Cloud are recognised with no setup. Self-hosted Bitbucket, Jenkins and Jira
  are added under **Recognised surfaces** in Options as a URL plus which product it
  is — including instances behind a reverse proxy on a sub-path, e.g.
  `https://corp.example/jira`. The product is never guessed from the URL shape.
- **Opt-in page access, per host.** Options can grant Nimbus permission to
  recognise pages on a site without you opening the panel first, and revoke it
  again. Nothing is granted at install. This is page access only — it does not
  change where Nimbus can send data, which remains your local gateway on
  `127.0.0.1` and nothing else.
```

Note that resolution requires a gateway route that is still being proposed upstream; until it ships, the panel says so plainly ("This Nimbus gateway can't resolve pages yet") and everything else works.

- [ ] **Step 4: Update `ROADMAP.md`**

- In the **Foundation — shipped** list, add a bullet for surface recognition + the panel shell.
- On **C1.2**, **C1.3** and **C1.4**, mark the client work shipped.
- On **C1.1**, note that the client path is built and degrades to `unsupported`, and that the gateway proposal is written up in the C1 design spec.

- [ ] **Step 5: Update the store listing copy**

In `store/`, extend the permissions/privacy copy to explain `optional_host_permissions` before a reviewer or user meets it cold:

- Chrome will show "Read your data on all websites" as an **optional** permission.
- It is never granted at install, only per-site when the user clicks Grant.
- Self-hosted Bitbucket/Jenkins/Jira hostnames cannot be enumerated in advance, which is why the pattern is broad.
- Page access does not change the network destination: `127.0.0.1` / `localhost`, still nothing else.

- [ ] **Step 6: Run the full suite**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all clean. If `test/unit/store-listing.test.ts` asserts on listing text that changed, update the assertion to match the new copy.

- [ ] **Step 7: Commit**

```bash
git add docs/ CHANGELOG.md ROADMAP.md store/ test/unit/store-listing.test.ts
git commit -m "docs: recognition layer, C1 status and the optional-permission copy"
```

---

## Notes for the implementer

- **The 404 mapping is not a detail.** `POST /v1/clips/resolve` does not exist upstream yet. If you find yourself tempted to synthesise resolution from `/v1/clips/related`, stop — `/related` uses `canonicalUrl` to *exclude* the current host, and faking resolution from ranked hits is the one thing this design forbids.
- **`recognise()` must never throw.** It takes arbitrary tab URLs (`chrome://`, `file:`, `about:blank`, malformed strings). Every failure path returns a `Recognition` with `ok: false`.
- **Don't widen `host_permissions`.** If a task seems to need it, the design is wrong — re-read the spec's Constraints.
- **Watch `noUncheckedIndexedAccess`.** `segments[0]` is `string | undefined`. Destructure and check; don't reach for `!` (Biome's `noNonNullAssertion` will fail anyway).
- **One follow-up lives outside this repo.** The `POST /v1/clips/resolve` proposal has to be opened in the [Nimbus gateway repo](https://github.com/nimbus-agent/Nimbus) — the "Proposed gateway contract" and "Resolved and deferred questions" sections of the design spec are the brief to file there. No task here blocks on it; the client ships degraded until it lands.
