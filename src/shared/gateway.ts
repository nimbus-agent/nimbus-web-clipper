// The gateway's locked HTTP contract (shipped on the Nimbus monorepo in PR #718).
// The gateway binds 127.0.0.1 only (invariant I6); the extension only ever talks
// to loopback. The port is configurable because the owner can run the gateway on
// a non-default port — the pairing step is where the chosen origin is confirmed.

/** Default loopback origin for a stock gateway install. */
export const DEFAULT_GATEWAY_ORIGIN = "http://127.0.0.1:8765";

/** Locked endpoint paths — do not redesign (see PR #718). */
export const CLIP_PATHS = {
  ingest: "/v1/clips",
  pairConfirm: "/v1/clips/pair/confirm",
  related: "/v1/clips/related",
} as const;

export type ClipEndpoint = keyof typeof CLIP_PATHS;

/** Join a gateway origin with a locked endpoint path, tolerating a trailing slash. */
export function endpointUrl(origin: string, endpoint: ClipEndpoint): string {
  const trimmed = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return `${trimmed}${CLIP_PATHS[endpoint]}`;
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
