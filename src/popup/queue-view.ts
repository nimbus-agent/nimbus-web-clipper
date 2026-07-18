// src/popup/queue-view.ts
// Pure DOM builders for the popup queue manager. Every entry string is written via
// textContent (never innerHTML); the host is parsed with a guarded new URL and the
// row renders NO href — the manager does not navigate, so there is no javascript:
// href surface. Retry/Remove buttons carry the entry url in dataset.url; the popup
// attaches a single delegated click listener.
import type { QueuedClipView } from "../shared/queue.ts";

const REASON_LABELS: Record<string, string> = {
  unreachable: "Can't reach Nimbus",
  server_error: "Nimbus had an error",
  unauthorized: "Pairing expired",
  invalid_request: "Couldn't save — won't retry automatically",
  not_paired: "Not paired",
};

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function formatAge(nowMs: number, queuedAt: number): string {
  const sec = Math.max(0, Math.floor((nowMs - queuedAt) / 1000));
  if (sec < 60) {
    return "just now";
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  return `${Math.floor(hr / 24)}d ago`;
}

export function renderQueueItem(doc: Document, item: QueuedClipView, nowMs: number): HTMLElement {
  const li = doc.createElement("li");
  li.className = "queue__item";

  const title = doc.createElement("span");
  title.className = "queue__item-title";
  title.textContent = item.title !== "" ? item.title : hostOf(item.url);

  const meta = doc.createElement("span");
  meta.className = "queue__item-meta";
  meta.textContent = `${hostOf(item.url)} · ${formatAge(nowMs, item.queuedAt)}`;

  li.append(title, meta);

  if (item.attempts > 0 || item.lastReason !== undefined) {
    const status = doc.createElement("span");
    status.className = "queue__item-status";
    const label =
      item.lastReason !== undefined
        ? (REASON_LABELS[item.lastReason] ?? "Couldn't save")
        : "Pending";
    const unit = item.attempts === 1 ? "try" : "tries";
    status.textContent = item.attempts > 0 ? `${label} · ${item.attempts} ${unit}` : label;
    li.append(status);
  }

  const actions = doc.createElement("span");
  actions.className = "queue__item-actions";
  const retry = doc.createElement("button");
  retry.type = "button";
  retry.className = "queue__retry";
  retry.dataset["url"] = item.url;
  retry.textContent = "Retry";
  const remove = doc.createElement("button");
  remove.type = "button";
  remove.className = "queue__remove";
  remove.dataset["url"] = item.url;
  remove.textContent = "Remove";
  actions.append(retry, remove);
  li.append(actions);

  return li;
}

export function renderQueueList(
  doc: Document,
  items: QueuedClipView[],
  nowMs: number,
): HTMLElement {
  const list = doc.createElement("ul");
  list.className = "queue__list";
  for (const item of items) {
    list.append(renderQueueItem(doc, item, nowMs));
  }
  return list;
}
