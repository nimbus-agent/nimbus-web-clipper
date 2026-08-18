# Passages as Brief Sources (C5.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A right-click collects the current selection; passages accumulate across pages and
tabs; and the brief composer sends a highlighted page to the gateway as one source holding
those passages in collection order.

**Architecture:** All rules live in one pure module (`src/shared/passage.ts`) that a thin
`chrome.storage.local` store persists and a thin worker action feeds. The gateway contract does
not change: `BriefSourceBody.body` is supplied by the client, so a stitched excerpt set is
already a legal source. The composer gains passage rows beside its tab rows, and the pre-send
preview — uniquely, because passage text is captured before the run — shows the exact bytes
that will leave.

**Tech Stack:** TypeScript (strict, no `any`), Vitest (node env; jsdom via a `@vitest-environment`
docblock), Playwright for e2e, Biome for lint/format, esbuild via Bun, MV3 (`chrome.*` namespace
on both Chrome and Firefox).

**Spec:** [`docs/superpowers/specs/2026-08-18-passages-as-brief-sources-design.md`](../specs/2026-08-18-passages-as-brief-sources-design.md)
— read it first. Every task below cites the decision it implements; the spec is the argument,
this plan is the sequence.

## Global Constraints

- **TypeScript strict, no `any`.** External or cross-boundary data is `unknown`, narrowed with a
  type guard. Biome enforces `noExplicitAny`, `noNonNullAssertion`.
- **No `console.*` anywhere in `src/`** (`noConsole`). Tests and `scripts/` may log. A swallowed
  error gets an explanatory comment, never a log.
- **No new manifest permission.** `contextMenus`, `activeTab`, `scripting`, `storage` are already
  granted. Do not add `unlimitedStorage` (spec decision 8).
- **Loopback only.** No new fetch, no new host permission.
- **Never log the bearer token or the pairing code.** Passage text is user content: it may be
  rendered, never logged.
- `PASSAGE_SEPARATOR` is exactly `"\n\n[...]\n\n"` — one exported constant, used by `stitch` and
  by the preview renderer, byte for byte (spec decision 3).
- Caps come from the shipped `BRIEF_CAPS` (`src/shared/brief.ts`); never re-declare their values:
  `maxSources` 20, `extractionCapBytes` 200 × 1024.
- **Every task ends green:** `bun run typecheck && bun run lint && bun run test` all pass before
  the commit. The baseline on this branch is 74 files / 1302 tests.
- Commit messages: `<type>(<scope>): <subject>`, ending with the repo's `Co-Authored-By` trailer.

---

### Task 1: The pure collection rules

**Files:**
- Create: `src/shared/passage.ts`
- Test: `test/unit/passage.test.ts`

**Interfaces:**
- Consumes: `BRIEF_CAPS`, `utf8Bytes` from `src/shared/brief.ts` (both already exported).
- Produces: `Passage`, `PassageGroup`, `PassageRefusal`, `PassageUpdate`, `PASSAGE_SEPARATOR`,
  `PASSAGE_CAPS`, `groupKey`, `groupPassages`, `stitch`, `groupCapturedAt`, `addPassage`,
  `removePassage`, `removeGroup`, `isPassage`. Every later task depends on these names.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/passage.test.ts`:

```ts
// test/unit/passage.test.ts
import { describe, expect, test } from "vitest";
import { BRIEF_CAPS } from "../../src/shared/brief.ts";
import {
  addPassage,
  groupCapturedAt,
  groupKey,
  groupPassages,
  isPassage,
  PASSAGE_CAPS,
  PASSAGE_SEPARATOR,
  type Passage,
  removeGroup,
  removePassage,
  stitch,
} from "../../src/shared/passage.ts";

function p(url: string, text: string, at = 1, title = "T"): Passage {
  return { url, title, text, at };
}

describe("groupKey", () => {
  test("strips the fragment and nothing else", () => {
    expect(groupKey("http://h/a?b=1#frag")).toBe("http://h/a?b=1");
    expect(groupKey("http://h/a?b=1")).toBe("http://h/a?b=1");
  });

  // The gateway drops utm_*/click-ids and the trailing slash itself
  // (recognise.ts). Doing it here too would be a second, drifting
  // implementation of its canonicalisation — see the spec's grouping section.
  test("preserves utm parameters, click ids and the trailing slash", () => {
    expect(groupKey("http://h/a?utm_source=x")).toBe("http://h/a?utm_source=x");
    expect(groupKey("http://h/a/")).toBe("http://h/a/");
  });

  test("leaves a string it cannot parse alone rather than throwing", () => {
    expect(groupKey("not a url")).toBe("not a url");
  });
});

describe("groupPassages", () => {
  test("two fragments of one page are one group; two query strings are two", () => {
    const groups = groupPassages([
      p("http://h/a#one", "first"),
      p("http://h/a#two", "second"),
      p("http://h/a?utm_source=x", "third"),
    ]);
    expect(groups.map((g) => g.url)).toEqual(["http://h/a", "http://h/a?utm_source=x"]);
    expect(groups[0]?.passages.map((x) => x.text)).toEqual(["first", "second"]);
  });

  test("keys keep first-seen order and the group takes the first title", () => {
    const groups = groupPassages([
      p("http://h/b", "b1", 1, "B title"),
      p("http://h/a", "a1", 2, "A title"),
      p("http://h/b", "b2", 3, "B renamed"),
    ]);
    expect(groups.map((g) => g.url)).toEqual(["http://h/b", "http://h/a"]);
    expect(groups[0]?.title).toBe("B title");
  });
});

describe("PASSAGE_SEPARATOR", () => {
  // Pinned by value, not because a formatter would rewrite a string literal —
  // none does — but because these bytes are visible in three places at once: the
  // body the gateway receives, the text the preview shows, and the e2e's literal
  // assertion. Changing it is allowed; changing it by accident is not, and this
  // is the test that names the contract when someone does.
  test("is exactly a bracketed ellipsis on its own line", () => {
    expect(PASSAGE_SEPARATOR).toBe("\n\n[...]\n\n");
  });
});

describe("stitch", () => {
  test("joins in collection order with the separator between passages", () => {
    const group = groupPassages([p("http://h/a", "one"), p("http://h/a", "two")])[0];
    expect(group).toBeDefined();
    expect(stitch(group as never)).toBe(`one${PASSAGE_SEPARATOR}two`);
  });

  test("a single passage carries no leading or trailing separator", () => {
    const group = groupPassages([p("http://h/a", "only")])[0];
    expect(stitch(group as never)).toBe("only");
  });
});

describe("groupCapturedAt", () => {
  // A stitched body is only as fresh as its OLDEST text. Reporting the newest
  // would overstate the freshness of everything above it.
  test("returns the oldest, even when passages arrived out of order", () => {
    const group = groupPassages([p("http://h/a", "late", 900), p("http://h/a", "early", 100)])[0];
    expect(groupCapturedAt(group as never)).toBe(100);
  });
});

describe("addPassage", () => {
  test("appends to the end of the collection", () => {
    const res = addPassage([p("http://h/a", "one")], p("http://h/a", "two", 2));
    expect(res.ok).toBe(true);
    expect(res.ok && res.all.map((x) => x.text)).toEqual(["one", "two"]);
  });

  test("refuses an exact duplicate of a passage already held for that page", () => {
    const res = addPassage([p("http://h/a", "same")], p("http://h/a#other", "same", 2));
    expect(res).toEqual({ ok: false, reason: "duplicate" });
  });

  test("the same text on a different page is not a duplicate", () => {
    const res = addPassage([p("http://h/a", "same")], p("http://h/b", "same", 2));
    expect(res.ok).toBe(true);
  });

  test("refuses when the page's stitched body would exceed the extraction cap", () => {
    const big = "x".repeat(BRIEF_CAPS.extractionCapBytes - 10);
    const res = addPassage([p("http://h/a", big)], p("http://h/a", "yyyyyyyyyyyyyyyy", 2));
    expect(res).toEqual({ ok: false, reason: "page-full" });
  });

  test("accepts a page's passages right up to the cap", () => {
    const body = "x".repeat(BRIEF_CAPS.extractionCapBytes - PASSAGE_SEPARATOR.length - 1);
    const res = addPassage([p("http://h/a", body)], p("http://h/a", "y", 2));
    expect(res.ok).toBe(true);
  });

  test("counts UTF-8 bytes, not code units", () => {
    // A 4-byte astral character must count as four. A length-based cap would
    // admit four times the ceiling.
    const astral = "\u{1F600}".repeat(BRIEF_CAPS.extractionCapBytes / 4);
    const res = addPassage([p("http://h/a", astral)], p("http://h/a", "y", 2));
    expect(res).toEqual({ ok: false, reason: "page-full" });
  });

  test("refuses a new page once the collection holds the cap", () => {
    const full = Array.from({ length: PASSAGE_CAPS.maxPages }, (_, i) =>
      p(`http://h/${i}`, "t", i),
    );
    expect(addPassage(full, p("http://h/new", "t", 99))).toEqual({
      ok: false,
      reason: "collection-full",
    });
  });

  test("a page already held still accepts passages when the collection is full", () => {
    const full = Array.from({ length: PASSAGE_CAPS.maxPages }, (_, i) =>
      p(`http://h/${i}`, "t", i),
    );
    expect(addPassage(full, p("http://h/0", "another", 99)).ok).toBe(true);
  });

  test("a refusal never mutates the input", () => {
    const before = [p("http://h/a", "same")];
    addPassage(before, p("http://h/a", "same", 2));
    expect(before).toEqual([p("http://h/a", "same")]);
  });
});

describe("removePassage / removeGroup", () => {
  test("removePassage drops one and leaves its siblings in order", () => {
    const all = [p("http://h/a", "one", 1), p("http://h/a", "two", 2), p("http://h/a", "three", 3)];
    expect(removePassage(all, "http://h/a", 2).map((x) => x.text)).toEqual(["one", "three"]);
  });

  test("removing the last passage of a group leaves no empty group behind", () => {
    const all = [p("http://h/a", "only", 1), p("http://h/b", "other", 2)];
    const left = removePassage(all, "http://h/a", 1);
    expect(groupPassages(left).map((g) => g.url)).toEqual(["http://h/b"]);
  });

  test("removeGroup drops only its own page, fragment-insensitively", () => {
    const all = [p("http://h/a#x", "one", 1), p("http://h/b", "two", 2)];
    expect(removeGroup(all, "http://h/a").map((x) => x.text)).toEqual(["two"]);
  });
});

