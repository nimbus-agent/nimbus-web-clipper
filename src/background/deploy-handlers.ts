// The deploy-readiness handlers (C10): pure decision logic with injected deps,
// exactly like handlers.ts. Nothing here touches chrome.* directly.

import { isUnknownService } from "../shared/deploy.ts";
import type {
  BindingCheckStatus,
  DeployPreflightRequest,
  DeployPreflightResponse,
  ServiceBindingsCheckResponse,
  ServiceBindingsListResponse,
  ServiceBindRequest,
  ServiceBindResponse,
  ServiceResolutionOutcome,
  ServiceUnbindRequest,
} from "../shared/messages.ts";
import { findBinding, guessServiceId, repoUrn, type ServiceBinding } from "../shared/services.ts";
import type { Connection, Product } from "../shared/types.ts";
import { fetchItemBranch, fetchPreflight, type fetchServiceResolution } from "./deploy-client.ts";

export interface DeployDeps {
  /**
   * The whole pairing record, not just its origin. Two of these routes are
   * public and need only an address, but `resolveService` is a BEARER read and
   * a 403 needs the device LABEL as well — `scopeCommand` cannot build a
   * pasteable `nimbus clip scopes <label> --set …` without it, and the 403 body
   * cannot carry it because the label is client-side state.
   *
   * A superset of the `getOrigin` this replaced, not a second dependency: that
   * field's own comment said the address is learned from the pairing, so every
   * caller that had an origin already had a connection.
   */
  readonly getConnection: () => Promise<Connection | null>;
  readonly getBindings: () => Promise<ServiceBinding[]>;
  readonly putBinding: (entry: ServiceBinding) => Promise<void>;
  readonly dropBinding: (origin: string, product: Product, scope: string) => Promise<void>;
  /** Injected so the handler's five outcomes are testable without a fetch stub
   *  per case — the same shape `EgressDeps` uses. */
  readonly resolveService: typeof fetchServiceResolution;
  readonly doFetch: typeof fetch;
}

/**
 * Widen the gateway's raw two-field gap into the `ScopeGap` the views need.
 *
 * Copied from `egress-handlers.ts` rather than imported — same behaviour,
 * unchanged. See that file's `withLabel` for the rationale: the device label is
 * client-side state, so the handler is what adds it, because the 403 body
 * cannot carry it.
 */
function withLabel(
  label: string,
  gap: { required: string; granted: string[] } | undefined,
): { label: string; required: string; granted: string[] } | undefined {
  return gap === undefined ? undefined : { label, ...gap };
}

/**
 * Ask the gateway which service claims this page's repo, as structure.
 *
 * Never throws and never blocks the refusal it decorates: every failure is an
 * outcome, because the `unbound` answer is correct with or without it — the
 * resolution only decides how good the seed is.
 */
async function resolutionFor(
  req: DeployPreflightRequest,
  conn: Connection,
  deps: DeployDeps,
): Promise<ServiceResolutionOutcome> {
  const urn = repoUrn(req.product, req.scope);
  if (urn === null) {
    // A product with no URN provider, or a scope that could never be sent.
    // Asking would be a guaranteed 400; say nothing and keep the guess.
    return { kind: "silent" };
  }
  const res = await deps.resolveService(conn.origin, conn.token, urn, deps.doFetch);
  if (!res.ok) {
    if (res.reason === "insufficient_scope") {
      const gap = withLabel(conn.label, res.scopeGap);
      return gap === undefined ? { kind: "forbidden" } : { kind: "forbidden", scopeGap: gap };
    }
    return { kind: "silent" };
  }
  const { service, candidates } = res.value;
  if (service === null) {
    return { kind: "unclaimed" };
  }
  // Seeded from `service`, NOT `candidates[0]` — design §2.1. The gateway
  // already picked; the client does not re-derive the pick.
  return candidates.length > 1
    ? { kind: "ambiguous", serviceId: service, candidates }
    : { kind: "resolved", serviceId: service };
}

/**
 * §4.3's ladder: the resolved item's branch, then the binding's defaultBranch,
 * then nothing.
 *
 * "Nothing" is NOT a failure. Only `failing_ci_runs` is ref-scoped; incidents
 * and merge conflicts are service-wide and answer regardless, so an absent ref
 * costs one check of three. The empty string is never sent — the route's lower
 * bound is 1 — so the fallback is a literal "HEAD", which matches no branch and
 * therefore reports the CI check as finding nothing rather than erroring.
 */
async function targetRefFor(
  req: DeployPreflightRequest,
  binding: ServiceBinding,
  origin: string,
  deps: DeployDeps,
): Promise<string> {
  if (req.targetRef !== undefined && req.targetRef !== "") {
    return req.targetRef;
  }
  // Rung 1: the item the PANEL resolved. The worker cannot resolve the page
  // here, so this arrives on the request or not at all.
  if (req.itemId !== undefined && req.itemId !== "") {
    const branch = await fetchItemBranch(origin, req.itemId, deps.doFetch);
    // A failed item read is not a failed answer — fall through to the binding.
    if (branch.ok && branch.value !== null && branch.value !== "") {
      return branch.value;
    }
  }
  // `?? "HEAD"` alone would be wrong: `"" ?? "HEAD"` is `""`. The guard already
  // rejects an empty stored branch; this is the second lock on the same door.
  const fallback = binding.defaultBranch?.trim();
  return fallback === undefined || fallback === "" ? "HEAD" : fallback;
}

