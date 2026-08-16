// src/panel/related-groups.ts
// How the Related lane's hits are arranged and labelled. Pure — no DOM, no
// messaging — so the two rules that decide what the reader sees are testable on
// their own, and so neither grows inside panel-view.ts or panel-in-page.ts.
import type { RelatedHit } from "../shared/types.ts";

/** One service's hits, in the order the gateway ranked them. */
export interface RelatedGroup {
  readonly service: string;
  readonly hits: readonly RelatedHit[];
}

/**
 * Collapse ranked hits into per-service groups WITHOUT reordering relevance.
 *
 * The wire carries no score — only position, from the gateway's `ORDER BY rank`.
 * So a service's rank is the position of its best hit: groups appear in order of
 * first appearance, and hits keep their ranked order inside each group. Sorting
 * groups by size instead would promote a big pile of weak hits over the single
 * best answer, which is the one thing this lane must not do.
 */
export function groupHits(hits: readonly RelatedHit[]): RelatedGroup[] {
  const order: string[] = [];
  const byService = new Map<string, RelatedHit[]>();
  for (const h of hits) {
    const existing = byService.get(h.service);
    if (existing === undefined) {
      order.push(h.service);
      byService.set(h.service, [h]);
    } else {
      existing.push(h);
    }
  }
  return order.map((service) => ({ service, hits: byService.get(service) ?? [] }));
}

/**
 * The handful of kinds whose mechanical humanisation reads wrong. Deliberately
 * TINY, and deliberately not a complete map: `item.type` is an open vocabulary —
 * the connectors already write 23+ distinct values and every new connector may
 * add another — so a closed table would go stale and start mislabelling real,
 * nameable kinds as something generic.
 */
const TYPE_OVERRIDES: Record<string, string> = {
  pr: "Pull request",
  ci_run: "CI run",
  api_endpoint: "API endpoint",
};

/**
 * A short human label for an item kind, or null when there is nothing to say.
 *
 * Null — not "Item" — because a chip that says nothing specific is furniture: it
 * costs a row of space and tells the reader something they already knew.
 */
export function humaniseType(type: string | undefined): string | null {
  if (type === undefined) {
    return null;
  }
  const key = type.trim();
  if (key === "") {
    return null;
  }
  const override = TYPE_OVERRIDES[key];
  if (override !== undefined) {
    return override;
  }
  const words = key.replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
