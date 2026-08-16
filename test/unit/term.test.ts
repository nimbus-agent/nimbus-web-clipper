// test/unit/term.test.ts
import { describe, expect, it } from "vitest";
import { isNormalisedTerm, MAX_TERM_LENGTH, normaliseTerm } from "../../src/shared/term.ts";

// Escape sequences, never a literal control character typed into source — the
// same rule agent-run-store.ts's key separator follows.
const NUL = "\u0000";
const NEL = "\u0085";

describe("normaliseTerm", () => {
  it("keeps a clean term unchanged", () => {
    expect(normaliseTerm("idempotency key")).toEqual({ ok: true, term: "idempotency key" });
  });

  it("trims and collapses whitespace", () => {
    expect(normaliseTerm("  blast    radius  ")).toEqual({ ok: true, term: "blast radius" });
  });

  it("replaces control characters with a space rather than deleting them", () => {
    // Deleting would weld two words into one the user never selected.
    expect(normaliseTerm("blast\nradius")).toEqual({ ok: true, term: "blast radius" });
    expect(normaliseTerm("blast\tradius")).toEqual({ ok: true, term: "blast radius" });
    // C1 controls (U+0080–U+009F) count too — a selection out of a PDF or an
    // editor can carry them, and they are invisible on screen.
    expect(normaliseTerm(`blast${NEL}radius`)).toEqual({ ok: true, term: "blast radius" });
  });

  // A NUL is the run store's key separator (`makeKey`), chosen because it cannot
  // occur in any part of a key. A term is the one subject value a user supplies
  // directly, so this is the one place that assumption could be attacked.
  it("strips the NUL that keys the run store", () => {
    expect(normaliseTerm(`a${NUL}item${NUL}impact`)).toEqual({ ok: true, term: "a item impact" });
    expect(isNormalisedTerm(`a${NUL}b`)).toBe(false);
  });

  it("reports an empty or whitespace-only selection", () => {
    expect(normaliseTerm("")).toEqual({ ok: false, reason: "empty" });
    expect(normaliseTerm(" \n\t ")).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses a passage instead of truncating it", () => {
    expect(normaliseTerm("x".repeat(MAX_TERM_LENGTH + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("measures length AFTER normalising, not before", () => {
    // A padded short term is a short term. Measuring the raw selection would
    // refuse a two-word phrase for the crime of being double-spaced.
    const padded = `${" ".repeat(400)}canary${" ".repeat(400)}`;
    expect(normaliseTerm(padded)).toEqual({ ok: true, term: "canary" });
  });

  // The property the message guard depends on: normalising twice changes
  // nothing, so "equals its own normal form" is a stable thing to demand.
  it("is idempotent", () => {
    const once = normaliseTerm("  blast \n radius ");
    expect(once.ok).toBe(true);
    if (once.ok) {
      expect(normaliseTerm(once.term)).toEqual(once);
    }
  });
});

describe("isNormalisedTerm", () => {
  it("accepts a term already in normal form", () => {
    expect(isNormalisedTerm("blast radius")).toBe(true);
  });

  // The boundary validates; it must not quietly repair. A guard that accepted
  // "  foo  " would be claiming the sender sent something it did not.
  it("rejects a term that is merely normalisABLE", () => {
    expect(isNormalisedTerm("  blast radius  ")).toBe(false);
    expect(isNormalisedTerm("blast  radius")).toBe(false);
    expect(isNormalisedTerm("blast\nradius")).toBe(false);
  });

  it("rejects an over-long term", () => {
    expect(isNormalisedTerm("x".repeat(MAX_TERM_LENGTH + 1))).toBe(false);
  });

  it("rejects an empty string and every non-string", () => {
    expect(isNormalisedTerm("")).toBe(false);
    for (const v of [undefined, null, 42, {}, ["a"]]) {
      expect(isNormalisedTerm(v)).toBe(false);
    }
  });
});
