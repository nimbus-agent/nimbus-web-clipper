import { afterEach, describe, expect, test } from "vitest";
import {
  clearConnection,
  getConnection,
  markClipSuccess,
  markStale,
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

describe("connection health facts", () => {
  test("a record without the new fields still loads (migration)", async () => {
    installChromeStub({ storage: { connection: conn } });
    const loaded = await getConnection();
    expect(loaded?.label).toBe("chrome");
    expect(loaded?.lastClipAt).toBeUndefined();
    expect(loaded?.stale).toBeUndefined();
  });

  test("markClipSuccess records the timestamp", async () => {
    installChromeStub();
    await setConnection(conn);
    await markClipSuccess(1234);
    expect((await getConnection())?.lastClipAt).toBe(1234);
  });

  test("markClipSuccess also clears a stale flag — a clip proves the token works", async () => {
    installChromeStub();
    await setConnection({ ...conn, stale: true });
    await markClipSuccess(1234);
    expect((await getConnection())?.stale).toBe(false);
  });

  test("markStale sets the flag without touching the token", async () => {
    installChromeStub();
    await setConnection(conn);
    await markStale();
    const loaded = await getConnection();
    expect(loaded?.stale).toBe(true);
    expect(loaded?.token).toBe("tok");
  });

  test("marking with no connection stored is a no-op, not a crash", async () => {
    installChromeStub();
    await markStale();
    await markClipSuccess(1);
    expect(await getConnection()).toBeNull();
  });

  test("a re-pair racing a 401 keeps the NEW token, not the old one", async () => {
    installChromeStub();
    await setConnection(conn);
    const fresh: Connection = { ...conn, token: "new-tok", label: "re-paired", pairedAt: 99 };

    // A queue flush 401s at the same moment the user re-pairs. Both are started
    // before either is awaited, which is exactly how they interleave in the
    // service worker.
    const marking = markStale();
    const pairing = setConnection(fresh);
    await Promise.all([marking, pairing]);

    const stored = await getConnection();
    expect(stored?.token).toBe("new-tok");
    expect(stored?.label).toBe("re-paired");
    // THIS is the assertion that distinguishes fixed from unfixed, so do not
    // drop it as redundant. On the shared chain, markStale runs FIRST (it was
    // enqueued first) and setConnection's whole-record write lands after it, so
    // the fresh record has no `stale` field at all. Without the chain,
    // setConnection writes immediately and markStale's read-modify-write lands
    // after it — re-flagging the brand-new token as rejected.
    expect(stored?.stale).toBeUndefined();
  });

  test("unpair racing a clip success leaves nothing behind", async () => {
    installChromeStub();
    await setConnection(conn);

    const marking = markClipSuccess(5);
    const clearing = clearConnection();
    await Promise.all([marking, clearing]);

    expect(await getConnection()).toBeNull();
  });
});
