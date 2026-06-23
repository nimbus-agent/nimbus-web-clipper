import { afterEach, describe, expect, test } from "vitest";
import {
  clearConnection,
  getConnection,
  setConnection,
} from "../../src/background/connection-store.ts";
import type { Connection } from "../../src/shared/types.ts";
import { installChromeStub } from "./chrome-stub.ts";

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

const conn: Connection = {
  origin: "http://127.0.0.1:8765",
  token: "tok",
  label: "chrome",
  pairedAt: 1,
};

describe("connection-store", () => {
  test("empty storage → null", async () => {
    installChromeStub();
    expect(await getConnection()).toBeNull();
  });
  test("set then get round-trips", async () => {
    installChromeStub();
    await setConnection(conn);
    expect(await getConnection()).toEqual(conn);
  });
  test("clear removes it", async () => {
    installChromeStub({ storage: { connection: conn } });
    await clearConnection();
    expect(await getConnection()).toBeNull();
  });
  test("a malformed stored value → null (not a throw)", async () => {
    installChromeStub({ storage: { connection: { origin: "x" } } });
    expect(await getConnection()).toBeNull();
  });
});