export async function handleDeployPreflight(
  req: DeployPreflightRequest,
  deps: DeployDeps,
): Promise<DeployPreflightResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "deploy-preflight", ok: false, reason: "unreachable" };
  }
  const binding = findBinding(await deps.getBindings(), req.origin, req.product, req.scope);
  if (binding === null) {
    return {
      kind: "deploy-preflight",
      ok: false,
      reason: "unbound",
      guessServiceId: guessServiceId(req.scope),
      resolution: await resolutionFor(req, conn, deps),
    };
  }
  const targetRef = await targetRefFor(req, binding, conn.origin, deps);
  const res = await fetchPreflight(conn.origin, binding.serviceId, targetRef, deps.doFetch);
  if (!res.ok) {
    return { kind: "deploy-preflight", ok: false, reason: res.reason };
  }
  return {
    kind: "deploy-preflight",
    ok: true,
    serviceId: binding.serviceId,
    preflight: res.value,
  };
}

/**
 * Bind by ASKING. There is no route that lists services, and none is needed:
 * an id the gateway does not know comes back as a normal envelope reporting
 * `unknown_service` on every check.
 *
 * A binding is never saved unverified. An unreachable gateway refuses rather
 * than storing something that may be wrong — the user can retry, and a stored
 * wrong id produces a permanently confusing section.
 *
 * What is persisted is RECONSTRUCTED from the five fields, never `req.binding`
 * itself. `isServiceBinding` is a shape check and accepts extra properties, so
 * storing the request's object would let a page-supplied message write arbitrary
 * keys into `chrome.storage.local` — a quota shared with the clip queue and the
 * connection record. The guard bounds what it reads; this bounds what we keep.
 */
export async function handleServiceBind(
  req: ServiceBindRequest,
  deps: DeployDeps,
): Promise<ServiceBindResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "service-bind", ok: false, reason: "unreachable" };
  }
  const { product, scope, serviceId, defaultBranch, origin: bindingOrigin } = req.binding;
  const probe = await fetchPreflight(conn.origin, serviceId, defaultBranch ?? "HEAD", deps.doFetch);
  if (!probe.ok) {
    return { kind: "service-bind", ok: false, reason: probe.reason };
  }
  if (isUnknownService(probe.value)) {
    return { kind: "service-bind", ok: false, reason: "unknown_service" };
  }
  await deps.putBinding({
    product,
    origin: bindingOrigin,
    scope,
    serviceId,
    // `exactOptionalPropertyTypes` is on: an explicit `defaultBranch: undefined`
    // is not the same type as an absent key, and only the absent one round-trips
    // through JSON storage as the guard expects.
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
  });
  return { kind: "service-bind", ok: true };
}

export async function handleServiceUnbind(
  req: ServiceUnbindRequest,
  deps: DeployDeps,
): Promise<ServiceBindResponse> {
  await deps.dropBinding(req.origin, req.product, req.scope);
  return { kind: "service-bind", ok: true };
}

export async function handleServiceBindingsList(
  deps: DeployDeps,
): Promise<ServiceBindingsListResponse> {
  return { kind: "service-bindings-list", ok: true, bindings: await deps.getBindings() };
}

/**
 * Check every stored binding against the gateway's current config.
 *
 * `Promise.allSettled`, never `Promise.all`: one unreachable or rate-limited
 * binding must not discard four good answers. A rejected promise becomes an
 * `unchecked` row rather than a failed check — the same rule the panel follows,
 * one surface up.
 *
 * FAN-OUT IS UNBOUNDED, deliberately for now (design §7.2): the destination is
 * loopback, this route is an unthrottled read, and bindings are created by hand
 * one page at a time. The fact that argues the other way is recorded there —
 * upstream re-reads and re-parses `nimbus.toml` on every call, uncached on
 * purpose — so if a user with tens of bindings reports a slow check, a small
 * pool here is the fix.
 */
export async function handleServiceBindingsCheck(
  deps: DeployDeps,
): Promise<ServiceBindingsCheckResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "service-bindings-check", ok: false, reason: "not_paired" };
  }
  const bindings = await deps.getBindings();
  const settled = await Promise.allSettled(
    bindings.map(async (binding): Promise<BindingCheckStatus> => {
      const urn = repoUrn(binding.product, binding.scope);
      if (urn === null) {
        return { state: "unchecked", reason: "unsupported" };
      }
      const res = await deps.resolveService(conn.origin, conn.token, urn, deps.doFetch);
      if (!res.ok) {
        return { state: "unchecked", reason: res.reason };
      }
      const { service, candidates } = res.value;
      if (service === null) {
        return { state: "unclaimed" };
      }
      if (candidates.length > 1) {
        return { state: "ambiguous", candidates };
      }
      return service === binding.serviceId
        ? { state: "agrees" }
        : { state: "disagrees", proposedServiceId: service };
    }),
  );
  const rows = bindings.map((binding, i) => {
    const outcome = settled[i];
    return {
      binding,
      status:
        outcome?.status === "fulfilled"
          ? outcome.value
          : ({ state: "unchecked", reason: "server_error" } as const),
    };
  });
  return { kind: "service-bindings-check", ok: true, rows };
}
