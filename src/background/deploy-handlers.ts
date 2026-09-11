// The deploy-readiness handlers (C10): pure decision logic with injected deps,
// exactly like handlers.ts. Nothing here touches chrome.* directly.

import { isUnknownService } from "../shared/deploy.ts";
import type {
  DeployPreflightRequest,
  DeployPreflightResponse,
  ServiceBindingsListResponse,
  ServiceBindRequest,
  ServiceBindResponse,
  ServiceUnbindRequest,
} from "../shared/messages.ts";
import type { ServiceBinding } from "../shared/services.ts";
import { findBinding, guessServiceId } from "../shared/services.ts";
import type { Product } from "../shared/types.ts";
import { fetchItemBranch, fetchPreflight } from "./deploy-client.ts";

export interface DeployDeps {
  /** The paired gateway origin, or null when nothing is paired. These routes need
   *  no token, but they still need an address, and the pairing is where we learn
   *  one. */
  readonly getOrigin: () => Promise<string | null>;
  readonly getBindings: () => Promise<ServiceBinding[]>;
  readonly putBinding: (entry: ServiceBinding) => Promise<void>;
  readonly dropBinding: (origin: string, product: Product, scope: string) => Promise<void>;
  readonly doFetch: typeof fetch;
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
  const origin = await deps.getOrigin();
  if (origin === null) {
    return { kind: "deploy-preflight", ok: false, reason: "unreachable" };
  }
  const binding = findBinding(await deps.getBindings(), req.origin, req.product, req.scope);
  if (binding === null) {
    return {
      kind: "deploy-preflight",
      ok: false,
      reason: "unbound",
      guessServiceId: guessServiceId(req.scope),
    };
  }
  const targetRef = await targetRefFor(req, binding, origin, deps);
  const res = await fetchPreflight(origin, binding.serviceId, targetRef, deps.doFetch);
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
  const origin = await deps.getOrigin();
  if (origin === null) {
    return { kind: "service-bind", ok: false, reason: "unreachable" };
  }
  const { product, scope, serviceId, defaultBranch, origin: bindingOrigin } = req.binding;
  const probe = await fetchPreflight(origin, serviceId, defaultBranch ?? "HEAD", deps.doFetch);
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
