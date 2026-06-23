import type { RelatedHit } from "./types.ts";

/** The gateway request body for POST /v1/clips/related. */
export interface RelatedQuery {
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly selection?: string;
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
  ctx: { title?: string; canonicalUrl?: string; selection?: string },
  limit: number = RELATED_LIMIT,
): RelatedQuery {
  const title = ctx.title?.trim();
  const canonicalUrl = ctx.canonicalUrl?.trim();
  const selection = ctx.selection?.trim();
  return {
    ...(title !== undefined && title !== "" ? { title } : {}),
    ...(canonicalUrl !== undefined && canonicalUrl !== "" ? { canonicalUrl } : {}),
    ...(selection !== undefined && selection !== "" ? { selection } : {}),
    limit,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isRelatedHit(v: unknown): v is RelatedHit {
  return (
    isObject(v) &&
    typeof v["id"] === "string" &&
    typeof v["title"] === "string" &&
    typeof v["service"] === "string" &&
    typeof v["snippet"] === "string" &&
    (v["url"] === null || typeof v["url"] === "string")
  );
}
