import { describe, expect, test } from "vitest";
import { CLIP_INGEST, PAIR_CONFIRM, RELATED } from "../../scripts/screenshots/gateway-fixtures.ts";

describe("mock gateway fixtures — locked contract shape", () => {
  test("pair/confirm returns a non-empty token and label", () => {
    expect(typeof PAIR_CONFIRM.token).toBe("string");
    expect(PAIR_CONFIRM.token.length).toBeGreaterThan(0);
    expect(typeof PAIR_CONFIRM.label).toBe("string");
    expect(PAIR_CONFIRM.label.length).toBeGreaterThan(0);
  });

  test("clip ingest returns an id and a created|updated status", () => {
    expect(typeof CLIP_INGEST.id).toBe("string");
    expect(["created", "updated"]).toContain(CLIP_INGEST.status);
  });

  test("related returns RelatedHit items including a url:null hit", () => {
    expect(RELATED.items.length).toBeGreaterThan(0);
    for (const hit of RELATED.items) {
      expect(typeof hit.id).toBe("string");
      expect(typeof hit.title).toBe("string");
      expect(typeof hit.service).toBe("string");
      expect(typeof hit.snippet).toBe("string");
      expect(hit.url === null || typeof hit.url === "string").toBe(true);
    }
    expect(RELATED.items.some((h) => h.url === null)).toBe(true);
  });
});
