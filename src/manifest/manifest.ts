// Single source of truth for the MV3 manifest, composed per browser target.
//
// Chrome and Firefox both speak MV3 but differ in two load-bearing ways:
//   1. Background — Chrome wants a `service_worker`; Firefox (Gecko) wants a
//      `scripts` array (it runs an event page, not a true service worker).
//   2. Firefox requires `browser_specific_settings.gecko.id` to install an
//      unsigned/self-distributed add-on; Chrome rejects that key.
// Everything else is shared. Keeping this in one typed module (rather than two
// hand-maintained JSON files) means the build and the unit tests agree on the
// shape, and a drift between targets is a type error, not a runtime surprise.

export type BrowserTarget = "chrome" | "firefox";

export const BROWSER_TARGETS: readonly BrowserTarget[] = ["chrome", "firefox"];

/** Gecko add-on id — required by Firefox to install a self-distributed MV3 add-on. */
export const FIREFOX_ADDON_ID = "web-clipper@nimbus-agent.dev";

/** Oldest Firefox that ships MV3 + the host-permission posture we rely on. */
export const FIREFOX_MIN_VERSION = "121.0";

interface ManifestAction {
  readonly default_popup: string;
  readonly default_title: string;
}

interface ManifestCommands {
  readonly show_related: {
    readonly suggested_key: { readonly default: string };
    readonly description: string;
  };
}

interface ChromeBackground {
  readonly service_worker: string;
}

interface FirefoxBackground {
  readonly scripts: readonly string[];
}

interface GeckoSettings {
  readonly gecko: {
    readonly id: string;
    readonly strict_min_version: string;
    // AMO requires every add-on to declare its data collection. `none` is the
    // special keyword for "collects/transmits no user data" — the truth here,
    // since the extension only ever talks to the loopback gateway. Older Firefox
    // ignores the key; AMO validation requires it.
    readonly data_collection_permissions: { readonly required: readonly string[] };
  };
}

export interface WebClipperManifest {
  readonly manifest_version: 3;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly permissions: readonly string[];
  readonly host_permissions: readonly string[];
  readonly action: ManifestAction;
  readonly commands: ManifestCommands;
  readonly options_ui: { readonly page: string; readonly open_in_tab: boolean };
  readonly background: ChromeBackground | FirefoxBackground;
  readonly icons: Readonly<Record<string, string>>;
  readonly browser_specific_settings?: GeckoSettings;
}

/**
 * Build the manifest for a target browser.
 * @param version semver written into the manifest (publish stamps it from the git tag).
 */
export function composeManifest(target: BrowserTarget, version: string): WebClipperManifest {
  const base = {
    manifest_version: 3 as const,
    name: "Nimbus Web Clipper",
    version,
    description:
      "Clip articles and selections from the browser into your local-first Nimbus index.",
    // Minimal, capability-scoped: storage holds the paired bearer token; activeTab +
    // scripting let the popup capture the current page on user action (no broad host
    // access); alarms wakes the SW to drain the offline retry queue.
    permissions: ["activeTab", "scripting", "storage", "alarms"],
    // The gateway is loopback-only (invariant I6). The extension never talks to any
    // other origin — no remote host permissions, by design.
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    action: {
      default_popup: "popup.html",
      default_title: "Clip to Nimbus",
    },
    // A separate trigger from the toolbar action (which opens the clip popup): this
    // hotkey injects the related-items panel. Users can rebind it at the browser's
    // extension-shortcuts page. Alt+Shift+R is chosen to avoid Chrome/Firefox defaults.
    commands: {
      show_related: {
        suggested_key: { default: "Alt+Shift+R" },
        description: "Show related items in Nimbus",
      },
    },
    options_ui: {
      page: "options.html",
      open_in_tab: true,
    },
    icons: {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
  };

  if (target === "firefox") {
    return {
      ...base,
      background: { scripts: ["background.js"] },
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_ADDON_ID,
          strict_min_version: FIREFOX_MIN_VERSION,
          data_collection_permissions: { required: ["none"] },
        },
      },
    };
  }

  return {
    ...base,
    background: { service_worker: "background.js" },
  };
}
