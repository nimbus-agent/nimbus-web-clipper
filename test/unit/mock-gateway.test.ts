import { describe, expect, it, test } from "vitest";
import { CLIP_INGEST, PAIR_CONFIRM, RELATED } from "../../scripts/screenshots/gateway-fixtures.ts";
import { handleRequest } from "../../scripts/screenshots/mock-gateway.ts";

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

  it("serves GET /v1/items/resolve with a found outcome", async () => {
    const res = await handleRequest(
      new Request(
        "http://127.0.0.1:8765/v1/items/resolve?url=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fpull%2F1",
        {
          method: "GET",
          headers: { authorization: "Bearer test-token" },
        },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["found"]).toBe(true);
    expect(body["matchKind"]).toBe("exact");
    expect((body["item"] as Record<string, unknown>)["modified_at"]).toEqual(expect.any(Number));
  });
});
