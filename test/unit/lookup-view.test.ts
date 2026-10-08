// test/unit/lookup-view.test.ts
import { describe, expect, test } from "vitest";
import { lookupLine } from "../../src/popup/lookup-view.ts";

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

describe("lookupLine", () => {
  test("a clip says when you clipped it", () => {
    expect(
      lookupLine({ kind: "clip-lookup", state: "clipped", modifiedAt: NOW - 3 * DAY }, NOW),
    ).toBe("You clipped this 3 days ago.");
    expect(lookupLine({ kind: "clip-lookup", state: "clipped", modifiedAt: NOW }, NOW)).toBe(
      "You clipped this just now.",
    );
  });

  test("a connector item names its product when the registry knows it", () => {
    expect(
      lookupLine(
        { kind: "clip-lookup", state: "indexed", service: "github", modifiedAt: NOW - 2 * DAY },
        NOW,
      ),
    ).toBe("Already in Nimbus from GitHub, updated 2 days ago.");
  });

  test("an unknown service is not given a made-up name", () => {
    expect(
      lookupLine(
        { kind: "clip-lookup", state: "indexed", service: "gmail", modifiedAt: NOW - DAY },
        NOW,
      ),
    ).toBe("Already in Nimbus, updated 1 day ago.");
  });

  test("nothing to say is no line", () => {
    expect(lookupLine({ kind: "clip-lookup", state: "none" }, NOW)).toBeNull();
  });
});
