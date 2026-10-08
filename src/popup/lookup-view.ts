// src/popup/lookup-view.ts
// The popup's never-clip-twice line (roadmap 1.1). Pure: a lookup reply and a
// clock in, one sentence (or nothing) out.

import { formatAge } from "../shared/freshness.ts";
import type { ClipLookupResponse } from "../shared/messages.ts";
import { PRODUCT_RULES } from "../shared/recognise/registry.ts";

/**
 * The product name for a gateway service id, when the registry knows it.
 *
 * A service the registry does not list (a mail or chat connector, say) gets no
 * name rather than its raw id: "from gmail" would read as a typo, and the
 * sentence is still true without it.
 */
function productNameFor(service: string): string | null {
  return PRODUCT_RULES.find((rule) => rule.serviceId === service)?.name ?? null;
}

export function lookupLine(res: ClipLookupResponse, nowMs: number): string | null {
  if (res.state === "none") return null;
  const age = formatAge(res.modifiedAt, nowMs);
  if (res.state === "clipped") return `You clipped this ${age}.`;
  const name = productNameFor(res.service);
  return name === null
    ? `Already in Nimbus, updated ${age}.`
    : `Already in Nimbus from ${name}, updated ${age}.`;
}