describe("isPassage", () => {
  test("accepts a well-formed stored passage", () => {
    expect(isPassage({ url: "http://h/a", title: "T", text: "x", at: 1 })).toBe(true);
  });

  test.each([
    ["null", null],
    ["a string", "x"],
    ["a missing url", { title: "T", text: "x", at: 1 }],
    ["a numeric title", { url: "u", title: 2, text: "x", at: 1 }],
    ["a missing text", { url: "u", title: "T", at: 1 }],
    ["a string at", { url: "u", title: "T", text: "x", at: "1" }],
  ])("rejects %s", (_label, value) => {
    expect(isPassage(value)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/passage.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/shared/passage.ts"`.

- [ ] **Step 3: Write the module**

Create `src/shared/passage.ts`:

```ts
// src/shared/passage.ts
// The passage collection's rules, and nothing else: no storage, no tabs, no
// gateway. One module owns grouping, stitching and every cap, so a store that
// persists only what `addPassage` returns cannot drift from them.
import { BRIEF_CAPS, utf8Bytes } from "./brief.ts";

export type Passage = {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  /** When this passage was captured — the collect gesture, not the run. */
  readonly at: number;
};

export type PassageGroup = {
  /** The grouping key: the url with its fragment removed. */
  readonly url: string;
  readonly title: string;
  readonly passages: readonly Passage[];
};

export type PassageRefusal = "duplicate" | "page-full" | "collection-full" | "storage-full";

export type PassageUpdate =
  | { readonly ok: true; readonly all: readonly Passage[] }
  | { readonly ok: false; readonly reason: PassageRefusal };

/**
 * The scholarly mark for omitted text.
 *
 * Not a rule (`---` is legal page content and reads as content), and not a
 * worded label — client vocabulary inside a source body can be quoted back as
 * though the page had written it. `[...]` means "text was omitted here" to a
 * human and a model alike, and fabricates nothing.
 */
export const PASSAGE_SEPARATOR = "\n\n[...]\n\n";

export const PASSAGE_CAPS = {
  /** One page's stitched body, in UTF-8 bytes. THIS CLIENT's extraction cap. */
  maxPageBytes: BRIEF_CAPS.extractionCapBytes,
  /** Pages held at once — aligned with what one run can carry. */
  maxPages: BRIEF_CAPS.maxSources,
} as const;

/**
 * The identity of the page a passage belongs to: the url with its fragment
 * removed, and NOTHING else removed.
 *
 * The fragment goes because it is not part of a document's identity by the URL
 * spec's own rules — it is never sent to a server — and because the gateway
 * drops it too, so keeping it would declare one page twice in one run.
 *
 * Everything else stays. `utm_*`, click-ids and trailing slashes are dropped by
 * the gateway's `canonicalizeUrl`, and `recognise.ts` records why re-deriving
 * those rules here is worse than not: `externalIdFor` hashes that function's
 * output, so a client copy that drifts changes item identity.
 *
 * A textual cut, not a `URL` round-trip: `new URL().toString()` also lower-cases
 * the host, normalises percent-encoding and adds a trailing slash to a bare
 * origin — all of it canonicalisation this must not do. Per RFC 3986 the first
 * `#` is the fragment delimiter, so the cut is exact.
 */
export function groupKey(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/** Group by key, keys in first-seen order, each group titled by its first passage. */
export function groupPassages(all: readonly Passage[]): readonly PassageGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, Passage[]>();
  for (const passage of all) {
    const key = groupKey(passage.url);
    const held = byKey.get(key);
    if (held === undefined) {
      order.push(key);
      byKey.set(key, [passage]);
      continue;
    }
    held.push(passage);
  }
  return order.map((key) => {
    const passages = byKey.get(key) ?? [];
    return { url: key, title: passages[0]?.title ?? key, passages };
  });
}

export function stitch(group: PassageGroup): string {
  return group.passages.map((passage) => passage.text).join(PASSAGE_SEPARATOR);
}

/**
 * The group's capture time: its OLDEST passage.
 *
 * A stitched body is only as fresh as the oldest text in it, so the newest
 * would overstate the freshness of everything above it. Understating is the
 * safe direction.
 */
export function groupCapturedAt(group: PassageGroup): number {
  return group.passages.reduce((oldest, passage) => Math.min(oldest, passage.at), Number.MAX_SAFE_INTEGER);
}

/**
 * The collection's ONE mutation, and the only place a cap is enforced.
 *
 * Enforced here rather than at feed time on purpose: truncate-and-declare is
 * right for a page the client extracted on the user's behalf, and wrong for text
 * the user selected by hand — there the honest move is to refuse now, while they
 * are standing there, rather than to cut it silently later.
 */
export function addPassage(all: readonly Passage[], next: Passage): PassageUpdate {
  const key = groupKey(next.url);
  const same = all.filter((passage) => groupKey(passage.url) === key);
  if (same.some((passage) => passage.text === next.text)) {
    return { ok: false, reason: "duplicate" };
  }
  const stitched = [...same.map((passage) => passage.text), next.text].join(PASSAGE_SEPARATOR);
  if (utf8Bytes(stitched) > PASSAGE_CAPS.maxPageBytes) {
    return { ok: false, reason: "page-full" };
  }
  if (same.length === 0) {
    const pages = new Set(all.map((passage) => groupKey(passage.url)));
    if (pages.size >= PASSAGE_CAPS.maxPages) {
      return { ok: false, reason: "collection-full" };
    }
  }
  return { ok: true, all: [...all, next] };
}

/** Drop one passage, identified by its page and its capture instant. */
export function removePassage(
  all: readonly Passage[],
  url: string,
  at: number,
): readonly Passage[] {
  const key = groupKey(url);
  const index = all.findIndex((passage) => groupKey(passage.url) === key && passage.at === at);
  return index === -1 ? all : [...all.slice(0, index), ...all.slice(index + 1)];
}

/** Drop every passage held for one page. */
export function removeGroup(all: readonly Passage[], url: string): readonly Passage[] {
  const key = groupKey(url);
  return all.filter((passage) => groupKey(passage.url) !== key);
}

/** Guard for a value read back out of storage. */
export function isPassage(v: unknown): v is Passage {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    typeof o["url"] === "string" &&
    typeof o["title"] === "string" &&
    typeof o["text"] === "string" &&
    typeof o["at"] === "number"
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/passage.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify the gates and commit**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass; test count is the baseline plus this file's cases.

```bash
git add src/shared/passage.ts test/unit/passage.test.ts
git commit -m "feat(shared): the passage collection's rules

Grouping strips the fragment and nothing else: the gateway drops it too, so
keeping it would declare one page twice in one run. utm_*/click-ids stay —
that is canonicalisation, and recognise.ts records why a second implementation
here is worse than none.

Caps are enforced on add, not on feed: truncate-and-declare is right for a page
the client extracted, wrong for text a person selected by hand.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Persistence

**Files:**
- Create: `src/background/passage-store.ts`
- Test: `test/unit/passage-store.test.ts`

**Interfaces:**
- Consumes: `Passage`, `PassageUpdate`, `isPassage` (Task 1); `storageGet`/`storageSet` from
  `src/browser/storage.ts`.
- Produces: `getPassages(): Promise<Passage[]>` and
  `updatePassages(mutator: (all: readonly Passage[]) => PassageUpdate): Promise<PassageUpdate>`.
  Task 3 and Task 6 both call these.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/passage-store.test.ts`:

```ts
// test/unit/passage-store.test.ts
import { beforeEach, describe, expect, test } from "vitest";
import { addPassage, type Passage, removeGroup } from "../../src/shared/passage.ts";
import { installChromeStub } from "./chrome-stub.ts";

async function load() {
  // Re-imported per test: the module holds a write-chain promise, and a chain
  // carried between tests would serialise unrelated cases together.
  return await import(`../../src/background/passage-store.ts?${Math.random()}`);
}

function p(url: string, text: string, at = 1): Passage {
  return { url, title: "T", text, at };
}

describe("passage store", () => {
  beforeEach(() => {
    installChromeStub();
  });

  test("an empty store reads as an empty list", async () => {
    const { getPassages } = await load();
    expect(await getPassages()).toEqual([]);
  });

  test("a write is readable back", async () => {
    const { getPassages, updatePassages } = await load();
    const res = await updatePassages((all) => addPassage(all, p("http://h/a", "one")));
    expect(res.ok).toBe(true);
    expect(await getPassages()).toEqual([p("http://h/a", "one")]);
  });

  test("a refusal from the mutator writes nothing and is returned verbatim", async () => {
    const { getPassages, updatePassages } = await load();
    await updatePassages((all) => addPassage(all, p("http://h/a", "one")));
    const res = await updatePassages((all) => addPassage(all, p("http://h/a", "one", 2)));
    expect(res).toEqual({ ok: false, reason: "duplicate" });
    expect(await getPassages()).toHaveLength(1);
  });

  test("a malformed stored entry is dropped, and the rest survive", async () => {
    installChromeStub({ storage: { passages: [p("http://h/a", "one"), { url: 5 }, "junk"] } });
    const { getPassages } = await load();
    expect(await getPassages()).toEqual([p("http://h/a", "one")]);
  });

  test("a non-array stored value reads as empty", async () => {
    installChromeStub({ storage: { passages: { nope: true } } });
    const { getPassages } = await load();
    expect(await getPassages()).toEqual([]);
  });

  // Refuse, never evict: a passage exists in exactly one place and was put
  // there by hand. The clip queue drops its oldest under pressure; this must
  // not.
  test("a failed write refuses and leaves the held collection intact", async () => {
    installChromeStub({ storage: { passages: [p("http://h/a", "one")] }, failFirstSet: true });
    const { getPassages, updatePassages } = await load();
    const res = await updatePassages((all) => addPassage(all, p("http://h/b", "two", 2)));
    expect(res).toEqual({ ok: false, reason: "storage-full" });
    expect(await getPassages()).toEqual([p("http://h/a", "one")]);
  });

  test("concurrent updates each run against freshly-read state", async () => {
    const { getPassages, updatePassages } = await load();
    await Promise.all([
      updatePassages((all) => addPassage(all, p("http://h/a", "one", 1))),
      updatePassages((all) => addPassage(all, p("http://h/b", "two", 2))),
      updatePassages((all) => addPassage(all, p("http://h/c", "three", 3))),
    ]);
    expect((await getPassages()).map((x) => x.text)).toEqual(["one", "two", "three"]);
  });

  test("a remove is a mutator like any other", async () => {
    const { getPassages, updatePassages } = await load();
    await updatePassages((all) => addPassage(all, p("http://h/a", "one")));
    await updatePassages((all) => addPassage(all, p("http://h/b", "two", 2)));
    await updatePassages((all) => ({ ok: true, all: removeGroup(all, "http://h/a") }));
    expect((await getPassages()).map((x) => x.text)).toEqual(["two"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/passage-store.test.ts`
Expected: FAIL — cannot resolve `src/background/passage-store.ts`.

- [ ] **Step 3: Write the store**

Create `src/background/passage-store.ts`:

```ts
// src/background/passage-store.ts
// The passage collection's persistence: a read and a *serialized*
// read-modify-write, the same single-writer shape `clip-queue-store.ts` uses —
// the worker is single-threaded but not single-task, and a menu click and a
// composer read can interleave on this key.
//
// It differs from that store in one deliberate place: a failed write REFUSES.
// The queue drops its oldest entry under storage pressure; a passage exists in
// exactly one place and was put there by hand, so losing one silently is worse
// than a refusal the user can act on immediately.
import { storageGet, storageSet } from "../browser/storage.ts";
import { isPassage, type Passage, type PassageUpdate } from "../shared/passage.ts";

const PASSAGES_KEY = "passages";

export async function getPassages(): Promise<Passage[]> {
  const value = await storageGet(PASSAGES_KEY);
  return Array.isArray(value) ? value.filter(isPassage) : [];
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Apply `mutator` to the freshly-read collection and persist what it returns.
 *
 * A refusal is passed straight back to the caller and nothing is written, so
 * every cap in `addPassage` reaches the user as the toast for that reason.
 */
export function updatePassages(
  mutator: (all: readonly Passage[]) => PassageUpdate,
): Promise<PassageUpdate> {
  const next = chain.then(async (): Promise<PassageUpdate> => {
    const current = await getPassages();
    const desired = mutator(current);
    if (!desired.ok) {
      return desired;
    }
    try {
      await storageSet(PASSAGES_KEY, desired.all);
    } catch {
      // Intentionally not logged (`noConsole`), and intentionally not retried by
      // dropping anything — see the module comment.
      return { ok: false, reason: "storage-full" };
    }
    return desired;
  });
  // Keep the lock chain alive whether or not this call resolved or rejected.
  chain = next.catch(() => undefined);
  return next;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/passage-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the gates and commit**

Run: `bun run typecheck && bun run lint && bun run test`

```bash
git add src/background/passage-store.ts test/unit/passage-store.test.ts
git commit -m "feat(background): persist the passage collection

Serialized read-modify-write like clip-queue-store, minus its eviction: a
failed write refuses and leaves the held collection intact. A passage exists in
one place only and was put there by hand.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The collect gesture

**Files:**
- Create: `src/background/passage-collect.ts`
- Modify: `src/background/menus.ts` (one `MENU_ITEMS` row, one constant, one `menuAction` arm,
  one `MenuAction` member)
- Modify: `src/background/service-worker.ts` (one deps object, one switch arm)
- Modify: `test/unit/menus.test.ts` — it asserts **exactly five entries**; a sixth breaks it
- Test: `test/unit/passage-collect.test.ts`

**Interfaces:**
- Consumes: `captureTab` + `CaptureOutcome` from `src/background/capture-tab.ts`;
  `updatePassages` (Task 2); `addPassage`, `Passage`, `PassageRefusal` (Task 1); `ToastState`
  from `src/shared/types.ts`.
- Produces: `MENU_ADD_PASSAGE = "add-passage"`, the `"add-passage"` `MenuAction` member,
  `PassageCollectDeps`, `collectPassage(deps, tabId): Promise<void>`.

**Note on the badge.** `showFeedback`'s `restricted` argument flashes the toolbar badge when a
toast cannot be injected. That is the shipped fallback for an un-injectable page and does not
contradict spec decision 10, which forbids the collection *tracking state* on the badge — the
queue owns that.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/passage-collect.test.ts`:

```ts
// test/unit/passage-collect.test.ts
import { describe, expect, test, vi } from "vitest";
import {
  collectPassage,
  type PassageCollectDeps,
} from "../../src/background/passage-collect.ts";
import { addPassage, type Passage, type PassageUpdate } from "../../src/shared/passage.ts";
import type { CaptureResult, ToastState } from "../../src/shared/types.ts";

const CAPTURE: CaptureResult = {
  url: "http://h/a#frag",
  title: "A page",
  mode: "selection",
  body: "the selected words",
};

function deps(over: Partial<PassageCollectDeps> = {}): {
  deps: PassageCollectDeps;
  held: Passage[];
  toasts: ToastState[];
} {
  const held: Passage[] = [];
  const toasts: ToastState[] = [];
  const base: PassageCollectDeps = {
    capture: async () => ({ ok: true, capture: CAPTURE }),
    update: async (mutator) => {
      const res: PassageUpdate = mutator(held);
      if (res.ok) {
        held.length = 0;
        held.push(...res.all);
      }
      return res;
    },
    showFeedback: async (_tabId, state) => {
      toasts.push(state);
    },
    now: () => 1000,
    ...over,
  };
  return { deps: base, held, toasts };
}

describe("collectPassage", () => {
  test("stores the captured selection under the page's own url and title", async () => {
    const { deps: d, held } = deps();
    await collectPassage(d, 7);
    expect(held).toEqual([
      { url: "http://h/a#frag", title: "A page", text: "the selected words", at: 1000 },
    ]);
  });

  test("confirms with a toast naming how many passages the page now holds", async () => {
    const { deps: d, toasts } = deps();
    await collectPassage(d, 7);
    await collectPassage(
      { ...d, capture: async () => ({ ok: true, capture: { ...CAPTURE, body: "more words" } }) },
      7,
    );
    expect(toasts[0]).toEqual({ variant: "success", text: "Added — 1 passage from this page." });
    expect(toasts[1]).toEqual({ variant: "success", text: "Added — 2 passages from this page." });
  });

  test("an empty capture says nothing was selected and stores nothing", async () => {
    const { deps: d, held, toasts } = deps({
      capture: async () => ({ ok: false, reason: "empty" }),
    });
    await collectPassage(d, 7);
    expect(held).toEqual([]);
    expect(toasts).toEqual([{ variant: "error", text: "Nothing selected." }]);
  });

  test("a restricted page reports through the badge fallback", async () => {
    const restrictedFlags: (boolean | undefined)[] = [];
    const { deps: d } = deps({
      capture: async () => ({ ok: false, reason: "restricted" }),
      showFeedback: async (_tabId, _state, restricted) => {
        restrictedFlags.push(restricted);
      },
    });
    await collectPassage(d, 7);
    expect(restrictedFlags).toEqual([true]);
  });

  test("each refusal reason gets its own words", async () => {
    for (const [reason, text] of [
      ["duplicate", "Already collected."],
      ["page-full", "That page's passages are full."],
      ["collection-full", "Collection is full — send or clear a brief first."],
      ["storage-full", "Couldn't store that passage."],
    ] as const) {
      const { deps: d, toasts } = deps({ update: async () => ({ ok: false, reason }) });
      await collectPassage(d, 7);
      expect(toasts).toEqual([{ variant: "error", text }]);
    }
  });

  test("a duplicate is refused by the rules, not by the action", async () => {
    // The action must not pre-filter: `addPassage` owns every cap, and a second
    // implementation here could disagree with it.
    const { deps: d, held, toasts } = deps();
    await collectPassage(d, 7);
    await collectPassage(d, 7);
    expect(held).toHaveLength(1);
    expect(toasts[1]).toEqual({ variant: "error", text: "Already collected." });
  });

  test("a failing toast never rejects the collect", async () => {
    const { deps: d, held } = deps({
      showFeedback: () => Promise.reject(new Error("no receiver")),
    });
    await expect(collectPassage(d, 7)).resolves.toBeUndefined();
    expect(held).toHaveLength(1);
  });

  test("the mutator it passes is addPassage's result, unmodified", async () => {
    const update = vi.fn(async (m: (all: readonly Passage[]) => PassageUpdate) => m([]));
    const { deps: d } = deps({ update });
    await collectPassage(d, 7);
    const mutator = update.mock.calls[0]?.[0];
    expect(mutator).toBeDefined();
    expect(mutator?.([])).toEqual(
      addPassage([], {
        url: "http://h/a#frag",
        title: "A page",
        text: "the selected words",
        at: 1000,
      }),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/passage-collect.test.ts`
Expected: FAIL — cannot resolve `src/background/passage-collect.ts`.

- [ ] **Step 3: Write the collect action**

Create `src/background/passage-collect.ts`:

```ts
// src/background/passage-collect.ts
// The collect gesture, end to end: capture the live selection, hand it to the
// collection's rules, and report what happened in the page.
//
// Shaped like `quick-clip.ts` — pure orchestration over injected seams — for the
// same reason: the whole action is testable without a browser. It reuses
// `captureTab` rather than the menu click's `info.selectionText`, which the
// browser truncates without saying so; a silently cut excerpt filed under the
// user's own selection is exactly the defect `BriefSource.truncated` exists to
// prevent.
import type { CaptureOutcome } from "./capture-tab.ts";
import {
  addPassage,
  groupKey,
  type Passage,
  type PassageRefusal,
  type PassageUpdate,
} from "../shared/passage.ts";
import type { ToastState } from "../shared/types.ts";

const REFUSAL_TEXT: Record<PassageRefusal, string> = {
  duplicate: "Already collected.",
  "page-full": "That page's passages are full.",
  "collection-full": "Collection is full — send or clear a brief first.",
  "storage-full": "Couldn't store that passage.",
};

const CANT_READ: ToastState = { variant: "error", text: "Nothing selected." };
const CANT_INJECT: ToastState = {
  variant: "error",
  text: "Nimbus can't read a selection on this page.",
};

export interface PassageCollectDeps {
  readonly capture: (tabId: number) => Promise<CaptureOutcome>;
  readonly update: (m: (all: readonly Passage[]) => PassageUpdate) => Promise<PassageUpdate>;
  readonly showFeedback: (tabId: number, state: ToastState, restricted?: boolean) => Promise<void>;
  readonly now: () => number;
}

function heldForPage(all: readonly Passage[], url: string): number {
  const key = groupKey(url);
  return all.filter((passage) => groupKey(passage.url) === key).length;
}

/**
 * Collect the current selection in `tabId` into the brief collection.
 *
 * Never throws: a menu click has nowhere to report a rejection, so every path
 * ends in a toast (or the badge, when the page cannot host one).
 */
export async function collectPassage(deps: PassageCollectDeps, tabId: number): Promise<void> {
  const outcome = await deps.capture(tabId);
  if (!outcome.ok) {
    // `restricted` is the one reason the page cannot host a toast at all, so it
    // takes the badge fallback. This is not the collection owning the badge —
    // the queue owns that; this is the shipped un-injectable-page path.
    const state = outcome.reason === "empty" ? CANT_READ : CANT_INJECT;
    await deps
      .showFeedback(tabId, state, outcome.reason === "restricted")
      .catch(() => undefined);
    return;
  }
  const passage: Passage = {
    url: outcome.capture.url,
    title: outcome.capture.title,
    text: outcome.capture.body,
    at: deps.now(),
  };
  const res = await deps.update((all) => addPassage(all, passage));
  const state: ToastState = res.ok
    ? {
        variant: "success",
        text: `Added — ${heldForPage(res.all, passage.url)} ${
          heldForPage(res.all, passage.url) === 1 ? "passage" : "passages"
        } from this page.`,
      }
    : { variant: "error", text: REFUSAL_TEXT[res.reason] };
  await deps.showFeedback(tabId, state).catch(() => undefined);
}
```

Note the quoted keys: three of the four `PassageRefusal` members are hyphenated, so they are not
bare identifiers.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/passage-collect.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the menu entry**

In `src/background/menus.ts`: add the constant beside the others, the row at the **end** of
`MENU_ITEMS`, the `MenuAction` member, and the `menuAction` arm.

```ts
export const MENU_ADD_PASSAGE = "add-passage";
```

```ts
  // Selection-only, like the two lane-input entries above and for the same
  // reason: it is meaningless without selected text, and Chrome only offers a
  // selection item when there is some.
  { id: MENU_ADD_PASSAGE, title: "Add to brief", contexts: ["selection"] },
```

```ts
export type MenuAction =
  | "clip-article"
  | "clip-selection"
  | "show-related"
  | "define-selection"
  | "related-to-selection"
  | "add-passage";
```

```ts
    case MENU_ADD_PASSAGE:
      return "add-passage";
```

- [ ] **Step 6: Update the menus test, which asserts exactly five entries**

In `test/unit/menus.test.ts`: import `MENU_ADD_PASSAGE`, rename the first test to
`"declares exactly the six entries, ids matching the constants"`, append `MENU_ADD_PASSAGE` to
the expected id array, and extend the selection-context test:

```ts
  test("the selection-only entries appear on a selection and nowhere else", () => {
    const byId = new Map(MENU_ITEMS.map((i) => [i.id, i]));
    expect(byId.get(MENU_DEFINE)?.contexts).toEqual(["selection"]);
    expect(byId.get(MENU_RELATED_TO_SELECTION)?.contexts).toEqual(["selection"]);
    expect(byId.get(MENU_ADD_PASSAGE)?.contexts).toEqual(["selection"]);
  });

  test("every id maps to an action, and no action is unrouted", () => {
    // The `never` arm in the worker's switch catches a new MenuAction with no
    // route at compile time; this catches a new MENU_ITEMS row with no action.
    for (const item of MENU_ITEMS) {
      expect(menuAction(item.id)).not.toBeNull();
    }
  });
```

- [ ] **Step 7: Wire the worker**

In `src/background/service-worker.ts`, add the deps object near `quickClipDeps` (it reuses the
same `tabUrl`/`runCapture` seams `briefDeps.capture` uses, with `"selection"` and no
`expectedUrl` — a menu click has no pinned page to be wrong about):

```ts
const passageCollectDeps: PassageCollectDeps = {
  capture: (tabId) => captureTab({ tabUrl, runCapture }, tabId, "selection"),
  update: updatePassages,
  showFeedback: (tabId, state, restricted) =>
    showFeedback(feedbackDeps, tabId, state, restricted),
  now: () => Date.now(),
};
```

Match the existing `showFeedback` wiring in `quickClipDeps` exactly — copy its right-hand side
rather than inventing one. Then add the switch arm to `addMenuClickListener`, before the
`default: never` arm:

```ts
    case "add-passage":
      // `tabId` is `number | undefined` here. Early return, never a `!`
      // (`noNonNullAssertion` is an error in this repo) and never the active tab
      // as a fallback: a right-click in a non-focused window targets a different
      // tab than `tabs.query({active})`, and the activeTab grant belongs to the
      // CLICKED tab — the same reasoning the clip path already documents.
      if (tabId === undefined) {
        return;
      }
      collectPassage(passageCollectDeps, tabId).catch(() => undefined);
      return;
```

- [ ] **Step 8: Run the full suite**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS. If `menus.test.ts` still fails on a count, Step 6 was skipped.

- [ ] **Step 9: Commit**

```bash
git add src/background/passage-collect.ts src/background/menus.ts \
        src/background/service-worker.ts test/unit/passage-collect.test.ts \
        test/unit/menus.test.ts
git commit -m "feat(background): right-click to add a passage to a brief

Reuses captureTab, not the menu click's selectionText: the browser truncates
that field without saying so, and a silently cut excerpt filed under the user's
own selection is the defect BriefSource.truncated exists to prevent.

The action pre-filters nothing — addPassage owns every cap, so a refusal
reaches the user as the toast for that exact reason.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The preview tells pages and passages apart

**Files:**
- Modify: `src/shared/preview.ts` (`BriefPreview`, `buildBriefPreview`)
- Modify: `src/shared/preview-view.ts` (render a passages row and its text)
- Test: `test/unit/preview.test.ts`, `test/unit/preview-view.test.ts` (both exist)

**Interfaces:**
- Consumes: `PASSAGE_SEPARATOR` (Task 1).
- Produces: `BriefPreviewSource = { title: string; url: string; passages?: readonly string[] }`;
  `buildBriefPreview({ question, sources: readonly BriefPreviewSource[] })`. Task 7 builds the
  input; nothing else changes shape.

**Why this shape:** a source's `passages` being present *is* the marker that it is an excerpt
set, so the renderer needs no second flag. The strings are the passage texts in collection
order — the renderer joins them with `PASSAGE_SEPARATOR` so what is shown is byte-for-byte what
`stitch` will send.

**`bodies` is required, not optional, and that breaks existing test literals.** Every
`BriefPreview` object literal in `test/unit/preview-view.test.ts` must gain `bodies: []`. Do that
rather than marking the field optional: an absent list and an empty list would render identically
while meaning different things, and the whole point of decision 7 is that this preview cannot
quietly omit what it is about to send. Same treatment as the menus test in Task 3 — update the
callers, don't weaken the type.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/preview.test.ts`:

```ts
describe("buildBriefPreview with passage sources", () => {
  const question = "What do these disagree about?";

  test("the count names both kinds", () => {
    const preview = buildBriefPreview({
      question,
      sources: [
        { title: "Whole", url: "http://h/w" },
        { title: "Excerpts", url: "http://h/e", passages: ["one", "two"] },
      ],
    });
    expect(preview.fields).toEqual([
      { label: "Question", value: question },
      { label: "Sources", value: "2 sources — 1 page, 1 set of passages" },
    ]);
  });

  test("all pages reads as pages alone, as it did before passages existed", () => {
    const preview = buildBriefPreview({
      question,
      sources: [
        { title: "A", url: "http://h/a" },
        { title: "B", url: "http://h/b" },
      ],
    });
    expect(preview.fields[1]).toEqual({ label: "Sources", value: "2 pages" });
  });

  test("all passages reads as sets of passages alone", () => {
    const preview = buildBriefPreview({
      question,
      sources: [{ title: "A", url: "http://h/a", passages: ["one"] }],
    });
    expect(preview.fields[1]).toEqual({ label: "Sources", value: "1 set of passages" });
  });

  test("a passages row says how many; a page row says the address alone", () => {
    const preview = buildBriefPreview({
      question,
      sources: [
        { title: "Whole", url: "http://h/w" },
        { title: "Excerpts", url: "http://h/e", passages: ["one", "two", "three"] },
      ],
    });
    expect(preview.sources).toEqual([
      { label: "Whole", value: "http://h/w" },
      { label: "Excerpts", value: "http://h/e — 3 passages" },
    ]);
  });

  test("the text of each passage source is carried, in order", () => {
    const preview = buildBriefPreview({
      question,
      sources: [{ title: "E", url: "http://h/e", passages: ["first", "second"] }],
    });
    expect(preview.bodies).toEqual([{ label: "E", value: `first${PASSAGE_SEPARATOR}second` }]);
  });

  test("a page source carries no body — its text does not exist yet", () => {
    const preview = buildBriefPreview({
      question,
      sources: [{ title: "W", url: "http://h/w" }],
    });
    expect(preview.bodies).toEqual([]);
  });

  test("the synthesis notice is unchanged", () => {
    const preview = buildBriefPreview({ question, sources: [{ title: "W", url: "http://h/w" }] });
    expect(preview.synthesisNotice).toBe(SYNTHESIS_NOTICE);
  });
});
```

Add to `test/unit/preview-view.test.ts`:

```ts
describe("renderPreview with passage bodies", () => {
  test("renders each passage body under a disclosure, labelled by its source", () => {
    const frag = renderPreview(document, {
      fields: [{ label: "Question", value: "q" }],
      sources: [{ label: "E", value: "http://h/e — 2 passages" }],
      bodies: [{ label: "E", value: "first\n\n[...]\n\nsecond" }],
      synthesisNotice: "notice",
    });
    const host = document.createElement("div");
    host.append(frag);
    const details = host.querySelectorAll("details.preview__passages");
    expect(details).toHaveLength(1);
    expect(details[0]?.querySelector("summary")?.textContent).toBe("E");
    // textContent, never innerHTML: passage text is page content.
    expect(details[0]?.querySelector(".preview__body")?.textContent).toBe(
      "first\n\n[...]\n\nsecond",
    );
  });

  test("a brief with no passage bodies renders no disclosure at all", () => {
    const frag = renderPreview(document, {
      fields: [],
      sources: [{ label: "W", value: "http://h/w" }],
      bodies: [],
      synthesisNotice: "notice",
    });
    const host = document.createElement("div");
    host.append(frag);
    expect(host.querySelector("details")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run test/unit/preview.test.ts test/unit/preview-view.test.ts`
Expected: FAIL — `bodies` is not a property of `BriefPreview`; the passages wording is absent.

- [ ] **Step 3: Extend the builder**

In `src/shared/preview.ts`, replace the `BriefPreview` interface and `buildBriefPreview`:

```ts
export interface BriefPreviewSource {
  readonly title: string;
  readonly url: string;
  /**
   * Present ONLY for a passage source, and then the passage texts in collection
   * order. Its presence is the marker that this source is an excerpt set — the
   * renderer needs no second flag.
   */
  readonly passages?: readonly string[];
}

export interface BriefPreview {
  readonly fields: readonly PreviewField[];
  /** One row per source: `label` is the title, `value` the address. */
  readonly sources: readonly PreviewField[];
  /**
   * One row per PASSAGE source: the exact body that source will send.
   *
   * Only a passage source can have one. A page's text is captured during the
   * run, so at preview time it does not exist and claiming otherwise would be
   * an invention; a passage was captured when the user highlighted it, so here —
   * uniquely — the preview can show the bytes rather than describe them.
   */
  readonly bodies: readonly PreviewField[];
  readonly synthesisNotice: string;
}
```

```ts
function sourcesSummary(sources: readonly BriefPreviewSource[]): string {
  const sets = sources.filter((s) => s.passages !== undefined).length;
  const pages = sources.length - sets;
  const pagePart = `${pages} ${pages === 1 ? "page" : "pages"}`;
  const setPart = `${sets} ${sets === 1 ? "set of passages" : "sets of passages"}`;
  if (sets === 0) {
    return pagePart;
  }
  if (pages === 0) {
    return setPart;
  }
  // Both kinds present: lead with the total, because that is the number the cap
  // is about, then break it down so neither kind is implied to be the other.
  return `${sources.length} sources — ${pagePart}, ${setPart}`;
}

export function buildBriefPreview(input: {
  question: string;
  sources: readonly BriefPreviewSource[];
}): BriefPreview {
  return {
    fields: [
      { label: "Question", value: input.question },
      { label: "Sources", value: sourcesSummary(input.sources) },
    ],
    sources: input.sources.map((s) => ({
      label: s.title,
      value:
        s.passages === undefined
          ? s.url
          : `${s.url} — ${s.passages.length} ${s.passages.length === 1 ? "passage" : "passages"}`,
    })),
    bodies: input.sources
      .filter((s): s is BriefPreviewSource & { passages: readonly string[] } =>
        s.passages !== undefined,
      )
      .map((s) => ({ label: s.title, value: s.passages.join(PASSAGE_SEPARATOR) })),
    synthesisNotice: SYNTHESIS_NOTICE,
  };
}
```

Add the import: `import { PASSAGE_SEPARATOR } from "./passage.ts";`

Keep `buildBriefPreview`'s existing doc comment and add one line to it: *"A passage source's
body is joined with `PASSAGE_SEPARATOR`, the same constant `stitch` uses, so the text shown is
the text sent."*

- [ ] **Step 4: Render the bodies**

In `src/shared/preview-view.ts`, inside the `isBriefPreview` branch, after the sources list and
**before** the synthesis notice:

```ts
    for (const body of preview.bodies) {
      // A disclosure, not an always-open block: on a full collection the text
      // would push the Send button off the screen, and a consent surface the
      // user has to scroll past is one they stop reading.
      const details = doc.createElement("details");
      details.className = "preview__passages";
      const summary = doc.createElement("summary");
      summary.textContent = body.label;
      const text = doc.createElement("div");
      text.className = "preview__body";
      // textContent, never innerHTML — this is page content the user selected.
      text.textContent = body.value;
      details.append(summary, text);
      frag.append(details);
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/preview.test.ts test/unit/preview-view.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite — `buildBriefPreview` has an existing caller**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: `typecheck` FAILS in `src/brief/brief.ts`, which passes `CandidateTab[]` as `sources`.
That is Task 7's file. Make the minimal adapter now so the tree stays green:

```ts
  const sources = named
    .filter((t) => selected.has(t.id))
    .map((t) => ({ title: t.title, url: t.url }));
```

Re-run all three. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/preview.ts src/shared/preview-view.ts src/brief/brief.ts \
        test/unit/preview.test.ts test/unit/preview-view.test.ts
git commit -m "feat(preview): say pages when it means pages, passages when it means passages

Unchanged, the preview would have said 'N pages' while sending excerpts. A
source now carries its kind, and the count breaks both kinds out.

And the part only passages make possible: their text exists at preview time,
because it was captured when the user highlighted it. So this preview shows the
bytes that will leave instead of describing them — joined with the same
PASSAGE_SEPARATOR stitch uses, so the two cannot drift.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `picks` crosses the message boundary

**Files:**
- Modify: `src/shared/messages.ts` (`BriefStartRequest`, `isBriefStartRequest`)
- Test: `test/unit/messages.test.ts`

**Interfaces:**
- Consumes: `safeHttpUrl` from `src/shared/safe-url.ts`; `MAX_BRIEF_SOURCES` (already in
  `messages.ts`).
- Produces: `BriefPick = { kind: "tab"; id: number } | { kind: "passages"; url: string }` and
  `BriefStartRequest.picks: readonly BriefPick[]` — replacing `tabIds`. Tasks 6 and 7 both use it.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/messages.test.ts` (and delete or rewrite any existing `tabIds` case for
`isBriefStartRequest` — the field is gone):

```ts
describe("isBriefStartRequest picks", () => {
  const base = { kind: "brief-start", question: "q" };

  test("accepts a mixed, ordered pick list", () => {
    expect(
      isBriefStartRequest({
        ...base,
        picks: [
          { kind: "tab", id: 3 },
          { kind: "passages", url: "http://h/a" },
        ],
      }),
    ).toBe(true);
  });

  test("rejects an empty or over-long list", () => {
    expect(isBriefStartRequest({ ...base, picks: [] })).toBe(false);
    expect(
      isBriefStartRequest({
        ...base,
        picks: Array.from({ length: 21 }, () => ({ kind: "tab", id: 1 })),
      }),
    ).toBe(false);
  });

  test("rejects a kind outside the union", () => {
    expect(isBriefStartRequest({ ...base, picks: [{ kind: "clip", id: 1 }] })).toBe(false);
  });

  test("rejects a non-integer or negative tab id, as tabIds did", () => {
    expect(isBriefStartRequest({ ...base, picks: [{ kind: "tab", id: 1.5 }] })).toBe(false);
    expect(isBriefStartRequest({ ...base, picks: [{ kind: "tab", id: -1 }] })).toBe(false);
    expect(isBriefStartRequest({ ...base, picks: [{ kind: "tab", id: "1" }] })).toBe(false);
  });

  test("rejects a url safeHttpUrl rejects, not merely a non-string", () => {
    expect(isBriefStartRequest({ ...base, picks: [{ kind: "passages", url: 5 }] })).toBe(false);
    expect(
      isBriefStartRequest({ ...base, picks: [{ kind: "passages", url: "javascript:alert(1)" }] }),
    ).toBe(false);
    expect(
      isBriefStartRequest({ ...base, picks: [{ kind: "passages", url: "not a url" }] }),
    ).toBe(false);
  });

  test("still rejects a missing or over-long question", () => {
    expect(isBriefStartRequest({ kind: "brief-start", picks: [{ kind: "tab", id: 1 }] })).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run test/unit/messages.test.ts`
Expected: FAIL — `picks` is unknown; the guard still reads `tabIds`.

- [ ] **Step 3: Change the type and the guard**

In `src/shared/messages.ts`:

```ts
/**
 * One source the composer picked. ONE ordered list rather than `tabIds` plus
 * `passageUrls`: the order the composer displayed is then the order the gateway
 * is told, with no merge rule in the handler to get wrong.
 */
export type BriefPick =
  | { readonly kind: "tab"; readonly id: number }
  | { readonly kind: "passages"; readonly url: string };

export interface BriefStartRequest {
  readonly kind: "brief-start";
  readonly question: string;
  readonly picks: readonly BriefPick[];
}
```

```ts
function isBriefPick(v: unknown): v is BriefPick {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "tab") {
    const id = v["id"];
    return typeof id === "number" && Number.isInteger(id) && id >= 0;
  }
  if (v["kind"] === "passages") {
    // safeHttpUrl, not `typeof === "string"`: the shipped scheme validation
    // rather than a second, weaker rule beside it.
    return typeof v["url"] === "string" && safeHttpUrl(v["url"]) !== null;
  }
  return false;
}
```

and in `isBriefStartRequest`, replace the `tabIds` block with:

```ts
  const picks = v["picks"];
  if (!Array.isArray(picks) || picks.length === 0 || picks.length > MAX_BRIEF_SOURCES) {
    return false;
  }
  return picks.every(isBriefPick);
```

Add `import { safeHttpUrl } from "./safe-url.ts";` if it is not already imported.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run test/unit/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (typecheck will fail until Task 6 — commit tests + guard together)**

Run: `bunx vitest run test/unit/messages.test.ts && bun run lint`
`bun run typecheck` fails in `brief-handlers.ts` / `brief.ts`, which read `tabIds`. Those are
Tasks 6 and 7. Commit the guard now and make the next task the one that restores a green
typecheck — do not paper over it here.

```bash
git add src/shared/messages.ts test/unit/messages.test.ts
git commit -m "feat(messages): one ordered pick list, not two parallel arrays

A tab pick is identified by tab id, a passage pick by url; carrying them as one
ordered union means the order the composer showed is the order the gateway is
told, with no merge rule to get wrong.

The url is validated by safeHttpUrl rather than a bare string test — but the
real defence is Task 6: an unmatched pick is dropped, C2.5's rule for a
supplied id.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The run path takes both kinds of source

**Files:**
- Modify: `src/background/brief-handlers.ts` (`BriefDeps`, `BriefTabsResult`, `handleBriefTabs`,
  `feedAll`, `handleBriefStart`)
- Modify: `src/background/service-worker.ts` (`briefDeps` gains two store seams)
- Test: `test/unit/brief-handlers.test.ts`

**Interfaces:**
- Consumes: `BriefPick` (Task 5); `groupPassages`, `groupKey`, `stitch`, `groupCapturedAt`,
  `removeGroup`, `PassageGroup`, `Passage` (Task 1); `getPassages`, `updatePassages` (Task 2).
- Produces: `BriefTabsResult.passages: readonly PassageGroup[]`; `BriefDeps.passages` and
  `BriefDeps.forgetPassages`. Task 7 reads `BriefTabsResult`.

**The source union, internal to this file:**

```ts
type PickedSource =
  | { readonly kind: "tab"; readonly tab: CandidateTab }
  | { readonly kind: "passages"; readonly group: PassageGroup };
```

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/brief-handlers.test.ts`, following the existing deps-stub style in that file
(reuse its helper rather than writing a second one):

```ts
describe("handleBriefTabs with a collection", () => {
  test("returns the passage groups beside the tabs, in one answer", async () => {
    const res = await handleBriefTabs(
      deps({
        listTabs: async () => ({ named: [tab(1, "http://h/a")], hiddenCount: 0 }),
        passages: async () => [
          { url: "http://h/b", title: "B", text: "one", at: 5 },
          { url: "http://h/b#x", title: "B", text: "two", at: 6 },
        ],
      }),
    );
    expect(res.named).toHaveLength(1);
    expect(res.passages.map((g) => g.url)).toEqual(["http://h/b"]);
    expect(res.passages[0]?.passages).toHaveLength(2);
  });
});

describe("handleBriefStart with mixed picks", () => {
  test("declares every picked url exactly once, in picks order", async () => {
    const created: unknown[] = [];
    await handleBriefStart(
      deps({
        listTabs: async () => ({ named: [tab(1, "http://h/a")], hiddenCount: 0 }),
        passages: async () => [{ url: "http://h/b", title: "B", text: "one", at: 5 }],
        client: { ...client(), createBrief: async (_o, _t, body) => {
          created.push(body);
          return { ok: true, id: "r1", expected: 2 };
        } },
      }),
      {
        kind: "brief-start",
        question: "q",
        picks: [
          { kind: "passages", url: "http://h/b" },
          { kind: "tab", id: 1 },
        ],
      },
    );
    expect(created).toEqual([
      {
        brief: "q",
        sources: [
          { url: "http://h/b", title: "B" },
          { url: "http://h/a", title: "Tab 1" },
        ],
        useIndex: false,
      },
    ]);
  });

  test("never captures for a passage source, and feeds its stitched body", async () => {
    const captured: number[] = [];
    const fed: { url: string; body: string; capturedAt: number }[] = [];
    await handleBriefStart(
      deps({
        passages: async () => [
          { url: "http://h/b", title: "B", text: "one", at: 900 },
          { url: "http://h/b", title: "B", text: "two", at: 100 },
        ],
        capture: async (tabId) => {
          captured.push(tabId);
          return { ok: true, capture: capture("http://h/a") };
        },
        client: { ...client(), feedBriefSource: async (_o, _t, _id, body) => {
          fed.push({ url: body.url, body: body.body, capturedAt: body.capturedAt });
          return { ok: true, received: fed.length, expected: 1 };
        } },
      }),
      { kind: "brief-start", question: "q", picks: [{ kind: "passages", url: "http://h/b" }] },
    );
    expect(captured).toEqual([]);
    expect(fed).toEqual([
      { url: "http://h/b", body: "one\n\n[...]\n\ntwo", capturedAt: 100 },
    ]);
  });

  test("a pick naming a url the collection does not hold is dropped, and the run proceeds", async () => {
    const state = await handleBriefStart(
      deps({
        listTabs: async () => ({ named: [tab(1, "http://h/a")], hiddenCount: 0 }),
        passages: async () => [],
      }),
      {
        kind: "brief-start",
        question: "q",
        picks: [
          { kind: "passages", url: "http://h/gone" },
          { kind: "tab", id: 1 },
        ],
      },
    );
    expect(state.kind).not.toBe("failed");
  });

  test("picks that match nothing at all fail as no_sources", async () => {
    const state = await handleBriefStart(
      deps({ listTabs: async () => ({ named: [], hiddenCount: 0 }), passages: async () => [] }),
      { kind: "brief-start", question: "q", picks: [{ kind: "passages", url: "http://h/gone" }] },
    );
    expect(state).toEqual({ kind: "failed", reason: "no_sources" });
  });

  test("a fed passage group is forgotten once /run is accepted", async () => {
    const forgotten: string[] = [];
    await handleBriefStart(
      deps({
        passages: async () => [{ url: "http://h/b", title: "B", text: "one", at: 5 }],
        forgetPassages: async (urls) => {
          forgotten.push(...urls);
        },
      }),
      { kind: "brief-start", question: "q", picks: [{ kind: "passages", url: "http://h/b" }] },
    );
    expect(forgotten).toEqual(["http://h/b"]);
  });

  test("a run that fails before /run forgets nothing", async () => {
    const forgotten: string[] = [];
    await handleBriefStart(
      deps({
        passages: async () => [{ url: "http://h/b", title: "B", text: "one", at: 5 }],
        forgetPassages: async (urls) => {
          forgotten.push(...urls);
        },
        client: { ...client(), runBrief: async () => ({ ok: false, reason: "server_error" }) },
      }),
      { kind: "brief-start", question: "q", picks: [{ kind: "passages", url: "http://h/b" }] },
    );
    expect(forgotten).toEqual([]);
  });

  test("a group skipped for run_capacity keeps its passages", async () => {
    const forgotten: string[] = [];
    await handleBriefStart(
      deps({
        passages: async () => [
          { url: "http://h/b", title: "B", text: "one", at: 5 },
          { url: "http://h/c", title: "C", text: "two", at: 6 },
        ],
        forgetPassages: async (urls) => {
          forgotten.push(...urls);
        },
        client: {
          ...client(),
          feedBriefSource: async (_o, _t, _id, body) =>
            body.url === "http://h/b"
              ? { ok: true, received: 1, expected: 2 }
              : { ok: false, reason: "refused", detail: "run_capacity" },
        },
      }),
      {
        kind: "brief-start",
        question: "q",
        picks: [
          { kind: "passages", url: "http://h/b" },
          { kind: "passages", url: "http://h/c" },
        ],
      },
    );
    expect(forgotten).toEqual(["http://h/b"]);
  });

  test("a tab picked in whole-page mode keeps that page's passages", async () => {
    // The rule is CLEAR WHAT LEFT. In whole-page mode the page left, not the
    // passages — and whole-page is a choice about one question, not a statement
    // about the collection.
    const forgotten: string[] = [];
    await handleBriefStart(
      deps({
        listTabs: async () => ({ named: [tab(1, "http://h/b")], hiddenCount: 0 }),
        passages: async () => [{ url: "http://h/b", title: "B", text: "one", at: 5 }],
        forgetPassages: async (urls) => {
          forgotten.push(...urls);
        },
      }),
      { kind: "brief-start", question: "q", picks: [{ kind: "tab", id: 1 }] },
    );
    expect(forgotten).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run test/unit/brief-handlers.test.ts`
Expected: FAIL — `passages`/`forgetPassages` are not in `BriefDeps`; `picks` is not read.

- [ ] **Step 3: Extend `BriefDeps` and `BriefTabsResult`**

```ts
  /** The passage collection, as stored. Grouped here, not by the caller. */
  readonly passages: () => Promise<readonly Passage[]>;
  /** Drop every passage held for these pages. Called once, after `/run`. */
  readonly forgetPassages: (urls: readonly string[]) => Promise<void>;
```

```ts
export interface BriefTabsResult {
  readonly named: readonly CandidateTab[];
  readonly hiddenCount: number;
  readonly enumerationFailed: boolean;
  readonly questions: readonly string[];
  readonly recognitions: readonly Recognition[];
  /** The collection, grouped one row per page — see the spec's decision 5. */
  readonly passages: readonly PassageGroup[];
}
```

In `handleBriefTabs`, add `passages: groupPassages(await deps.passages())` to the returned
object. The questions still come from the tab recognitions only: a passage group carries no
`Recognition`, and inventing one from its url would claim a recognition the client did not run.

- [ ] **Step 4: Resolve `picks` into the source union**

Replace `handleBriefStart`'s `picked` construction:

```ts
  const tabs = await deps.listTabs();
  const groups = groupPassages(await deps.passages());
  // Every pick is resolved against state the background already holds — a tab id
  // against listTabs, a url against the collection — and an unmatched pick is
  // DROPPED, exactly as an unmatched tabId always was. A url the collection
  // never held cannot become a source, so the guard in messages.ts is the outer
  // fence, not the load-bearing one. Same rule C2.5 applies to a supplied itemId.
  const picked: PickedSource[] = [];
  for (const pick of req.picks) {
    if (pick.kind === "tab") {
      const tab = tabs.named.find((t) => t.id === pick.id);
      if (tab !== undefined) {
        picked.push({ kind: "tab", tab });
      }
      continue;
    }
    const group = groups.find((g) => g.url === groupKey(pick.url));
    if (group !== undefined) {
      picked.push({ kind: "passages", group });
    }
  }
  const sources = picked.slice(0, BRIEF_CAPS.maxSources);
  if (sources.length === 0) {
    return emit(deps, { kind: "failed", reason: "no_sources" });
  }
```

Then `buildCreateBody(req.question, sources.map(declare))` where:

```ts
function declare(source: PickedSource): { url: string; title: string } {
  return source.kind === "tab"
    ? { url: source.tab.url, title: source.tab.title }
    : { url: source.group.url, title: source.group.title };
}
```

Use `declare` for the `store.put` `declared` array too, so the stored run and the created brief
cannot disagree.

- [ ] **Step 5: Teach `feedAll` the union**

Change its `picked` parameter to `readonly PickedSource[]`, and return the fed passage urls
alongside the existing counts:

```ts
interface FeedResult {
  readonly accepted: number;
  readonly skipped: readonly SkippedSource[];
  readonly truncated: readonly string[];
  /** Passage-source urls the gateway ACCEPTED. Only these are forgotten. */
  readonly fedPassageUrls: readonly string[];
}
```

Inside the loop, replace the capture-then-build head with:

```ts
    const declared = declare(source);
    let text: string;
    let capturedAt: number;
    if (source.kind === "tab") {
      const outcome = await deps.capture(source.tab.id, source.tab.url);
      if (!outcome.ok) {
        skipped.push({ title: declared.title, reason: outcome.reason });
        continue;
      }
      text = outcome.capture.body;
      capturedAt = deps.now();
    } else {
      // No capture, and no way to fail one: the text was captured when the user
      // highlighted it. `capturedAt` is the group's OLDEST passage — a stitched
      // body is only as fresh as its oldest text.
      text = stitch(source.group);
      capturedAt = groupCapturedAt(source.group);
    }
    const body = buildSourceBody({ url: declared.url, title: declared.title, body: text, capturedAt });
```

and in the accepted branch, `if (source.kind === "passages") { fedPassageUrls.push(declared.url); }`.
Every remaining `tab.title` / `tab.url` in the loop becomes `declared.title` / `declared.url`.

- [ ] **Step 6: Forget the fed groups after `/run`**

Immediately after the existing `log.append` call in `handleBriefStart` (the moment of egress —
the same reason that call sits there):

```ts
  // Cleared HERE, not on the report: this is the moment the text left. Leaving
  // them would mean the next brief silently re-sends text already sent. A run
  // that failed before this line keeps everything, because nothing left.
  if (fed.fedPassageUrls.length > 0) {
    await deps.forgetPassages(fed.fedPassageUrls).catch(() => undefined);
  }
```

Swallowed rather than failing the run: the brief is already running and a storage failure must
not turn a live run into a reported failure.

- [ ] **Step 7: Wire the worker**

In `src/background/service-worker.ts`, add to `briefDeps`:

```ts
  passages: getPassages,
  forgetPassages: async (urls) => {
    for (const url of urls) {
      await updatePassages((all) => ({ ok: true, all: removeGroup(all, url) }));
    }
  },
```

- [ ] **Step 8: Run everything**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS — this is the task that restores the green typecheck Task 5 left broken, except
for `src/brief/brief.ts`'s `tabIds` send. If that is the only failure, fix it minimally now
(`picks: [...selected].map((id) => ({ kind: "tab", id }))`); Task 7 replaces it properly.

- [ ] **Step 9: Commit**

```bash
git add src/background/brief-handlers.ts src/background/service-worker.ts \
        src/brief/brief.ts test/unit/brief-handlers.test.ts
git commit -m "feat(brief): a source is a tab or a page's passages

feedAll no longer captures for a passage source — there is nothing to capture
and nothing that can fail, so a passage group never enters skipped and the
report's shortfall list stays true. capturedAt is the group's oldest passage.

Fed groups are forgotten at /run, the same moment the disclosure log entry is
written, and only those the gateway accepted. A failed run, a run_capacity
skip, and a page sent in whole-page mode all keep their passages.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The composer

**Files:**
- Modify: `src/brief/brief-view.ts` (`ComposerModel`, `renderComposer`)
- Modify: `src/brief/brief.ts` (state, `loadTabs`, `showPreview`, click delegation, run payload)
- Modify: `src/brief/brief.css`
- Test: `test/unit/brief-view.test.ts`, `test/unit/brief-page.test.ts`

**Interfaces:**
- Consumes: `PassageGroup`, `groupKey` (Task 1); `BriefTabsResult.passages` (Task 6);
  `BriefPreviewSource` (Task 4); `BriefPick` (Task 5).
- Produces: no exports other tasks depend on. The rendered contract:
  - a row's checkbox `value` is `tab:<id>` or `passages:<url>` — one namespace, so the click
    handler needs no lookup to know which kind it toggled
  - the whole-page control is `<button class="brief__mode" data-url="<url>">`
  - a passage remove is `<button class="brief__drop" data-url="<url>" data-at="<at>">`
  - the row remove is `<button class="brief__drop-row" data-url="<url>">`
  - clear-all is `<button id="clear-passages">`

**Row rules (spec decision 5):** one row per url. A group whose `url` equals `groupKey(tab.url)`
for some named tab renders **once**, in passages mode, at that tab's position, and carries the
whole-page control. Groups matching no named tab render after the tab rows, in collection order.
Both kinds count against one cap counter.

**Two existing test files break on this task's type change, by design.** `ComposerModel.selected`
goes from `ReadonlySet<number>` to `ReadonlySet<string>`, and the run payload from `tabIds` to
`picks`:
- `test/unit/brief-view.test.ts` — every existing case passing `selected: new Set([1])` must
  become `new Set(["tab:1"])`. Update them; do not widen the type to accept both.
- `test/unit/brief-page.test.ts` — the existing assertion on the `brief-start` payload expects
  `tabIds`. It must expect `picks: [{ kind: "tab", id: 1 }]`.

A pick id is `tab:<id>` or `passages:<url>` in **one** namespace so a checkbox toggle identifies
its own kind with no lookup. `passages:` is 9 characters and `tab:` is 4 — the slice offsets in
Step 5 depend on that, so change the prefixes and you change both.

- [ ] **Step 1: Write the failing view tests**

Add to `test/unit/brief-view.test.ts`:

```ts
const GROUP = {
  url: "http://h/a",
  title: "A page",
  passages: [
    { url: "http://h/a", title: "A page", text: "one", at: 100 },
    { url: "http://h/a#x", title: "A page", text: "two", at: 200 },
  ],
};

function render(model: Partial<ComposerModel> = {}): HTMLElement {
  const root = document.createElement("div");
  renderComposer(root, {
    named: [],
    hiddenCount: 0,
    questions: [],
    selected: new Set<string>(),
    passages: [],
    ...model,
  });
  return root;
}

describe("composer passage rows", () => {
  test("a collected page renders one row saying how many passages it holds", () => {
    const root = render({ passages: [GROUP] });
    const row = root.querySelector(".brief__tab");
    expect(row?.textContent).toContain("2 passages");
    expect(row?.querySelector("input")?.getAttribute("value")).toBe("passages:http://h/a");
  });

  test("a collected page that is also an open tab renders ONCE, in passages mode", () => {
    const root = render({
      named: [{ id: 1, url: "http://h/a#live", title: "A page" }],
      passages: [GROUP],
    });
    const boxes = [...root.querySelectorAll("input[type=checkbox]")].map((b) =>
      b.getAttribute("value"),
    );
    expect(boxes).toEqual(["passages:http://h/a"]);
  });

  test("the same page open in two tabs is still ONE passages row", () => {
    // Two fragments of one document, or the same page opened twice: one page
    // key, one row. A row per tab would let the user pick the page twice, and
    // `declare()` would send `http://h/a#one` and `http://h/a` — two strings the
    // gateway canonicalises to one identity.
    const root = render({
      named: [
        { id: 1, url: "http://h/a#one", title: "A page" },
        { id: 2, url: "http://h/a#two", title: "A page" },
      ],
      passages: [GROUP],
    });
    expect(root.querySelectorAll(".brief__tab")).toHaveLength(1);
    expect([...root.querySelectorAll("input[type=checkbox]")].map((b) => b.getAttribute("value"))).toEqual(
      ["passages:http://h/a"],
    );
  });

  test("the same page open in two tabs with NO passages is one tab row", () => {
    // The shipped composer emits a row per tab and so shows this page twice.
    // This slice makes one-row-per-page an invariant; the two cases must agree.
    const root = render({
      named: [
        { id: 1, url: "http://h/dup", title: "Dup" },
        { id: 2, url: "http://h/dup", title: "Dup" },
      ],
    });
    expect([...root.querySelectorAll("input[type=checkbox]")].map((b) => b.getAttribute("value"))).toEqual(
      ["tab:1"],
    );
  });

  test("that row offers the whole-page control", () => {
    const root = render({
      named: [{ id: 1, url: "http://h/a", title: "A page" }],
      passages: [GROUP],
    });
    expect(root.querySelector("button.brief__mode")?.getAttribute("data-url")).toBe("http://h/a");
  });

  test("a group whose tab is closed renders without the whole-page control", () => {
    // Whole-page mode means "capture this tab at start"; a closed tab has
    // nothing to capture, so offering it would be a dead control.
    const root = render({ passages: [GROUP] });
    expect(root.querySelector("button.brief__mode")).toBeNull();
    expect(root.querySelector("input")?.getAttribute("value")).toBe("passages:http://h/a");
  });

  test("whole-page mode for a row renders the tab checkbox instead", () => {
    const root = render({
      named: [{ id: 1, url: "http://h/a", title: "A page" }],
      passages: [GROUP],
      wholePage: new Set(["http://h/a"]),
    });
    expect(root.querySelector("input")?.getAttribute("value")).toBe("tab:1");
  });

  test("each passage is listed with its own remove control", () => {
    const root = render({ passages: [GROUP] });
    const drops = [...root.querySelectorAll("button.brief__drop")].map((b) => [
      b.getAttribute("data-url"),
      b.getAttribute("data-at"),
    ]);
    expect(drops).toEqual([
      ["http://h/a", "100"],
      ["http://h/a", "200"],
    ]);
  });

  test("the row and the collection each have their own remove", () => {
    const root = render({ passages: [GROUP] });
    expect(root.querySelector("button.brief__drop-row")?.getAttribute("data-url")).toBe(
      "http://h/a",
    );
    expect(root.querySelector("#clear-passages")).not.toBeNull();
  });

  test("no collection renders no clear-all", () => {
    expect(render().querySelector("#clear-passages")).toBeNull();
  });

  test("the cap counter counts both kinds", () => {
    const root = render({
      named: [{ id: 1, url: "http://h/t", title: "T" }],
      passages: [GROUP],
      selected: new Set(["tab:1", "passages:http://h/a"]),
    });
    expect(root.textContent).toContain("2 of 20");
  });

  test("passage text is set with textContent, never parsed as markup", () => {
    const root = render({
      passages: [
        {
          ...GROUP,
          passages: [{ url: "http://h/a", title: "A", text: "<img src=x onerror=1>", at: 1 }],
        },
      ],
    });
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=1>");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run test/unit/brief-view.test.ts`
Expected: FAIL — `ComposerModel` has no `passages` / `wholePage`, and `selected` is
`ReadonlySet<number>`.

- [ ] **Step 3: Extend the composer model and rendering**

`ComposerModel` becomes:

```ts
export type ComposerModel = {
  readonly named: readonly CandidateTab[];
  readonly hiddenCount: number;
  readonly questions: readonly string[];
  /** Pick ids — `tab:<id>` or `passages:<url>`. One namespace, so a toggle
   *  identifies its own kind without a lookup. */
  readonly selected: ReadonlySet<string>;
  readonly passages: readonly PassageGroup[];
  /** Urls the user switched back to whole-page mode. */
  readonly wholePage?: ReadonlySet<string>;
  readonly enumerationFailed?: boolean;
};
```

Render order: build a `Map<string, PassageGroup>` keyed by group url; walk `named` emitting
either a tab row or (when `groupKey(tab.url)` hits the map and the url is not in `wholePage`) a
passages row, marking that group consumed; then emit the unconsumed groups. Keep every string
set via `textContent` — passage text is page content, and the file's header comment already says
why.

Extract the row builders into their own functions in this file rather than growing
`renderComposer` — Sonar's cognitive-complexity gate (S3776, 15) is live in this repo and a
single function doing tab rows, passage rows, mode toggles, removes and the counter will trip it.

```ts
function pickBox(value: string, checked: boolean): HTMLInputElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.value = value;
  box.checked = checked;
  return box;
}

function iconButton(className: string, text: string, data: Record<string, string>): HTMLButtonElement {
  const button = el("button", text, className);
  button.type = "button";
  for (const [key, value] of Object.entries(data)) {
    button.dataset[key] = value;
  }
  return button;
}

function tabRow(tab: CandidateTab, selected: ReadonlySet<string>): HTMLElement {
  const item = el("li", undefined, "brief__tab");
  const label = el("label");
  label.appendChild(pickBox(`tab:${tab.id}`, selected.has(`tab:${tab.id}`)));
  label.appendChild(el("span", tab.title, "brief__tab-title"));
  label.appendChild(el("span", tab.url, "brief__tab-url"));
  item.appendChild(label);
  return item;
}

/** `openTab` is the named tab this group matches, or null when its tab is gone. */
function passageRow(
  group: PassageGroup,
  selected: ReadonlySet<string>,
  openTab: CandidateTab | null,
): HTMLElement {
  const item = el("li", undefined, "brief__tab");
  const label = el("label");
  label.appendChild(pickBox(`passages:${group.url}`, selected.has(`passages:${group.url}`)));
  label.appendChild(el("span", group.title, "brief__tab-title"));
  const n = group.passages.length;
  label.appendChild(el("span", `${n} ${n === 1 ? "passage" : "passages"}`, "brief__tab-count"));
  label.appendChild(el("span", group.url, "brief__tab-url"));
  item.appendChild(label);

  // Offered ONLY when the tab is open: whole-page mode means "capture this tab
  // at start", so on a closed tab it would be a dead control.
  if (openTab !== null) {
    item.appendChild(iconButton("brief__mode", "Use the whole page instead", { url: group.url }));
  }

  const list = el("ul", undefined, "brief__passages");
  for (const passage of group.passages) {
    const row = el("li");
    // textContent via `el` — passage text is page content, never markup.
    row.appendChild(el("span", passage.text, "brief__passage-text"));
    row.appendChild(
      iconButton("brief__drop", "Remove", { url: group.url, at: String(passage.at) }),
    );
    list.appendChild(row);
  }
  item.appendChild(list);
  item.appendChild(iconButton("brief__drop-row", "Remove page", { url: group.url }));
  return item;
}
```

`renderComposer` then walks `named` once, consuming matched groups, and emits the rest:

```ts
  const byKey = new Map(model.passages.map((g) => [g.url, g]));
  const whole = model.wholePage ?? new Set<string>();
  // ONE row per page key, whichever kind that row turns out to be. The same page
  // can be open in two tabs — plainly, or as two fragments of one document — and
  // both resolve to one key. Emitting a row per TAB would put two rows for one
  // page in a list whose whole job is "here is what goes", and picking both
  // would declare one page twice in `sources`: `declare()` sends `tab.url` for a
  // tab pick and `group.url` for a passages pick, so the two rows would send
  // `http://h/a#one` and `http://h/a`, which the gateway canonicalises to the
  // same identity. That is the defect the fragment-stripped group key exists to
  // prevent, arriving through a second door.
  const seen = new Set<string>();
  for (const tab of model.named) {
    const key = groupKey(tab.url);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const group = byKey.get(key);
    if (group === undefined || whole.has(group.url)) {
      list.appendChild(tabRow(tab, model.selected));
      continue;
    }
    list.appendChild(passageRow(group, model.selected, tab));
  }
  for (const group of model.passages) {
    if (!seen.has(group.url) && !whole.has(group.url)) {
      list.appendChild(passageRow(group, model.selected, null));
    }
  }
```

Two notes on that loop.

`whole.has(group.url)` in the first branch: a row switched to whole-page mode renders as a plain
tab row, which is exactly what "use the whole page instead" means. A group in `wholePage` whose
tab has since closed falls to neither branch — it has no tab to capture and the user asked not to
use its passages — so it renders nowhere until they toggle back.

**Deduping tab rows is a deliberate behaviour change to shipped code.** Today's composer emits a
row per named tab, so a page open in two tabs already appears twice and picking both already
declares it twice. It goes unnoticed because nothing else depended on page identity. This slice
makes "one row per page" an invariant, so the two cases must not disagree: a duplicate tab is the
same document, and dropping it is the same rule as merging two fragments. Cover it with a test
(Step 1) so the change is asserted rather than incidental.

Add the cap counter after the list:

```ts
  const picked = model.selected.size;
  root.appendChild(el("p", `${picked} of ${BRIEF_CAPS.maxSources} sources`, "brief__count"));
  if (model.passages.length > 0) {
    const clear = el("button", "Clear collected passages", "brief__clear");
    clear.type = "button";
    clear.id = "clear-passages";
    root.appendChild(clear);
  }
```

- [ ] **Step 4: Run the view tests to verify they pass**

Run: `bunx vitest run test/unit/brief-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the page**

In `src/brief/brief.ts`:
- `const selected = new Set<string>()`; hold `passages: readonly PassageGroup[]` and
  `const wholePage = new Set<string>()`
- `loadTabs` reads `data.passages ?? []` into it (extend `TabsAnswer` accordingly) and passes
  all three to `renderComposer`
- `showPreview` builds `BriefPreviewSource[]` **in the composer's displayed order** from
  `selected`: a `tab:<id>` pick becomes `{title, url}`; a `passages:<url>` pick becomes
  `{title, url, passages: group.passages.map((p) => p.text)}`
- the run payload becomes
  `picks: [...selected].map((id) => id.startsWith("tab:") ? { kind: "tab", id: Number(id.slice(4)) } : { kind: "passages", url: id.slice(9) })`
- click delegation gains four cases: `.brief__mode` toggles the url in `wholePage` (and moves the
  pick id if that row was selected, so a mode switch does not silently deselect), `.brief__drop`
  sends `{kind:"passage-drop", url, at}`, `.brief__drop-row` sends `{kind:"passage-drop", url}`,
  `#clear-passages` sends `{kind:"passage-clear"}`; each awaits its answer then calls `loadTabs()`
  so the rows re-render from stored truth rather than from a local guess

Add those two messages to `src/shared/messages.ts` with guards beside `isBriefStartRequest`
(`url` via `safeHttpUrl`, `at` an integer when present), route them in the worker's brief branch
to `updatePassages` with `removePassage` / `removeGroup` / `() => ({ ok: true, all: [] })`, and
cover the routing in `test/unit/brief-service-worker.test.ts` the way the existing brief
messages are covered there.

- [ ] **Step 6: Style the rows**

In `src/brief/brief.css`, add `.brief__passages` (the per-row passage list), `.brief__mode`,
`.brief__drop`, `.brief__drop-row` and `.brief__count`, following the file's existing custom
properties and spacing scale. No new fonts, no new colours outside the ones already defined.

- [ ] **Step 7: Extend the page test**

In `test/unit/brief-page.test.ts` (jsdom), add: a `brief-tabs` answer carrying one group renders
a passages row; ticking it and clicking Send posts
`{kind: "brief-start", question, picks: [{kind: "passages", url}]}`; the preview shows the
passage text; clicking `.brief__drop` posts a `passage-drop` carrying that `at`.

- [ ] **Step 8: Run everything**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/brief/ src/shared/messages.ts src/background/service-worker.ts \
        test/unit/brief-view.test.ts test/unit/brief-page.test.ts \
        test/unit/brief-service-worker.test.ts test/unit/messages.test.ts
git commit -m "feat(brief): pick passages beside the tabs you have open

One row per page: a collected page that is also an open tab appears once, in
passages mode, because highlighting is you telling the composer which part
matters. A control switches that row back to the whole page — offered only when
the tab is open, since a closed tab has nothing to capture.

Per-passage remove lives on the row, not in the pre-send preview: a mutation
control inside 'this is what gets sent' means the panel you confirmed is not
the panel you read.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The gate — mock gateway brief routes and an e2e

**Files:**
- Modify: `scripts/screenshots/gateway-fixtures.ts` (brief fixtures)
- Modify: `scripts/screenshots/mock-gateway.ts` (the five brief routes; it has none today)
- Create: `test/e2e/passages.e2e.ts`
- Modify: `docs/development.md` (a checklist section with `<!-- e2e:passages-N -->` markers)
- Test: the existing `test/unit/e2e-coverage.test.ts` enforces both directions

**Interfaces:**
- Consumes: `launchExtension` from `scripts/e2e/launch.ts`; `Scenario` from `gateway-fixtures.ts`.
- Produces: `export const COVERS = ["passages-1", ...] as const` — required and asserted
  non-empty by `e2e-coverage.test.ts`.

**Read first:** `test/unit/e2e-coverage.test.ts`. It fails if a checklist marker has no declaring
suite, if a suite declares an id with no marker, if a marker id repeats, or if a `.e2e.ts` file's
`COVERS` block is missing or empty. All four are live gates.

- [ ] **Step 1: Add the brief routes to the mock gateway**

The mock implements pair/clips/related/resolve/fetch/agents but **nothing under `/v1/briefs`**.
Add an in-memory run keyed by id, holding what was fed, and route:

- `POST /v1/briefs` → `{ id: "brief-1", status: "collecting", expected: <sources.length> }`
- `POST /v1/briefs/{id}/sources` → record `{url, title, body, capturedAt, truncated}`; return
  `{ accepted: true, received, expected }`
- `POST /v1/briefs/{id}/run` → `{ status: "running" }`
- `GET /v1/briefs/{id}` → `{ status: "done", report: <fixture> }`
- `POST /v1/briefs/{id}/save` → `{ itemId: "item-1" }`

Expose the recorded sources for assertions — follow the file's existing `Scenario` hook style
(`scenario.onRequest`) and add `scenario.onBriefSource?.(body)` rather than inventing a new
mechanism. Keep `handleRequest` pure request→response, as its comment requires.

In `gateway-fixtures.ts`, beside the existing fixtures:

```ts
export interface FedBriefSource {
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly capturedAt: number;
  readonly truncated: boolean;
}

/** A minimal done report: one finding citing the first source. */
export const BRIEF_REPORT = {
  summary: "Both sources describe the same change.",
  findings: [
    { text: "The sources agree on the approach.", citations: [{ url: "", title: "Source 1" }] },
  ],
  conflicts: [],
  gaps: [],
  synthesis: { remote: false, model: "local-fixture" },
} as const;
```

`Scenario` gains `readonly onBriefSource?: (source: FedBriefSource) => void;`.

**Derive `BRIEF_REPORT`'s exact shape from `src/shared/brief-report.ts`'s parser, not from the
sketch above.** That module is what accepts or rejects the payload; a fixture that misses a
required field makes the page render a failure and the e2e's banner assertion fail for a reason
that has nothing to do with passages. Read the guard, then match it.

**`isObject` does not exist in `mock-gateway.ts` or `gateway-fixtures.ts`** — verified, neither
file has one. Add a two-line local guard in the mock rather than importing from `src/`: this is a
dev fixture and must not grow a dependency on shipped code it is supposed to test against.

In `mock-gateway.ts`'s `handleRequest`, before the fallthrough (note the path shapes: create is
the bare base, the other four append `/{id}` and an action):

The per-run counters live in state **owned by one server**, never at module scope:

```ts
/** One mock server's live brief runs. Created per `startMockGateway` call. */
export type BriefRuns = Map<string, { expected: number; received: number }>;

export function newBriefRuns(): BriefRuns {
  return new Map();
}
```

`handleRequest` takes it as a third parameter, defaulting to a fresh map so its existing callers
and unit tests are unaffected:

```ts
export async function handleRequest(
  req: Request,
  scenario: Scenario = {},
  runs: BriefRuns = newBriefRuns(),
): Promise<Response> {
```

and `startMockGateway` creates one per server and closes over it, so two harnesses alive in one
process cannot see each other's counts.

```ts
  // The five research-brief routes. `expected` is echoed from what create
  // declared, so the page's received/expected counter is real rather than fixed.
  if (url.pathname === GATEWAY_PATHS.briefs && req.method === "POST") {
    const body: unknown = await req.json();
    const sources = isObject(body) && Array.isArray(body["sources"]) ? body["sources"] : [];
    const id = `brief-${runs.size + 1}`;
    runs.set(id, { expected: sources.length, received: 0 });
    return jsonResponse({ id, status: "collecting", expected: sources.length });
  }
  const brief = /^\/v1\/briefs\/([^/]+)(?:\/(sources|run|save))?$/.exec(url.pathname);
  if (brief !== null) {
    const id = brief[1] ?? "";
    const run = runs.get(id);
    if (run === undefined) {
      // An id this server never issued. 404 rather than a cheerful default: a
      // fixture that answers for a run it does not have hides a client bug.
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    const action = brief[2];
    if (action === "sources" && req.method === "POST") {
      scenario.onBriefSource?.((await req.json()) as FedBriefSource);
      run.received += 1;
      return jsonResponse({ accepted: true, received: run.received, expected: run.expected });
    }
    if (action === "run") {
      return jsonResponse({ status: "running" });
    }
    if (action === "save") {
      return jsonResponse({ itemId: "item-1" });
    }
    return jsonResponse({ status: "done", report: BRIEF_REPORT });
  }
```

Per-server state, not module state, and ids issued rather than fixed: two runs in one suite, or
two harnesses in one worker process, stay isolated without the caller thinking about it. It also
keeps `handleRequest` honest about its own doc comment — it is request→response over state it is
handed, with nothing hidden at module scope.

- [ ] **Step 2: Write the e2e**

Create `test/e2e/passages.e2e.ts`:

```ts
/**
 * Covers `docs/development.md` → "Manual verification — Passages as brief sources".
 *
 * COVERS steps 2-5 (ids passages-2..5). Step 1 (the right-click gesture itself)
 * is human: a browser context menu is OS-level chrome, outside the page, and
 * Playwright cannot open or click it. The collection is seeded through the
 * service worker instead, which is the same split `input-lanes.e2e.ts` already
 * documents for the two selection menus.
 */
import { expect, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";

export const COVERS = ["passages-2", "passages-3", "passages-4", "passages-5"] as const;

test("a seeded collection becomes one stitched source the gateway receives", async () => {
  const fed: { url: string; body: string }[] = [];
  const h = await launchExtension({ scenario: { onBriefSource: (b) => fed.push(b) } });
  try {
    // Seed two passages for one page: the gesture is human, the storage is not.
    await h.sw.evaluate(async () => {
      await chrome.storage.local.set({
        passages: [
          { url: "http://127.0.0.1/sample", title: "Sample", text: "first passage", at: 100 },
          { url: "http://127.0.0.1/sample#x", title: "Sample", text: "second passage", at: 200 },
        ],
      });
    });

    const page = await h.context.newPage();
    await page.goto(`chrome-extension://${h.extId}/brief.html`);

    // One row, saying two passages — not two rows, and not a whole page.
    const row = page.locator(".brief__tab", { hasText: "2 passages" });
    await expect(row).toHaveCount(1);
    await row.locator("input[type=checkbox]").check();
    await page.locator(".brief__question").first().click();

    // The preview shows the exact bytes, joins included.
    await expect(page.locator(".preview__passages .preview__body")).toContainText(
      "first passage\n\n[...]\n\nsecond passage",
    );

    await page.locator("#run").click();
    await expect(page.locator(".brief__banner")).toBeVisible();

    // The assertion no unit test can make: what the gateway actually received.
    expect(fed).toHaveLength(1);
    expect(fed[0]?.url).toBe("http://127.0.0.1/sample");
    expect(fed[0]?.body).toBe("first passage\n\n[...]\n\nsecond passage");

    // Fed groups are forgotten once /run was accepted.
    const left = await h.sw.evaluate(async () => {
      const got = await chrome.storage.local.get("passages");
      return got["passages"];
    });
    expect(left).toEqual([]);
  } finally {
    await h.close();
  }
});
```

- [ ] **Step 3: Add the checklist section with matching markers**

In `docs/development.md`, add a *Manual verification — Passages as brief sources* section whose
steps carry `<!-- e2e:passages-1 -->` … `<!-- e2e:passages-5 -->`. **Step 1 must NOT carry a
marker** — no suite declares `passages-1`, and a marker without a declaring suite fails
`e2e-coverage.test.ts`. Steps 2-5 carry markers matching `COVERS` exactly:

1. (no marker) On a normal article page, select a paragraph, right-click → **Add to brief**.
   Confirm the toast reads *"Added — 1 passage from this page."* Select a second paragraph and
   repeat; the toast now says *2 passages*. Right-click the same text a third time: *"Already
   collected."*
2. `<!-- e2e:passages-2 -->` Open the brief page. The page appears as **one** row saying
   *2 passages*, not two rows and not a whole page.
3. `<!-- e2e:passages-3 -->` Pick it, choose a question, and read the preview: it names the
   source as passages and shows both, with `[...]` between them.
4. `<!-- e2e:passages-4 -->` Send. The finished brief cites that page.
5. `<!-- e2e:passages-5 -->` Reopen the brief page: the sent page is gone from the collection.
6. (no marker) With that page still open in a tab, collect a passage, then use *use the whole
   page instead* and send. Reopen: the passages are still there.

If you give step 6 a marker, the gate fails — nothing declares `passages-6`.

- [ ] **Step 4: Run the gates**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS, including `e2e-coverage.test.ts`. Then build and run the e2e:
`bun run build && bunx playwright test test/e2e/passages.e2e.ts`
(the harness loads `dist/chrome`, so a stale build tests stale code; and it must run under
`node`, not `bun` — see `scripts/e2e/launch.ts`'s header).

- [ ] **Step 5: Commit**

```bash
git add scripts/screenshots/ test/e2e/passages.e2e.ts docs/development.md
git commit -m "test(e2e): assert the body the gateway actually receives

The mock gateway had no /v1/briefs routes at all, so the composer has never had
an e2e. It has one now, and it makes the assertion no unit test can: one
declared source, and a body carrying both passages with the separator between
them — then the collection empty afterwards.

The right-click itself stays human. A browser context menu is OS-level chrome
Playwright cannot open, the same split input-lanes.e2e.ts already documents.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The record

**Files:**
- Modify: `ROADMAP.md` (a C5.3 brief in Phase C5; a status line on 2.3)
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)
- Modify: `docs/architecture.md` (the collection in the layer map)
- Test: the existing `test/unit/doc-references.test.ts` resolves every spec path cited from
  `ROADMAP.md`, `docs/architecture.md` and source comments

- [ ] **Step 1: Add the C5.3 brief to `ROADMAP.md`**

After C5.2, in the shape every other brief uses (**What** / **Why it wows** / **Touches** /
**Approach** / **Done when** / **Status**), tagged `🟢 · M — ✅ shipped`, citing
`docs/superpowers/specs/2026-08-18-passages-as-brief-sources-design.md`. State the four things
the spec's *Corrections to the roadmap* section records, including that C5.1's "the set it can
name is the set it can read" holds for enumeration and that a passage is named because it was
acted on.

- [ ] **Step 2: Add the status line to 2.3**

2.3 "Highlight-stitching" gets a line saying it is **delivered re-aimed, not as written**: its
own acceptance bar (one clip) is deliberately unmet, C5.2 re-aimed it at a brief's source list,
and C5.3 is where it landed. Also correct its reframe note's claim that the collect UI "has to
live as a panel lane" — the overlay half stands, the lane half does not (spec decision 1).

- [ ] **Step 3: Add the changelog entry**

Under `## [Unreleased]`, an `### Added` entry in the changelog's existing user-facing voice — what
changed for the person using it, not which files moved. Name the honest details: the text is
captured when you highlight it (so it survives closing the tab), the preview shows exactly what
will be sent, and sending consumes the passages.

- [ ] **Step 4: Update `docs/architecture.md`**

Add the collection to the layer map beside the offline queue and the brief run store: one storage
key, one pure rules module, refuse-never-evict, and the collect path's reuse of `captureTab`.
Keep it to the load-bearing decisions — the spec is the long form and should be linked, not
restated.

- [ ] **Step 5: Run the gates**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS, including `doc-references.test.ts` (it will fail if a cited spec path is
mistyped) and `e2e-coverage.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add ROADMAP.md CHANGELOG.md docs/architecture.md
git commit -m "docs: record C5.3, and what it corrects

2.3 is delivered re-aimed, not as written — its one-clip acceptance bar is
deliberately unmet, and its reframe note's claim that the collect UI must live
as a panel lane no longer holds. Both said in place rather than silently
retagged, the way C5.2 recorded its own corrections.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Verification before calling this done

Run all of it, and read the output rather than assuming it:

```bash
bun run typecheck
bun run lint
bun run test
bun run build && bun run check-build
bunx playwright test test/e2e/passages.e2e.ts
```

Then the two manual steps no suite covers (Task 8's checklist steps 1 and 6): the right-click
gesture and its three toasts, and whole-page mode keeping its passages. Load the unpacked
`dist/chrome` per `docs/development.md`.

## Spec coverage

| Spec decision | Task |
| --- | --- |
| 1 menu collects, composer reviews | 3, 7 |
| 2 `runCapture`, not `selectionText` | 3 |
| 3 one stitched source + `PASSAGE_SEPARATOR` | 1 |
| 4 `capturedAt` is the oldest | 1, 6 |
| 5 one row, passages by default, whole-page toggle | 7 |
| 6 one ordered `picks` union + guard | 5, 6 |
| 7 preview distinguishes kinds and shows passage text | 4 |
| 8 caps at collect time; refuse never evict | 1, 2 |
| 9 fed groups forgotten at `/run`; whole-page keeps | 6 |
| 10 no badge state | 3 |
| 11 no new permission; ungranted origins collectable | 3 (asserted by the untouched `manifest.test.ts`) |
| 12 never a clip | — (nothing added to the clip path) |
| grouping key: fragment only | 1 |
| failure surface (every row) | 1, 2, 3, 6, 7 |
| testing section | 1-8 |
| corrections to the roadmap | 9 |
