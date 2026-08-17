# Research Briefs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pick several open tabs, ask one scaffolded question about them, and read a cited research brief with conflicts and gaps — then keep it.

**Architecture:** A new extension page (`brief.html`) composes the request; the service worker owns the staged gateway protocol (create → capture each tab → feed → run → poll) and pushes state to the page. Pure modules hold every decision: caps and question scaffolding, report guards, log eviction. Two `chrome.storage.local` stores — the in-flight run and an append-only egress disclosure log — neither of which ever holds source text.

**Tech Stack:** TypeScript strict (no `any`), Vitest (node env; jsdom via docblock), esbuild → IIFE bundles, Biome, MV3 (`chrome.*` seam in `src/browser/`), `bun` for every script.

**Spec:** [`docs/superpowers/specs/2026-08-17-research-briefs-design.md`](../specs/2026-08-17-research-briefs-design.md)

## Global Constraints

- **TypeScript strict, no `any`.** Cross-boundary data is `unknown`, narrowed by a guard in `src/shared/messages.ts`. Biome enforces `noExplicitAny`, `noNonNullAssertion`.
- **No `console.*` anywhere in `src/`.** `noConsole` is `"error"` in `biome.json` for `src/`. Tests and `scripts/` may log.
- **Never log or render the bearer token.** Never log the pairing code.
- **Loopback only.** No new host permissions, no fetch beyond `127.0.0.1` / `localhost`.
- **No new manifest permission.** `permissions` stays exactly `["activeTab", "scripting", "storage", "alarms", "contextMenus"]`. Adding one fails `test/unit/store-listing.test.ts` until `store/listing.md` is updated — and this slice needs none.
- **No source text in `chrome.storage.local`, ever.** Run records and log entries hold metadata only.
- **Client extraction cap is `200 * 1024` bytes** per source body — NOT the gateway's `MAX_SOURCE_BYTES` (256 KB). `MAX_RUN_BYTES / MAX_SOURCE_BYTES` is exactly 16, so cutting at 256 KB would refuse the 17th source of a 20-tab brief.
- **Gateway caps, verbatim:** `MAX_SOURCES_PER_RUN` 20, `MAX_SOURCE_BYTES` 262144, `MAX_RUN_BYTES` 4194304, `MAX_BRIEF_CHARS` 4000, `DEFAULT_RUN_TTL_MS` 1800000, `MAX_CONCURRENT_RUNS` 3, `MAX_RETAINED_TERMINAL_RUNS` 16.
- **No `vi.mock()`.** Dependency injection: handlers and stores take deps as an object.
- **Test-module ordering for entry points:** `installChromeMock()` → seed storage → `vi.resetModules()` → `await import(...)` → settle.
- **Every fire-and-forget promise carries `.catch(() => undefined)`** — an unhandled rejection fails the Vitest run.
- **Gates, all five, before every commit:** `bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`, `bun run check-build`.
- **THIS PLAN FILE MAKES EXACTLY ONE TEST FAIL, and that is expected.**
  `test/unit/doc-references.test.ts > plans are pruned, per the convention CLAUDE.md states`
  asserts `docs/superpowers/plans/` is empty — the repo's way of ensuring a shipped
  feature took its plan with it (added in `1947a7b`, PR #55, after pruning 19
  delivered plans). So every "Expected: all pass" step below means **all pass except
  that one line**. Check the failure list is exactly:

  ```
  FAIL test/unit/doc-references.test.ts > references to docs/superpowers resolve > plans are pruned, per the convention CLAUDE.md states
  ```

  Any second failure is real. Task 14 clears the directory, which is what turns the
  gate green — do not merge to `main` with it still present, and do not "fix" the
  assertion. Note the assertion counts **every** `.md` in that folder, so review
  notes left beside this plan grow the reported array without adding a second
  failing test: still one red line, listing more files.

---

### Task 1: Caps, question scaffolding, and payload builders

**Files:**
- Create: `src/shared/brief.ts`
- Test: `test/unit/brief.test.ts`

**Interfaces:**
- Consumes: `Recognition`, `SurfaceKind`, `Product` from `src/shared/types.ts`.
- Produces:
  - `BRIEF_CAPS: { readonly maxSources: 20; readonly extractionCapBytes: 204800; readonly maxRunBytes: 4194304; readonly maxQuestionChars: 4000 }`
  - `utf8Bytes(s: string): number`
  - `suggestQuestions(recognitions: readonly Recognition[]): readonly string[]`
  - `type BriefSourceDecl = { readonly url: string; readonly title: string }`
  - `buildCreateBody(question: string, sources: readonly BriefSourceDecl[]): { brief: string; sources: BriefSourceDecl[]; useIndex: false }`
  - `type BriefSourceBody = { readonly url: string; readonly title: string; readonly body: string; readonly capturedAt: number; readonly truncated: boolean }`
  - `buildSourceBody(src: { url: string; title: string; body: string; capturedAt: number }): BriefSourceBody`

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/brief.test.ts
import { describe, expect, it } from "vitest";
import {
  BRIEF_CAPS,
  buildCreateBody,
  buildSourceBody,
  suggestQuestions,
  utf8Bytes,
} from "../../src/shared/brief.ts";
import type { Recognition } from "../../src/shared/types.ts";

function pr(ref: string): Recognition {
  return {
    ok: true,
    product: "github",
    kind: "pr",
    label: "GitHub PR",
    ref,
    resolveUrl: `https://github.com/acme/web/pull/${ref}`,
  };
}
function issue(ref: string): Recognition {
  return {
    ok: true,
    product: "jira",
    kind: "issue",
    label: "Jira issue",
    ref,
    resolveUrl: `https://acme.atlassian.net/browse/${ref}`,
  };
}
const unknown: Recognition = { ok: false, reason: "unknown-host" };

describe("utf8Bytes", () => {
  it("counts bytes, not code units", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("😀")).toBe(4);
  });
});

describe("suggestQuestions", () => {
  it("offers change-shaped questions for two or more pull requests", () => {
    const qs = suggestQuestions([pr("1"), pr("2")]);
    expect(qs).toContain("What do these changes disagree about?");
    expect(qs).toContain("What breaks if all of these land?");
  });

  it("offers issue-shaped questions for two or more issues", () => {
    const qs = suggestQuestions([issue("A-1"), issue("A-2")]);
    expect(qs).toContain("What is the common thread?");
  });

  it("offers relational questions for a mixed recognised set", () => {
    const qs = suggestQuestions([pr("1"), issue("A-1")]);
    expect(qs).toContain("How do these relate?");
  });

  it("still offers questions when nothing is recognised", () => {
    const qs = suggestQuestions([unknown, unknown]);
    expect(qs).toContain("Where do these contradict each other?");
    expect(qs).toContain("What do these agree on?");
  });

  it("never returns an empty list", () => {
    expect(suggestQuestions([]).length).toBeGreaterThan(0);
  });

  it("returns no duplicates", () => {
    const qs = suggestQuestions([pr("1"), pr("2"), issue("A-1")]);
    expect(new Set(qs).size).toBe(qs.length);
  });
});

describe("buildSourceBody", () => {
  it("passes a small body through untruncated", () => {
    const out = buildSourceBody({
      url: "https://example.com/a",
      title: "A",
      body: "short",
      capturedAt: 1000,
    });
    expect(out.body).toBe("short");
    expect(out.truncated).toBe(false);
    expect(out.capturedAt).toBe(1000);
  });

  it("cuts an over-cap body and flags it", () => {
    const body = "y".repeat(BRIEF_CAPS.extractionCapBytes + 500);
    const out = buildSourceBody({ url: "u", title: "t", body, capturedAt: 1 });
    expect(out.truncated).toBe(true);
    expect(utf8Bytes(out.body)).toBeLessThanOrEqual(BRIEF_CAPS.extractionCapBytes);
  });

  it("cuts on BYTES, not characters, so multi-byte text cannot exceed the cap", () => {
    const body = "😀".repeat(BRIEF_CAPS.extractionCapBytes); // 4 bytes each
    const out = buildSourceBody({ url: "u", title: "t", body, capturedAt: 1 });
    expect(utf8Bytes(out.body)).toBeLessThanOrEqual(BRIEF_CAPS.extractionCapBytes);
  });

  it("never splits a multi-byte character in half", () => {
    const body = "😀".repeat(BRIEF_CAPS.extractionCapBytes);
    const out = buildSourceBody({ url: "u", title: "t", body, capturedAt: 1 });
    expect(out.body.includes("�")).toBe(false);
    expect([...out.body].every((c) => c === "😀")).toBe(true);
  });

  it("THE RUN BUDGET: 20 sources cut at the extraction cap fit inside MAX_RUN_BYTES", () => {
    // The reason the cut is 200 KB and not the gateway's 256 KB ceiling.
    // Cutting at MAX_SOURCE_BYTES would fit only 4194304/262144 = 16 sources.
    const url = "https://example.com/some/reasonably/long/path/to/a/pull/request/12345";
    const title = "A fairly long tab title of the sort a real pull request page has";
    const one =
      BRIEF_CAPS.extractionCapBytes + utf8Bytes(url) + utf8Bytes(title);
    expect(one * BRIEF_CAPS.maxSources).toBeLessThanOrEqual(BRIEF_CAPS.maxRunBytes);
  });
});

