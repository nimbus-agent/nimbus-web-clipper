// The gateway's locked HTTP contract (shipped on the Nimbus monorepo in PR #718).
// The gateway binds 127.0.0.1 only (invariant I6); the extension only ever talks
// to loopback. The port is configurable because the owner can run the gateway on
// a non-default port — the pairing step is where the chosen origin is confirmed.

/** Locked endpoint paths — do not redesign (see PR #718). */
export const CLIP_PATHS = {
  ingest: "/v1/clips",
  pairConfirm: "/v1/clips/pair/confirm",
  related: "/v1/clips/related",
} as const;

export type ClipEndpoint = keyof typeof CLIP_PATHS;

/**
 * PROPOSED, not contracted. `POST /v1/clips/resolve` does not exist on the
 * shipped gateway; it is designed in
 * docs/superpowers/specs/2026-08-07-phase-c1-know-where-you-are-design.md and
 * owned upstream. A 404 from this path is a first-class "this gateway can't
 * resolve pages yet", never an error — which is why it is kept OUT of
 * CLIP_PATHS, the locked three.
 */
export const PROPOSED_PATHS = {
  resolve: "/v1/clips/resolve",
} as const;

export type GatewayEndpoint = ClipEndpoint | keyof typeof PROPOSED_PATHS;

const ALL_PATHS: Record<GatewayEndpoint, string> = { ...CLIP_PATHS, ...PROPOSED_PATHS };

/** Join a gateway origin with an endpoint path, tolerating a trailing slash. */
export function endpointUrl(origin: string, endpoint: GatewayEndpoint): string {
  const trimmed = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return `${trimmed}${ALL_PATHS[endpoint]}`;
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
