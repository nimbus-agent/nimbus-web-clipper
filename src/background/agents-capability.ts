// src/background/agents-capability.ts
// What the PAIRED gateway can actually do, rather than what this build assumes.
//
// `AGENT_LANES` is a hardcoded list. It has always been an assertion about a
// gateway the user might not be running: an older one 404s the agent route, and
// the panel finds out by rendering a lane that then fails. `GET /v1/agents`
// publishes the invokable set, so the lane list can reflect the gateway in front
// of it instead.
//
// Reading the roster is NOT sufficient on its own, and the version floor below
// is why — see `meetsFloor`.

import { endpointUrl, isLoopbackOrigin } from "../shared/gateway.ts";
import { isObject, readJson } from "./http-json.ts";

/** A list read over a local index. The same bound the egress reads take. */
const ROSTER_TIMEOUT_MS = 10_000;

/**
 * The published set, or the fact that we could not learn it.
 *
 * `unavailable` is deliberately distinct from `{ names: [] }`. An empty roster
 * would withhold EVERY lane; not knowing must leave the panel exactly as it
 * renders today. That is the same degradation the connector-health gate makes
 * when `GET /v1/connectors` is absent, and for the same reason: a gateway that
 * cannot answer a capability question is not a gateway with no capabilities.
 */
export type AgentRoster = { readonly names: readonly string[] } | { readonly unavailable: true };

export type RosterDeps = {
  readonly origin: string;
  readonly token: string;
  readonly doFetch: typeof fetch;
};

/** Every entry a string, or the whole answer is untrusted. */
function parseNames(body: unknown): readonly string[] | null {
  if (!isObject(body)) return null;
  const agents = body["agents"];
  if (!Array.isArray(agents)) return null;
  return agents.every((n) => typeof n === "string") ? (agents as readonly string[]) : null;
}

export async function fetchAgentRoster(deps: RosterDeps): Promise<AgentRoster> {
  // Defence in depth, not a fix for a live path. Every caller passes the origin from
  // the connection store, which `handlePair` already validated before storing — and
  // `egress-client.ts` and `brief-client.ts` rely on exactly that and re-check nothing.
  // This request carries the bearer token, which is the extension's ONE secret, and
  // "loopback only" is a non-negotiable rather than a property to infer from a caller.
  // Three lines here mean the module cannot leak it even if called wrongly.
  if (!isLoopbackOrigin(deps.origin)) {
    return { unavailable: true };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROSTER_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await deps.doFetch(endpointUrl(deps.origin, "agents"), {
        method: "GET",
        headers: { authorization: `Bearer ${deps.token}` },
        signal: controller.signal,
      });
    } catch {
      return { unavailable: true };
    }
    if (res.status !== 200) {
      // 404 is a gateway older than the route; 401/403 is a token question the
      // lanes themselves will report far more precisely than a roster read can.
      // Every one of them means the same thing HERE: we did not learn the set.
      return { unavailable: true };
    }
    const names = parseNames(await readJson(res));
    return names === null ? { unavailable: true } : { names };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The gateway release that first served the `itemUrl` arm of `why`, `expert` and
 * `ownership`.
 *
 * A floor is necessary because `GET /v1/agents` lists agent NAMES, not their
 * param arms — every one of those three agents has been published for releases,
 * so the roster cannot tell us whether this gateway accepts an item URL. The
 * alternative is to try the call and hide the lane after a `-32602`, which costs
 * a request, an egress row and a visibly failing lane to learn something a
 * version string already says.
 *
 * Do not raise this without a released gateway to point at.
 */
export const ITEM_ARM_FLOOR = "2.19.0";

type Semver = { major: number; minor: number; patch: number; prerelease: boolean };

/**
 * Parse `major.minor.patch`, dropping build metadata and noting a prerelease.
 *
 * Build metadata (`+build.1234`) is stripped FIRST because semver excludes it
 * from precedence entirely, and a naive split would carry it into the patch
 * number. Anything that is not three integers returns null and fails closed.
 */
function parseSemver(version: string): Semver | null {
  const withoutBuild = version.split("+")[0] ?? "";
  const [core, ...pre] = withoutBuild.split("-");
  const parts = (core ?? "").split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number.parseInt(p, 10) : Number.NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return {
    major: nums[0] ?? 0,
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
    prerelease: pre.length > 0,
  };
}

/**
 * Does this gateway meet the floor?
 *
 * A DEVELOPMENT build satisfies any floor. A gateway built from a branch reports
 * `0.0.0` or `0.0.0-dev`, and a plain `>=` would put every such build below any
 * released floor — turning these lanes off for exactly the people building them,
 * and in the e2e job that exists to prove they work.
 *
 * That is the right default for a loopback-only client: the gateway on
 * 127.0.0.1 is the user's own build, and being wrong about it costs a `-32602`
 * the panel already renders — not a leak, and not a request to anyone else.
 *
 * An unparseable or absent version fails CLOSED: not knowing is not permission.
 */
export function meetsFloor(version: string | null, floor: string): boolean {
  if (version === null) return false;
  const got = parseSemver(version);
  const want = parseSemver(floor);
  if (got === null || want === null) return false;

  // `0.0.0` is not a release anyone cut; it is what an unversioned local build
  // reports. Prereleases OF the floor or later are development too.
  if (got.major === 0 && got.minor === 0 && got.patch === 0) return true;

  if (got.major !== want.major) return got.major > want.major;
  if (got.minor !== want.minor) return got.minor > want.minor;
  if (got.patch !== want.patch) return got.patch > want.patch;
  // Exactly the floor: a prerelease of it counts, since it is a build of the
  // release that carries the arm.
  return true;
}
