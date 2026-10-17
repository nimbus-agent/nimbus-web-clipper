import type { PaletteInit } from "../shared/panel-host.ts";
import { recognise } from "../shared/recognise/index.ts";
import type { ConfiguredOrigin, ToastState } from "../shared/types.ts";
import { isRestrictedUrl } from "./capture-tab.ts";

export interface OpenPaletteDeps {
  readonly activeTab: () => Promise<{ id: number; url: string; title: string }>;
  readonly getOrigins: () => Promise<readonly ConfiguredOrigin[]>;
  readonly showPalette: (tabId: number, init: PaletteInit) => Promise<void>;
  readonly showFeedback: (tabId: number, state: ToastState, restricted: boolean) => Promise<void>;
}

export const CANT_OPEN_PALETTE: ToastState = {
  variant: "error",
  text: "Nimbus can't open on this page.",
};

/**
 * The hotkey's way in. Unlike `openPanel` this is NOT silent: a palette that
 * does not appear on a system page would read as a dead key, so the badge says
 * why. Recognition happens here, in the worker, so the page gets the answer
 * with the overlay rather than asking for it.
 */
export async function openPalette(deps: OpenPaletteDeps): Promise<void> {
  const tab = await deps.activeTab();
  if (isRestrictedUrl(tab.url)) {
    await deps.showFeedback(tab.id, CANT_OPEN_PALETTE, true);
    return;
  }
  // Built-in products recognise without any configured origin.
  const origins = await deps.getOrigins().catch((): readonly ConfiguredOrigin[] => []);
  try {
    await deps.showPalette(tab.id, { recognition: recognise(tab.url, origins) });
  } catch {
    await deps.showFeedback(tab.id, CANT_OPEN_PALETTE, true);
  }
}
