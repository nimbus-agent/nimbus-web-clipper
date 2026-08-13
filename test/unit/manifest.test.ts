import { describe, expect, test } from "vitest";
import { BROWSER_TARGETS, composeManifest, FIREFOX_ADDON_ID } from "../../src/manifest/manifest.ts";

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

  test("optional_host_permissions is declared for both targets and is page-access only", () => {
    for (const target of BROWSER_TARGETS) {
      const m = composeManifest(target, "1.0.0");
      expect(m.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
      // The NETWORK destination is unchanged: loopback only, and never optional.
      expect(m.host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
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

  test("firefox declares no data collection (AMO requires the disclosure)", () => {
    // The `none` keyword = collects/transmits no user data — matches the
    // loopback-only posture. AMO rejects a submission that omits this key.
    const m = composeManifest("firefox", "0.0.1");
    expect(m.browser_specific_settings?.gecko.data_collection_permissions).toEqual({
      required: ["none"],
    });
  });

  test("the two targets differ only in background + gecko settings", () => {
    const chrome = composeManifest("chrome", "9.9.9");
    const firefox = composeManifest("firefox", "9.9.9");
    const { background: _cb, ...chromeRest } = chrome;
    const { background: _fb, browser_specific_settings: _gecko, ...firefoxRest } = firefox;
    expect(chromeRest).toEqual(firefoxRest);
  });

  test("declares the contextMenus permission (for right-click clipping)", () => {
    for (const target of BROWSER_TARGETS) {
      expect(composeManifest(target, "1.2.3").permissions).toContain("contextMenus");
    }
  });

  test("declares clip-page and clip-selection commands with default keys", () => {
    const m = composeManifest("chrome", "1.2.3");
    expect(m.commands["clip-page"]?.suggested_key.default).toBe("Alt+Shift+C");
    expect(m.commands["clip-selection"]?.suggested_key.default).toBe("Alt+Shift+S");
  });
});

describe("composeManifest — commands", () => {
  for (const target of ["chrome", "firefox"] as const) {
    test(`${target} declares the show_related command with a suggested key`, () => {
      const m = composeManifest(target, "1.2.3");
      expect(m.commands.show_related.suggested_key.default).toBe("Alt+Shift+R");
      expect(m.commands.show_related.description.length).toBeGreaterThan(0);
    });
  }
});

describe("composeManifest — alarms permission", () => {
  for (const target of BROWSER_TARGETS) {
    test(`${target} declares the alarms permission (for the offline-queue flush)`, () => {
      expect(composeManifest(target, "1.2.3").permissions).toContain("alarms");
    });
  }
});

test("ambient surfacing adds no permission — it rides the existing optional grants", () => {
  const m = composeManifest("chrome", "1.0.0");
  expect(m.permissions).toEqual(["activeTab", "scripting", "storage", "alarms", "contextMenus"]);
  expect(m.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
  expect(m.host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
});
