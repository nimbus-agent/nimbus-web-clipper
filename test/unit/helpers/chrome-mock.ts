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
  readonly alarmsClear: ReturnType<typeof vi.fn>;
  readonly tabsQuery: ReturnType<typeof vi.fn>;
  readonly storageGet: ReturnType<typeof vi.fn>;
  readonly storageSet: ReturnType<typeof vi.fn>;
  readonly storageRemove: ReturnType<typeof vi.fn>;
  /** Backing store for `chrome.storage.local`; seed or inspect it directly. */
  readonly storage: Map<string, unknown>;
  readonly messageListeners: MessageListener[];
  readonly commandListeners: Array<(command: string) => void>;
  readonly alarmListeners: Array<(alarm: { name: string }) => void>;
  /** Fire a runtime message through the first listener; resolves its response. */
  emitMessage(message: unknown): Promise<unknown>;
  /** Fire a keyboard command through every registered command listener. */
  emitCommand(command: string): void;
  /** Fire an alarm through every registered alarm listener. */
  emitAlarm(name: string): void;
  /** Remove the fake from `globalThis.chrome`. */
  restore(): void;
}

/** Install a fresh fake `chrome` on `globalThis` and return handles to it. */
export function installChromeMock(): ChromeHarness {
  const storage = new Map<string, unknown>();
  const messageListeners: MessageListener[] = [];
  const commandListeners: Array<(command: string) => void> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];

  const sendMessage = vi.fn(async (): Promise<unknown> => undefined);
  const executeScript = vi.fn(
    async (): Promise<Array<{ result: unknown }>> => [{ result: undefined }],
  );
  const setBadgeText = vi.fn(async (): Promise<void> => undefined);
  const setBadgeBackgroundColor = vi.fn(async (): Promise<void> => undefined);
  const alarmsCreate = vi.fn((): void => undefined);
  const alarmsClear = vi.fn(async (): Promise<boolean> => true);
  const tabsQuery = vi.fn(
    async (): Promise<Array<{ id?: number; url?: string; title?: string }>> => [
      { id: 1, url: "https://example.com/", title: "Example" },
    ],
  );
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

  const fakeChrome = {
    runtime: {
      sendMessage,
      onMessage: {
        addListener: (cb: MessageListener): void => {
          messageListeners.push(cb);
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
      clear: alarmsClear,
      onAlarm: {
        addListener: (cb: (alarm: { name: string }) => void): void => {
          alarmListeners.push(cb);
        },
      },
    },
    scripting: { executeScript },
    tabs: { query: tabsQuery },
    storage: { local: { get: storageGet, set: storageSet, remove: storageRemove } },
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

  function restore(): void {
    (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
  }

  return {
    sendMessage,
    executeScript,
    setBadgeText,
    setBadgeBackgroundColor,
    alarmsCreate,
    alarmsClear,
    tabsQuery,
    storageGet,
    storageSet,
    storageRemove,
    storage,
    messageListeners,
    commandListeners,
    alarmListeners,
    emitMessage,
    emitCommand,
    emitAlarm,
    restore,
  };
}
