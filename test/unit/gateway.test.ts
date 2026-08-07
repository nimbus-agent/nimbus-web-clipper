import { describe, expect, test } from "vitest";
import {
  CLIP_PATHS,
  endpointUrl,
  isLoopbackOrigin,
  PROPOSED_PATHS,
} from "../../src/shared/gateway.ts";

describe("gateway endpoints", () => {
  test("the locked contract paths are exactly the three shipped routes (PR #718)", () => {
    expect(CLIP_PATHS).toEqual({
      ingest: "/v1/clips",
      pairConfirm: "/v1/clips/pair/confirm",
      related: "/v1/clips/related",
    });
  });

  test("endpointUrl joins origin + path", () => {
    expect(endpointUrl("http://127.0.0.1:8765", "ingest")).toBe("http://127.0.0.1:8765/v1/clips");
    expect(endpointUrl("http://127.0.0.1:8765", "related")).toBe(
      "http://127.0.0.1:8765/v1/clips/related",
    );
  });

  test("the proposed resolve path is kept OUT of the locked three", () => {
    expect(Object.keys(CLIP_PATHS).sort()).toEqual(["ingest", "pairConfirm", "related"]);
    expect(PROPOSED_PATHS).toEqual({ resolve: "/v1/clips/resolve" });
  });

  test("endpointUrl builds the proposed resolve URL like the locked ones", () => {
    expect(endpointUrl("http://127.0.0.1:7474/", "resolve")).toBe(
      "http://127.0.0.1:7474/v1/clips/resolve",
    );
  });

  test("endpointUrl tolerates a trailing slash on the origin", () => {
    expect(endpointUrl("http://127.0.0.1:8765/", "pairConfirm")).toBe(
      "http://127.0.0.1:8765/v1/clips/pair/confirm",
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
