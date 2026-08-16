// test/unit/origin-store.test.ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getOrigins, setOrigins } from "../../src/background/origin-store.ts";
import type { ConfiguredOrigin } from "../../src/shared/types.ts";
import { type ChromeHarness, installChromeMock } from "./helpers/chrome-mock.ts";

let harness: ChromeHarness;

beforeEach(() => {
  harness = installChromeMock();
});

afterEach(() => {
  harness.restore();
});

const jira: ConfiguredOrigin = { origin: "https://corp.example/jira", product: "jira" };

describe("origin store", () => {
  test("an empty store reads as an empty list", async () => {
    await expect(getOrigins()).resolves.toEqual([]);
  });
  test("round-trips a list", async () => {
    await setOrigins([jira]);
    await expect(getOrigins()).resolves.toEqual([jira]);
  });
  test("drops entries that fail the guard rather than trusting storage", async () => {
    harness.storage.set("origins", [jira, { origin: "https://x", product: "svn" }, 42]);
    await expect(getOrigins()).resolves.toEqual([jira]);
  });
  test("a non-array value reads as an empty list", async () => {
    harness.storage.set("origins", { nope: true });
    await expect(getOrigins()).resolves.toEqual([]);
  });
});
