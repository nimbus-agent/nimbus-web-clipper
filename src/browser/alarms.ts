// Thin typed seam over chrome.alarms — the only place we touch the alarm API.

// create() is awaited, never fired and forgotten: Chrome's MV3 create() returns a
// promise, and a rejection nobody awaits surfaces as an unhandled rejection instead
// of reaching the caller's own error handling. Awaiting is equally safe where an
// implementation returns nothing (the unit tests' stubs do): it just resolves.

// create() CANCELS AND REPLACES a same-named alarm, restarting its countdown. This
// is called on every queue change, so it must be a genuine "ensure": re-creating
// would push the next fire out indefinitely and the queue would never drain.
export async function ensureAlarm(name: string, periodInMinutes: number): Promise<void> {
  const existing = await chrome.alarms.get(name);
  if (existing === undefined) {
    await chrome.alarms.create(name, { periodInMinutes });
  }
}

/** Deliberately replace the alarm, firing first after `delayInMinutes`. */
export async function rearmAlarm(
  name: string,
  delayInMinutes: number,
  periodInMinutes: number,
): Promise<void> {
  await chrome.alarms.create(name, { delayInMinutes, periodInMinutes });
}

export async function clearAlarm(name: string): Promise<void> {
  await chrome.alarms.clear(name);
}

export function addAlarmListener(fn: (name: string) => void): void {
  chrome.alarms.onAlarm.addListener((alarm) => fn(alarm.name));
}
