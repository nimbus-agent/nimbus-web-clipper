import { describe, expect, test } from "vitest";
import {
  BROWSER_TARGETS,
  composeManifest,
  FIREFOX_ADDON_ID,
} from "../../src/manifest/manifest.ts";

describe("composeManifest", () => {
  test("both targets share the locked core (MV3, name, loopback-only hosts)", () => {
    for (const target of BROWSER_TARGETS) {
      const m = composeManifest(target, "1.2.3");
      expect(m.manifest_version).toBe(3);
      expect(m.name).toBe("Nimbus Web Clipper");
      expect(m.version).toBe("1.2.3");
      // Loopback only — the extension never talks to a remote origin (I6).
      expect(m.host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
      expect(m.permissions).not.toContain("<all_urls>");
    }
  });

  test("chrome uses a service worker and no gecko settings", () => {
    const m = composeManifest("chrome", "0.0.1");
    expect(m.background).toEqual({ service_worker: "background.js" });
    expect(m.browser_specific_settings).toBeUndefined();
  });

  test("firefox uses a background scripts array and carries the gecko id", () => {
    const m = composeManifest("firefox", "0.0.1");
    expect(m.background).toEqual({ scripts: ["background.js"] });
    expect(m.browser_specific_settings?.gecko.id).toBe(FIREFOX_ADDON_ID);
  });

  test("the two targets differ only in background + gecko settings", () => {
    const chrome = composeManifest("chrome", "9.9.9");
    const firefox = composeManifest("firefox", "9.9.9");
    const { background: _cb, ...chromeRest } = chrome;
    const { background: _fb, browser_specific_settings: _gecko, ...firefoxRest } = firefox;
    expect(chromeRest).toEqual(firefoxRest);
  });
});
