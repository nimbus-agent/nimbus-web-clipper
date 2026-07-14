interface StubOptions {
  storage?: Record<string, unknown>;
  tab?: { id?: number; url?: string; title?: string };
  executeResults?: Array<{ result?: unknown }>;
  failFirstSet?: boolean;
}

/** Install a minimal fake `chrome` on globalThis; returns the backing storage map. */
export function installChromeStub(opts: StubOptions = {}): {
  storage: Map<string, unknown>;
  executeCalls: unknown[];
  alarmCalls: unknown[];
  badgeTexts: string[];
} {
  const storage = new Map<string, unknown>(Object.entries(opts.storage ?? {}));
  const executeCalls: unknown[] = [];
  const alarmCalls: unknown[] = [];
  const badgeTexts: string[] = [];
  let failsLeft = opts.failFirstSet ? 1 : 0;
  const fake = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage.get(key) }),
        set: async (items: Record<string, unknown>) => {
          if (failsLeft > 0) {
            failsLeft--;
            throw new Error("QUOTA_BYTES quota exceeded");
          }
          for (const [k, v] of Object.entries(items)) storage.set(k, v);
        },
        remove: async (key: string) => void storage.delete(key),
      },
    },
    tabs: {
      query: async () => [
        {
          id: opts.tab?.id ?? 1,
          url: opts.tab?.url ?? "https://ex.com",
          title: opts.tab?.title ?? "T",
        },
      ],
    },
    scripting: {
      executeScript: async (injection: unknown) => {
        executeCalls.push(injection);
        return opts.executeResults ?? [{ result: undefined }];
      },
    },
    runtime: {
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener: () => undefined },
    },
    alarms: {
      create: (name: string, info: unknown) => {
        alarmCalls.push({ create: name, info });
      },
      clear: async (name: string) => {
        alarmCalls.push({ clear: name });
        return true;
      },
      onAlarm: { addListener: () => undefined },
    },
    action: {
      setBadgeText: async (details: { text: string }) => {
        badgeTexts.push(details.text);
      },
      setBadgeBackgroundColor: async () => undefined,
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { storage, executeCalls, alarmCalls, badgeTexts };
}
