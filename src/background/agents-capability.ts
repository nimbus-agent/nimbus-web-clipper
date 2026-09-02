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
import { AGENT_LANES, type AgentLane, type SurfaceKind } from "../shared/types.ts";
import { isObject, readJson } from "./http-json.ts";

/** A list read over a local index. The same bound the egress reads take. */
const ROSTER_TIMEOUT_MS = 10_000;

/**
 * The published set, or the fact that we could not learn it.
 *
 * `unavailable` is deliberately distinct from `{ names: [] }`. An empty roster
 * would withhold EVERY lane; not knowing must leave the panel exactly as it
 * renders without a roster read at all. That is the same degradation the
 * connector-health gate makes when `GET /v1/connectors` is absent, and for the
 * same reason: a gateway that cannot answer a capability question is not a
 * gateway with no capabilities. What "as it renders without a roster read"
 * means per surface — and why an item surface is not simply unfiltered — is
 * `offeredLanes` below.
 */
export type AgentRoster =
  | { readonly names: readonly string[]; readonly version: string | null }
  | { readonly unavailable: true };

export type RosterDeps = {
  readonly origin: string;
  readonly token: string;
  readonly doFetch: typeof fetch;
};

/** Every entry a string, or the whole answer is untrusted. */
function parseNames(body: Record<string, unknown>): readonly string[] | null {
  const agents = body["agents"];
  if (!Array.isArray(agents)) return null;
  return agents.every((n) => typeof n === "string") ? (agents as readonly string[]) : null;
}

/**
 * The gateway's own version, or the fact that it did not say.
 *
 * `null` is NOT `unavailable`. A gateway that serves the roster but predates the
 * version field has told us the names, and that fact stands on its own — the
 * missing half fails closed at `meetsFloor`, which withholds exactly the lanes
 * that need an arm we cannot confirm, and nothing else.
 */
