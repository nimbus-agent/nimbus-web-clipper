// src/background/http-json.ts
// The three things every gateway client in this folder does to a Response
// before it trusts anything in it.
//
// `gateway-client.ts`, `egress-client.ts` and `brief-client.ts` each carried
// their own copy. Two of the `parseScopeGap` copies were byte-identical and the
// third differed only in spelling (`.every()` versus a loop) — three parsers for
// ONE wire shape, which is the drift class this repo has already been bitten by
// once as `isResolvedItem`.
//
// The scope gap is the one that matters most. Its output is rendered into a
// pasteable `nimbus clip scopes <label> --set <scopes>` command, and `--set`
// REPLACES the token's scope set — so a gap parsed from a partial body would
// build a command that silently REVOKES scopes the token already has. Nothing
// short of the full shape may produce one.

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * The body, or `null` when there isn't one that parses.
 *
 * A gateway behind a proxy can answer HTML on an error, and a killed connection
 * can truncate a body mid-object. Neither may throw out of a route's `await`:
 * every caller here is reached from a `void`-ed handler, where a rejection
 * surfaces as an unhandled rejection rather than a reason the user can act on.
 */
export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** The gateway's raw 403 detail, or `null` if the body is not exactly that. */
export function parseScopeGap(v: unknown): { required: string; granted: string[] } | null {
  if (!isObject(v) || typeof v["required"] !== "string" || !Array.isArray(v["granted"])) {
    return null;
  }
  const granted: string[] = [];
  for (const s of v["granted"]) {
    if (typeof s !== "string") {
      return null;
    }
    granted.push(s);
  }
  return { required: v["required"], granted };
}
