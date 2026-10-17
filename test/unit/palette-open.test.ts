import { describe, expect, test, vi } from "vitest";
import {
  CANT_OPEN_PALETTE,
  type OpenPaletteDeps,
  openPalette,
} from "../../src/background/palette-open.ts";
import { recognise } from "../../src/shared/recognise/index.ts";

const PR = "https://github.com/acme/web/pull/482";

function deps(over: Partial<OpenPaletteDeps> = {}): OpenPaletteDeps {
  return {
    activeTab: async () => ({ id: 7, url: PR, title: "PR" }),
    getOrigins: async () => [],
    showPalette: vi.fn(async () => undefined),
    showFeedback: vi.fn(async () => undefined),
    ...over,
  };
}

describe("openPalette", () => {
  test("a restricted page flashes the badge and injects nothing", async () => {
    const d = deps({ activeTab: async () => ({ id: 3, url: "chrome://extensions/", title: "" }) });
    await openPalette(d);
    expect(d.showFeedback).toHaveBeenCalledWith(3, CANT_OPEN_PALETTE, true);
    expect(d.showPalette).not.toHaveBeenCalled();
  });

  test("a normal page gets the palette with its recognition", async () => {
    const d = deps();
    await openPalette(d);
    expect(d.showPalette).toHaveBeenCalledWith(7, { recognition: recognise(PR, []) });
    expect(d.showFeedback).not.toHaveBeenCalled();
  });

  test("an inject rejection flashes the badge", async () => {
    const d = deps({
      showPalette: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    await openPalette(d);
    expect(d.showFeedback).toHaveBeenCalledWith(7, CANT_OPEN_PALETTE, true);
  });

  test("a getOrigins rejection still opens on a built-in host", async () => {
    const d = deps({
      getOrigins: async () => {
        throw new Error("storage");
      },
    });
    await openPalette(d);
    expect(d.showPalette).toHaveBeenCalledWith(7, { recognition: recognise(PR, []) });
  });

  test("copy", () => {
    expect(CANT_OPEN_PALETTE).toEqual({
      variant: "error",
      text: "Nimbus can't open on this page.",
    });
  });
});
