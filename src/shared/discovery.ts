// Zero-config gateway discovery (roadmap 3.5). Pure: the candidate list and the
// pick decision only — the probing itself is gateway-client.ts's job, because it
// touches the network.

/**
 * The origins discovery probes, in order.
 *
 * TWO candidates, never a range. A port sweep is slow, it is the one behaviour in
 * this extension that would look like malware to anyone watching the socket
 * table, and it buys a case the manual URL field already covers.
 *
 * `127.0.0.1` is FIRST because the gateway binds `127.0.0.1` and nothing else
 * (invariant I6) — it is the literal address of the thing we are looking for.
 * `localhost` is a fallback for a gateway reached by name and will rarely fire:
 * on Windows it may resolve to `::1` under dual-stack resolution, which a gateway
 * bound to IPv4 loopback refuses. That is exactly why it must not be probed first.
 */
export const DISCOVERY_CANDIDATES: readonly string[] = Object.freeze([
  "http://127.0.0.1:7474",
  "http://localhost:7474",
]);

export interface ProbeResult {
  readonly origin: string;
  readonly reachable: boolean;
}

/**
 * The first reachable origin, or null when none answered.
 *
 * Null is not a failure state — it means "ask the user", and the manual URL field
 * does not go away just because discovery exists.
 */
export function pickReachable(results: readonly ProbeResult[]): string | null {
  return results.find((r) => r.reachable)?.origin ?? null;
}
