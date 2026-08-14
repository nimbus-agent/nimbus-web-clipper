// The whole `chrome.commands` seam — the listener and the binding read together,
// so one browser API has one home. `addCommandListener` moved here from
// runtime.ts for that reason; runtime.ts keeps messaging and install events.

export interface CommandBinding {
  readonly name: string;
  readonly description: string;
  /** Empty string means UNBOUND. `suggested_key` is a suggestion the browser may decline. */
  readonly shortcut: string;
}

export function addCommandListener(fn: (command: string) => void): void {
  chrome.commands.onCommand.addListener(fn);
}

/**
 * Every declared command with the shortcut the browser ACTUALLY bound.
 *
 * Callback-style rather than the promise form: Chrome 91+ returns a promise but
 * Firefox MV3 does not, and this is one of the few reads both targets make.
 *
 * Missing fields normalise to `""` rather than `undefined` so a caller cannot
 * accidentally render "undefined" as a shortcut, and an absent `chrome.commands`
 * yields `[]` rather than throwing — Options must still render if the API is
 * unavailable, because a page that fails to render tells the user nothing at all.
 */
export async function getAllCommands(): Promise<CommandBinding[]> {
  const api = (chrome as { commands?: { getAll?: unknown } }).commands;
  if (api === undefined || typeof api.getAll !== "function") {
    return [];
  }
  const raw = await new Promise<unknown[]>((resolve) => {
    (api.getAll as (cb: (c: unknown[]) => void) => void)((commands) => resolve(commands ?? []));
  });
  return raw.map((c) => {
    const o = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    return {
      name: typeof o["name"] === "string" ? o["name"] : "",
      description: typeof o["description"] === "string" ? o["description"] : "",
      shortcut: typeof o["shortcut"] === "string" ? o["shortcut"] : "",
    };
  });
}
