import { beforeEach, describe, expect, test } from "vitest";
import {
  dropBinding,
  getBindings,
  putBinding,
} from "../../src/background/service-binding-store.ts";
import { installChromeMock } from "./helpers/chrome-mock.ts";

beforeEach(() => {
  installChromeMock();
});

const b = (scope: string, serviceId: string) => ({ product: "github", scope, serviceId }) as const;

describe("service-binding-store", () => {
  test("an empty store reads as an empty list, not a throw", async () => {
    expect(await getBindings()).toEqual([]);
  });

  test("a stored binding round-trips", async () => {
    await putBinding(b("acme/web", "web"));
    expect(await getBindings()).toEqual([
      { product: "github", scope: "acme/web", serviceId: "web" },
    ]);
  });

  test("putBinding replaces by key rather than appending", async () => {
    await putBinding(b("acme/web", "web"));
    await putBinding(b("acme/web", "payments"));
    const list = await getBindings();
    expect(list).toHaveLength(1);
    expect(list[0]?.serviceId).toBe("payments");
  });

  test("dropBinding removes only the named key", async () => {
    await putBinding(b("acme/web", "web"));
    await putBinding(b("acme/api", "api"));
    await dropBinding("github", "acme/web");
    expect((await getBindings()).map((x) => x.scope)).toEqual(["acme/api"]);
  });

  test("a corrupt row is filtered out, not returned", async () => {
    await chrome.storage.local.set({
      serviceBindings: [{ product: "github", scope: "ok", serviceId: "s" }, { product: "nope" }, 7],
    });
    expect(await getBindings()).toHaveLength(1);
  });

  test("a non-array stored value reads as empty", async () => {
    await chrome.storage.local.set({ serviceBindings: "corrupt" });
    expect(await getBindings()).toEqual([]);
  });

  // The reason this store has a write chain and origin-store.ts does not:
  // two concurrent read-modify-write cycles must not lose the first write.
  test("concurrent writes do not clobber each other", async () => {
    await Promise.all([
      putBinding(b("acme/a", "a")),
      putBinding(b("acme/b", "b")),
      putBinding(b("acme/c", "c")),
    ]);
    expect((await getBindings()).map((x) => x.scope).sort()).toEqual([
      "acme/a",
      "acme/b",
      "acme/c",
    ]);
  });
});
