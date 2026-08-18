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

/**
 * The ONE join, spelled once.
 *
 * Three call sites depend on producing byte-for-byte the same string: `stitch`
 * builds the body that is sent, `addPassage` builds the candidate body its cap
 * is measured against, and `buildBriefPreview` builds the body it SHOWS. If any
 * of them joined differently — trimming each passage, say — the preview would
 * stop being the honest statement decision 7 claims it is, and the cap would
 * stop measuring what actually leaves. Only the e2e would notice.
 */
export function joinPassages(texts: readonly string[]): string {
  return texts.join(PASSAGE_SEPARATOR);
}

export function stitch(group: PassageGroup): string {
  return joinPassages(group.passages.map((passage) => passage.text));
}

/**
 * The group's capture time: its OLDEST passage.
 *
 * A stitched body is only as fresh as the oldest text in it, so the newest
 * would overstate the freshness of everything above it. Understating is the
 * safe direction.
 */
export function groupCapturedAt(group: PassageGroup): number {
  return group.passages.reduce(
    (oldest, passage) => Math.min(oldest, passage.at),
    Number.MAX_SAFE_INTEGER,
  );
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
  const stitched = joinPassages([...same.map((passage) => passage.text), next.text]);
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
