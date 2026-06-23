interface StubOptions {
  storage?: Record<string, unknown>;
  tab?: { id?: number; url?: string; title?: string };
  executeResults?: Array<{ result?: unknown }>;
}

/** Install a minimal fake `chrome` on globalThis; returns the backing storage map. */
export function installChromeStub(opts: StubOptions = {}): {
  storage: Map<string, unknown>;
  executeCalls: unknown[];
} {
  const storage = new Map<string, unknown>(Object.entries(opts.storage ?? {}));
  const executeCalls: unknown[] = [];
  const fake = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage.get(key) }),
        set: async (items: Record<string, unknown>) => {
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
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { storage, executeCalls };
}
