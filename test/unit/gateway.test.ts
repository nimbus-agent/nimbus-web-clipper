import { describe, expect, test } from "vitest";
import { endpointUrl, GATEWAY_PATHS, isLoopbackOrigin } from "../../src/shared/gateway.ts";

describe("GATEWAY_PATHS", () => {
  test("is the five contracted gateway paths", () => {
    expect(GATEWAY_PATHS).toEqual({
      ingest: "/v1/clips",
      pairConfirm: "/v1/clips/pair/confirm",
      related: "/v1/clips/related",
      resolve: "/v1/items/resolve",
      itemsFetch: "/v1/items/fetch",
    });
  });

  test("builds a resolve URL under a trailing-slash origin", () => {
    expect(endpointUrl("http://127.0.0.1:8765/", "resolve")).toBe(
      "http://127.0.0.1:8765/v1/items/resolve",
    );
  });
});

describe("isLoopbackOrigin", () => {
  test("accepts http loopback hosts", () => {
    for (const o of [
      "http://127.0.0.1:8765",
      "http://127.0.0.5",
      "http://localhost:3000",
      "http://[::1]:8765",
    ]) {
      expect(isLoopbackOrigin(o)).toBe(true);
    }
  });
  test("rejects non-loopback, https, lookalikes, and garbage", () => {
    for (const o of [
      "http://example.com",
      "https://127.0.0.1:8765", // https excluded (gateway is http-only)
      "http://127.0.0.1.attacker.com", // distinct host, not loopback
      "http://localhost.attacker.com",
      "http://10.0.0.1",
      "not a url",
    ]) {
      expect(isLoopbackOrigin(o)).toBe(false);
    }
  });
});
