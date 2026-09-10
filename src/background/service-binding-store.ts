// Persistence for the user's service bindings (C10).
//
// Carries no secret and is READ directly from the Options page and the DORA
// page — chrome.storage.local is shared across extension contexts.
//
// WRITES ARE DIFFERENT, and this is the part that must not be "simplified" into
// origin-store.ts's shape. That store is safe with a bare read-modify-write
// because `setOrigins` has exactly ONE caller (options.ts). This store has two
// would-be writers — the panel's inline bind and the Options table — so a bare
// cycle is a lost update.
//
// `createWriteChain` alone does NOT fix that: it is an in-memory lock scoped to
// ONE JS context, so a chain held here would serialise the worker against
// itself while the Options page overwrote it regardless. The lock only means
// something because the worker is the SOLE writer and Options mutates by
// message (service-worker.ts). Keep both halves or neither.
import { storageGet, storageSet } from "../browser/storage.ts";
import type { ServiceBinding } from "../shared/services.ts";
import { isServiceBinding, removeBinding, upsertBinding } from "../shared/services.ts";
import type { Product } from "../shared/types.ts";
import { createWriteChain } from "./keyed-store.ts";

const BINDINGS_KEY = "serviceBindings";

const exclusively = createWriteChain();

/** Stored data is external input: filter through the guard, never cast. */
export async function getBindings(): Promise<ServiceBinding[]> {
  const value = await storageGet(BINDINGS_KEY);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isServiceBinding);
}

export function putBinding(entry: ServiceBinding): Promise<void> {
  return exclusively(async () => {
    await storageSet(BINDINGS_KEY, upsertBinding(await getBindings(), entry));
  });
}

export function dropBinding(product: Product, scope: string): Promise<void> {
  return exclusively(async () => {
    await storageSet(BINDINGS_KEY, removeBinding(await getBindings(), product, scope));
  });
}
