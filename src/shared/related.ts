import type { RelatedHit } from "./types.ts";

/** The gateway request body for POST /v1/clips/related. */
export interface RelatedQuery {
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly selection?: string;
  readonly itemId?: string;
  readonly limit: number;
}

/** Default number of related items to request for this slice. */
export const RELATED_LIMIT = 10;

/**
 * Build the related-query body from the page context: trim each field, drop the
 * blank ones (conditional spread keeps the object exactOptionalPropertyTypes-safe —
 * an absent field is omitted, never set to undefined), and attach the limit.
 */
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

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
