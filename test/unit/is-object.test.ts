import { describe, expect, it } from "vitest";
import { isObject } from "../../src/shared/is-object.ts";

describe("isObject", () => {
  it.each([
    ["a plain object", {}],
    ["an object with fields", { kind: "clip" }],
    // Every caller goes on to check named fields, which an array does not have —
    // so arrays pass THIS rung. The guards that must refuse an array keep their
    // own predicate (see the module's docblock).
    ["an array", ["a"]],
  ])("accepts %s", (_name, v) => {
    expect(isObject(v)).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "{}"],
    ["a number", 42],
    ["a boolean", true],
  ])("refuses %s", (_name, v) => {
    expect(isObject(v)).toBe(false);
  });
});
