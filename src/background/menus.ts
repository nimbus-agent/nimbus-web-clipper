// Every context-menu entry, its registration, and the id→action mapping.
//
// Lifted out of service-worker.ts, which is the largest file in the repo and was
// carrying this alongside message routing, alarms and the ambient cue. The menu
// is now one thing in one place, and adding an entry is a table edit plus a
// `menuAction` arm rather than a change inside the router.
import type { MenuItem } from "../browser/context-menus.ts";

export const MENU_CLIP_PAGE = "clip-page";
export const MENU_CLIP_SELECTION = "clip-selection";
export const MENU_SHOW_RELATED = "show-related";

/**
 * Hyphenated ids, deliberately unlike the manifest's `show_related` COMMAND name.
 * They are different namespaces — a menu id and a command name — and making them
 * identical would invite a future reader to route one through the other.
 */
export const MENU_ITEMS: readonly MenuItem[] = Object.freeze([
  { id: MENU_CLIP_PAGE, title: "Clip page to Nimbus", contexts: ["page"] },
  { id: MENU_CLIP_SELECTION, title: "Clip selection to Nimbus", contexts: ["selection"] },
  // The entry this slice exists for: a way into the panel the browser cannot
  // silently withhold, unlike a hotkey the browser may decline to bind.
  { id: MENU_SHOW_RELATED, title: "Show related in Nimbus", contexts: ["page"] },
]);

export type MenuAction = "clip-article" | "clip-selection" | "show-related";

/**
 * The action an id means, or null when the id is not ours.
 *
 * Null rather than a default: the previous routing treated every non-selection id
 * as "clip the page", so any future entry would have silently clipped until
 * someone noticed. An unknown id must do nothing.
 */
export function menuAction(menuItemId: string): MenuAction | null {
  switch (menuItemId) {
    case MENU_CLIP_PAGE:
      return "clip-article";
    case MENU_CLIP_SELECTION:
      return "clip-selection";
    case MENU_SHOW_RELATED:
      return "show-related";
    default:
      return null;
  }
}

export interface RegisterMenusDeps {
  readonly removeAll: () => Promise<void>;
  readonly create: (item: MenuItem) => void;
}

/**
 * Re-register from scratch. `removeAll` first because chrome.contextMenus.create
 * throws on a duplicate id, and a reload or upgrade would otherwise leave one
 * behind. The caller single-flights this — on a fresh install the startup
 * sequence and onInstalled both fire, and interleaved removeAll/create pairs can
 * hit a duplicate id.
 */
export async function registerMenus(deps: RegisterMenusDeps): Promise<void> {
  await deps.removeAll();
  for (const item of MENU_ITEMS) {
    // Each entry registers independently: one failure must not cost the others.
    //
    // This is not defensive noise. `show-related` is LAST in MENU_ITEMS, so a
    // throw while creating either clip entry would take out precisely the entry
    // this slice exists to add — and the caller already swallows
    // (`registerContextMenus().catch(() => undefined)`), so that loss would be
    // silent. Isolating does not make it any quieter; it just stops one bad
    // entry from deleting the rest.
    //
    // Swallowed rather than logged because `noConsole` bans console.* in src/.
    try {
      deps.create(item);
    } catch {
      // Intentionally empty — see above.
    }
  }
}
