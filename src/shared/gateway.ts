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
