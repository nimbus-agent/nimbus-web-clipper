// Thin typed seam over chrome.alarms — the only place we touch the alarm API.
export function ensureAlarm(name: string, periodInMinutes: number): void {
  chrome.alarms.create(name, { periodInMinutes });
}

export async function clearAlarm(name: string): Promise<void> {
  await chrome.alarms.clear(name);
}

export function addAlarmListener(fn: (name: string) => void): void {
  chrome.alarms.onAlarm.addListener((alarm) => fn(alarm.name));
}