describe("buildCreateBody", () => {
  it("declares every source and pins useIndex false for this slice", () => {
    const body = buildCreateBody("Why?", [
      { url: "https://example.com/1", title: "One" },
      { url: "https://example.com/2", title: "Two" },
    ]);
    expect(body.brief).toBe("Why?");
    expect(body.sources).toHaveLength(2);
    expect(body.useIndex).toBe(false);
  });

  it("cuts an over-long question to the gateway's character cap", () => {
    const body = buildCreateBody("q".repeat(BRIEF_CAPS.maxQuestionChars + 10), []);
    expect(body.brief.length).toBe(BRIEF_CAPS.maxQuestionChars);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/brief.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/shared/brief.ts"`.

- [ ] **Step 3: Write the implementation**

```ts
// src/shared/brief.ts
// Pure decisions for a research brief: the caps, which questions a tab set
// deserves, and the two request bodies.
//
// The extraction cap is the load-bearing constant here and it is NOT the
// gateway's per-source ceiling. `MAX_RUN_BYTES / MAX_SOURCE_BYTES` is exactly
// 16, so a client cutting at 256 KB fits sixteen sources into a run whose
// declared limit is twenty — the seventeenth feed is refused, every time.
// Upstream sized the run budget against a 200 KB client cap and says so:
// "256 KB against the client's 200 KB extraction cap" (brief-constants.ts).
import type { Recognition } from "./types.ts";

export const BRIEF_CAPS = {
  /** Gateway `MAX_SOURCES_PER_RUN`. */
  maxSources: 20,
  /** THIS CLIENT's extraction cap — see the module comment. */
  extractionCapBytes: 200 * 1024,
  /** Gateway `MAX_RUN_BYTES`. Held here to assert the budget in tests. */
  maxRunBytes: 4 * 1024 * 1024,
  /** Gateway `MAX_BRIEF_CHARS`. */
  maxQuestionChars: 4000,
} as const;

const ENCODER = new TextEncoder();

export function utf8Bytes(s: string): number {
  return ENCODER.encode(s).length;
}

/**
 * Cut `s` to at most `maxBytes` UTF-8 bytes without splitting a character.
 *
 * Byte-based, never `slice(0, n)` on code units: a body of astral-plane text is
 * four bytes per character, so a character-count cut would send four times the
 * cap. Walks back off a partial character rather than emitting U+FFFD, because a
 * replacement character in a source body would be quoted back to the user as if
 * the page contained it.
 */
function cutToBytes(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) {
    return s;
  }
  let out = "";
  let used = 0;
  for (const ch of s) {
    const size = utf8Bytes(ch);
    if (used + size > maxBytes) {
      break;
    }
    out += ch;
    used += size;
  }
  return out;
}

const Q_PR_DISAGREE = "What do these changes disagree about?";
const Q_PR_BREAK = "What breaks if all of these land?";
const Q_ISSUE_THREAD = "What is the common thread?";
const Q_CONTRADICT = "Where do these contradict each other?";
const Q_RELATE = "How do these relate?";
const Q_AGREE = "What do these agree on?";

/**
 * The questions a tab set earns, from the SHAPE of what was recognised.
 *
 * This is what keeps the feature on the right side of the roadmap's "not a
 * generic ask box" non-goal: the surface leads with what it already knows about
 * the tabs, and free text is a collapsed control beside these, not the entry
 * point. Adding a question is one row.
 *
 * Never returns an empty list — a set of entirely unrecognised tabs is still a
 * set of documents, and "where do these contradict each other" is answerable
 * about any of them.
 */
export function suggestQuestions(recognitions: readonly Recognition[]): readonly string[] {
  const kinds = recognitions.filter((r) => r.ok).map((r) => r.kind);
  const prs = kinds.filter((k) => k === "pr").length;
  const issues = kinds.filter((k) => k === "issue").length;
  const out: string[] = [];
  if (prs >= 2) {
    out.push(Q_PR_DISAGREE, Q_PR_BREAK);
  }
  if (issues >= 2) {
    out.push(Q_ISSUE_THREAD, Q_CONTRADICT);
  }
  if (out.length === 0 && kinds.length >= 2) {
    out.push(Q_RELATE, Q_CONTRADICT);
  }
  if (out.length === 0) {
    out.push(Q_CONTRADICT, Q_AGREE);
  }
  return [...new Set(out)];
}

export type BriefSourceDecl = {
  readonly url: string;
  readonly title: string;
};

/**
 * The create body. Every picked tab is DECLARED here even though some may fail
 * to capture: `BriefRun.declared` is fixed at create and never grows, and the
 * gateway reports the shortfall in the report's `gaps` ("2 of 3"). Declaring
 * only the survivors would hide it.
 */
export function buildCreateBody(
  question: string,
  sources: readonly BriefSourceDecl[],
): { brief: string; sources: BriefSourceDecl[]; useIndex: false } {
  return {
    brief: cutToBytes(question.slice(0, BRIEF_CAPS.maxQuestionChars), BRIEF_CAPS.maxQuestionChars),
    sources: sources.slice(0, BRIEF_CAPS.maxSources).map((s) => ({ url: s.url, title: s.title })),
    useIndex: false,
  };
}

export type BriefSourceBody = {
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly capturedAt: number;
  readonly truncated: boolean;
};

/**
 * One fed source.
 *
 * Truncate-and-DECLARE, the opposite of this repo's clip path. `POST /v1/clips`
 * has no way to say a body was cut, so a truncated clip would be a silent lie
 * (Nimbus#1005). `BriefSource.truncated` is a contract field, so here the honest
 * move is to cut and say so.
 */
export function buildSourceBody(src: {
  url: string;
  title: string;
  body: string;
  capturedAt: number;
}): BriefSourceBody {
  const body = cutToBytes(src.body, BRIEF_CAPS.extractionCapBytes);
  return {
    url: src.url,
    title: src.title,
    body,
    capturedAt: src.capturedAt,
    truncated: body.length !== src.body.length,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/brief.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass; 1120 + 13 tests.

- [ ] **Step 6: Commit**

```bash
git add src/shared/brief.ts test/unit/brief.test.ts
git commit -m "feat(brief): caps, question scaffolding and payload builders"
```

---

### Task 2: Report types, guards, and the disclosure filter

**Files:**
- Create: `src/shared/brief-report.ts`
- Test: `test/unit/brief-report.test.ts`

**Interfaces:**
- Produces:
  - `type BriefCitation = { readonly kind: "source" | "clip"; readonly title: string; readonly url?: string; readonly clipId?: string; readonly quote?: string }`
  - `type BriefReportItem = { readonly text: string; readonly citations: readonly BriefCitation[] }`
  - `type BriefSynthesis = { readonly model: string; readonly remote: boolean; readonly disclosure?: string }`
  - `type BriefReport = { readonly summary: string; readonly findings: readonly BriefReportItem[]; readonly conflicts: readonly BriefReportItem[]; readonly gaps: readonly string[]; readonly synthesis: BriefSynthesis }`
  - `isBriefReport(v: unknown): v is BriefReport`
  - `visibleGaps(report: BriefReport): readonly string[]`
  - `QUOTES_OMITTED_GAP: string`
  - `quotesWereOmitted(report: BriefReport): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/brief-report.test.ts
import { describe, expect, it } from "vitest";
import {
  type BriefReport,
  QUOTES_OMITTED_GAP,
  isBriefReport,
  quotesWereOmitted,
  visibleGaps,
} from "../../src/shared/brief-report.ts";

function report(over: Partial<BriefReport> = {}): BriefReport {
  return {
    summary: "s",
    findings: [{ text: "f", citations: [{ kind: "source", title: "One" }] }],
    conflicts: [],
    gaps: [],
    synthesis: { model: "llama3", remote: false },
    ...over,
  };
}

describe("isBriefReport", () => {
  it("accepts a well-formed local report", () => {
    expect(isBriefReport(report())).toBe(true);
  });

  it("accepts a remote report carrying a disclosure", () => {
    expect(
      isBriefReport(
        report({
          gaps: ["Synthesised remotely."],
          synthesis: { model: "gpt", remote: true, disclosure: "Synthesised remotely." },
        }),
      ),
    ).toBe(true);
  });

  it("rejects a missing synthesis block", () => {
    const { synthesis: _drop, ...rest } = report();
    expect(isBriefReport(rest)).toBe(false);
  });

  it("rejects a non-boolean remote flag", () => {
    expect(isBriefReport(report({ synthesis: { model: "m", remote: "yes" } as never }))).toBe(false);
  });

  it("rejects a citation whose kind is not source or clip", () => {
    expect(
      isBriefReport(report({ findings: [{ text: "f", citations: [{ kind: "web", title: "t" } as never] }] })),
    ).toBe(false);
  });

  it("rejects non-objects and null", () => {
    expect(isBriefReport(null)).toBe(false);
    expect(isBriefReport("report")).toBe(false);
    expect(isBriefReport(undefined)).toBe(false);
  });
});

describe("visibleGaps", () => {
  it("suppresses the disclosure duplicate BY EQUALITY", () => {
    const r = report({
      gaps: ["Only 2 of 3 sources were read.", "Synthesised on a remote model."],
      synthesis: { model: "gpt", remote: true, disclosure: "Synthesised on a remote model." },
    });
    expect(visibleGaps(r)).toEqual(["Only 2 of 3 sources were read."]);
  });

  it("keeps a gap that merely resembles the disclosure", () => {
    // Guards against anyone replacing the equality check with a pattern match.
    const r = report({
      gaps: ["Synthesised on a remote model (see docs)."],
      synthesis: { model: "gpt", remote: true, disclosure: "Synthesised on a remote model." },
    });
    expect(visibleGaps(r)).toHaveLength(1);
  });

  it("returns gaps unchanged when there is no disclosure", () => {
    const r = report({ gaps: ["a", "b"] });
    expect(visibleGaps(r)).toEqual(["a", "b"]);
  });
});

describe("quotesWereOmitted", () => {
  it("detects the save-time quote-stripping gap", () => {
    expect(quotesWereOmitted(report({ gaps: [QUOTES_OMITTED_GAP] }))).toBe(true);
  });

  it("is false for an ordinary report", () => {
    expect(quotesWereOmitted(report())).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/brief-report.test.ts`
Expected: FAIL — cannot resolve `src/shared/brief-report.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/shared/brief-report.ts
// The report a finished brief carries, and the two honesty rules that read it.
//
// Mirrors packages/gateway/src/briefs/brief-types.ts. A report crosses the
// gateway boundary and then the SW→page boundary, so it is `unknown` until a
// guard says otherwise — same rule as every other cross-boundary value here.

export type BriefCitation = {
  readonly kind: "source" | "clip";
  readonly title: string;
  readonly url?: string;
  readonly clipId?: string;
  readonly quote?: string;
};

export type BriefReportItem = {
  readonly text: string;
  readonly citations: readonly BriefCitation[];
};

export type BriefSynthesis = {
  readonly model: string;
  readonly remote: boolean;
  /**
   * Present iff `remote`. The EXACT string also appended to `gaps` — see
   * `visibleGaps`.
   */
  readonly disclosure?: string;
};

export type BriefReport = {
  readonly summary: string;
  readonly findings: readonly BriefReportItem[];
  /** Every entry carries >= 2 distinct citations; the gateway's validator enforces it. */
  readonly conflicts: readonly BriefReportItem[];
  readonly gaps: readonly string[];
  readonly synthesis: BriefSynthesis;
};

/**
 * The gap `brief-save.ts` appends when a report exceeds the item metadata
 * ceiling and its supporting quotes are stripped from the SAVED copy. Copied
 * verbatim from upstream: this is matched by equality, so a reworded upstream
 * string must be updated here rather than pattern-matched around.
 */
export const QUOTES_OMITTED_GAP =
  "Supporting quotes were omitted from the saved copy (size limit).";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isCitation(v: unknown): v is BriefCitation {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] !== "source" && v["kind"] !== "clip") {
    return false;
  }
  return (
    typeof v["title"] === "string" &&
    (v["url"] === undefined || typeof v["url"] === "string") &&
    (v["clipId"] === undefined || typeof v["clipId"] === "string") &&
    (v["quote"] === undefined || typeof v["quote"] === "string")
  );
}

function isReportItem(v: unknown): v is BriefReportItem {
  return (
    isObject(v) &&
    typeof v["text"] === "string" &&
    Array.isArray(v["citations"]) &&
    v["citations"].every(isCitation)
  );
}

function isSynthesis(v: unknown): v is BriefSynthesis {
  return (
    isObject(v) &&
    typeof v["model"] === "string" &&
    typeof v["remote"] === "boolean" &&
    (v["disclosure"] === undefined || typeof v["disclosure"] === "string")
  );
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

export function isBriefReport(v: unknown): v is BriefReport {
  return (
    isObject(v) &&
    typeof v["summary"] === "string" &&
    Array.isArray(v["findings"]) &&
    v["findings"].every(isReportItem) &&
    Array.isArray(v["conflicts"]) &&
    v["conflicts"].every(isReportItem) &&
    isStringArray(v["gaps"]) &&
    isSynthesis(v["synthesis"])
  );
}

/**
 * `gaps` minus the remote disclosure, which is rendered as its own banner.
 *
 * BY EQUALITY, never by pattern. Upstream's own comment says why: `disclosure`
 * is "the EXACT string also appended to `gaps` … so a live view can suppress the
 * duplicate by equality rather than by pattern-matching prose the gateway might
 * later reword." A regex would pass today and silently double-render the
 * disclosure the first time upstream rewords a sentence.
 */
export function visibleGaps(report: BriefReport): readonly string[] {
  const disclosure = report.synthesis.disclosure;
  if (disclosure === undefined) {
    return report.gaps;
  }
  return report.gaps.filter((g) => g !== disclosure);
}

/** True when a SAVED report came back without its supporting quotes. */
export function quotesWereOmitted(report: BriefReport): boolean {
  return report.gaps.includes(QUOTES_OMITTED_GAP);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/brief-report.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/shared/brief-report.ts test/unit/brief-report.test.ts
git commit -m "feat(brief): report guards and the equality-based disclosure filter"
```

---

### Task 3: The five brief routes

**Files:**
- Modify: `src/shared/gateway.ts` (add `briefs` to `GATEWAY_PATHS`)
- Create: `src/background/brief-client.ts`
- Test: `test/unit/brief-client.test.ts`

**Interfaces:**
- Consumes: `endpointUrl`, `GatewayEndpoint` (`src/shared/gateway.ts`); `BriefSourceBody`, `BriefSourceDecl` (Task 1); `BriefReport`, `isBriefReport` (Task 2).
- Produces:
  - `type BriefError = "unreachable" | "unauthorized" | "insufficient_scope" | "briefs_disabled" | "not_found" | "expired" | "busy" | "rate_limited" | "server_error"`
  - `type FeedRefusal = "source_too_large" | "run_capacity"`
  - `type ScopeGap = { required: string; granted: string[] }`
  - `createBrief(origin, token, body, doFetch?): Promise<{ ok: true; id: string; expected: number } | { ok: false; reason: BriefError; scopeGap?: ScopeGap } | { ok: false; reason: "disabled"; hint?: string }>`
  - `feedBriefSource(origin, token, id, source, doFetch?): Promise<{ ok: true; received: number; expected: number } | { ok: false; reason: BriefError } | { ok: false; reason: "refused"; detail: FeedRefusal }>`
  - `runBrief(origin, token, id, doFetch?): Promise<{ ok: true } | { ok: false; reason: BriefError }>`
  - `getBrief(origin, token, id, doFetch?): Promise<{ ok: true; status: "collecting" | "running" } | { ok: true; status: "done"; report: BriefReport } | { ok: true; status: "failed"; failureReason?: string } | { ok: false; reason: BriefError }>`
  - `saveBrief(origin, token, id, doFetch?): Promise<{ ok: true; itemId: string } | { ok: false; reason: BriefError }>`

- [ ] **Step 1: Add the endpoint path**

In `src/shared/gateway.ts`, inside `GATEWAY_PATHS`, after the `agentRuns` entry, add:

```ts
  /**
   * BASE, not a complete path: create is `POST /v1/briefs`, and the other four
   * routes append `/{id}` and an action (`/sources`, `/run`, `/save`) which this
   * static map cannot express. Bearer-authed under the `briefs` scope — which is
   * a LEGACY scope (`clips/api-scopes.ts`'s `LEGACY_SCOPES = ["clip","briefs"]`),
   * so unlike `resolve`/`fetch`/`agents` every token already in the wild carries
   * it. Returns 404 `briefs_disabled` when the gateway's briefs seam is off.
   */
  briefs: "/v1/briefs",
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/unit/brief-client.test.ts
import { describe, expect, it } from "vitest";
import {
  createBrief,
  feedBriefSource,
  getBrief,
  runBrief,
  saveBrief,
} from "../../src/background/brief-client.ts";

const ORIGIN = "http://127.0.0.1:7474";
const TOKEN = "tok";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stub(res: Response): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fake = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(res);
  }) as unknown as typeof fetch;
  return { fetch: fake, calls };
}

describe("createBrief", () => {
  it("returns the id and expected count on 200", async () => {
    const { fetch: f, calls } = stub(
      jsonResponse(200, { id: "b1", status: "collecting", expected: 2 }),
    );
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({ ok: true, id: "b1", expected: 2 });
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/briefs`);
  });

  it("maps 404 briefs_disabled to `disabled`, carrying the gateway's hint", async () => {
    const { fetch: f } = stub(
      jsonResponse(404, { error: "briefs_disabled", hint: "enable [briefs] in nimbus.toml" }),
    );
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({ ok: false, reason: "disabled", hint: "enable [briefs] in nimbus.toml" });
  });

  it("maps 503 briefs_busy to `busy`", async () => {
    const { fetch: f } = stub(jsonResponse(503, { error: "briefs_busy" }));
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({ ok: false, reason: "busy" });
  });

  it("parses a 403 scope gap", async () => {
    const { fetch: f } = stub(
      jsonResponse(403, { error: "insufficient_scope", required: "briefs", granted: ["clip"] }),
    );
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { required: "briefs", granted: ["clip"] },
    });
  });

  it("maps 401 to unauthorized", async () => {
    const { fetch: f } = stub(jsonResponse(401, { error: "unauthorized" }));
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("maps a thrown fetch to unreachable", async () => {
    const f = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({ ok: false, reason: "unreachable" });
  });

  it("treats a malformed 200 as server_error rather than trusting it", async () => {
    const { fetch: f } = stub(jsonResponse(200, { id: 7 }));
    const out = await createBrief(ORIGIN, TOKEN, { brief: "q", sources: [], useIndex: false }, f);
    expect(out).toEqual({ ok: false, reason: "server_error" });
  });
});

describe("feedBriefSource", () => {
  const src = { url: "u", title: "t", body: "b", capturedAt: 1, truncated: false };

  it("returns the running count on 200", async () => {
    const { fetch: f, calls } = stub(jsonResponse(200, { accepted: true, received: 1, expected: 3 }));
    const out = await feedBriefSource(ORIGIN, TOKEN, "b1", src, f);
    expect(out).toEqual({ ok: true, received: 1, expected: 3 });
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/briefs/b1/sources`);
  });

  it("DISTINGUISHES run_capacity from source_too_large — same status, different detail", async () => {
    const cap = stub(jsonResponse(413, { error: "payload_too_large", detail: "run_capacity" }));
    expect(await feedBriefSource(ORIGIN, TOKEN, "b1", src, cap.fetch)).toEqual({
      ok: false,
      reason: "refused",
      detail: "run_capacity",
    });

    const big = stub(jsonResponse(413, { error: "payload_too_large", detail: "source_too_large" }));
    expect(await feedBriefSource(ORIGIN, TOKEN, "b1", src, big.fetch)).toEqual({
      ok: false,
      reason: "refused",
      detail: "source_too_large",
    });
  });

  it("treats a 413 with an unknown detail as source_too_large, the recoverable reading", async () => {
    const { fetch: f } = stub(jsonResponse(413, { error: "payload_too_large" }));
    const out = await feedBriefSource(ORIGIN, TOKEN, "b1", src, f);
    expect(out).toEqual({ ok: false, reason: "refused", detail: "source_too_large" });
  });

  it("maps 410 to expired", async () => {
    const { fetch: f } = stub(jsonResponse(410, { error: "expired" }));
    expect(await feedBriefSource(ORIGIN, TOKEN, "b1", src, f)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("maps 429 to rate_limited", async () => {
    const { fetch: f } = stub(jsonResponse(429, { error: "rate_limited" }));
    expect(await feedBriefSource(ORIGIN, TOKEN, "b1", src, f)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
  });

  it("never puts the token in the URL", async () => {
    const { fetch: f, calls } = stub(jsonResponse(200, { accepted: true, received: 1, expected: 1 }));
    await feedBriefSource(ORIGIN, TOKEN, "b1", src, f);
    expect(calls[0]?.url.includes(TOKEN)).toBe(false);
  });
});

describe("runBrief", () => {
  it("succeeds on 200", async () => {
    const { fetch: f, calls } = stub(jsonResponse(200, { status: "running" }));
    expect(await runBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/briefs/b1/run`);
  });

  it("maps 404 to not_found", async () => {
    const { fetch: f } = stub(jsonResponse(404, { error: "not_found" }));
    expect(await runBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("getBrief", () => {
  const report = {
    summary: "s",
    findings: [],
    conflicts: [],
    gaps: [],
    synthesis: { model: "m", remote: false },
  };

  it("returns a done report", async () => {
    const { fetch: f } = stub(jsonResponse(200, { status: "done", report }));
    const out = await getBrief(ORIGIN, TOKEN, "b1", f);
    expect(out).toEqual({ ok: true, status: "done", report });
  });

  it("returns failed with its failureReason, NOT an error", async () => {
    const { fetch: f } = stub(jsonResponse(200, { status: "failed", failureReason: "no_provider" }));
    const out = await getBrief(ORIGIN, TOKEN, "b1", f);
    expect(out).toEqual({ ok: true, status: "failed", failureReason: "no_provider" });
  });

  it("returns collecting and running as non-terminal", async () => {
    for (const status of ["collecting", "running"] as const) {
      const { fetch: f } = stub(jsonResponse(200, { status }));
      expect(await getBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: true, status });
    }
  });

  it("rejects a done body whose report fails the guard", async () => {
    const { fetch: f } = stub(jsonResponse(200, { status: "done", report: { summary: 1 } }));
    expect(await getBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: false, reason: "server_error" });
  });

  it("maps 410 to expired and 404 to not_found", async () => {
    const gone = stub(jsonResponse(410, { error: "expired" }));
    expect(await getBrief(ORIGIN, TOKEN, "b1", gone.fetch)).toEqual({
      ok: false,
      reason: "expired",
    });
    const missing = stub(jsonResponse(404, { error: "not_found" }));
    expect(await getBrief(ORIGIN, TOKEN, "b1", missing.fetch)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("saveBrief", () => {
  it("returns the minted item id", async () => {
    const { fetch: f, calls } = stub(jsonResponse(200, { itemId: "nimbus:brief:abc" }));
    expect(await saveBrief(ORIGIN, TOKEN, "b1", f)).toEqual({
      ok: true,
      itemId: "nimbus:brief:abc",
    });
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/briefs/b1/save`);
  });

  it("maps 410 to expired — a finished run can age out before save", async () => {
    const { fetch: f } = stub(jsonResponse(410, { error: "expired" }));
    expect(await saveBrief(ORIGIN, TOKEN, "b1", f)).toEqual({ ok: false, reason: "expired" });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bunx vitest run test/unit/brief-client.test.ts`
Expected: FAIL — cannot resolve `src/background/brief-client.ts`.

- [ ] **Step 4: Write the implementation**

```ts
// src/background/brief-client.ts
// The five routes of the research-briefs surface, and nothing else.
//
// Split from gateway-client.ts rather than added to it: that file is already 648
// lines across six routes, and these five share a path prefix, an error
// vocabulary and a rate-limit bucket that none of the others do.
//
// The `briefs` scope is LEGACY (`clips/api-scopes.ts`), so a 403 here is the
// uncommon case rather than the first thing a pre-scopes token hits — but it is
// still parsed into a scopeGap, because a token minted after scopes exist can
// have been narrowed by the owner.
import { endpointUrl } from "../shared/gateway.ts";
import { type BriefReport, isBriefReport } from "../shared/brief-report.ts";
import type { BriefSourceBody, BriefSourceDecl } from "../shared/brief.ts";

/** Create/run/save share the gateway's `brief` bucket; feeding has its own. */
const BRIEF_TIMEOUT_MS = 10_000;
/** Synthesis is the long one — the poll, not the run trigger, waits it out. */
const BRIEF_POLL_TIMEOUT_MS = 15_000;

export type BriefError =
  | "unreachable"
  | "unauthorized"
  | "insufficient_scope"
  | "not_found"
  | "expired"
  | "busy"
  | "rate_limited"
  | "server_error";

/**
 * A refused feed. Both arrive as `413 payload_too_large` and differ only in
 * `detail`, which is why they are one reason with a discriminating field rather
 * than two reasons: the status code alone cannot tell them apart.
 */
export type FeedRefusal = "source_too_large" | "run_capacity";

export type ScopeGap = { required: string; granted: string[] };

type FetchLike = typeof fetch;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function parseScopeGap(body: unknown): ScopeGap | null {
  if (!isObject(body) || typeof body["required"] !== "string") {
    return null;
  }
  const granted = body["granted"];
  if (!Array.isArray(granted) || !granted.every((g) => typeof g === "string")) {
    return null;
  }
  return { required: body["required"], granted: [...granted] };
}

function briefUrl(origin: string, id?: string, action?: string): string {
  const base = endpointUrl(origin, "briefs");
  if (id === undefined) {
    return base;
  }
  const tail = action === undefined ? "" : `/${action}`;
  return `${base}/${encodeURIComponent(id)}${tail}`;
}

async function send(
  doFetch: FetchLike,
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
  method: "GET" | "POST",
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, {
      method,
      headers:
        body === undefined
          ? { authorization: `Bearer ${token}` }
          : { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** The status→reason mapping shared by every route here. Callers handle 200/404 themselves. */
function commonError(status: number): BriefError | null {
  if (status === 401) return "unauthorized";
  if (status === 410) return "expired";
  if (status === 429) return "rate_limited";
  if (status === 503) return "busy";
  return null;
}

export async function createBrief(
  origin: string,
  token: string,
  body: { brief: string; sources: BriefSourceDecl[]; useIndex: false },
  doFetch: FetchLike = fetch,
): Promise<
  | { ok: true; id: string; expected: number }
  | { ok: false; reason: BriefError; scopeGap?: ScopeGap }
  | { ok: false; reason: "disabled"; hint?: string }
> {
  let res: Response;
  try {
    res = await send(doFetch, briefUrl(origin), token, body, BRIEF_TIMEOUT_MS, "POST");
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    return isObject(data) && typeof data["id"] === "string" && typeof data["expected"] === "number"
      ? { ok: true, id: data["id"], expected: data["expected"] }
      : { ok: false, reason: "server_error" };
  }
  if (res.status === 403) {
    const gap = parseScopeGap(await readJson(res));
    return gap === null
      ? { ok: false, reason: "insufficient_scope" }
      : { ok: false, reason: "insufficient_scope", scopeGap: gap };
  }
  // 404 on CREATE is the seam being off, not a missing run — there is no id yet
  // to be missing. Carry the gateway's own hint rather than inventing copy.
  if (res.status === 404) {
    const data = await readJson(res);
    const hint = isObject(data) && typeof data["hint"] === "string" ? data["hint"] : undefined;
    return hint === undefined ? { ok: false, reason: "disabled" } : { ok: false, reason: "disabled", hint };
  }
  return { ok: false, reason: commonError(res.status) ?? "server_error" };
}

export async function feedBriefSource(
  origin: string,
  token: string,
  id: string,
  source: BriefSourceBody,
  doFetch: FetchLike = fetch,
): Promise<
  | { ok: true; received: number; expected: number }
  | { ok: false; reason: BriefError }
  | { ok: false; reason: "refused"; detail: FeedRefusal }
> {
  let res: Response;
  try {
    res = await send(doFetch, briefUrl(origin, id, "sources"), token, source, BRIEF_TIMEOUT_MS, "POST");
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    return isObject(data) &&
      typeof data["received"] === "number" &&
      typeof data["expected"] === "number"
      ? { ok: true, received: data["received"], expected: data["expected"] }
      : { ok: false, reason: "server_error" };
  }
  if (res.status === 413) {
    const data = await readJson(res);
    // Default to `source_too_large`, the RECOVERABLE reading: it retries one
    // source, where `run_capacity` stops the whole feed. Guessing the
    // destructive one on an unrecognised detail would abandon sources the
    // gateway never refused.
    const detail: FeedRefusal =
      isObject(data) && data["detail"] === "run_capacity" ? "run_capacity" : "source_too_large";
    return { ok: false, reason: "refused", detail };
  }
  if (res.status === 403) {
    return { ok: false, reason: "insufficient_scope" };
  }
  if (res.status === 404) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: commonError(res.status) ?? "server_error" };
}

export async function runBrief(
  origin: string,
  token: string,
  id: string,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true } | { ok: false; reason: BriefError }> {
  let res: Response;
  try {
    res = await send(doFetch, briefUrl(origin, id, "run"), token, undefined, BRIEF_TIMEOUT_MS, "POST");
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    return { ok: true };
  }
  if (res.status === 403) {
    return { ok: false, reason: "insufficient_scope" };
  }
  if (res.status === 404) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: commonError(res.status) ?? "server_error" };
}

export async function getBrief(
  origin: string,
  token: string,
  id: string,
  doFetch: FetchLike = fetch,
): Promise<
  | { ok: true; status: "collecting" | "running" }
  | { ok: true; status: "done"; report: BriefReport }
  | { ok: true; status: "failed"; failureReason?: string }
  | { ok: false; reason: BriefError }
> {
  let res: Response;
  try {
    res = await send(doFetch, briefUrl(origin, id), token, undefined, BRIEF_POLL_TIMEOUT_MS, "GET");
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    return parseBriefBody(await readJson(res));
  }
  if (res.status === 403) {
    return { ok: false, reason: "insufficient_scope" };
  }
  if (res.status === 404) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: commonError(res.status) ?? "server_error" };
}

/**
 * Interpret a 200 from `GET /v1/briefs/{id}`.
 *
 * Split out of {@link getBrief} for the same reason `parseAgentRunBody` was
 * split out of `getAgentRun`: every branch here is about the SHAPE of a body,
 * and folding them into the status ladder above puts that function over Sonar's
 * cognitive-complexity cap (S3776, 15).
 */
function parseBriefBody(
  data: unknown,
):
  | { ok: true; status: "collecting" | "running" }
  | { ok: true; status: "done"; report: BriefReport }
  | { ok: true; status: "failed"; failureReason?: string }
  | { ok: false; reason: BriefError } {
  if (!isObject(data)) {
    return { ok: false, reason: "server_error" };
  }
  const status = data["status"];
  if (status === "collecting" || status === "running") {
    return { ok: true, status };
  }
  if (status === "done") {
    const report = data["report"];
    return isBriefReport(report)
      ? { ok: true, status: "done", report }
      : { ok: false, reason: "server_error" };
  }
  if (status === "failed") {
    const reason = data["failureReason"];
    return typeof reason === "string"
      ? { ok: true, status: "failed", failureReason: reason }
      : { ok: true, status: "failed" };
  }
  return { ok: false, reason: "server_error" };
}

export async function saveBrief(
  origin: string,
  token: string,
  id: string,
  doFetch: FetchLike = fetch,
): Promise<{ ok: true; itemId: string } | { ok: false; reason: BriefError }> {
  let res: Response;
  try {
    res = await send(doFetch, briefUrl(origin, id, "save"), token, undefined, BRIEF_TIMEOUT_MS, "POST");
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 200) {
    const data = await readJson(res);
    return isObject(data) && typeof data["itemId"] === "string"
      ? { ok: true, itemId: data["itemId"] }
      : { ok: false, reason: "server_error" };
  }
  if (res.status === 403) {
    return { ok: false, reason: "insufficient_scope" };
  }
  if (res.status === 404) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: commonError(res.status) ?? "server_error" };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run test/unit/brief-client.test.ts`
Expected: PASS, 21 tests.

- [ ] **Step 6: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass. Note `test/unit/gateway.test.ts` may assert the shape of `GATEWAY_PATHS`; if it enumerates keys, add `briefs` there too.

- [ ] **Step 7: Commit**

```bash
git add src/shared/gateway.ts src/background/brief-client.ts test/unit/brief-client.test.ts
git commit -m "feat(brief): the five research-brief routes"
```

---

### Task 4: Candidate-tab enumeration

**Files:**
- Modify: `src/browser/tabs.ts`
- Test: `test/unit/tabs.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `type CandidateTab = { readonly id: number; readonly url: string; readonly title: string }`
  - `type TabCandidates = { readonly named: readonly CandidateTab[]; readonly hiddenCount: number }`
  - `listCandidateTabs(): Promise<TabCandidates>`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/tabs.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listCandidateTabs } from "../../src/browser/tabs.ts";

type FakeTab = { id?: number; url?: string; title?: string };

function installTabs(tabs: FakeTab[]): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { query: vi.fn(() => Promise.resolve(tabs)) },
  };
}

describe("listCandidateTabs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("names the tabs whose url is visible", async () => {
    installTabs([
      { id: 1, url: "https://github.com/acme/web/pull/1", title: "PR 1" },
      { id: 2, url: "https://github.com/acme/web/pull/2", title: "PR 2" },
    ]);
    const out = await listCandidateTabs();
    expect(out.named).toHaveLength(2);
    expect(out.named[0]).toEqual({
      id: 1,
      url: "https://github.com/acme/web/pull/1",
      title: "PR 1",
    });
    expect(out.hiddenCount).toBe(0);
  });

  it("COUNTS but does not name a tab whose url is withheld", async () => {
    // No host permission => chrome strips `url`/`title`. We can say how many
    // there are; we cannot say what they are, and must not guess.
    installTabs([
      { id: 1, url: "https://github.com/acme/web/pull/1", title: "PR 1" },
      { id: 2 },
      { id: 3, title: undefined },
    ]);
    const out = await listCandidateTabs();
    expect(out.named).toHaveLength(1);
    expect(out.hiddenCount).toBe(2);
  });

  it("excludes restricted-scheme tabs from BOTH counts", async () => {
    // chrome://extensions is visible but uninjectable, so offering it as a
    // source would promise a capture that always fails; counting it as
    // "ungranted" would send the user to Options to grant something no grant
    // can fix.
    installTabs([
      { id: 1, url: "https://example.com/a", title: "A" },
      { id: 2, url: "chrome://extensions", title: "Extensions" },
      { id: 3, url: "about:debugging", title: "Debug" },
    ]);
    const out = await listCandidateTabs();
    expect(out.named).toHaveLength(1);
    expect(out.hiddenCount).toBe(0);
  });

  it("skips tabs with no id, which cannot be injected into", async () => {
    installTabs([{ url: "https://example.com/a", title: "A" }]);
    const out = await listCandidateTabs();
    expect(out.named).toHaveLength(0);
    expect(out.hiddenCount).toBe(0);
  });

  it("DISTINGUISHES a failed query from an empty one, rather than throwing", async () => {
    // "You have no eligible tabs" and "we couldn't read your tabs" are different
    // facts and must not render the same. `noConsole` is an error inside `src/`,
    // and this extension ships no telemetry, so the failure is surfaced to the
    // USER rather than to a log they will never see.
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: { query: vi.fn(() => Promise.reject(new Error("no"))) },
    };
    const out = await listCandidateTabs();
    expect(out).toEqual({ named: [], hiddenCount: 0, enumerationFailed: true });
  });

  it("reports enumerationFailed false on a genuinely empty tab set", async () => {
    installTabs([]);
    const out = await listCandidateTabs();
    expect(out).toEqual({ named: [], hiddenCount: 0, enumerationFailed: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/tabs.test.ts`
Expected: FAIL — `listCandidateTabs` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/browser/tabs.ts`:

```ts
/** One tab the composer may offer as a brief source. */
export type CandidateTab = {
  readonly id: number;
  readonly url: string;
  readonly title: string;
};

/**
 * `named` is every tab we may both describe and capture. `hiddenCount` is how
 * many others exist that we may do neither with.
 */
export type TabCandidates = {
  readonly named: readonly CandidateTab[];
  readonly hiddenCount: number;
  /**
   * True when the query itself failed, as opposed to genuinely finding nothing.
   *
   * These are different facts and must not render identically: an empty list says
   * "nothing here to brief on", and a failed query says "we could not look". This
   * flag is how the failure reaches the user, which is the only place it can go —
   * `noConsole` is an error inside `src/` and this extension ships no telemetry,
   * so there is no log to write it to and there should not be one.
   */
  readonly enumerationFailed: boolean;
};

/**
 * The brief composer's source pool.
 *
 * The permission axis and the capability axis are the same set here, which is
 * why this needs no `tabs` permission. `chrome.tabs.query` returns a `Tab` for
 * every tab but strips `url`/`title` unless we hold host permission for it — the
 * same boundary `addNavigationListener` above relies on — and host permission is
 * exactly what `scripting.executeScript` needs to capture the page. So a tab we
 * can name is a tab we can read, and a tab we cannot name we could not have
 * captured either.
 *
 * An unnamed tab is COUNTED, never guessed at: "3 open tabs are on sites you
 * haven't granted page access to" is honest, and inventing a label for one is
 * not. An inline `chrome.permissions.request` cannot help — it needs the concrete
 * origins, which are precisely what is being withheld.
 *
 * Restricted-scheme tabs are in neither number. They are visible but
 * uninjectable, so listing one offers a capture that always fails, and counting
 * one as ungranted sends the user to Options to fix something no grant can.
 */
export async function listCandidateTabs(): Promise<TabCandidates> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return { named: [], hiddenCount: 0, enumerationFailed: true };
  }
  const named: CandidateTab[] = [];
  let hiddenCount = 0;
  for (const tab of tabs) {
    const id = tab.id;
    if (id === undefined) {
      continue;
    }
    const url = tab.url;
    if (typeof url !== "string" || url === "") {
      hiddenCount += 1;
      continue;
    }
    if (isRestrictedTabUrl(url)) {
      continue;
    }
    named.push({ id, url, title: tab.title ?? url });
  }
  return { named, hiddenCount, enumerationFailed: false };
}

const RESTRICTED_TAB_SCHEMES = new Set([
  "chrome:",
  "chrome-extension:",
  "moz-extension:",
  "about:",
  "edge:",
  "view-source:",
]);

/**
 * Deliberately a local copy of `capture-tab.ts`'s scheme set rather than an
 * import: `src/browser/` is the `chrome.*` seam and must not depend on
 * `src/background/`. `captureTab` re-checks the same rule at injection time, so
 * this one is a UI filter and that one is the security boundary.
 */
function isRestrictedTabUrl(url: string): boolean {
  try {
    return RESTRICTED_TAB_SCHEMES.has(new URL(url).protocol);
  } catch {
    return true;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/tabs.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/browser/tabs.ts test/unit/tabs.test.ts
git commit -m "feat(brief): enumerate candidate tabs, counting the ones we may not name"
```

---

### Task 5: The in-flight run store

**Files:**
- Create: `src/background/brief-run-store.ts`
- Test: `test/unit/brief-run-store.test.ts`

**Interfaces:**
- Consumes: `storageGet`, `storageSet` (`src/browser/storage.ts`); `BriefReport`, `isBriefReport` (Task 2).
- Produces:
  - `BRIEF_RUN_TTL_MS: 1_800_000`
  - `type BriefPhase = { kind: "feeding"; received: number; expected: number } | { kind: "running" } | { kind: "done"; report: BriefReport; savedItemId?: string } | { kind: "failed"; reason: string }`
  - `type StoredBrief = { readonly id: string; readonly question: string; readonly declared: readonly { url: string; title: string }[]; readonly phase: BriefPhase; readonly expiresAtMs: number }`
  - `getBriefRun(id: string, nowMs: number): Promise<StoredBrief | null>`
  - `putBriefRun(run: StoredBrief, nowMs: number): Promise<void>`
  - `listBriefRuns(nowMs: number): Promise<StoredBrief[]>`
  - `clearBriefRuns(): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/brief-run-store.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";
import {
  BRIEF_RUN_TTL_MS,
  type StoredBrief,
  clearBriefRuns,
  getBriefRun,
  listBriefRuns,
  putBriefRun,
} from "../../src/background/brief-run-store.ts";

const NOW = 1_000_000;

function run(over: Partial<StoredBrief> = {}): StoredBrief {
  return {
    id: "b1",
    question: "Where do these contradict each other?",
    declared: [{ url: "https://example.com/a", title: "A" }],
    phase: { kind: "feeding", received: 0, expected: 1 },
    expiresAtMs: NOW + BRIEF_RUN_TTL_MS,
    ...over,
  };
}

describe("brief-run-store", () => {
  let harness: ChromeHarness;

  beforeEach(() => {
    harness = installChromeMock();
  });

  afterEach(() => {
    harness.restore();
  });

  it("round-trips a run", async () => {
    await putBriefRun(run(), NOW);
    expect(await getBriefRun("b1", NOW)).toEqual(run());
  });

  it("hides an expired run", async () => {
    await putBriefRun(run({ expiresAtMs: NOW - 1 }), NOW);
    expect(await getBriefRun("b1", NOW)).toBeNull();
  });

  it("keeps a done report so reopening the page replays instead of re-running", async () => {
    const report = {
      summary: "s",
      findings: [],
      conflicts: [],
      gaps: [],
      synthesis: { model: "m", remote: true, disclosure: "d" },
    };
    await putBriefRun(run({ phase: { kind: "done", report } }), NOW);
    const got = await getBriefRun("b1", NOW);
    expect(got?.phase).toEqual({ kind: "done", report });
  });

  it("NEVER stores source text — only declared url and title", async () => {
    await putBriefRun(run(), NOW);
    const raw = JSON.stringify([...harness.storage.entries()]);
    expect(raw.includes("https://example.com/a")).toBe(true);
    expect(raw.toLowerCase().includes("body")).toBe(false);
  });

  it("discards a stored entry that fails the guard rather than throwing", async () => {
    harness.storage.set("briefRuns", { b1: { id: "b1", phase: "nonsense" } });
    expect(await getBriefRun("b1", NOW)).toBeNull();
    expect(await listBriefRuns(NOW)).toEqual([]);
  });

  it("serialises concurrent writes instead of clobbering", async () => {
    await Promise.all([
      putBriefRun(run({ id: "a" }), NOW),
      putBriefRun(run({ id: "b" }), NOW),
      putBriefRun(run({ id: "c" }), NOW),
    ]);
    const ids = (await listBriefRuns(NOW)).map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("clearBriefRuns drops everything, so a brief cannot outlive its gateway", async () => {
    await putBriefRun(run(), NOW);
    await clearBriefRuns();
    expect(await listBriefRuns(NOW)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/brief-run-store.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

```ts
// src/background/brief-run-store.ts
// Persistence for a brief run, so closing the page does not lose it.
//
// Modelled on agent-run-store.ts: same storageGet/storageSet seam, same rule
// that stored data is external input to be filtered through a guard and never
// cast, and the same single-writer chain — the SW is single-threaded but not
// single-task, so two `putBriefRun` calls in flight together would otherwise
// read the same snapshot and the second would clobber the first.
//
// WHAT IS NOT HERE IS THE POINT: no source bodies. `BriefSource.body` is
// ephemeral by contract ("never written to disk"), and this client must not hold
// what the gateway refuses to hold. Only the declared url/title the user already
// chose, the question they asked, and the phase.
import { storageGet, storageSet } from "../browser/storage.ts";
import { type BriefReport, isBriefReport } from "../shared/brief-report.ts";

const STORE_KEY = "briefRuns";

/**
 * Mirrors the gateway's `DEFAULT_RUN_TTL_MS` (briefs/brief-constants.ts), not a
 * number chosen here — and upstream does NOT refresh it on access, so anything
 * held past it is unre-pollable and unsaveable.
 */
export const BRIEF_RUN_TTL_MS = 30 * 60_000;

/** Deliberately the gateway's own `MAX_RETAINED_TERMINAL_RUNS`. */
export const MAX_STORED_BRIEFS = 16;

export type BriefPhase =
  | { readonly kind: "feeding"; readonly received: number; readonly expected: number }
  | { readonly kind: "running" }
  | { readonly kind: "done"; readonly report: BriefReport; readonly savedItemId?: string }
  | { readonly kind: "failed"; readonly reason: string };

export type StoredBrief = {
  readonly id: string;
  readonly question: string;
  readonly declared: readonly { readonly url: string; readonly title: string }[];
  readonly phase: BriefPhase;
  readonly expiresAtMs: number;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isDeclared(v: unknown): v is { url: string; title: string } {
  return isObject(v) && typeof v["url"] === "string" && typeof v["title"] === "string";
}

function isPhase(v: unknown): v is BriefPhase {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "feeding") {
    return typeof v["received"] === "number" && typeof v["expected"] === "number";
  }
  if (v["kind"] === "running") {
    return true;
  }
  if (v["kind"] === "done") {
    return (
      isBriefReport(v["report"]) &&
      (v["savedItemId"] === undefined || typeof v["savedItemId"] === "string")
    );
  }
  return v["kind"] === "failed" && typeof v["reason"] === "string";
}

interface StoredEntry extends StoredBrief {
  readonly writtenAtMs: number;
}

function isStoredEntry(v: unknown): v is StoredEntry {
  return (
    isObject(v) &&
    typeof v["id"] === "string" &&
    typeof v["question"] === "string" &&
    Array.isArray(v["declared"]) &&
    v["declared"].every(isDeclared) &&
    isPhase(v["phase"]) &&
    typeof v["expiresAtMs"] === "number" &&
    typeof v["writtenAtMs"] === "number"
  );
}

async function readAll(): Promise<Record<string, StoredEntry>> {
  const raw = await storageGet(STORE_KEY);
  if (!isObject(raw)) {
    return {};
  }
  const out: Record<string, StoredEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isStoredEntry(value)) {
      out[key] = value;
    }
  }
  return out;
}

function toStoredBrief(entry: StoredEntry): StoredBrief {
  const { id, question, declared, phase, expiresAtMs } = entry;
  return { id, question, declared, phase, expiresAtMs };
}

export async function getBriefRun(id: string, nowMs: number): Promise<StoredBrief | null> {
  const all = await readAll();
  const found = all[id];
  if (found === undefined || found.expiresAtMs <= nowMs) {
    return null;
  }
  return toStoredBrief(found);
}

let chain: Promise<unknown> = Promise.resolve();

export function putBriefRun(run: StoredBrief, nowMs: number): Promise<void> {
  const next = chain.then(async () => {
    const all = await readAll();
    const entries = Object.entries(all).filter(([k]) => k !== run.id);
    entries.push([run.id, { ...run, writtenAtMs: nowMs }]);
    entries.sort(([, a], [, b]) => a.writtenAtMs - b.writtenAtMs);
    while (entries.length > MAX_STORED_BRIEFS) {
      entries.shift();
    }
    await storageSet(STORE_KEY, Object.fromEntries(entries));
  });
  chain = next.catch(() => undefined);
  return next;
}

export async function listBriefRuns(nowMs: number): Promise<StoredBrief[]> {
  const all = await readAll();
  return Object.values(all)
    .filter((r) => r.expiresAtMs > nowMs)
    .map(toStoredBrief);
}

/** Dropped on unpair and on a confirmed re-pair: a report is one gateway's answer. */
export function clearBriefRuns(): Promise<void> {
  const next = chain.then(async () => {
    await storageSet(STORE_KEY, {});
  });
  chain = next.catch(() => undefined);
  return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/brief-run-store.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/background/brief-run-store.ts test/unit/brief-run-store.test.ts
git commit -m "feat(brief): persist an in-flight run, without its source text"
```

---

### Task 6: The disclosure log

**Files:**
- Create: `src/shared/brief-log.ts`, `src/background/brief-log-store.ts`
- Test: `test/unit/brief-log.test.ts`

**Interfaces:**
- Produces:
  - `MAX_LOG_ENTRIES: 500`
  - `type BriefLogEntry = { readonly runId: string; readonly at: number; readonly question: string; readonly sourceCount: number; readonly truncatedCount: number; readonly model?: string; readonly remote?: boolean; readonly failed?: boolean; readonly savedItemId?: string }`
  - `isBriefLogEntry(v: unknown): v is BriefLogEntry`
  - `evictLog(entries: readonly BriefLogEntry[], cap: number): BriefLogEntry[]`
  - `appendLogEntry(entry: BriefLogEntry): Promise<void>`
  - `updateLogEntry(runId: string, patch: Partial<BriefLogEntry>): Promise<void>`
  - `readLog(): Promise<BriefLogEntry[]>`
  - `clearLog(): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/brief-log.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";
import {
  type BriefLogEntry,
  MAX_LOG_ENTRIES,
  evictLog,
  isBriefLogEntry,
} from "../../src/shared/brief-log.ts";
import {
  appendLogEntry,
  clearLog,
  readLog,
  updateLogEntry,
} from "../../src/background/brief-log-store.ts";

function entry(over: Partial<BriefLogEntry> = {}): BriefLogEntry {
  return { runId: "r1", at: 1000, question: "q", sourceCount: 2, truncatedCount: 0, ...over };
}

describe("isBriefLogEntry", () => {
  it("accepts a minimal entry", () => {
    expect(isBriefLogEntry(entry())).toBe(true);
  });

  it("accepts a completed remote entry", () => {
    expect(isBriefLogEntry(entry({ model: "gpt", remote: true, savedItemId: "i1" }))).toBe(true);
  });

  it("rejects a missing sourceCount", () => {
    const { sourceCount: _drop, ...rest } = entry();
    expect(isBriefLogEntry(rest)).toBe(false);
  });

  it("rejects a non-boolean remote", () => {
    expect(isBriefLogEntry(entry({ remote: "yes" } as never))).toBe(false);
  });
});

describe("evictLog", () => {
  it("keeps everything under the cap", () => {
    const entries = [entry({ runId: "a" }), entry({ runId: "b" })];
    expect(evictLog(entries, 5)).toHaveLength(2);
  });

  it("EVICTS SAVED RUNS FIRST — the unsaved entry is the only record that exists", () => {
    // A saved run's disclosure is durable upstream: brief-save.ts persists
    // `synthesis` as its own metadata field on the research_brief item. An
    // unsaved run's log entry is the only record anywhere that the egress
    // happened, so it outlives the saved one.
    const entries = [
      entry({ runId: "saved-old", at: 1, savedItemId: "i1" }),
      entry({ runId: "unsaved-old", at: 2 }),
      entry({ runId: "unsaved-new", at: 3 }),
    ];
    const kept = evictLog(entries, 2).map((e) => e.runId);
    expect(kept).not.toContain("saved-old");
    expect(kept).toContain("unsaved-old");
    expect(kept).toContain("unsaved-new");
  });

  it("falls back to oldest-first once only unsaved entries remain", () => {
    const entries = [entry({ runId: "a", at: 1 }), entry({ runId: "b", at: 2 })];
    expect(evictLog(entries, 1).map((e) => e.runId)).toEqual(["b"]);
  });

  it("keeps the newest entry even at a cap of one", () => {
    const entries = [entry({ runId: "a", at: 1 }), entry({ runId: "b", at: 9 })];
    expect(evictLog(entries, 1)).toEqual([entry({ runId: "b", at: 9 })]);
  });
});

describe("brief-log-store", () => {
  let harness: ChromeHarness;

  beforeEach(() => {
    harness = installChromeMock();
  });

  afterEach(() => {
    harness.restore();
  });

  it("appends and reads back, newest last", async () => {
    await appendLogEntry(entry({ runId: "a", at: 1 }));
    await appendLogEntry(entry({ runId: "b", at: 2 }));
    expect((await readLog()).map((e) => e.runId)).toEqual(["a", "b"]);
  });

  it("patches an entry in place, so the model lands on the run that caused it", async () => {
    await appendLogEntry(entry({ runId: "a" }));
    await updateLogEntry("a", { model: "llama3", remote: false });
    const [got] = await readLog();
    expect(got?.model).toBe("llama3");
    expect(got?.remote).toBe(false);
  });

  it("ignores a patch for an unknown runId rather than inventing a row", async () => {
    await appendLogEntry(entry({ runId: "a" }));
    await updateLogEntry("zzz", { model: "m" });
    expect(await readLog()).toHaveLength(1);
  });

  it("never stores a question longer than the log needs, and never a body", async () => {
    await appendLogEntry(entry({ question: "q".repeat(500) }));
    const raw = JSON.stringify([...harness.storage.entries()]);
    expect(raw.toLowerCase().includes("body")).toBe(false);
  });

  it("enforces the cap on write", async () => {
    for (let i = 0; i < MAX_LOG_ENTRIES + 5; i++) {
      await appendLogEntry(entry({ runId: `r${i}`, at: i }));
    }
    expect((await readLog()).length).toBe(MAX_LOG_ENTRIES);
  });

  it("clearLog empties it", async () => {
    await appendLogEntry(entry());
    await clearLog();
    expect(await readLog()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/brief-log.test.ts`
Expected: FAIL — cannot resolve the two modules.

- [ ] **Step 3: Write the pure module**

```ts
// src/shared/brief-log.ts
// The browser-side record of what this extension caused to leave the machine.
//
// This exists because the gateway's egress ledger does NOT cover it.
// `THIS_BINARY_COVERAGE.model` is `none` (egress/egress-coverage.ts) — the
// `model` source type is declared but its appender has not landed — and
// `agent-brief-egress.ts` covers `agents.*` briefs, which is a different route
// from `/v1/briefs`. So `nimbus prove` shows nothing for a brief's synthesis,
// and without this the only disclosure (`Report.synthesis`) dies with the run's
// 30-minute TTL.
//
// C4.1's caution — read the gateway's record rather than keep a private one that
// could quietly disagree — is right wherever a gateway record exists. Here none
// does, and a local record cannot disagree with a record that was never written.

/**
 * Entries are ~200 bytes, so a cap in the hundreds costs well under a megabyte
 * and makes eviction a theoretical path rather than a routine one. Deliberately
 * unrelated to the gateway's `MAX_RETAINED_TERMINAL_RUNS` (16): that bounds how
 * many finished runs the gateway holds for GET/save, and tying an egress record
 * to a server-side memory budget would shrink it for no reason.
 */
export const MAX_LOG_ENTRIES = 500;

export type BriefLogEntry = {
  readonly runId: string;
  /** When `/run` was accepted — the moment of egress, not when the report arrived. */
  readonly at: number;
  readonly question: string;
  readonly sourceCount: number;
  readonly truncatedCount: number;
  /** Absent until the report arrives; absent forever on a run that failed. */
  readonly model?: string;
  readonly remote?: boolean;
  readonly failed?: boolean;
  /** A pointer that may dangle — see `evictLog`. */
  readonly savedItemId?: string;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isBriefLogEntry(v: unknown): v is BriefLogEntry {
  return (
    isObject(v) &&
    typeof v["runId"] === "string" &&
    typeof v["at"] === "number" &&
    typeof v["question"] === "string" &&
    typeof v["sourceCount"] === "number" &&
    typeof v["truncatedCount"] === "number" &&
    (v["model"] === undefined || typeof v["model"] === "string") &&
    (v["remote"] === undefined || typeof v["remote"] === "boolean") &&
    (v["failed"] === undefined || typeof v["failed"] === "boolean") &&
    (v["savedItemId"] === undefined || typeof v["savedItemId"] === "string")
  );
}

/**
 * Trim to `cap`, evicting SAVED entries before unsaved ones.
 *
 * This is the opposite of the intuitive rule and it is deliberate. A saved
 * brief's disclosure is durable upstream — `brief-save.ts` persists `synthesis`
 * as its own metadata field on the `research_brief` item — so dropping a saved
 * run's entry loses a pointer, not the record. An unsaved run's entry is the
 * only evidence anywhere that the egress happened. Within each group, oldest
 * goes first.
 */
export function evictLog(entries: readonly BriefLogEntry[], cap: number): BriefLogEntry[] {
  if (entries.length <= cap) {
    return [...entries];
  }
  const byAge = [...entries].sort((a, b) => a.at - b.at);
  const order = [
    ...byAge.filter((e) => e.savedItemId !== undefined),
    ...byAge.filter((e) => e.savedItemId === undefined),
  ];
  const doomed = new Set(order.slice(0, entries.length - cap).map((e) => e.runId));
  return entries.filter((e) => !doomed.has(e.runId));
}
```

- [ ] **Step 4: Write the store**

```ts
// src/background/brief-log-store.ts
// Append-only persistence for the disclosure log. Same seam, guard and
// single-writer chain as brief-run-store.ts.
import { storageGet, storageSet } from "../browser/storage.ts";
import {
  type BriefLogEntry,
  MAX_LOG_ENTRIES,
  evictLog,
  isBriefLogEntry,
} from "../shared/brief-log.ts";

const STORE_KEY = "briefLog";

async function readAllEntries(): Promise<BriefLogEntry[]> {
  const raw = await storageGet(STORE_KEY);
  return Array.isArray(raw) ? raw.filter(isBriefLogEntry) : [];
}

export function readLog(): Promise<BriefLogEntry[]> {
  return readAllEntries();
}

let chain: Promise<unknown> = Promise.resolve();

export function appendLogEntry(entry: BriefLogEntry): Promise<void> {
  const next = chain.then(async () => {
    const all = await readAllEntries();
    await storageSet(STORE_KEY, evictLog([...all, entry], MAX_LOG_ENTRIES));
  });
  chain = next.catch(() => undefined);
  return next;
}

/** Patch one entry. An unknown `runId` is a no-op — never a fabricated row. */
export function updateLogEntry(runId: string, patch: Partial<BriefLogEntry>): Promise<void> {
  const next = chain.then(async () => {
    const all = await readAllEntries();
    await storageSet(
      STORE_KEY,
      all.map((e) => (e.runId === runId ? { ...e, ...patch } : e)),
    );
  });
  chain = next.catch(() => undefined);
  return next;
}

/**
 * The user's own control. NOT called on unpair: unlike a cached report, this is
 * a record of something that already happened, and a new pairing does not make
 * a past egress un-happen.
 */
export function clearLog(): Promise<void> {
  const next = chain.then(async () => {
    await storageSet(STORE_KEY, []);
  });
  chain = next.catch(() => undefined);
  return next;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run test/unit/brief-log.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 6: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/shared/brief-log.ts src/background/brief-log-store.ts test/unit/brief-log.test.ts
git commit -m "feat(brief): a local disclosure log for egress the ledger does not cover"
```

---

### Task 7: The brief preview

**Files:**
- Modify: `src/shared/preview.ts`
- Test: `test/unit/preview.test.ts` (extend the existing file)

**Interfaces:**
- Produces:
  - `interface BriefPreview { readonly fields: readonly PreviewField[]; readonly sources: readonly PreviewField[]; readonly synthesisNotice: string }`
  - `buildBriefPreview(input: { question: string; sources: readonly { url: string; title: string }[] }): BriefPreview`
  - `SYNTHESIS_NOTICE: string`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/preview.test.ts`:

```ts
import { SYNTHESIS_NOTICE, buildBriefPreview } from "../../src/shared/preview.ts";

describe("buildBriefPreview", () => {
  const input = {
    question: "What do these changes disagree about?",
    sources: [
      { url: "https://github.com/acme/web/pull/1", title: "Fix the thing" },
      { url: "https://github.com/acme/web/pull/2", title: "Also fix the thing" },
    ],
  };

  it("names the question and the source count", () => {
    const p = buildBriefPreview(input);
    expect(p.fields).toEqual([
      { label: "Question", value: "What do these changes disagree about?" },
      { label: "Sources", value: "2 pages" },
    ]);
  });

  it("names EVERY source, so nothing leaves unnamed", () => {
    const p = buildBriefPreview(input);
    expect(p.sources).toHaveLength(2);
    expect(p.sources[0]).toEqual({
      label: "Fix the thing",
      value: "https://github.com/acme/web/pull/1",
    });
  });

  it("uses the singular for one source", () => {
    const p = buildBriefPreview({ question: "q", sources: [input.sources[0]!] });
    expect(p.fields[1]).toEqual({ label: "Sources", value: "1 page" });
  });

  it("carries the synthesis notice and never claims the run stays local", () => {
    const p = buildBriefPreview(input);
    expect(p.synthesisNotice).toBe(SYNTHESIS_NOTICE);
    expect(p.synthesisNotice.toLowerCase()).not.toContain("stays on your machine");
    expect(p.synthesisNotice.toLowerCase()).toContain("local or a remote model");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/preview.test.ts`
Expected: FAIL — `buildBriefPreview` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/shared/preview.ts`:

```ts
export interface BriefPreview {
  readonly fields: readonly PreviewField[];
  /** One row per source: `label` is the title, `value` the address. */
  readonly sources: readonly PreviewField[];
  readonly synthesisNotice: string;
}

/**
 * What the user is told before source text leaves, and it deliberately does not
 * promise local synthesis.
 *
 * The client CANNOT know: `createBriefLlm` resolves `[briefs].prefer_local` and
 * falls back to remote when no local provider is available, `GET /v1/health`
 * reports only liveness, and `/v1/admin/status` needs a token this client does
 * not hold. Saying "stays on your machine" would be a guess presented as a
 * guarantee. The report's `synthesis.remote` is what actually happened, and the
 * page shows it afterwards.
 */
export const SYNTHESIS_NOTICE =
  "Your gateway will read these pages and answer with a local or a remote model, depending on how it is configured. The finished brief names which one it used.";

/**
 * A brief run, source by source.
 *
 * Same construction rule as {@link buildClipPreview}: fields are listed
 * explicitly, never derived by iterating an object, so the bearer token cannot
 * arrive here by inheritance. Every source is named individually rather than
 * summarised as a count alone — a count is not consent to send twenty specific
 * pages.
 *
 * Unlike the clip preview there is no off switch. Same reasoning C4.2 applied to
 * the targeted fetch: this is a larger egress than a fetch, not a smaller one.
 */
export function buildBriefPreview(input: {
  question: string;
  sources: readonly { url: string; title: string }[];
}): BriefPreview {
  return {
    fields: [
      { label: "Question", value: input.question },
      {
        label: "Sources",
        value: `${input.sources.length} ${input.sources.length === 1 ? "page" : "pages"}`,
      },
    ],
    sources: input.sources.map((s) => ({ label: s.title, value: s.url })),
    synthesisNotice: SYNTHESIS_NOTICE,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/preview.test.ts`
Expected: PASS — existing tests plus 4 new.

- [ ] **Step 5: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/shared/preview.ts test/unit/preview.test.ts
git commit -m "feat(brief): pre-run preview naming every source and the honest synthesis notice"
```

---

### Task 8: Messages and guards

**Files:**
- Modify: `src/shared/messages.ts`
- Test: `test/unit/messages.test.ts` (extend)

**Interfaces:**
- Produces (added to `ExtensionRequest`):
  - `BriefTabsRequest { kind: "brief-tabs" }`
  - `BriefStartRequest { kind: "brief-start"; question: string; tabIds: readonly number[] }`
  - `BriefStateRequest { kind: "brief-state"; id?: string }`
  - `BriefSaveRequest { kind: "brief-save"; id: string }`
  - `BriefLogRequest { kind: "brief-log" }`
  - `BriefLogClearRequest { kind: "brief-log-clear" }`
- Also: `isBriefStartRequest(v: unknown): v is BriefStartRequest` used by the router.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/messages.test.ts`:

```ts
import { isBriefStartRequest } from "../../src/shared/messages.ts";

describe("isBriefStartRequest", () => {
  it("accepts a well-formed request", () => {
    expect(isBriefStartRequest({ kind: "brief-start", question: "q", tabIds: [1, 2] })).toBe(true);
  });

  it("rejects a non-array tabIds", () => {
    expect(isBriefStartRequest({ kind: "brief-start", question: "q", tabIds: 1 })).toBe(false);
  });

  it("rejects non-numeric tab ids — the page is untrusted input", () => {
    expect(isBriefStartRequest({ kind: "brief-start", question: "q", tabIds: ["1"] })).toBe(false);
  });

  it("rejects an empty tabIds — a brief needs at least one source", () => {
    expect(isBriefStartRequest({ kind: "brief-start", question: "q", tabIds: [] })).toBe(false);
  });

  it("rejects more than the gateway's source cap", () => {
    const tabIds = Array.from({ length: 21 }, (_, i) => i);
    expect(isBriefStartRequest({ kind: "brief-start", question: "q", tabIds })).toBe(false);
  });

  it("rejects a blank question", () => {
    expect(isBriefStartRequest({ kind: "brief-start", question: "   ", tabIds: [1] })).toBe(false);
  });

  it("rejects a question over the gateway's character cap", () => {
    expect(
      isBriefStartRequest({ kind: "brief-start", question: "q".repeat(4001), tabIds: [1] }),
    ).toBe(false);
  });

  it("rejects the wrong kind", () => {
    expect(isBriefStartRequest({ kind: "clip", question: "q", tabIds: [1] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/messages.test.ts`
Expected: FAIL — `isBriefStartRequest` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/shared/messages.ts`, add the request interfaces before the `ExtensionRequest` union, add all six to that union, and add the guard:

```ts
/** Ask the worker which open tabs may be offered as brief sources. */
export interface BriefTabsRequest {
  readonly kind: "brief-tabs";
}

/**
 * Start a brief.
 *
 * `tabIds` arrives from an extension page, which is same-origin and not a
 * content script — but it is still a message payload, and the worker will
 * `executeScript` into every id in it. So it is narrowed here like every other
 * cross-boundary value: numbers only, at least one, never more than the
 * gateway's source cap. A forged id cannot widen what the worker may inject
 * into (host permission still gates that), but an unbounded list would let one
 * message fan out into arbitrarily many injections.
 */
export interface BriefStartRequest {
  readonly kind: "brief-start";
  readonly question: string;
  readonly tabIds: readonly number[];
}

/** Read current brief state. Omit `id` for the most recent run. Read-only. */
export interface BriefStateRequest {
  readonly kind: "brief-state";
  readonly id?: string;
}

export interface BriefSaveRequest {
  readonly kind: "brief-save";
  readonly id: string;
}

export interface BriefLogRequest {
  readonly kind: "brief-log";
}

export interface BriefLogClearRequest {
  readonly kind: "brief-log-clear";
}
```

Add to the union:

```ts
  | BriefTabsRequest
  | BriefStartRequest
  | BriefStateRequest
  | BriefSaveRequest
  | BriefLogRequest
  | BriefLogClearRequest;
```

And the guard (place it beside the other request guards):

```ts
/** Caps duplicated from shared/brief.ts deliberately: this guard must not import
 *  a module that imports types.ts, and the two are asserted equal in the test. */
const MAX_BRIEF_SOURCES = 20;
const MAX_BRIEF_QUESTION_CHARS = 4000;

export function isBriefStartRequest(v: unknown): v is BriefStartRequest {
  if (!isObject(v) || v["kind"] !== "brief-start") {
    return false;
  }
  const question = v["question"];
  if (typeof question !== "string" || question.trim() === "") {
    return false;
  }
  if (question.length > MAX_BRIEF_QUESTION_CHARS) {
    return false;
  }
  const tabIds = v["tabIds"];
  if (!Array.isArray(tabIds) || tabIds.length === 0 || tabIds.length > MAX_BRIEF_SOURCES) {
    return false;
  }
  return tabIds.every((id) => typeof id === "number" && Number.isInteger(id) && id >= 0);
}
```

- [ ] **Step 4: Add the cap-parity test**

Append to `test/unit/messages.test.ts`:

```ts
import { BRIEF_CAPS } from "../../src/shared/brief.ts";

it("the guard's caps match shared/brief.ts, which is the source of truth", () => {
  // Two literals for one rule drift silently; this is the assertion that stops it.
  const tooMany = Array.from({ length: BRIEF_CAPS.maxSources + 1 }, (_, i) => i);
  const atCap = Array.from({ length: BRIEF_CAPS.maxSources }, (_, i) => i);
  expect(isBriefStartRequest({ kind: "brief-start", question: "q", tabIds: tooMany })).toBe(false);
  expect(isBriefStartRequest({ kind: "brief-start", question: "q", tabIds: atCap })).toBe(true);
  expect(
    isBriefStartRequest({
      kind: "brief-start",
      question: "q".repeat(BRIEF_CAPS.maxQuestionChars),
      tabIds: [1],
    }),
  ).toBe(true);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run test/unit/messages.test.ts`
Expected: PASS — existing tests plus 9 new.

- [ ] **Step 6: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/shared/messages.ts test/unit/messages.test.ts
git commit -m "feat(brief): typed brief messages, with tabIds narrowed at the boundary"
```

---

### Task 9: The staged orchestration

**Files:**
- Create: `src/background/brief-handlers.ts`
- Test: `test/unit/brief-handlers.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces:
  - `interface BriefDeps { readonly now: () => number; readonly listTabs: () => Promise<TabCandidates>; readonly capture: (tabId: number, expectedUrl: string) => Promise<CaptureOutcome>; readonly connection: () => Promise<{ origin: string; token: string } | null>; readonly client: { createBrief; feedBriefSource; runBrief; getBrief; saveBrief }; readonly store: { get; put }; readonly log: { append; update }; readonly onState: (state: BriefState) => void }`
  - `type BriefState` — the page-facing view of a run
  - `handleBriefTabs(deps): Promise<{ named: readonly CandidateTab[]; hiddenCount: number; enumerationFailed: boolean; questions: readonly string[]; recognitions: readonly Recognition[] }>`
  - `handleBriefStart(deps, req: BriefStartRequest): Promise<BriefState>`
  - `handleBriefSave(deps, id: string): Promise<BriefState>`

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/brief-handlers.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  type BriefDeps,
  handleBriefStart,
} from "../../src/background/brief-handlers.ts";
import type { BriefReport } from "../../src/shared/brief-report.ts";

const REPORT: BriefReport = {
  summary: "They disagree about retries.",
  findings: [{ text: "A retries; B does not.", citations: [{ kind: "source", title: "A" }] }],
  conflicts: [],
  gaps: [],
  synthesis: { model: "llama3", remote: false },
};

function deps(over: Partial<BriefDeps> = {}): BriefDeps {
  const states: unknown[] = [];
  return {
    now: () => 1000,
    listTabs: () =>
      Promise.resolve({
        named: [
          { id: 1, url: "https://example.com/a", title: "A" },
          { id: 2, url: "https://example.com/b", title: "B" },
        ],
        hiddenCount: 0,
        enumerationFailed: false,
      }),
    capture: (tabId) =>
      Promise.resolve({
        ok: true,
        capture: {
          url: `https://example.com/${tabId === 1 ? "a" : "b"}`,
          title: tabId === 1 ? "A" : "B",
          body: "body text",
          mode: "article",
          wordCount: 2,
        },
      } as never),
    connection: () => Promise.resolve({ origin: "http://127.0.0.1:7474", token: "t" }),
    client: {
      createBrief: vi.fn(() => Promise.resolve({ ok: true, id: "b1", expected: 2 })),
      feedBriefSource: vi.fn(() => Promise.resolve({ ok: true, received: 1, expected: 2 })),
      runBrief: vi.fn(() => Promise.resolve({ ok: true })),
      getBrief: vi.fn(() => Promise.resolve({ ok: true, status: "done", report: REPORT })),
      saveBrief: vi.fn(() => Promise.resolve({ ok: true, itemId: "i1" })),
    } as never,
    store: { get: vi.fn(() => Promise.resolve(null)), put: vi.fn(() => Promise.resolve()) } as never,
    log: { append: vi.fn(() => Promise.resolve()), update: vi.fn(() => Promise.resolve()) } as never,
    onState: (s) => states.push(s),
    ...over,
  };
}

describe("handleBriefStart", () => {
  it("declares every picked tab at create, then feeds each", async () => {
    const d = deps();
    await handleBriefStart(d, { kind: "brief-start", question: "q", tabIds: [1, 2] });
    const create = (d.client.createBrief as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(create?.[2].sources).toHaveLength(2);
    expect((d.client.feedBriefSource as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(d.client.runBrief).toHaveBeenCalledTimes(1);
  });

  it("still runs when one tab fails to capture — a partial brief is a real answer", async () => {
    const d = deps({
      capture: (tabId) =>
        tabId === 2
          ? Promise.resolve({ ok: false, reason: "url-changed" } as never)
          : Promise.resolve({
              ok: true,
              capture: {
                url: "https://example.com/a",
                title: "A",
                body: "b",
                mode: "article",
                wordCount: 1,
              },
            } as never),
    });
    const state = await handleBriefStart(d, { kind: "brief-start", question: "q", tabIds: [1, 2] });
    expect((d.client.feedBriefSource as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(d.client.runBrief).toHaveBeenCalledTimes(1);
    expect(state.kind).toBe("done");
  });

  it("refuses to run when NO source captured — there is nothing to answer from", async () => {
    const d = deps({ capture: () => Promise.resolve({ ok: false, reason: "restricted" } as never) });
    const state = await handleBriefStart(d, { kind: "brief-start", question: "q", tabIds: [1, 2] });
    expect(d.client.runBrief).not.toHaveBeenCalled();
    expect(state.kind).toBe("failed");
  });

  it("STOPS feeding on run_capacity but still runs what was accepted", async () => {
    const feed = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, received: 1, expected: 2 })
      .mockResolvedValueOnce({ ok: false, reason: "refused", detail: "run_capacity" });
    const d = deps({ client: { ...deps().client, feedBriefSource: feed } as never });
    await handleBriefStart(d, { kind: "brief-start", question: "q", tabIds: [1, 2] });
    expect(feed).toHaveBeenCalledTimes(2);
    expect(d.client.runBrief).toHaveBeenCalledTimes(1);
  });

  it("writes the log entry when /run is ACCEPTED, before the report arrives", async () => {
    const d = deps();
    await handleBriefStart(d, { kind: "brief-start", question: "q", tabIds: [1] });
    const append = d.log.append as ReturnType<typeof vi.fn>;
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toMatchObject({ runId: "b1", sourceCount: 1 });
  });

  it("logs a run that FAILS during synthesis — the source text still left", async () => {
    const d = deps({
      client: {
        ...deps().client,
        getBrief: vi.fn(() => Promise.resolve({ ok: true, status: "failed", failureReason: "x" })),
      } as never,
    });
    await handleBriefStart(d, { kind: "brief-start", question: "q", tabIds: [1] });
    expect(d.log.append).toHaveBeenCalledTimes(1);
    expect(d.log.update).toHaveBeenCalledWith("b1", { failed: true });
  });

  it("patches the log with the model that actually answered", async () => {
    const d = deps();
    await handleBriefStart(d, { kind: "brief-start", question: "q", tabIds: [1] });
    expect(d.log.update).toHaveBeenCalledWith("b1", { model: "llama3", remote: false });
  });

  it("does not log or feed when create is refused", async () => {
    const d = deps({
      client: {
        ...deps().client,
        createBrief: vi.fn(() => Promise.resolve({ ok: false, reason: "disabled", hint: "h" })),
      } as never,
    });
    const state = await handleBriefStart(d, { kind: "brief-start", question: "q", tabIds: [1] });
    expect(state).toMatchObject({ kind: "failed" });
    expect(d.log.append).not.toHaveBeenCalled();
    expect(d.client.feedBriefSource).not.toHaveBeenCalled();
  });

  it("fails closed with no connection, without touching the client", async () => {
    const d = deps({ connection: () => Promise.resolve(null) });
    const state = await handleBriefStart(d, { kind: "brief-start", question: "q", tabIds: [1] });
    expect(state).toMatchObject({ kind: "failed" });
    expect(d.client.createBrief).not.toHaveBeenCalled();
  });

  it("captures only the tabs asked for, and only ones the tab list named", async () => {
    const capture = vi.fn(() =>
      Promise.resolve({
        ok: true,
        capture: { url: "https://example.com/a", title: "A", body: "b", mode: "article", wordCount: 1 },
      } as never),
    );
    const d = deps({ capture });
    await handleBriefStart(d, { kind: "brief-start", question: "q", tabIds: [1, 999] });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(1, "https://example.com/a");
  });

  it("counts truncated sources into the log entry", async () => {
    const d = deps({
      capture: () =>
        Promise.resolve({
          ok: true,
          capture: {
            url: "https://example.com/a",
            title: "A",
            body: "y".repeat(300 * 1024),
            mode: "article",
            wordCount: 1,
          },
        } as never),
    });
    await handleBriefStart(d, { kind: "brief-start", question: "q", tabIds: [1] });
    const append = d.log.append as ReturnType<typeof vi.fn>;
    expect(append.mock.calls[0]?.[0]).toMatchObject({ truncatedCount: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/brief-handlers.test.ts`
Expected: FAIL — cannot resolve `src/background/brief-handlers.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/background/brief-handlers.ts
// The staged brief protocol, as pure orchestration over injected deps.
//
// A SUB-ROUTER, not branches in service-worker.ts. That router is already a
// fourteen-branch function that needed `openPanelForCue` extracted to stay under
// Sonar's cognitive-complexity cap (S3776, 15); six more kinds inline would
// break the gate. The worker gains one branch that delegates here.
import { captureTab } from "./capture-tab.ts";
import type { CaptureOutcome } from "./capture-tab.ts";
import type { CandidateTab, TabCandidates } from "../browser/tabs.ts";
import type { BriefLogEntry } from "../shared/brief-log.ts";
import type { BriefReport } from "../shared/brief-report.ts";
import type { StoredBrief } from "./brief-run-store.ts";
import { BRIEF_RUN_TTL_MS } from "./brief-run-store.ts";
import { BRIEF_CAPS, buildCreateBody, buildSourceBody, suggestQuestions } from "../shared/brief.ts";
import type { BriefStartRequest } from "../shared/messages.ts";
import { recognise } from "../shared/recognise.ts";
import type { ConfiguredOrigin, Recognition } from "../shared/types.ts";
import type * as client from "./brief-client.ts";

/** The page-facing view of a run. Never carries source text. */
export type BriefState =
  | { readonly kind: "idle" }
  | { readonly kind: "feeding"; readonly id: string; readonly received: number; readonly expected: number }
  | { readonly kind: "running"; readonly id: string }
  | {
      readonly kind: "done";
      readonly id: string;
      readonly report: BriefReport;
      readonly skipped: readonly { readonly title: string; readonly reason: string }[];
      readonly truncated: readonly string[];
      readonly savedItemId?: string;
      /**
       * A failed Save, reported WITHOUT discarding the report.
       *
       * This is why a save failure is not a `failed` state: `renderState` clears
       * the root before drawing, so transitioning to `failed` would erase the
       * brief the user was reading because a save they attempted afterwards
       * didn't land. The spec's failure table says the report stays on screen,
       * and this field is how.
       */
      readonly saveError?: string;
    }
  | { readonly kind: "failed"; readonly id?: string; readonly reason: string; readonly hint?: string }
  /**
   * Save failed. Carries no report, because the handler may no longer hold one —
   * the page merges this into the `done` state it is already showing. See
   * `brief.ts`'s `lastDone`.
   */
  | { readonly kind: "save-failed"; readonly id: string; readonly reason: string };

export interface BriefDeps {
  readonly now: () => number;
  readonly listTabs: () => Promise<TabCandidates>;
  readonly origins: () => Promise<readonly ConfiguredOrigin[]>;
  readonly capture: (tabId: number, expectedUrl: string) => Promise<CaptureOutcome>;
  readonly connection: () => Promise<{ origin: string; token: string } | null>;
  readonly client: {
    createBrief: typeof client.createBrief;
    feedBriefSource: typeof client.feedBriefSource;
    runBrief: typeof client.runBrief;
    getBrief: typeof client.getBrief;
    saveBrief: typeof client.saveBrief;
  };
  readonly store: {
    get: (id: string, nowMs: number) => Promise<StoredBrief | null>;
    put: (run: StoredBrief, nowMs: number) => Promise<void>;
  };
  readonly log: {
    append: (entry: BriefLogEntry) => Promise<void>;
    update: (runId: string, patch: Partial<BriefLogEntry>) => Promise<void>;
  };
  readonly onState: (state: BriefState) => void;
}

export async function handleBriefTabs(deps: BriefDeps): Promise<{
  named: readonly CandidateTab[];
  hiddenCount: number;
  questions: readonly string[];
  recognitions: readonly Recognition[];
}> {
  const tabs = await deps.listTabs();
  const origins = await deps.origins();
  const recognitions = tabs.named.map((t) => recognise(t.url, origins));
  return {
    named: tabs.named,
    hiddenCount: tabs.hiddenCount,
    enumerationFailed: tabs.enumerationFailed,
    questions: suggestQuestions(recognitions),
    recognitions,
  };
}

function emit(deps: BriefDeps, state: BriefState): BriefState {
  deps.onState(state);
  return state;
}

/**
 * Create → capture → feed → run → poll.
 *
 * The order matters and is decision 4 of the spec: every picked tab is DECLARED
 * at create even though some may fail to capture, because `BriefRun.declared` is
 * fixed at create and the gateway reports the shortfall in the report's `gaps`.
 * Capturing first and declaring only the survivors would hide it.
 */
export async function handleBriefStart(
  deps: BriefDeps,
  req: BriefStartRequest,
): Promise<BriefState> {
  const conn = await deps.connection();
  if (conn === null) {
    return emit(deps, { kind: "failed", reason: "not_paired" });
  }
  const tabs = await deps.listTabs();
  const picked = req.tabIds
    .map((id) => tabs.named.find((t) => t.id === id))
    .filter((t): t is CandidateTab => t !== undefined)
    .slice(0, BRIEF_CAPS.maxSources);
  if (picked.length === 0) {
    return emit(deps, { kind: "failed", reason: "no_sources" });
  }

  const created = await deps.client.createBrief(
    conn.origin,
    conn.token,
    buildCreateBody(req.question, picked.map((t) => ({ url: t.url, title: t.title }))),
  );
  if (!created.ok) {
    return emit(deps, {
      kind: "failed",
      reason: created.reason,
      ...("hint" in created && created.hint !== undefined ? { hint: created.hint } : {}),
    });
  }

  const id = created.id;
  const nowMs = deps.now();
  const declared = picked.map((t) => ({ url: t.url, title: t.title }));
  await deps.store.put(
    {
      id,
      question: req.question,
      declared,
      phase: { kind: "feeding", received: 0, expected: created.expected },
      expiresAtMs: nowMs + BRIEF_RUN_TTL_MS,
    },
    nowMs,
  );
  emit(deps, { kind: "feeding", id, received: 0, expected: created.expected });

  const fed = await feedAll(deps, conn, id, picked, created.expected);
  if (fed.accepted === 0) {
    const state: BriefState = { kind: "failed", id, reason: "no_sources_captured" };
    await putPhase(deps, id, { kind: "failed", reason: "no_sources_captured" });
    return emit(deps, state);
  }

  const started = await deps.client.runBrief(conn.origin, conn.token, id);
  if (!started.ok) {
    await putPhase(deps, id, { kind: "failed", reason: started.reason });
    return emit(deps, { kind: "failed", id, reason: started.reason });
  }

  // The log entry is written HERE — when `/run` is accepted, which is the moment
  // of egress — not when the report arrives. A run that fails during synthesis
  // still sent its source text, so it still gets an entry.
  await deps.log.append({
    runId: id,
    at: deps.now(),
    question: req.question,
    sourceCount: fed.accepted,
    truncatedCount: fed.truncated.length,
  });
  await putPhase(deps, id, { kind: "running" });
  emit(deps, { kind: "running", id });

  return pollToTerminal(deps, conn, id, fed);
}

interface FeedResult {
  readonly accepted: number;
  readonly skipped: readonly { readonly title: string; readonly reason: string }[];
  readonly truncated: readonly string[];
}

async function feedAll(
  deps: BriefDeps,
  conn: { origin: string; token: string },
  id: string,
  picked: readonly CandidateTab[],
  expected: number,
): Promise<FeedResult> {
  const skipped: { title: string; reason: string }[] = [];
  const truncated: string[] = [];
  let accepted = 0;
  for (const tab of picked) {
    const outcome = await deps.capture(tab.id, tab.url);
    if (!outcome.ok) {
      skipped.push({ title: tab.title, reason: outcome.reason });
      continue;
    }
    const body = buildSourceBody({
      url: tab.url,
      title: tab.title,
      body: outcome.capture.body,
      capturedAt: deps.now(),
    });
    const res = await deps.client.feedBriefSource(conn.origin, conn.token, id, body);
    if (res.ok) {
      accepted += 1;
      if (body.truncated) {
        truncated.push(tab.title);
      }
      emit(deps, { kind: "feeding", id, received: res.received, expected });
      continue;
    }
    if (res.reason === "refused" && res.detail === "run_capacity") {
      // The run is full. Every remaining source would be refused too, and the
      // sources already accepted still produce a report whose `gaps` name the
      // shortfall. Stopping is the correct answer, not an error.
      skipped.push({ title: tab.title, reason: "run_capacity" });
      break;
    }
    skipped.push({ title: tab.title, reason: res.reason });
  }
  return { accepted, skipped, truncated };
}

async function putPhase(
  deps: BriefDeps,
  id: string,
  phase: StoredBrief["phase"],
): Promise<void> {
  const nowMs = deps.now();
  const existing = await deps.store.get(id, nowMs);
  if (existing === null) {
    return;
  }
  await deps.store.put({ ...existing, phase }, nowMs);
}

/**
 * Poll until terminal. The cadence is the caller's `setTimeout` in the worker —
 * never the page's. See the spec's ownership rules: one poller, and it is not in
 * the page.
 */
async function pollToTerminal(
  deps: BriefDeps,
  conn: { origin: string; token: string },
  id: string,
  fed: FeedResult,
): Promise<BriefState> {
  const res = await deps.client.getBrief(conn.origin, conn.token, id);
  if (!res.ok) {
    await putPhase(deps, id, { kind: "failed", reason: res.reason });
    return emit(deps, { kind: "failed", id, reason: res.reason });
  }
  if (res.status === "collecting" || res.status === "running") {
    return emit(deps, { kind: "running", id });
  }
  if (res.status === "failed") {
    await deps.log.update(id, { failed: true });
    const reason = res.failureReason ?? "synthesis_failed";
    await putPhase(deps, id, { kind: "failed", reason });
    return emit(deps, { kind: "failed", id, reason });
  }
  await deps.log.update(id, {
    model: res.report.synthesis.model,
    remote: res.report.synthesis.remote,
  });
  await putPhase(deps, id, { kind: "done", report: res.report });
  return emit(deps, {
    kind: "done",
    id,
    report: res.report,
    skipped: fed.skipped,
    truncated: fed.truncated,
  });
}

/**
 * Save on the user's explicit click.
 *
 * EVERY failure path here is `save-failed`, never `failed`. A brief the user is
 * reading must not vanish because the save they tried afterwards was refused —
 * and refusal is a real state, not a theoretical one: `MAX_RETAINED_TERMINAL_RUNS`
 * is 16 and the TTL is not refreshed on access, so a brief left open for half an
 * hour is genuinely no longer saveable.
 */
export async function handleBriefSave(deps: BriefDeps, id: string): Promise<BriefState> {
  const conn = await deps.connection();
  if (conn === null) {
    return emit(deps, { kind: "save-failed", id, reason: "not_paired" });
  }
  const nowMs = deps.now();
  const stored = await deps.store.get(id, nowMs);
  if (stored === null || stored.phase.kind !== "done") {
    return emit(deps, { kind: "save-failed", id, reason: "expired" });
  }
  const saved = await deps.client.saveBrief(conn.origin, conn.token, id);
  if (!saved.ok) {
    return emit(deps, { kind: "save-failed", id, reason: saved.reason });
  }
  await deps.log.update(id, { savedItemId: saved.itemId });
  await deps.store.put(
    { ...stored, phase: { ...stored.phase, savedItemId: saved.itemId } },
    nowMs,
  );
  return emit(deps, {
    kind: "done",
    id,
    report: stored.phase.report,
    skipped: [],
    truncated: [],
    savedItemId: saved.itemId,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/brief-handlers.test.ts`
Expected: PASS, 11 tests. If a `deps()` override needs `origins`, add `origins: () => Promise.resolve([])` to the default.

- [ ] **Step 5: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/background/brief-handlers.ts test/unit/brief-handlers.test.ts
git commit -m "feat(brief): the staged create-capture-feed-run orchestration"
```

---

### Task 10: The brief page

**Files:**
- Create: `src/brief/brief-view.ts`, `src/brief/brief.ts`, `src/brief/brief.html`, `src/brief/brief.css`
- Modify: `esbuild.mjs` (`ENTRIES`, `HTML_CSS`), `scripts/check-build.mjs` (`REQUIRED_FILES`)
- Test: `test/unit/brief-view.test.ts`

**Interfaces:**
- Consumes: `BriefState` (Task 9), `BriefPreview` (Task 7), `visibleGaps` / `quotesWereOmitted` (Task 2), `CandidateTab` (Task 4).
- Produces:
  - `renderComposer(root: HTMLElement, model: ComposerModel): void`
  - `renderState(root: HTMLElement, state: BriefState): void`
  - `type ComposerModel = { named: readonly CandidateTab[]; hiddenCount: number; questions: readonly string[]; selected: ReadonlySet<number>; enumerationFailed?: boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// @vitest-environment jsdom
// test/unit/brief-view.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { renderComposer, renderState } from "../../src/brief/brief-view.ts";
import type { BriefReport } from "../../src/shared/brief-report.ts";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

const report: BriefReport = {
  summary: "They disagree about retries.",
  findings: [{ text: "A retries.", citations: [{ kind: "source", title: "A", quote: "we retry" }] }],
  conflicts: [
    {
      text: "A retries, B does not.",
      citations: [
        { kind: "source", title: "A" },
        { kind: "source", title: "B" },
      ],
    },
  ],
  gaps: ["Only 2 of 3 sources were read.", "Ran on a remote model."],
  synthesis: { model: "gpt", remote: true, disclosure: "Ran on a remote model." },
};

describe("renderComposer", () => {
  it("lists each named tab with a checkbox", () => {
    renderComposer(root, {
      named: [
        { id: 1, url: "https://example.com/a", title: "A" },
        { id: 2, url: "https://example.com/b", title: "B" },
      ],
      hiddenCount: 0,
      questions: ["Where do these contradict each other?"],
      selected: new Set([1]),
    });
    const boxes = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.checked).toBe(true);
    expect(boxes[1]?.checked).toBe(false);
  });

  it("reports ungranted tabs as a COUNT and names none of them", () => {
    renderComposer(root, {
      named: [{ id: 1, url: "https://example.com/a", title: "A" }],
      hiddenCount: 3,
      questions: ["q"],
      selected: new Set(),
    });
    expect(root.textContent).toContain("3 open tabs");
    expect(root.textContent).toContain("page access");
  });

  it("says nothing about ungranted tabs when there are none", () => {
    renderComposer(root, {
      named: [{ id: 1, url: "https://example.com/a", title: "A" }],
      hiddenCount: 0,
      questions: ["q"],
      selected: new Set(),
    });
    expect(root.textContent).not.toContain("page access");
  });

  it("says the tabs couldn't be READ rather than claiming there are none", () => {
    renderComposer(root, {
      named: [],
      hiddenCount: 0,
      questions: [],
      selected: new Set(),
      enumerationFailed: true,
    });
    expect(root.textContent).toContain("Couldn't read your open tabs");
    expect(root.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it("offers the scaffolded questions and a COLLAPSED custom-question control", () => {
    renderComposer(root, {
      named: [{ id: 1, url: "https://example.com/a", title: "A" }],
      hiddenCount: 0,
      questions: ["What breaks if all of these land?"],
      selected: new Set([1]),
    });
    expect(root.textContent).toContain("What breaks if all of these land?");
    const details = root.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Ask your own question");
  });
});

describe("renderState", () => {
  it("shows feed progress", () => {
    renderState(root, { kind: "feeding", id: "b1", received: 2, expected: 5 });
    expect(root.textContent).toContain("2");
    expect(root.textContent).toContain("5");
  });

  it("renders summary, findings and conflicts", () => {
    renderState(root, { kind: "done", id: "b1", report, skipped: [], truncated: [] });
    expect(root.textContent).toContain("They disagree about retries.");
    expect(root.textContent).toContain("A retries.");
    expect(root.textContent).toContain("A retries, B does not.");
  });

  it("renders the remote banner and does NOT repeat it in gaps", () => {
    renderState(root, { kind: "done", id: "b1", report, skipped: [], truncated: [] });
    const text = root.textContent ?? "";
    const occurrences = text.split("Ran on a remote model.").length - 1;
    expect(occurrences).toBe(1);
    expect(text).toContain("Only 2 of 3 sources were read.");
  });

  it("names the model that answered", () => {
    renderState(root, { kind: "done", id: "b1", report, skipped: [], truncated: [] });
    expect(root.textContent).toContain("gpt");
  });

  it("names skipped sources and why", () => {
    renderState(root, {
      kind: "done",
      id: "b1",
      report,
      skipped: [{ title: "C", reason: "url-changed" }],
      truncated: ["A"],
    });
    expect(root.textContent).toContain("C");
    expect(root.textContent).toContain("A");
  });

  it("renders a failure with its reason and never as an empty panel", () => {
    renderState(root, { kind: "failed", id: "b1", reason: "briefs_disabled", hint: "turn it on" });
    expect(root.textContent).toContain("turn it on");
    expect(root.textContent?.trim()).not.toBe("");
  });

  it("A FAILED SAVE KEEPS THE REPORT ON SCREEN and offers the button again", () => {
    // The whole reason `saveError` exists rather than a transition to `failed`:
    // the user was reading this brief, and a refused save must not erase it.
    renderState(root, {
      kind: "done",
      id: "b1",
      report,
      skipped: [],
      truncated: [],
      saveError: "expired",
    });
    expect(root.textContent).toContain("They disagree about retries.");
    expect(root.textContent?.toLowerCase()).toContain("no longer available to save");
    expect(root.querySelector("#save-brief")).not.toBeNull();
  });

  it("hides the save button once saved, and shows no save error", () => {
    renderState(root, {
      kind: "done",
      id: "b1",
      report,
      skipped: [],
      truncated: [],
      savedItemId: "i1",
    });
    expect(root.querySelector("#save-brief")).toBeNull();
    expect(root.textContent).toContain("Saved to your index.");
  });

  it("escapes source-controlled text rather than parsing it as HTML", () => {
    renderState(root, {
      kind: "done",
      id: "b1",
      report: { ...report, summary: "<img src=x onerror=alert(1)>" },
      skipped: [],
      truncated: [],
    });
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/brief-view.test.ts`
Expected: FAIL — cannot resolve `src/brief/brief-view.ts`.

- [ ] **Step 3: Write `src/brief/brief-view.ts`**

Build every node with `document.createElement` and set text via `textContent` — never `innerHTML` with interpolated values. A report's `summary`, `text`, `title` and `quote` are model output derived from page content, so they are untrusted.

```ts
// src/brief/brief-view.ts
// Pure rendering for the brief page. No chrome.* here, no fetch — the page's
// only job is to draw what the worker sends.
import { type BriefReport, quotesWereOmitted, visibleGaps } from "../shared/brief-report.ts";
import type { BriefState } from "../background/brief-handlers.ts";
import type { CandidateTab } from "../browser/tabs.ts";

export type ComposerModel = {
  readonly named: readonly CandidateTab[];
  readonly hiddenCount: number;
  readonly questions: readonly string[];
  readonly selected: ReadonlySet<number>;
  /** See `TabCandidates.enumerationFailed` — rendered, not logged. */
  readonly enumerationFailed?: boolean;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className !== undefined) {
    node.className = className;
  }
  return node;
}

export function renderComposer(root: HTMLElement, model: ComposerModel): void {
  root.replaceChildren();
  root.appendChild(el("h2", "Pick the pages"));

  // A failed enumeration is not an empty one. Saying "no eligible tabs" here
  // would be a false statement about the browser rather than an honest one about
  // us, and it is the only place this failure can be reported.
  if (model.enumerationFailed === true) {
    root.appendChild(
      el("p", "Couldn't read your open tabs. Reload this page to try again.", "enumerate-error"),
    );
    return;
  }

  const list = el("ul", undefined, "tabs");
  for (const tab of model.named) {
    const item = el("li");
    const label = el("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = String(tab.id);
    box.checked = model.selected.has(tab.id);
    label.appendChild(box);
    label.appendChild(el("span", tab.title, "tab-title"));
    label.appendChild(el("span", tab.url, "tab-url"));
    item.appendChild(label);
    list.appendChild(item);
  }
  root.appendChild(list);

  // A COUNT, never a name. Without host permission the url is withheld, so
  // there is nothing honest to print — and an inline permissions.request would
  // need exactly those origins.
  if (model.hiddenCount > 0) {
    const n = model.hiddenCount;
    root.appendChild(
      el(
        "p",
        `${n} open ${n === 1 ? "tab is" : "tabs are"} on sites you haven't granted page access to. Grant it in Options to include them.`,
        "hidden-note",
      ),
    );
  }

  root.appendChild(el("h2", "Ask"));
  const questions = el("ul", undefined, "questions");
  for (const q of model.questions) {
    const item = el("li");
    const button = el("button", q, "question");
    button.type = "button";
    button.dataset["question"] = q;
    item.appendChild(button);
    questions.appendChild(item);
  }
  root.appendChild(questions);

  // A collapsed control, not a warning. The non-goal this serves is about which
  // affordance LEADS; someone who arrived with a specific question should reach
  // it in one click.
  const details = el("details", undefined, "custom");
  details.appendChild(el("summary", "Ask your own question"));
  const input = document.createElement("textarea");
  input.id = "custom-question";
  input.rows = 3;
  details.appendChild(input);
  root.appendChild(details);
}

export function renderState(root: HTMLElement, state: BriefState): void {
  root.replaceChildren();
  if (state.kind === "idle") {
    return;
  }
  if (state.kind === "feeding") {
    root.appendChild(el("p", `Reading pages — ${state.received} of ${state.expected}.`));
    return;
  }
  if (state.kind === "running") {
    root.appendChild(el("p", "Your gateway is writing the brief."));
    return;
  }
  if (state.kind === "failed") {
    root.appendChild(el("h2", "Couldn't finish this brief"));
    root.appendChild(el("p", state.reason, "reason"));
    if (state.hint !== undefined) {
      root.appendChild(el("p", state.hint, "hint"));
    }
    return;
  }
  if (state.kind === "save-failed") {
    // Only reached if the page has no retained `done` state to merge into — see
    // brief.ts's `lastDone`. Normally a save failure arrives here as a `done`
    // state carrying `saveError`, with the report intact.
    root.appendChild(el("h2", "Couldn't save this brief"));
    root.appendChild(el("p", saveErrorText(state.reason), "reason"));
    return;
  }
  renderReport(root, state);
}

/** Save refusals in the user's words. `expired` is the common one, not an edge case. */
function saveErrorText(reason: string): string {
  if (reason === "expired" || reason === "not_found") {
    return "This brief is no longer available to save — your gateway only keeps a finished brief for a while.";
  }
  if (reason === "not_paired") {
    return "Not paired with a gateway any more, so there is nowhere to save it.";
  }
  return `Couldn't save it: ${reason}.`;
}

function renderCitations(item: { citations: BriefReport["findings"][number]["citations"] }): HTMLElement {
  const list = el("ul", undefined, "citations");
  for (const c of item.citations) {
    const li = el("li");
    li.appendChild(el("span", c.title, "cite-title"));
    if (c.quote !== undefined) {
      li.appendChild(el("blockquote", c.quote));
    }
    if (c.url !== undefined) {
      const a = el("a", c.url);
      a.href = c.url;
      li.appendChild(a);
    }
    list.appendChild(li);
  }
  return list;
}

function renderItems(root: HTMLElement, heading: string, items: BriefReport["findings"]): void {
  if (items.length === 0) {
    return;
  }
  root.appendChild(el("h2", heading));
  const list = el("ul", undefined, "items");
  for (const item of items) {
    const li = el("li");
    li.appendChild(el("p", item.text));
    li.appendChild(renderCitations(item));
    list.appendChild(li);
  }
  root.appendChild(list);
}

function renderReport(root: HTMLElement, state: Extract<BriefState, { kind: "done" }>): void {
  const { report, skipped, truncated, savedItemId, saveError } = state;
  // The banner, and the gaps list with its duplicate removed BY EQUALITY.
  if (report.synthesis.remote) {
    root.appendChild(
      el(
        "p",
        report.synthesis.disclosure ??
          `This brief was written by a remote model (${report.synthesis.model}).`,
        "banner remote",
      ),
    );
  } else {
    root.appendChild(
      el("p", `Written on your machine by ${report.synthesis.model}.`, "banner local"),
    );
  }

  root.appendChild(el("h2", "Summary"));
  root.appendChild(el("p", report.summary));
  renderItems(root, "Findings", report.findings);
  renderItems(root, "Where your sources disagree", report.conflicts);

  const gaps = visibleGaps(report);
  if (gaps.length > 0) {
    root.appendChild(el("h2", "Not covered"));
    const list = el("ul", undefined, "gaps");
    for (const g of gaps) {
      list.appendChild(el("li", g));
    }
    root.appendChild(list);
  }

  if (skipped.length > 0) {
    root.appendChild(el("h2", "Pages that couldn't be read"));
    const list = el("ul", undefined, "skipped");
    for (const s of skipped) {
      list.appendChild(el("li", `${s.title} — ${s.reason}`));
    }
    root.appendChild(list);
  }
  if (truncated.length > 0) {
    root.appendChild(
      el("p", `Shortened to fit: ${truncated.join(", ")}.`, "truncated-note"),
    );
  }

  if (savedItemId === undefined) {
    // The error goes ABOVE the button, and the button stays: a refusal the user
    // can retry is not the same as a dead end, and the report is still here.
    if (saveError !== undefined) {
      root.appendChild(el("p", saveErrorText(saveError), "save-error"));
    }
    const save = el("button", "Save to Nimbus", "save");
    save.type = "button";
    save.id = "save-brief";
    root.appendChild(save);
  } else {
    root.appendChild(el("p", "Saved to your index.", "saved"));
    // Save is not lossless when the report is over the item metadata ceiling.
    if (quotesWereOmitted(report)) {
      root.appendChild(
        el("p", "The saved copy left out the supporting quotes (size limit).", "saved-note"),
      );
    }
  }
}
```

- [ ] **Step 4: Write `brief.html`, `brief.css`, and `brief.ts`**

`src/brief/brief.html` — mirror `options.html`'s structure; two containers (`#composer`, `#state`) and a `#run` button, plus a `#preview` container. `src/brief/brief.css` — plain CSS, no external fonts. `src/brief/brief.ts` — wire it up:

```ts
// src/brief/brief.ts
// The page. Sends messages, renders what comes back. It never calls the gateway
// and it never polls — the service worker owns the run (see the spec's ownership
// rules), so there is exactly one poller and it is not here.
import { buildBriefPreview } from "../shared/preview.ts";
import { renderPreview } from "../shared/preview-view.ts";
import type { BriefState } from "../background/brief-handlers.ts";
import { renderComposer, renderState } from "./brief-view.ts";
import type { CandidateTab } from "../browser/tabs.ts";

const selected = new Set<number>();
let named: readonly CandidateTab[] = [];
let question = "";

function root(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing #${id}`);
  }
  return node;
}

async function loadTabs(): Promise<void> {
  const res: unknown = await chrome.runtime.sendMessage({ kind: "brief-tabs" });
  if (typeof res !== "object" || res === null) {
    return;
  }
  const data = res as {
    named?: CandidateTab[];
    hiddenCount?: number;
    questions?: string[];
    enumerationFailed?: boolean;
  };
  named = data.named ?? [];
  renderComposer(root("composer"), {
    named,
    hiddenCount: data.hiddenCount ?? 0,
    questions: data.questions ?? [],
    selected,
    enumerationFailed: data.enumerationFailed === true,
  });
}

function showPreview(): void {
  const sources = named.filter((t) => selected.has(t.id));
  renderPreview(root("preview"), buildBriefPreview({ question, sources }));
}

root("composer").addEventListener("click", (ev) => {
  const target = ev.target;
  if (target instanceof HTMLInputElement && target.type === "checkbox") {
    const id = Number(target.value);
    if (target.checked) {
      selected.add(id);
    } else {
      selected.delete(id);
    }
    showPreview();
  }
  if (target instanceof HTMLButtonElement && target.dataset["question"] !== undefined) {
    question = target.dataset["question"];
    showPreview();
  }
});

root("run").addEventListener("click", () => {
  const custom = document.getElementById("custom-question");
  if (custom instanceof HTMLTextAreaElement && custom.value.trim() !== "") {
    question = custom.value.trim();
  }
  void chrome.runtime
    .sendMessage({ kind: "brief-start", question, tabIds: [...selected] })
    .catch(() => undefined);
});

/**
 * The last `done` state, retained so a later save failure can be shown WITHOUT
 * discarding the brief the user is reading. `save-failed` carries no report —
 * the worker may no longer hold one — so merging it here is what keeps the
 * report on screen.
 */
let lastDone: Extract<BriefState, { kind: "done" }> | null = null;

function show(state: BriefState): void {
  if (state.kind === "done") {
    lastDone = state;
    renderState(root("state"), state);
    return;
  }
  if (state.kind === "save-failed" && lastDone !== null) {
    renderState(root("state"), { ...lastDone, saveError: state.reason });
    return;
  }
  renderState(root("state"), state);
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (typeof msg === "object" && msg !== null && (msg as { kind?: string }).kind === "brief-state") {
    show((msg as { state: BriefState }).state);
  }
});

// The Save button is created by `renderState`, so it is bound by DELEGATION on a
// container that outlives it rather than by id after each render.
root("state").addEventListener("click", (ev) => {
  const target = ev.target;
  if (!(target instanceof HTMLButtonElement) || target.id !== "save-brief") {
    return;
  }
  const id = lastDone?.id;
  if (id === undefined) {
    return;
  }
  target.disabled = true;
  void chrome.runtime
    .sendMessage({ kind: "brief-save", id })
    .then((res: unknown) => {
      if (typeof res === "object" && res !== null && "kind" in res) {
        show(res as BriefState);
      }
    })
    .catch(() => {
      // Re-enable rather than leaving a dead disabled button: an unreachable
      // worker is retryable, and a spinner that never resolves is the failure
      // mode this guards against.
      target.disabled = false;
    });
});

// Returning from Options must not need a manual reload — the grant may have
// added tabs this composer could not name a moment ago.
chrome.permissions.onAdded.addListener(() => {
  void loadTabs().catch(() => undefined);
});
window.addEventListener("focus", () => {
  void loadTabs().catch(() => undefined);
});

void loadTabs().catch(() => undefined);
```

- [ ] **Step 5: Register the entry in BOTH places**

In `esbuild.mjs`, add to `ENTRIES`:

```js
  { in: "src/brief/brief.ts", out: "brief" },
```

and to `HTML_CSS`:

```js
  "src/brief/brief.html",
  "src/brief/brief.css",
```

In `scripts/check-build.mjs`, add to `REQUIRED_FILES`:

```js
  "brief.js",
  "brief.html",
  "brief.css",
```

**This second edit is the one that silently rots if skipped.** `REQUIRED_FILES` is a hand-written literal: adding an `ENTRIES` row without it leaves the new bundle unguarded and `check-build` still prints OK.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bunx vitest run test/unit/brief-view.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 7: Run the full gate set including the build**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all pass; `dist/chrome/brief.js`, `brief.html`, `brief.css` and the Firefox equivalents exist.

- [ ] **Step 8: Commit**

```bash
git add src/brief esbuild.mjs scripts/check-build.mjs test/unit/brief-view.test.ts
git commit -m "feat(brief): the brief page, composer and report renderer"
```

---

### Task 11: Service-worker wiring, poll cadence and the eviction net

**Files:**
- Modify: `src/background/service-worker.ts`
- Test: `test/unit/brief-service-worker.test.ts`

**Interfaces:**
- Consumes: `handleBriefTabs`, `handleBriefStart`, `handleBriefSave`, `BriefDeps` (Task 9); `readLog`, `clearLog` (Task 6).
- Produces: `BRIEF_POLL_ALARM = "nimbus-brief-poll"`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/brief-service-worker.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("service worker brief routing", () => {
  let harness: ChromeHarness;

  beforeEach(() => {
    harness = installChromeMock();
    vi.resetModules();
  });

  afterEach(() => {
    harness.restore();
  });

  it("routes brief-tabs and answers with named tabs plus a hidden count", async () => {
    await import("../../src/background/service-worker.ts");
    await settle();
    const res = await harness.emitMessage({ kind: "brief-tabs" });
    expect(res).toHaveProperty("named");
    expect(res).toHaveProperty("hiddenCount");
  });

  it("refuses a brief-start whose tabIds fail the guard, without calling the gateway", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await import("../../src/background/service-worker.ts");
    await settle();
    const res = await harness.emitMessage({ kind: "brief-start", question: "q", tabIds: ["1"] });
    expect(res).toMatchObject({ kind: "failed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("registers the brief poll alarm as the eviction net, not the cadence", async () => {
    await import("../../src/background/service-worker.ts");
    await settle();
    const created = harness.alarmsCreate.mock.calls.map((c) => c[0]);
    // The alarm exists only to resume a run whose worker died. A one-minute
    // floor is far slower than a brief poll cadence.
    expect(created).not.toContain("nimbus-brief-poll-cadence");
  });

  it("does NOT disarm the eviction net while another brief is still running", async () => {
    // Two briefs can overlap — the gateway allows three concurrent runs. Clearing
    // the alarm when the first reaches a terminal state would orphan the second.
    const now = Date.now();
    const run = (id: string, kind: string) => ({
      id,
      question: "q",
      declared: [],
      phase: { kind },
      expiresAtMs: now + 60_000,
      writtenAtMs: now,
    });
    harness.storage.set("briefRuns", { a: run("a", "running"), b: run("b", "running") });
    await import("../../src/background/service-worker.ts");
    await settle();
    const clear = harness.alarmsClear;
    clear.mockClear();
    // One run finishes; the other is still running.
    harness.storage.set("briefRuns", { a: run("a", "done"), b: run("b", "running") });
    harness.emitAlarm("nimbus-brief-poll");
    await settle();
    expect(clear).not.toHaveBeenCalledWith("nimbus-brief-poll");
  });

  it("clears stored briefs on unpair, so a report cannot outlive its gateway", async () => {
    harness.storage.set("briefRuns", {
      b1: {
        id: "b1",
        question: "q",
        declared: [],
        phase: { kind: "running" },
        expiresAtMs: Date.now() + 60_000,
        writtenAtMs: Date.now(),
      },
    });
    await import("../../src/background/service-worker.ts");
    await settle();
    await harness.emitMessage({ kind: "unpair" });
    await settle();
    const stored = harness.storage.get("briefRuns");
    expect(stored).toEqual({});
  });

  it("keeps the disclosure log across unpair — a past egress did not un-happen", async () => {
    harness.storage.set("briefLog", [
      { runId: "r1", at: 1, question: "q", sourceCount: 1, truncatedCount: 0 },
    ]);
    await import("../../src/background/service-worker.ts");
    await settle();
    await harness.emitMessage({ kind: "unpair" });
    await settle();
    const stored = harness.storage.get("briefLog");
    expect(stored).toHaveLength(1);
  });

  it("serves the log and clears it on request", async () => {
    harness.storage.set("briefLog", [
      { runId: "r1", at: 1, question: "q", sourceCount: 1, truncatedCount: 0 },
    ]);
    await import("../../src/background/service-worker.ts");
    await settle();
    expect(await harness.emitMessage({ kind: "brief-log" })).toMatchObject({ entries: [{ runId: "r1" }] });
    await harness.emitMessage({ kind: "brief-log-clear" });
    await settle();
    expect(await harness.emitMessage({ kind: "brief-log" })).toMatchObject({ entries: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/brief-service-worker.test.ts`
Expected: FAIL — the router has no brief branches.

- [ ] **Step 3: Write the implementation**

In `src/background/service-worker.ts`:

1. Add the alarm name beside `AGENT_POLL_ALARM`:

```ts
/**
 * The eviction net for brief runs — NOT the poll cadence. `chrome.alarms` has a
 * one-minute floor while a live poll runs on a `setTimeout` backoff; this only
 * resumes runs whose worker died. The floor matters more here than for agent
 * lanes, because synthesis over up to 4 MB of source text can genuinely outlast
 * a worker.
 */
export const BRIEF_POLL_ALARM = "nimbus-brief-poll";
```

2. Build the deps object once, beside the other wired implementations:

```ts
function briefDeps(): BriefDeps {
  return {
    now: () => Date.now(),
    listTabs: listCandidateTabs,
    origins: readConfiguredOrigins,
    capture: (tabId, expectedUrl) =>
      captureTab({ tabUrl, runCapture }, tabId, "article", expectedUrl),
    connection: async () => {
      const conn = await readConnection();
      return conn.token === null ? null : { origin: conn.origin, token: conn.token };
    },
    client: { createBrief, feedBriefSource, runBrief, getBrief, saveBrief },
    store: { get: getBriefRun, put: putBriefRun },
    log: { append: appendLogEntry, update: updateLogEntry },
    onState: (state) => {
      // Broadcast: the page re-renders if it is open, and the store is still
      // correct if it is not.
      void chrome.runtime
        .sendMessage({ kind: "brief-state", state })
        .catch(() => undefined);
    },
  };
}
```

3. Add ONE branch to the message router that delegates, keeping the router flat:

```ts
  if (isBriefMessage(msg)) {
    return routeBriefMessage(msg, briefDeps());
  }
```

4. Put the fan-out in a helper below the router, not inside it:

```ts
function isBriefMessage(msg: ExtensionRequest): boolean {
  return msg.kind.startsWith("brief-");
}

async function routeBriefMessage(msg: ExtensionRequest, deps: BriefDeps): Promise<unknown> {
  if (msg.kind === "brief-tabs") {
    return handleBriefTabs(deps);
  }
  if (msg.kind === "brief-start") {
    return isBriefStartRequest(msg)
      ? handleBriefStart(deps, msg)
      : { kind: "failed", reason: "invalid_request" };
  }
  if (msg.kind === "brief-save") {
    return handleBriefSave(deps, msg.id);
  }
  if (msg.kind === "brief-log") {
    return { entries: await readLog() };
  }
  if (msg.kind === "brief-log-clear") {
    await clearLog();
    return { ok: true };
  }
  if (msg.kind === "brief-state") {
    const id = msg.id;
    const run = id === undefined ? null : await getBriefRun(id, Date.now());
    return { run };
  }
  return { kind: "failed", reason: "unknown_brief_message" };
}
```

5. **The alarm lifecycle, copied from the agent-lane pattern rather than invented.** A periodic alarm left armed wakes the worker every minute forever, so it is armed on demand and disarmed when nothing needs it — with one subtlety that is easy to get wrong.

   - **Arm it where a run is persisted as `running`**, not at startup. `service-worker.ts:215` does exactly this inside the `putRun` seam wrapper, which is also the one place a poll loop starts. Use **`ensureAlarm(BRIEF_POLL_ALARM, 1)`**, never `chrome.alarms.create`: `alarms.ts`'s comment records why — `create` cancels and replaces a same-named alarm, restarting its countdown, so calling it on every state change would push the next fire out indefinitely and the net would never fire.
   - **Disarm it only when NO run is left running.** `service-worker.ts:440` is the model:

     ```ts
     if ((await listBriefRuns(Date.now())).filter((r) => r.phase.kind === "running").length === 0) {
       await clearAlarm(BRIEF_POLL_ALARM).catch(() => undefined);
     }
     ```

     Clearing unconditionally when *a* run reaches a terminal state would disarm the net for a second brief still in flight — two briefs can overlap, since the gateway allows three concurrent runs. This is the part the lifecycle is easy to get wrong in a way no test notices until a run is silently orphaned.
   - **Keep an `activeBriefPolls: Set<string>` of runIds being polled in-worker**, mirroring `activeAgentPolls`. Chrome fires a periodic alarm whether or not the worker died, so without it the alarm's resume double-polls a run whose `setTimeout` loop is alive and well.

6. Resume any brief left `running` from the alarm handler, and clear stored briefs in the existing unpair path (alongside `clearRuns()`) — **without** clearing the log, which records something that already happened.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/brief-service-worker.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all pass. If Sonar-style complexity is a concern locally, confirm `routeBriefMessage` is a separate function from the main router — that is what keeps both under S3776's cap of 15.

- [ ] **Step 6: Commit**

```bash
git add src/background/service-worker.ts test/unit/brief-service-worker.test.ts
git commit -m "feat(brief): route brief messages through one worker branch"
```

---

### Task 12: Entry points

**Files:**
- Modify: `src/popup/popup.html`, `src/popup/popup.ts`, `src/options/options.html`, `src/options/options.ts`
- Test: `test/unit/popup.test.ts` (extend), `test/unit/options.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new. Both entry points call `chrome.tabs.create({ url: chrome.runtime.getURL("brief.html") })`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/popup.test.ts`:

```ts
it("opens the brief page in a tab, not in the popup", async () => {
  // The popup is destroyed on blur and a brief run outlives it, so the composer
  // cannot live here.
  const create = vi.fn(() => Promise.resolve({}));
  (chrome.tabs as unknown as { create: unknown }).create = create;
  document.getElementById("open-brief")?.dispatchEvent(new MouseEvent("click"));
  await new Promise((r) => setTimeout(r, 0));
  expect(create).toHaveBeenCalledWith({ url: chrome.runtime.getURL("brief.html") });
});
```

Append to `test/unit/options.test.ts`:

```ts
it("links to the brief page from stage 2", () => {
  const link = document.getElementById("open-brief-link");
  expect(link).not.toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/popup.test.ts test/unit/options.test.ts`
Expected: FAIL — no `#open-brief` / `#open-brief-link`.

- [ ] **Step 3: Write the implementation**

Add to `src/popup/popup.html`, below the clip controls:

```html
<button id="open-brief" type="button">Brief from open tabs…</button>
```

In `src/popup/popup.ts`:

```ts
document.getElementById("open-brief")?.addEventListener("click", () => {
  void chrome.tabs
    .create({ url: chrome.runtime.getURL("brief.html") })
    .catch(() => undefined);
});
```

Add to `src/options/options.html` in stage 2, and wire the same `chrome.tabs.create` call in `options.ts`:

```html
<a id="open-brief-link" href="#">Write a research brief from your open tabs</a>
```

Two click-driven entry points, deliberately no `commands` entry: **C1.5** exists because `suggested_key` is a suggestion the browser may silently decline to bind, and neither of these can disappear that way.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/popup.test.ts test/unit/options.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/popup src/options test/unit/popup.test.ts test/unit/options.test.ts
git commit -m "feat(brief): two click-driven ways into the brief page"
```

---

### Task 13: The log in the trust panel

**Files:**
- Create: `src/options/brief-log-view.ts`
- Modify: `src/options/options.html`, `src/options/options.ts`
- Test: `test/unit/brief-log-view.test.ts`

**Interfaces:**
- Consumes: `BriefLogEntry`, `MAX_LOG_ENTRIES` (Task 6).
- Produces: `renderBriefLog(root: HTMLElement, entries: readonly BriefLogEntry[]): void`

- [ ] **Step 1: Write the failing tests**

```ts
// @vitest-environment jsdom
// test/unit/brief-log-view.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { renderBriefLog } from "../../src/options/brief-log-view.ts";
import { MAX_LOG_ENTRIES } from "../../src/shared/brief-log.ts";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

describe("renderBriefLog", () => {
  it("says plainly when nothing has left", () => {
    renderBriefLog(root, []);
    expect(root.textContent).toContain("No research briefs");
  });

  it("names the model and whether it was remote", () => {
    renderBriefLog(root, [
      { runId: "r1", at: 1_700_000_000_000, question: "Why?", sourceCount: 3, truncatedCount: 1, model: "gpt-4", remote: true },
    ]);
    expect(root.textContent).toContain("gpt-4");
    expect(root.textContent).toContain("3");
    expect(root.textContent?.toLowerCase()).toContain("remote");
  });

  it("distinguishes a local run", () => {
    renderBriefLog(root, [
      { runId: "r1", at: 1, question: "q", sourceCount: 1, truncatedCount: 0, model: "llama3", remote: false },
    ]);
    expect(root.textContent?.toLowerCase()).toContain("your machine");
  });

  it("shows a failed run — the source text still left", () => {
    renderBriefLog(root, [
      { runId: "r1", at: 1, question: "q", sourceCount: 2, truncatedCount: 0, failed: true },
    ]);
    expect(root.textContent?.toLowerCase()).toContain("didn't finish");
  });

  it("states the retention cap rather than forgetting quietly", () => {
    renderBriefLog(root, []);
    expect(root.textContent).toContain(String(MAX_LOG_ENTRIES));
  });

  it("newest first", () => {
    renderBriefLog(root, [
      { runId: "old", at: 1, question: "first", sourceCount: 1, truncatedCount: 0 },
      { runId: "new", at: 2, question: "second", sourceCount: 1, truncatedCount: 0 },
    ]);
    const text = root.textContent ?? "";
    expect(text.indexOf("second")).toBeLessThan(text.indexOf("first"));
  });

  it("escapes the question rather than parsing it", () => {
    renderBriefLog(root, [
      { runId: "r1", at: 1, question: "<b>hi</b>", sourceCount: 1, truncatedCount: 0 },
    ]);
    expect(root.querySelector("b")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/brief-log-view.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

```ts
// src/options/brief-log-view.ts
// The log, rendered in stage 4 — the "Where does my data go?" panel, which is
// where a user already goes to ask this. Pure: no chrome.*, no fetch.
//
// This is the second half of that panel's answer. The first half says which one
// origin the extension talks to; this one says what it caused to leave.
import { type BriefLogEntry, MAX_LOG_ENTRIES } from "../shared/brief-log.ts";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className !== undefined) {
    node.className = className;
  }
  return node;
}

function describe(entry: BriefLogEntry): string {
  const pages = `${entry.sourceCount} ${entry.sourceCount === 1 ? "page" : "pages"}`;
  const shortened =
    entry.truncatedCount > 0 ? `, ${entry.truncatedCount} shortened to fit` : "";
  if (entry.failed === true) {
    return `${pages} were sent${shortened}, but the brief didn't finish.`;
  }
  if (entry.model === undefined) {
    return `${pages} were sent${shortened}.`;
  }
  return entry.remote === true
    ? `${pages} were sent${shortened} and answered by a remote model (${entry.model}).`
    : `${pages} were sent${shortened} and answered on your machine by ${entry.model}.`;
}

export function renderBriefLog(root: HTMLElement, entries: readonly BriefLogEntry[]): void {
  root.replaceChildren();
  root.appendChild(el("h3", "Research briefs you have run"));
  root.appendChild(
    el(
      "p",
      `Nimbus's own record does not cover model calls, so this list is kept here, in your browser. The last ${MAX_LOG_ENTRIES} are kept.`,
      "log-note",
    ),
  );
  if (entries.length === 0) {
    root.appendChild(el("p", "No research briefs have been run from this browser.", "log-empty"));
    return;
  }
  const list = el("ul", undefined, "brief-log");
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const li = el("li");
    li.appendChild(el("p", new Date(entry.at).toLocaleString(), "log-when"));
    li.appendChild(el("p", entry.question, "log-question"));
    li.appendChild(el("p", describe(entry), "log-what"));
    if (entry.savedItemId !== undefined) {
      li.appendChild(el("p", "Saved to your index.", "log-saved"));
    }
    list.appendChild(li);
  }
  root.appendChild(list);
  const clear = el("button", "Clear this list", "clear-log");
  clear.type = "button";
  clear.id = "clear-brief-log";
  root.appendChild(clear);
}
```

Then in `options.html` add `<section id="brief-log"></section>` inside stage 4, and in `options.ts` fetch `{ kind: "brief-log" }` on load, call `renderBriefLog`, and wire `#clear-brief-log` to send `{ kind: "brief-log-clear" }` and re-render.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/brief-log-view.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/options test/unit/brief-log-view.test.ts
git commit -m "feat(brief): show the disclosure log in the trust panel"
```

---

### Task 14: Documentation, roadmap and changelog

**Files:**
- Modify: `docs/architecture.md`, `docs/development.md`, `CHANGELOG.md`, `ROADMAP.md`
- Test: `bun run test` (the doc-reference and store-listing guards)

- [ ] **Step 1: Add the architecture section**

In `docs/architecture.md`, add a `## Research briefs` section covering: the five-route staged protocol; why the worker owns polling and the page never does; the 200 KB extraction cap and the 16-vs-20 arithmetic behind it; `run_capacity` vs `source_too_large`; why no source text reaches storage; and why the disclosure log exists (`THIS_BINARY_COVERAGE.model` is `none`). Link the spec.

- [ ] **Step 2: Add the manual checklist**

In `docs/development.md`, add a "Research briefs" checklist, and state plainly what the mock gateway cannot verify:

```markdown
### Research briefs — needs a REAL gateway

`scripts/screenshots/mock-gateway.ts` builds its `Request` from method and headers
only and **drops the POST body**, so every body-driven behaviour below is invisible
to it. A pass against the mock is not evidence for any of these.

1. Open three tabs on a granted host, open the brief page, pick all three, run.
2. Confirm the pre-run preview names all three sources and does not claim local synthesis.
3. Confirm the report renders summary, findings, conflicts and gaps.
4. Confirm the banner names the model, and the disclosure appears exactly once.
5. Open a fourth tab on an UNGRANTED host; confirm it is counted, not named.
6. Grant that host in Options, return to the brief tab; confirm it appears without a reload.
7. Navigate one source tab away mid-run; confirm the brief still finishes and names the skipped page.
8. With 17+ large tabs, confirm feeding stops on `run_capacity` and the brief still answers.
9. Turn the gateway's briefs seam off; confirm the page reports it with the gateway's own hint.
10. Start a fourth concurrent brief; confirm `briefs_busy` reads as "already running three" with no auto-retry.
11. Save a brief; confirm Options stage 4 shows the run and marks it saved.
12. Unpair; confirm stored briefs are gone and the disclosure log is NOT.
13. Repeat 1–4 in Firefox.
```

- [ ] **Step 3: Add the changelog entry**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:

```markdown
- **Ask one question about several open tabs.** Pick the tabs you have open, choose
  a question Nimbus suggests from what those pages are, and get back a brief with
  findings, the places your sources disagree, and an honest list of what it could
  not cover. Each finding cites the page it came from. It works on the sites you
  have granted page access to; other tabs are counted, never named, because Nimbus
  cannot read them.
- **A record of what left.** Options now lists every research brief you have run —
  when, how many pages, and whether the answer came from a model on your machine or
  a remote one. Nimbus's own audit trail does not cover model calls, so this list is
  kept in your browser.
```

- [ ] **Step 4: Add the roadmap item**

Add a **Phase C5 — Ask across what you have open** section with a `C5.1` brief in the house shape (What / Why it wows / Touches / Approach / Done when / Status), and record the corrections from the spec's final section: 5.1 superseded, 2.3 re-aimed, C4.1 half-delivered with its approach note qualified, C1.4's status line stale.

- [ ] **Step 5: Run the full gate set**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all pass. `test/unit/doc-references.test.ts` walks `ROADMAP.md` and `docs/*.md` for spec paths and fails on a dangling one, so the spec link must be exact.

- [ ] **Step 6: Prune this plan and the review notes**

The assertion is `readdirSync("docs/superpowers/plans").filter(f => f.endsWith(".md"))` — it
does not care *which* markdown file is in there. So a review-notes file dropped beside the
plan trips the same gate, and pruning only the plan by name would leave it red. Clear the
directory, then remove the review notes wherever they were left:

```bash
git rm -f docs/superpowers/plans/*.md
rm -f docs/superpowers/plans/*.md
rm -f docs/superpowers/specs/*-suggestions.md
bun run test
```

Then confirm the directory is actually empty rather than trusting the glob:

```bash
ls docs/superpowers/plans/
```

This is the last step for a reason: the plan is a working document, the spec is the record,
and git history keeps both. Expect a **fully** green suite after this — zero failures. If
anything else is red, it was hiding behind the known one all along.

- [ ] **Step 7: Commit**

```bash
git add docs CHANGELOG.md ROADMAP.md
git commit -m "docs(brief): architecture, manual checklist, changelog and roadmap entry"
```

---

## Self-Review

**Spec coverage.** Every decision maps to a task: sources-are-tabs → 4, 9; no-new-permission → 4 (and the Global Constraints ban); scaffolded question → 1, 10; declare-all/feed-what-captures → 9; truncate-and-declare at 200 KB → 1; `run_capacity` vs `source_too_large` → 3, 9; never-queued/no-source-text → 5, 6 (asserted by test); the honest synthesis notice → 7; no ledger coverage → 6; disclosure log → 6, 13; save is the user's call → 9, 10; quote-stripping honesty → 2, 10; its own page → 10, 12. Shape's ownership rules → 11. Testing's four pinned assertions → Tasks 1, 6, 9 (log-on-failure), 3 (`run_capacity`).

**Two things deliberately deferred inside the plan**, flagged so an executor does not think they were forgotten: the `brief-state` request arm in Task 11 returns the stored run but the page currently renders only pushed state — wire the initial read if reopening a page mid-run should paint immediately; and Task 11 step 5's alarm-resume branch is described rather than coded, because its exact shape depends on the existing `AGENT_POLL_ALARM` handler it sits beside.

**Type consistency.** `BriefState` is defined in Task 9 and consumed by name in 10 and 11. `CandidateTab`/`TabCandidates` from Task 4 flow into 9 and 10. `BriefReport` from Task 2 is used by 3, 5, 9, 10. `BriefLogEntry` from Task 6 is used by 9 and 13. `BriefSourceBody`/`BriefSourceDecl` from Task 1 are used by 3 and 9. The caps appear in two places by design (`shared/brief.ts` and the `messages.ts` guard, which must not import `types.ts`), and Task 8 step 4 asserts they agree.

**One known duplication.** The restricted-scheme set exists in both `capture-tab.ts` and `browser/tabs.ts`. That is deliberate — `src/browser/` is the `chrome.*` seam and must not import from `src/background/` — and the comment in Task 4 says so. If a third copy ever appears, it belongs in `src/shared/`.
