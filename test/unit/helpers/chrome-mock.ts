// A configurable in-memory fake of the `chrome.*` MV3 surface the extension
// touches (via the `src/browser/` seam), installed on `globalThis.chrome` so
// entry-point modules can be imported and driven under Vitest's jsdom/node env.
//
// Register it in a test with `installChromeMock()` and tear it down in
// `afterEach` with the returned `restore()`. The handles it returns are the
// same `vi.fn()`s the code calls, so tests both configure return values
// (`harness.tabsQuery.mockResolvedValue(...)`) and assert calls
// (`expect(harness.sendMessage).toHaveBeenCalledWith(...)`). The `emit*`
// helpers fire registered listeners the way the real browser would.
import { vi } from "vitest";

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

export interface ChromeHarness {
  readonly sendMessage: ReturnType<typeof vi.fn>;
  readonly executeScript: ReturnType<typeof vi.fn>;
  readonly setBadgeText: ReturnType<typeof vi.fn>;
  readonly setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
  readonly alarmsCreate: ReturnType<typeof vi.fn>;
  readonly alarmsGet: ReturnType<typeof vi.fn>;
  readonly alarmsClear: ReturnType<typeof vi.fn>;
  readonly tabsQuery: ReturnType<typeof vi.fn>;
  readonly tabsGet: ReturnType<typeof vi.fn>;
  readonly tabsUpdatedListeners: Array<
    (tabId: number, changeInfo: { url?: string | undefined }, tab: { active?: boolean }) => void
  >;
  readonly tabsRemovedListeners: Array<(tabId: number) => void>;
  readonly storageGet: ReturnType<typeof vi.fn>;
  readonly storageSet: ReturnType<typeof vi.fn>;
  readonly storageRemove: ReturnType<typeof vi.fn>;
  /** Backing store for `chrome.storage.local`; seed or inspect it directly. */
  readonly storage: Map<string, unknown>;
  readonly messageListeners: MessageListener[];
  readonly commandListeners: Array<(command: string) => void>;
  readonly alarmListeners: Array<(alarm: { name: string }) => void>;
  readonly contextMenusCreate: ReturnType<typeof vi.fn>;
  readonly contextMenusRemoveAll: ReturnType<typeof vi.fn>;
  readonly permissionsContains: ReturnType<typeof vi.fn>;
  readonly permissionsRequest: ReturnType<typeof vi.fn>;
  readonly permissionsRemove: ReturnType<typeof vi.fn>;
  /** Backing set of granted origin patterns; seed or inspect it directly. */
  readonly grantedOrigins: Set<string>;
  /** Fire a runtime message through the first listener; resolves its response. */
  emitMessage(message: unknown): Promise<unknown>;
  /** Fire a keyboard command through every registered command listener. */
  emitCommand(command: string): void;
  /** Fire an alarm through every registered alarm listener. */
  emitAlarm(name: string): void;
  /** Fire a context-menu click. */
  emitMenuClick(menuItemId: string, tabId?: number): void;
  /** Fire runtime.onInstalled. */
  emitInstalled(): void;
  /** Fire a tab update through every registered listener. */
  emitTabUpdated(
    tabId: number,
    changeInfo: { url?: string | undefined },
    tab: { active?: boolean },
  ): void;
  /** Fire a tab removal through every registered listener. */
  emitTabRemoved(tabId: number): void;
  /** Remove the fake from `globalThis.chrome`. */
  restore(): void;
}

