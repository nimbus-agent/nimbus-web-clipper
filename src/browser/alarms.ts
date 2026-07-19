// Thin typed seam over chrome.alarms — the only place we touch the alarm API.

// create() CANCELS AND REPLACES a same-named alarm, restarting its countdown. This
// is called on every queue change, so it must be a genuine "ensure": re-creating
// would push the next fire out indefinitely and the queue would never drain.
export async function ensureAlarm(name: string, periodInMinutes: number): Promise<void> {
  const existing = await chrome.alarms.get(name);
  if (existing === undefined) {
    chrome.alarms.create(name, { periodInMinutes });
  }
}

/** Deliberately replace the alarm, firing first after `delayInMinutes`. */
export function rearmAlarm(name: string, delayInMinutes: number, periodInMinutes: number): void {
  chrome.alarms.create(name, { delayInMinutes, periodInMinutes });
}

export async function clearAlarm(name: string): Promise<void> {
  await chrome.alarms.clear(name);
}

export function addAlarmListener(fn: (name: string) => void): void {
  chrome.alarms.onAlarm.addListener((alarm) => fn(alarm.name));
}
