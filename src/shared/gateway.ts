// The gateway's locked HTTP contract (shipped on the Nimbus monorepo in PR #718).
// The gateway binds 127.0.0.1 only (invariant I6); the extension only ever talks
// to loopback. The port is configurable because the owner can run the gateway on
// a non-default port — the pairing step is where the chosen origin is confirmed.

/**
 * Every path this extension calls, all of them contracted and shipped upstream.
 *
 * `ingest` / `pairConfirm` / `related` shipped in the Nimbus monorepo PR #718.
 * `resolve` shipped later, under its own `resolve` token scope — see
 * packages/gateway/src/ipc/http-server.ts#handleItemsResolve. It was briefly
 * modelled here as PROPOSED while this client was built against a guessed shape;
 * that split is gone because the guess is gone.
 *
 * `itemsFetch` is the targeted-fetch route under the `fetch` token scope — an
 * explicit I13 WRITE, not a read with side effects, because it causes an
 * outbound request to a configured provider under the user's stored credential.
 */
export const GATEWAY_PATHS = {
  ingest: "/v1/clips",
  pairConfirm: "/v1/clips/pair/confirm",
  related: "/v1/clips/related",
  resolve: "/v1/items/resolve",
  itemsFetch: "/v1/items/fetch",
  /**
   * Unauthenticated liveness — the ONLY route this client calls without a bearer
   * token. Served by the same server as the clip routes
   * (packages/gateway/src/ipc/http-server.ts, dispatchReadOnlyDataGet), so an
   * answer here means the gateway that ingests clips is up, not merely that
   * something is listening on the port.
   */
  health: "/v1/health",
  /**
   * BASES, not complete paths: both agent routes carry a path parameter
   * (`/v1/agents/{agent}`, `/v1/agents/runs/{id}`) which this static map cannot
   * express. Callers append the segment. Kept here anyway so every contracted
   * path still has exactly one home — a second map is what Task 1 of the resolve
   * slice existed to delete.
   */
  agents: "/v1/agents",
  agentRuns: "/v1/agents/runs",
  /**
   * BASE, not a complete path: create is `POST /v1/briefs`, and the other four
   * routes append `/{id}` and an action (`/sources`, `/run`, `/save`) which this
   * static map cannot express.
   *
   * Bearer-authed under the `briefs` scope — which is a LEGACY scope
   * (`clips/api-scopes.ts`'s `LEGACY_SCOPES = ["clip", "briefs"]`), so unlike
   * `resolve` / `fetch` / `agents` every token already in the wild carries it. A
   * token minted after scopes existed can still lack it if the owner narrowed
   * `--scopes`, so the 403 path stays; it is just not the common case.
   *
   * Returns 404 `briefs_disabled` when the gateway's briefs seam is not wired.
   */
  briefs: "/v1/briefs",
  /**
   * The egress-ledger reads (C4.1), under the `egress` token scope.
   *
   * Four separate paths rather than one with a mode parameter, mirroring the
   * four separate verbs they sit over upstream. `egress` is NOT a legacy scope
   * and is not granted by any existing pairing, so a 403 here is the FIRST
   * thing every already-paired browser hits — the owner grants it in place with
   * `nimbus clip scopes`, without re-pairing.
   *
   * A gateway that predates the surface 404s; the client says so rather than
   * rendering an empty list.
   */
  egress: "/v1/egress",
  egressHead: "/v1/egress/head",
  egressVerify: "/v1/egress/verify",
  egressProve: "/v1/egress/prove",
} as const;

export type GatewayEndpoint = keyof typeof GATEWAY_PATHS;

/** Join a gateway origin with an endpoint path, tolerating a trailing slash. */
export function endpointUrl(origin: string, endpoint: GatewayEndpoint): string {
  const trimmed = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return `${trimmed}${GATEWAY_PATHS[endpoint]}`;
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True only for an http loopback origin. Uses the URL parser (never a substring
 * check) so lookalikes like 127.0.0.1.attacker.com are rejected. HTTPS is excluded
 * by design — the shipped gateway serves plain http on 127.0.0.1.
 */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") {
    return false;
  }
  // WHATWG URL serializes an IPv6 host WITH brackets, so url.hostname is "[::1]"
  // (never bare "::1"), consistently across Chrome/Firefox/Node.
  const host = url.hostname;
  return host === "localhost" || host === "[::1]" || LOOPBACK_V4.test(host);
}