function parseVersion(body: Record<string, unknown>): string | null {
  const v = body["version"];
  return typeof v === "string" ? v : null;
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
    const body = await readJson(res);
    // Narrow ONCE, here: both parsers read the same body and only one caller
    // should have to ask what shape it is.
    if (!isObject(body)) {
      return { unavailable: true };
    }
    const names = parseNames(body);
    return names === null ? { unavailable: true } : { names, version: parseVersion(body) };
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
 * Upstream Nimbus#1421 landed before the v7.5.0 release, so that is the first
 * release serving the arm. Note the consequence, which is deliberate: 7.5.0 HAS
 * the arm and does not report a version, so it fails closed and is offered no
 * item lanes. The effective floor is the release that added the version field,
 * because a gateway that cannot say what it is has not told us it can answer.
 *
 * As of 2026-09-02 that release does not exist. Upstream `GET /v1/agents`
 * answers `{ agents }` alone — Nimbus#1421 shipped the arm, not the field — so
 * `meetsFloor(null, …)` is false everywhere and these three lanes are withheld
 * on EVERY gateway, a locally built one included: a local build reports no
 * version rather than `0.0.0`, so it fails closed before the development-build
 * allowance in `meetsFloor` can apply. The client is complete and waiting on the
 * field. Do not loosen the floor to make the lanes appear; a lane offered
 * against a gateway that cannot serve its arm is a `-32602` under a header that
 * promised an answer, which is the thing this gate exists to prevent.
 *
 * Do not raise this without a released gateway to point at.
 */
export const ITEM_ARM_FLOOR = "7.5.0";

type Semver = { major: number; minor: number; patch: number };

/**
 * Parse `major.minor.patch`, dropping build metadata and any prerelease tag.
 *
 * Build metadata (`+build.1234`) is stripped FIRST because semver excludes it
 * from precedence entirely, and a naive split would carry it into the patch
 * number. Anything that is not three integers returns null and fails closed.
 *
 * The prerelease tag is dropped rather than recorded. `meetsFloor` below treats
 * a prerelease exactly as it treats the release it is a build of, and that falls
 * out of the numeric comparison on its own — a flag nothing reads would only be
 * a second place for the same rule to be written down and then disagree.
 */
function parseSemver(version: string): Semver | null {
  const core = version.split("+")[0]?.split("-")[0] ?? "";
  const parts = core.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number.parseInt(p, 10) : Number.NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return {
    major: nums[0] ?? 0,
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
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

/**
 * The (lane, surface) pairs whose params are the `itemUrl` arm, and therefore the
 * only ones the version floor gates.
 *
 * This CANNOT be derived from `LANE_RULES`. That table says scope `"item"` for
 * `why` on `pr` and for `why` on `issue` alike — correctly, because both end at
 * one indexed item — but `pr` sends `prUrl`, an arm every released gateway has
 * served, and `issue` sends `itemUrl`, an arm that arrived in 7.5.0. The scope is
 * where the input comes from; this table is which arm carries it. Two questions,
 * two tables, and collapsing them is what would put a floor on lanes that work
 * today.
 */
const ITEM_ARM_LANES: ReadonlySet<AgentLane> = new Set<AgentLane>(["why", "expert", "ownership"]);
const ITEM_ARM_SURFACES: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>(["issue", "incident"]);

/**
 * Does this (lane, surface) pair send the `itemUrl` arm?
 *
 * EXPORTED, and read by two callers that must never disagree: `offeredLanes`
 * below, deciding whether the version floor applies, and `agentParams`
 * (`handlers.ts`), deciding which arm to actually send. They are the same
 * question — "does this pair need an arm the gateway may not have" — and a
 * second copy of the surface list in `agentParams` is how a C7 surface would end
 * up floored in one place and sent the wrong params in the other.
 */
export function needsItemArm(lane: AgentLane, kind: SurfaceKind): boolean {
  return ITEM_ARM_LANES.has(lane) && ITEM_ARM_SURFACES.has(kind);
}

/**
 * Which lanes the PAIRED gateway can actually serve on a page of this kind — or
 * `null` when we did not learn and nothing on this surface depended on learning.
 *
 * The rule this whole module exists to keep is: **not knowing must leave the
 * panel exactly as it renders without a roster read at all.** `null` is how that
 * is said, and every caller must read it as "do not filter", never as "no lanes"
 * — a gateway that cannot answer a capability question is not a gateway with no
 * capabilities. Same fail-open the connector-health gate makes when
 * `GET /v1/connectors` is absent, and for the same reason.
 *
 * A roster we could not read is therefore handled per SURFACE, not globally:
 *
 * - **No lane here needs the item arm** (`pr`, `home`, and every other surface
 *   today) → `null`. Those pages rendered these lanes before any of this existed
 *   and they render byte-identically now; the wire field stays absent.
 * - **Some lane here does** (`issue`, `incident`) → this surface's lanes MINUS
 *   the item-arm ones. Exactly the lanes whose arm we could not confirm are
 *   withheld, and nothing else.
 *
 * The second case is the one an earlier shape got backwards. It returned `null`
 * there too — so a roster that answered without a version withheld the three item
 * lanes, while a roster that did not answer at all offered them. The more ignorant
 * state was the more permissive one, and the population it was most permissive
 * with (a gateway too old to serve `GET /v1/agents`) is precisely the one least
 * likely to serve the arm. Withholding them here does not weaken the rule above,
 * it is what finally makes it true on the new surfaces as well as the old ones:
 * an `issue` or an `incident` with an unreadable roster renders exactly what it
 * rendered before this feature shipped — header, freshness, Related, glossary.
 *
 * Two gates, and they answer different questions. The roster says whether this
 * gateway serves the agent at all. The floor says whether it serves the ARM this
 * surface needs — see `ITEM_ARM_LANES` for why the second cannot be read off
 * `LANE_RULES`.
 *
 * This deliberately does NOT apply `LANE_RULES`: whether a lane belongs on a
 * surface is the panel's question and is already answered by `lanesFor`. Asking it
 * twice, in two places, is how the two answers start to disagree.
 */
export function offeredLanes(roster: AgentRoster, kind: SurfaceKind): readonly AgentLane[] | null {
  if ("unavailable" in roster) {
    if (!AGENT_LANES.some((lane) => needsItemArm(lane, kind))) return null;
    return AGENT_LANES.filter((lane) => !needsItemArm(lane, kind));
  }
  const published = new Set(roster.names);
  return AGENT_LANES.filter(
    (lane) =>
      published.has(lane) &&
      (!needsItemArm(lane, kind) || meetsFloor(roster.version, ITEM_ARM_FLOOR)),
  );
}
