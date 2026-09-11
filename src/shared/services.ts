// The service-binding model: which Nimbus service a repo-level scope belongs to.
//
// A Nimbus SERVICE is a `[metrics.dora.<id>]` block in the gateway's own config.
// It is NOT `PRODUCT_SERVICE_ID`'s connector id ("github", "jenkins") — a
// different axis entirely, and the one the agent lanes use. The gateway holds
// the reverse map internally but exposes no route over it, so the user binds it
// here, once per scope.
import { isProduct } from "./origins.ts";
import type { Product } from "./types.ts";

/** The gateway's own bound on `service` (preflight-rpc.ts: MAX_SERVICE_LEN). */
export const MAX_SERVICE_ID_LEN = 64;
/** The gateway's own bound on `target_ref` (preflight-rpc.ts: MAX_TARGET_REF_LEN). */
export const MAX_BRANCH_LEN = 255;
/**
 * Our own bound on `scope` — the gateway has none, because `scope` never
 * crosses the wire (§3.1). It still has to be bounded HERE: this is the one
 * field a page-supplied message can carry into `chrome.storage.local`, which is
 * a quota shared with the clip queue and the connection record, so an unbounded
 * value is a way for a hostile page to evict either.
 *
 * 255 is the ceiling of the coordinate shapes this key is made of, not a round
 * number: GitHub's `owner/repo` cannot exceed 140 (39 + 1 + 100), GitLab bounds
 * its full nested-group path at 255, and a Jenkins job path is a path of job
 * names on the same order. A scope is a repo coordinate or a job path — never
 * free text — so anything longer is not a scope that could ever match a
 * recognised page.
 */
export const MAX_SCOPE_LEN = 255;

export interface ServiceBinding {
  readonly product: Product;
  /**
   * The matched `ConfiguredOrigin.origin` (`Recognition.origin`) — scheme + host
   * [+ port] plus any path prefix. REQUIRED here, unlike on `Recognition`: a
   * stored binding with no origin is exactly the ambiguity this field exists to
   * remove. Two self-hosted instances of one product (two Jenkins, two
   * Bitbucket Servers) are a supported configuration (`upsertOrigin` dedupes by
   * origin, not by product) and would otherwise share one binding, so a verdict
   * bound on one instance would silently answer for the other. Never sent to
   * the gateway — like `scope`, it is a local key only.
   */
  readonly origin: string;
  /** The registry-supplied repo-level key (`Recognition.scope`). Never sent to
   *  the gateway — it is a local key only. */
  readonly scope: string;
  /** The Nimbus `[metrics.dora.<id>]` id. This is what crosses the wire. */
  readonly serviceId: string;
  /** `target_ref` fallback when the page resolves to no item, or to one carrying
   *  no branch. */
  readonly defaultBranch?: string;
}

/**
 * Stored data is external input: filter through this, never cast.
 *
 * `serviceId` is bounded HERE rather than at the input, so a binding restored
 * from storage is checked by the same rule as one typed today — a value that
 * cannot be sent must never be readable back as if it could. `scope` is bounded
 * for the storage-quota reason on `MAX_SCOPE_LEN`, and `defaultBranch` by the
 * route's own limit.
 *
 * This is a CHECK, not a normaliser: it accepts extra properties, because a
 * `Record<string, unknown>` narrows on the keys it tests and nothing more. A
 * caller that persists external input must therefore reconstruct the object
 * from the fields it wants (see `handleServiceBind`) rather than storing what
 * it was handed.
 */
export function isServiceBinding(v: unknown): v is ServiceBinding {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const rec = v as Record<string, unknown>;
  const origin = rec["origin"];
  const serviceId = rec["serviceId"];
  const scope = rec["scope"];
  const branch = rec["defaultBranch"];
  return (
    isProduct(rec["product"]) &&
    // Bounded the same way as `scope` and for the same reason: `origin` never
    // crosses the wire either, but it does cross into `chrome.storage.local`, a
    // quota shared with the clip queue and the connection record. `MAX_SCOPE_LEN`
    // is reused rather than a second constant because both fields are bounded
    // for the identical storage-quota reason, not by any gateway-side limit.
    typeof origin === "string" &&
    origin !== "" &&
    origin.length <= MAX_SCOPE_LEN &&
    typeof scope === "string" &&
    scope !== "" &&
    scope.length <= MAX_SCOPE_LEN &&
    typeof serviceId === "string" &&
    serviceId.length >= 1 &&
    serviceId.length <= MAX_SERVICE_ID_LEN &&
    // ABSENT or a sendable branch — never the empty string. `"" ?? "HEAD"` is
    // `""`, so an empty value here would slip past the handler's fallback and
    // fail the route's lower bound on every request.
    (branch === undefined ||
      (typeof branch === "string" && branch.length >= 1 && branch.length <= MAX_BRANCH_LEN))
  );
}

/**
 * Keyed by `(origin, product, scope)`, not `(product, scope)` alone — see
 * `ServiceBinding.origin`'s doc comment for why the origin has to be part of
 * the identity: two self-hosted instances of one product are a supported
 * configuration, and without the origin their bindings would collide.
 */
export function bindingKey(origin: string, product: Product, scope: string): string {
  return `${origin}:${product}:${scope}`;
}

export function findBinding(
  list: readonly ServiceBinding[],
  origin: string,
  product: Product,
  scope: string,
): ServiceBinding | null {
  const key = bindingKey(origin, product, scope);
  return list.find((x) => bindingKey(x.origin, x.product, x.scope) === key) ?? null;
}

export function upsertBinding(
  list: readonly ServiceBinding[],
  entry: ServiceBinding,
): ServiceBinding[] {
  const key = bindingKey(entry.origin, entry.product, entry.scope);
  return [...list.filter((x) => bindingKey(x.origin, x.product, x.scope) !== key), entry];
}

export function removeBinding(
  list: readonly ServiceBinding[],
  origin: string,
  product: Product,
  scope: string,
): ServiceBinding[] {
  const key = bindingKey(origin, product, scope);
  return list.filter((x) => bindingKey(x.origin, x.product, x.scope) !== key);
}

/**
 * A seed for the bind input, never an answer.
 *
 * The last segment is right often enough on a forge scope to save typing, and
 * wrong often enough on a Jenkins job path that the field stays editable. It is
 * truncated to the route's bound so the guess is always sendable.
 */
export function guessServiceId(scope: string): string {
  const last = scope.slice(scope.lastIndexOf("/") + 1);
  return last.slice(0, MAX_SERVICE_ID_LEN);
}
