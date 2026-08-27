// The ambient cue's whole decision, in one pure module with injected deps.
//
// Pure so the behaviour is testable without a browser: every branch below is a
// row in ambient.test.ts. service-worker.ts supplies the real deps and does the
// injecting; it makes no decisions of its own.
//
// THE RULE THIS MODULE ENFORCES: the cue appears only when there is a real
// answer behind it. Every other path is silence — never an error surface, never
// a cue that leads nowhere. See the design spec's "Error handling".
import type { TabNavigation } from "../browser/tabs.ts";
import type { ResolveResponse } from "../shared/messages.ts";
import { recognise, sameItem } from "../shared/recognise/index.ts";
import type { ConfiguredOrigin, CueState, Recognition } from "../shared/types.ts";
import { isAmbientUrl } from "./ambient-prefs.ts";

/** Why no cue. Exists for the tests; never logged (noConsole applies in src/). */
export type AmbientSkip =
  | "inactive-tab"
  | "not-enabled"
  | "unrecognised"
  | "already-cued"
  | "tab-gone"
  | "navigated"
  | "no-item";

export type AmbientDecision =
  | { readonly kind: "show"; readonly cue: CueState; readonly recognition: Recognition }
  | { readonly kind: "none"; readonly why: AmbientSkip };

export interface AmbientDeps {
  /** Host permission patterns the user switched the cue on for. */
  readonly enabledHosts: () => Promise<string[]>;
  readonly getOrigins: () => Promise<ConfiguredOrigin[]>;
  /** The item last cued in this tab, if any — the per-tab dedupe memory. */
  readonly lastCued: (tabId: number) => Recognition | undefined;
  readonly resolve: (pageUrl: string) => Promise<ResolveResponse>;
  /** The tab's url RIGHT NOW; null when it is gone or invisible to us. */
  readonly currentUrl: (tabId: number) => Promise<string | null>;
}

const NONE = (why: AmbientSkip): AmbientDecision => ({ kind: "none", why });

export async function decideAmbient(
  deps: AmbientDeps,
  nav: TabNavigation,
): Promise<AmbientDecision> {
  // Cheapest gates first, and every one of them ahead of the gateway call: the
  // ordering is the cost model. A background tab or a switched-off host must
  // never reach the network.
  if (!nav.active) {
    return NONE("inactive-tab");
  }
  if (!isAmbientUrl(nav.url, await deps.enabledHosts())) {
    return NONE("not-enabled");
  }
  const origins = await deps.getOrigins();
  const recognition = recognise(nav.url, origins);
  if (!recognition.ok) {
    return NONE("unrecognised");
  }
  const previous = deps.lastCued(nav.tabId);
  if (previous !== undefined && sameItem(previous, recognition)) {
    // Same item, this tab — whether it was clicked, dismissed or ignored. It
    // stays quiet until the tab moves to a DIFFERENT item, which is what
    // `sameItem` (product + kind + ref) measures: a PR's Files sub-tab is the
    // same item as its Conversation sub-tab, and re-cueing on a sub-tab switch
    // is exactly the nagging this rule exists to prevent.
    return NONE("already-cued");
  }

  let response: ResolveResponse;
  try {
    response = await deps.resolve(recognition.resolveUrl);
  } catch {
    // A throw here is the route's own failure (a storage read, a malformed
    // reply). The ambient path treats it like any other non-answer.
    return NONE("no-item");
  }
  if (!response.ok || response.outcome.kind !== "found") {
    // not-indexed, unresolvable, ambiguous, and every ResolveError — all
    // silence. An ambient surface has no standing to report our problems on a
    // page the user is reading; the panel, which they opened, is where errors
    // get spoken.
    return NONE("no-item");
  }

  // The resolve took up to RESOLVE_TIMEOUT_MS. `found` is not on its own
  // permission to mount — re-check the page is still the one we asked about.
  const nowUrl = await deps.currentUrl(nav.tabId);
  if (nowUrl === null) {
    return NONE("tab-gone");
  }
  if (!sameItem(recognise(nowUrl, origins), recognition)) {
    return NONE("navigated");
  }
  // Deliberately NOT re-checked: whether the tab is still active. That test's
  // job is to stop background tabs costing resolves, and it already did it
  // above; re-applying it here would turn "switched tabs for four seconds" into
  // no cue at all, permanently.
  return {
    kind: "show",
    cue: { label: recognition.label, ref: recognition.ref },
    recognition,
  };
}