/** Install a fresh fake `chrome` on `globalThis` and return handles to it. */
export function installChromeMock(): ChromeHarness {
  const storage = new Map<string, unknown>();
  const messageListeners: MessageListener[] = [];
  const commandListeners: Array<(command: string) => void> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const menuClickListeners: Array<(info: { menuItemId: string }, tab?: { id?: number }) => void> =
    [];
  const installedListeners: Array<() => void> = [];

  const sendMessage = vi.fn(async (): Promise<unknown> => undefined);
  const executeScript = vi.fn(
    async (): Promise<Array<{ result: unknown }>> => [{ result: undefined }],
  );
  const setBadgeText = vi.fn(async (): Promise<void> => undefined);
  const setBadgeBackgroundColor = vi.fn(async (): Promise<void> => undefined);
  // Track live alarms so `get` can answer truthfully — ensureAlarm depends on it.
  const liveAlarms = new Map<string, unknown>();
  const alarmsCreate = vi.fn((name: string, info: unknown): void => {
    liveAlarms.set(name, info);
  });
  const alarmsGet = vi.fn(async (name: string): Promise<unknown> => {
    const info = liveAlarms.get(name);
    return info === undefined ? undefined : { name, ...(info as Record<string, unknown>) };
  });
  const alarmsClear = vi.fn(async (name: string): Promise<boolean> => {
    liveAlarms.delete(name);
    return true;
  });
  const tabsQuery = vi.fn(
    async (): Promise<Array<{ id?: number; url?: string; title?: string }>> => [
      { id: 1, url: "https://example.com/", title: "Example" },
    ],
  );
  const tabsGet = vi.fn(async (_id: number) => ({ url: "https://github.com/acme/web/pull/482" }));
  const tabsUpdatedListeners: ChromeHarness["tabsUpdatedListeners"] = [];
  const tabsRemovedListeners: ChromeHarness["tabsRemovedListeners"] = [];
  const storageGet = vi.fn(
    async (key: string): Promise<Record<string, unknown>> => ({
      [key]: storage.get(key),
    }),
  );
  const storageSet = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
    for (const [k, v] of Object.entries(items)) {
      storage.set(k, v);
    }
  });
  const storageRemove = vi.fn(async (key: string): Promise<void> => {
    storage.delete(key);
  });
  const contextMenusCreate = vi.fn();
  // Real chrome.contextMenus.removeAll honours BOTH shapes: it invokes the
  // callback when one is supplied, and returns a promise when one is not. This
  // double previously modelled only the promise half, so a callback-style
  // caller would hang against it forever.
  const contextMenusRemoveAll = vi.fn(async (cb?: () => void): Promise<void> => {
    cb?.();
  });

  // Optional host permissions: nothing is granted until requested, mirroring the
  // real surface where `optional_host_permissions` is inert at install.
  const grantedOrigins = new Set<string>();
  const permissionsContains = vi.fn(
    async (p: { origins?: string[] }): Promise<boolean> =>
      (p.origins ?? []).every((o) => grantedOrigins.has(o)),
  );
  const permissionsRequest = vi.fn(async (p: { origins?: string[] }): Promise<boolean> => {
    for (const o of p.origins ?? []) {
      grantedOrigins.add(o);
    }
    return true;
  });
  const permissionsRemove = vi.fn(async (p: { origins?: string[] }): Promise<boolean> => {
    for (const o of p.origins ?? []) {
      grantedOrigins.delete(o);
    }
    return true;
  });

  const fakeChrome = {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: (cb: MessageListener): void => {
          messageListeners.push(cb);
        },
      },
      onInstalled: {
        addListener: (cb: () => void): void => {
          installedListeners.push(cb);
        },
      },
    },
    commands: {
      onCommand: {
        addListener: (cb: (command: string) => void): void => {
          commandListeners.push(cb);
        },
      },
    },
    action: { setBadgeText, setBadgeBackgroundColor },
    alarms: {
      create: alarmsCreate,
      get: alarmsGet,
      clear: alarmsClear,
      onAlarm: {
        addListener: (cb: (alarm: { name: string }) => void): void => {
          alarmListeners.push(cb);
        },
      },
    },
    scripting: { executeScript },
    tabs: {
      query: tabsQuery,
      get: tabsGet,
      onUpdated: {
        addListener: (
          cb: (
            tabId: number,
            changeInfo: { url?: string | undefined },
            tab: { active?: boolean },
          ) => void,
        ): void => {
          tabsUpdatedListeners.push(cb);
        },
      },
      onRemoved: {
        addListener: (cb: (tabId: number) => void): void => {
          tabsRemovedListeners.push(cb);
        },
      },
    },
    storage: { local: { get: storageGet, set: storageSet, remove: storageRemove } },
    permissions: {
      contains: permissionsContains,
      request: permissionsRequest,
      remove: permissionsRemove,
    },
    contextMenus: {
      create: contextMenusCreate,
      removeAll: contextMenusRemoveAll,
      onClicked: {
        addListener: (cb: (info: { menuItemId: string }, tab?: { id?: number }) => void): void => {
          menuClickListeners.push(cb);
        },
      },
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = fakeChrome;

  function emitMessage(message: unknown): Promise<unknown> {
    if (messageListeners.length === 0) {
      throw new Error("no runtime.onMessage listener registered");
    }
    return new Promise<unknown>((resolve) => {
      // Real Chrome invokes every registered onMessage listener; whichever one
      // returns `true` first owns the async response (subsequent sendResponse
      // calls are no-ops once the promise has settled).
      let settled = false;
      const sendResponse = (response: unknown): void => {
        if (!settled) {
          settled = true;
          resolve(response);
        }
      };
      let anyKeptOpen = false;
      for (const listener of messageListeners) {
        const keptOpen = listener(message, {}, sendResponse);
        if (keptOpen === true) {
          anyKeptOpen = true;
        }
      }
      if (!anyKeptOpen) {
        resolve(undefined);
      }
    });
  }

  function emitCommand(command: string): void {
    for (const cb of commandListeners) {
      cb(command);
    }
  }

  function emitAlarm(name: string): void {
    for (const cb of alarmListeners) {
      cb({ name });
    }
  }

  function emitMenuClick(menuItemId: string, tabId?: number): void {
    for (const cb of menuClickListeners) {
      cb({ menuItemId }, tabId === undefined ? undefined : { id: tabId });
    }
  }

  function emitInstalled(): void {
    for (const cb of installedListeners) {
      cb();
    }
  }

  function emitTabUpdated(
    tabId: number,
    changeInfo: { url?: string | undefined },
    tab: { active?: boolean },
  ): void {
    for (const cb of tabsUpdatedListeners) {
      cb(tabId, changeInfo, tab);
    }
  }

  function emitTabRemoved(tabId: number): void {
    for (const cb of tabsRemovedListeners) {
      cb(tabId);
    }
  }

  function restore(): void {
    (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
  }

  return {
    sendMessage,
    executeScript,
    setBadgeText,
    setBadgeBackgroundColor,
    alarmsCreate,
    alarmsGet,
    alarmsClear,
    tabsQuery,
    tabsGet,
    tabsUpdatedListeners,
    tabsRemovedListeners,
    storageGet,
    storageSet,
    storageRemove,
    storage,
    messageListeners,
    commandListeners,
    alarmListeners,
    contextMenusCreate,
    contextMenusRemoveAll,
    permissionsContains,
    permissionsRequest,
    permissionsRemove,
    grantedOrigins,
    emitMessage,
    emitCommand,
    emitAlarm,
    emitMenuClick,
    emitInstalled,
    emitTabUpdated,
    emitTabRemoved,
    restore,
  };
}
