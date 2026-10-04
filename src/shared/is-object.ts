// src/shared/is-object.ts
// The first rung of every boundary guard in this extension: "is this something
// whose properties I may read?" Eleven modules carried their own byte-identical
// copy; this is the one they share.

/**
 * True for any non-null object — ARRAYS INCLUDED, which is what every caller
 * here wants: each goes on to check named fields, and an array has none.
 *
 * Deliberately NOT the rule for a value that must be a plain record and nothing
 * else. Those guards refuse arrays and keep their own predicate, because a
 * different rule is not a duplicate: `connector-health.ts`'s `isObject`,
 * `deploy.ts`'s `isObj`, and `clip.ts`'s `isSourceShape`.
 */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
