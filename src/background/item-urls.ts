// src/background/item-urls.ts
// Turns a set of item ids into the URLs the index holds for them: de-duplicated,
// chunked against BOTH of `/v1/items/resolve-ids`'s bounds, and tolerant of a
// chunk — or every chunk — failing. Runs in the background service worker, when
// an agent run lands, never in the panel (which holds no token). See
// docs/superpowers/specs/2026-09-08-a-title-you-can-follow-design.md §4.
import type { ItemUrlMap, LaneFindings } from "../shared/findings.ts";
import { RESOLVE_IDS_MAX_BATCH, type ResolvedIdRow } from "./gateway-client.ts";

/**
 * The item ids worth resolving out of one lane's findings — `expert`'s
 * evidence and `catchup`'s items, and `[]` for the other five lanes.
 *
 * **This is not an oversight to fill in later.** `why`, `glossary` and
 * `decisions` already carry a `url` on the wire (`WhyFinding.url`,
 * `GlossarySourceRef.url`, `DecisionEvidence.url`), so there is nothing here
 * for a resolver to add. `impact` and `ownership` are the two that look like
 * they qualify and do not:
 *
 * - **The trap**: `ImpactFinding.affectedItemId` READS like an item id — the
 *   name says so — but it is a `graph_entity.id` (every one of the gateway's
 *   five impact sub-lanes selects `e.id FROM graph_entity`; see
 *   `ImpactFindings`'s own comment in `findings.ts`). Passing it to
 *   `resolve-ids`, which resolves `item.id`s, would issue a request the
 *   gateway is guaranteed to answer with nothing — silently, since resolution
 *   failure never surfaces as an error (spec §4.2). Its `affectedTitle` is
 *   already the reader-facing text; there is no id to link.
 * - `ownership` carries no item id at all: `OwnershipOwner.externalId` is a
 *   PERSON id, and `OwnershipTargetView.displayPath` is a file-system path.
 *   Neither is anything `/v1/items/resolve-ids` could ever answer for.
 */
export function itemIdsOf(findings: LaneFindings): readonly string[] {
  switch (findings.kind) {
    case "expert":
      return findings.ranked.flatMap((person) => person.evidence.map((e) => e.itemId));
    case "catchup":
      return findings.sections.flatMap((section) => section.items.map((item) => item.itemId));
    case "why":
    case "glossary":
    case "decisions":
    case "impact":
    case "ownership":
      return [];
  }
}

/** The shape of `resolveItemIds` (gateway-client.ts), injected rather than
 *  imported as a value — this module never touches `fetch` or a token directly,
 *  and a test never has to build a `Response`. */
export type ResolveItemIdsFn = (
  origin: string,
  token: string,
  ids: readonly string[],
) => Promise<
  | { readonly ok: true; readonly items: readonly ResolvedIdRow[] }
  | { readonly ok: false; readonly reason: "unsupported" | "forbidden" | "failed" }
>;

export interface ResolveItemUrlsDeps {
  readonly origin: string;
  readonly token: string;
  readonly resolveItemIds: ResolveItemIdsFn;
}

/**
 * This client's OWN half of the two-bound chunking rule (spec §4.1). The
 * route's `RESOLVE_IDS_MAX_BATCH` (100 raw `?id=` params) is the other half,
 * and the route cannot enforce this one itself: `item.id` is unconstrained
 * `TEXT` — a GitHub PR id is ~20 characters, a deep GitLab subgroup path is
 * several times that — so 100 ids is anywhere from ~3 KB to well past 12 KB of
 * query string. A URL past the server's request-line limit is refused BEFORE
 * any handler runs, so an over-long batch comes back as a transport error
 * rather than the honest `400 too_many_ids` the route would give for a batch
 * it could actually see. ~1,800 bytes sits comfortably under every request-line
 * limit likely to sit in front of a loopback gateway (Node's own default is
 * 8 KB; a reverse proxy in front of it typically allows more, not less), with
 * headroom left for the scheme/origin/path this budget does not itself count.
 */
export const QUERY_BYTES_BUDGET = 1_800;

/**
 * The bytes ONE id contributes to the query string, encoded exactly the way
 * `resolveItemIds` encodes it: `URLSearchParams`'s
 * application/x-www-form-urlencoded rules, as `id=<percent-encoded id>`.
 *
 * Measured by actually encoding, not by the raw id length — the whole point of
 * the byte budget is that an id's wire cost is not its character count (a
 * colon, a slash, a space each expand under percent-encoding). Every character
 * that encoding can produce (letters, digits, `%`, `+`, `-`, `_`, `.`, `=`,
 * `&`) is single-byte ASCII, so the resulting JS string's `.length` already IS
 * its UTF-8 byte count — no `TextEncoder` needed on top.
 */
function pairBytes(id: string): number {
  return new URLSearchParams([["id", id]]).toString().length;
}

/**
 * Greedily group `ids` into batches that respect BOTH of the route's bounds —
 * whichever binds first, binds (spec §4.1): at most `RESOLVE_IDS_MAX_BATCH` ids,
 * and at most `QUERY_BYTES_BUDGET` bytes of query string. Joining `n` encoded
 * `id=…` pairs with `&` costs `n - 1` extra bytes, which is why the running
 * byte check below adds `current.length` — the separator this next id would
 * need — on top of its own `pairBytes`.
 *
 * **An id whose own encoded bytes alone exceed `QUERY_BYTES_BUDGET` is still
 * attempted, ALONE, in a chunk of one — never silently dropped.** The budget
 * above is this client's own conservative estimate of a limit the gateway
 * does not publish, not a hard wall the transport is known to enforce at
 * exactly that number: a solo request for one oversized id has a real chance
 * of still landing, and a missing link is worse than one request that might
 * come back `failed`. That id is added unconditionally the moment it starts a
 * new chunk (the bound check below only ever fires once `current` already
 * holds something), and the very next id then forces a flush because the
 * running byte total is already over budget.
 */
export function chunkIds(ids: readonly string[]): readonly (readonly string[])[] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;

  for (const id of ids) {
    const bytes = pairBytes(id);
    const wouldCount = current.length + 1;
    const wouldBytes = currentBytes + bytes + current.length; // + this id's own separator
    if (
      current.length > 0 &&
      (wouldCount > RESOLVE_IDS_MAX_BATCH || wouldBytes > QUERY_BYTES_BUDGET)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(id);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Resolve `ids` to the URLs the index holds for them, as a partial map.
 *
 * De-duplicated before chunking — the same item id recurs across evidence
 * rows (an `expert` ranking cites the same PR under two people; a `catchup`
 * window lists it once per section), and paying for it twice is free to
 * avoid — then issued chunk by chunk, in order, against `deps.resolveItemIds`.
 *
 * **`"unsupported"` and `"forbidden"` stop the loop; `"failed"` does not.** The
 * first two are PERMANENT for this token: a 404 means the route does not exist
 * on this gateway at all, a 403 means the token lacks the `resolve` scope
 * (cleared only by the owner running `nimbus clip scopes`) — either way every
 * remaining chunk is guaranteed to fail identically, so running them anyway is
 * pure waste, worst on exactly the runs carrying the most evidence (250 ids is
 * three pointless requests instead of one). `"failed"` covers transient causes
 * — a network blip, a timeout, a malformed body — where the next chunk may
 * well succeed, and losing chunks that already succeeded because a later one
 * failed would be strictly worse than the partial map this returns instead.
 *
 * Never throws. Every failure — one chunk's, or all of them — yields a partial
 * (possibly empty) map, exactly as an older gateway or an un-scoped token
 * would. A lane rendering titles as plain text is the NORMAL state here, not a
 * degraded one (spec §4.2).
 */
export async function resolveItemUrls(
  deps: ResolveItemUrlsDeps,
  ids: readonly string[],
): Promise<ItemUrlMap> {
  const unique = Array.from(new Set(ids));
  // A `Map`, not a plain object, and the difference is not stylistic: an
  // `item.id` of exactly `"__proto__"` assigned onto an object literal hits
  // the legacy prototype setter instead of creating an own property, so the
  // URL is silently dropped and that one title never links. `item.id` is
  // unconstrained `TEXT` upstream, so nothing rules the value out.
  const map = new Map<string, string>();
  for (const chunk of chunkIds(unique)) {
    const result = await deps.resolveItemIds(deps.origin, deps.token, chunk);
    if (!result.ok) {
      if (result.reason === "unsupported" || result.reason === "forbidden") {
        break;
      }
      continue;
    }
    // Only ids we asked for. A row for anything else is a gateway that
    // answered a question we did not ask, and storing it would put bytes we
    // can never look up into the run's shared byte budget - which is charged
    // against `findings`, so enough of them would drop the findings and leave
    // the reader with the prose brief instead. Keeping the good rows beats
    // rejecting the whole chunk: there is no channel to report the oddity on,
    // and the remaining rows are still answers to real questions.
    const requested = new Set(chunk);
    for (const item of result.items) {
      if (item.url !== null && requested.has(item.id)) {
        map.set(item.id, item.url);
      }
    }
  }
  return Object.fromEntries(map);
}
