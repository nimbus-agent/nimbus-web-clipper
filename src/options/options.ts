import { getAmbientHosts, setAmbientHost } from "../background/ambient-prefs.ts";
import { getOrigins, setOrigins } from "../background/origin-store.ts";
import { hasOrigin, removeOrigin, requestOrigin } from "../browser/permissions.ts";
import { sendMessage } from "../browser/runtime.ts";
import { isConnectionResponse, type PairResponse } from "../shared/messages.ts";
import {
  hostPermissionPattern,
  isProduct,
  parseConfiguredOrigin,
  removeConfiguredOrigin,
  upsertOrigin,
} from "../shared/origins.ts";
import { BUILT_IN_SURFACES } from "../shared/recognise.ts";
import type { ConfiguredOrigin } from "../shared/types.ts";
import { formatPairedSince } from "./connection-view.ts";
import { renderSurfaceList, type SurfaceRow, sharedHostNote } from "./surfaces-view.ts";

const PAIR_MESSAGES: Record<string, string> = {
  bad_origin: "Enter a 127.0.0.1 / localhost URL.",
  pairing_failed: "Code wrong or expired — run `nimbus clip pair` again.",
  unreachable: "Can't reach Nimbus — is the gateway running?",
  server_error: "Nimbus had an error during pairing.",
};

function isPairResponse(v: unknown): v is PairResponse {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "pair";
}

function setStatus(text: string): void {
  const el = document.getElementById("pairing-status");
  if (el !== null) {
    el.textContent = text;
  }
}

let unpairArmed = false;

function disarmUnpair(): void {
  unpairArmed = false;
  const unpair = document.getElementById("unpair");
  const cancel = document.getElementById("unpair-cancel");
  if (unpair instanceof HTMLButtonElement) {
    unpair.textContent = "Unpair this browser";
  }
  if (cancel instanceof HTMLElement) {
    cancel.hidden = true;
  }
}

function renderConnection(res: unknown): void {
  const pairing = document.getElementById("pairing-section");
  const connection = document.getElementById("connection-section");
  const status = document.getElementById("connection-status");
  if (
    !(pairing instanceof HTMLElement) ||
    !(connection instanceof HTMLElement) ||
    status === null
  ) {
    return;
  }
  if (!isConnectionResponse(res) || !res.paired) {
    connection.hidden = true;
    pairing.hidden = false;
    disarmUnpair();
    return;
  }
  status.textContent = `Paired as "${res.label}" to ${res.origin}, since ${formatPairedSince(res.pairedAt)}.`;
  pairing.hidden = true;
  connection.hidden = false;
}

async function refreshConnection(): Promise<void> {
  renderConnection(await sendMessage({ kind: "connection-status" }));
}

async function pair(): Promise<void> {
  const originEl = document.getElementById("origin");
  const codeEl = document.getElementById("code");
  if (!(originEl instanceof HTMLInputElement) || !(codeEl instanceof HTMLInputElement)) {
    return;
  }
  const origin = originEl.value.trim();
  const code = codeEl.value.trim();
  if (origin === "" || code === "") {
    setStatus("Enter both the gateway URL and the pairing code.");
    return;
  }
  setStatus("Pairing…");
  try {
    const res = await sendMessage({ kind: "pair", origin, code });
    if (!isPairResponse(res)) {
      setStatus("Unexpected response.");
      return;
    }
    if (res.ok) {
      codeEl.value = "";
      setStatus("");
      await refreshConnection();
    } else {
      setStatus(PAIR_MESSAGES[res.reason] ?? "Pairing failed.");
    }
  } catch {
    // The message channel rejected — recover the status rather than sticking on "Pairing…".
    setStatus("Couldn't reach the extension — please try again.");
  }
}

async function onUnpairClick(): Promise<void> {
  const unpair = document.getElementById("unpair");
  const cancel = document.getElementById("unpair-cancel");
  if (!unpairArmed) {
    unpairArmed = true;
    if (unpair instanceof HTMLButtonElement) {
      unpair.textContent = "Click again to confirm unpair";
    }
    if (cancel instanceof HTMLElement) {
      cancel.hidden = false;
    }
    return;
  }
  // Confirmed. Show an in-flight state and disable the buttons; do NOT pre-disarm
  // (resetting the button text first would briefly flash the normal paired panel
  // before the section is hidden). renderConnection performs the final transition —
  // its not-paired branch calls disarmUnpair() to reset the button text + cancel.
  if (unpair instanceof HTMLButtonElement) {
    unpair.textContent = "Unpairing…";
    unpair.disabled = true;
  }
  if (cancel instanceof HTMLButtonElement) {
    cancel.disabled = true;
  }
  try {
    renderConnection(await sendMessage({ kind: "unpair" }));
  } catch {
    // The message channel itself rejected (e.g. the SW didn't respond) — the unpair
    // didn't happen, so reset the button and leave the paired panel as-is rather than
    // sticking on a disabled "Unpairing…".
    disarmUnpair();
  } finally {
    if (unpair instanceof HTMLButtonElement) {
      unpair.disabled = false;
    }
    if (cancel instanceof HTMLButtonElement) {
      cancel.disabled = false;
    }
  }
}

function setSurfaceStatus(text: string): void {
  const el = document.getElementById("surface-status");
  if (el !== null) {
    el.textContent = text;
  }
}

/**
 * Serialize read-modify-write cycles on the origin list.
 *
 * Every mutation below is `getOrigins()` → transform → `setOrigins()`, and the
 * store only writes the whole list. Two handlers that interleave (a fast
 * double-click, or Remove while Add is still awaiting storage) would both read
 * the pre-change list and the second write would silently drop the first one's
 * edit. Chaining them onto one promise makes each cycle see the previous one's
 * result — the same lost-update guard clip-queue-store.ts applies to the queue.
 */
let originWrites: Promise<void> = Promise.resolve();

function mutateOrigins(transform: (list: ConfiguredOrigin[]) => ConfiguredOrigin[]): Promise<void> {
  originWrites = originWrites
    .catch(() => undefined)
    .then(async () => {
      await setOrigins(transform(await getOrigins()));
    });
  return originWrites;
}

/** Serialise prefs writes for the same reason origin writes are serialised: two
 *  toggles flipped in quick succession both read the pre-change list, and the
 *  second write would silently drop the first one's edit. */
let ambientWrites: Promise<void> = Promise.resolve();

/**
 * Storage is the source of truth for the user's own entries; the browser is the
 * source of truth for grants; the prefs store is for the ambient toggle.
 *
 * Built-ins come FIRST and are always present. Until this existed there was no
 * row for github.com, gitlab.com, bitbucket.org or Jira Cloud — and since the
 * Grant button lives on a row, there was no way to grant page access to them at
 * all. See the design spec's "The prerequisite this slice discovered".
 */
async function surfaceRows(): Promise<SurfaceRow[]> {
  const ambient = await getAmbientHosts();
  const rows: SurfaceRow[] = [];
  for (const surface of BUILT_IN_SURFACES) {
    rows.push({
      origin: surface.label,
      product: surface.product,
      granted: await hasOrigin(surface.pattern),
      builtIn: true,
      pattern: surface.pattern,
      ambient: ambient.includes(surface.pattern),
    });
  }
  for (const entry of await getOrigins()) {
    const pattern = hostPermissionPattern(entry.origin);
    rows.push({
      origin: entry.origin,
      product: entry.product,
      granted: pattern !== null && (await hasOrigin(pattern)),
      builtIn: false,
      pattern,
      ambient: pattern !== null && ambient.includes(pattern),
    });
  }
  return rows;
}

async function refreshSurfaces(): Promise<void> {
  const list = document.getElementById("surface-list");
  if (list === null) {
    return;
  }
  list.replaceChildren(renderSurfaceList(document, await surfaceRows()));
}

async function addSurface(): Promise<void> {
  const originEl = document.getElementById("surface-origin");
  const productEl = document.getElementById("surface-product");
  if (!(originEl instanceof HTMLInputElement) || !(productEl instanceof HTMLSelectElement)) {
    return;
  }
  if (!isProduct(productEl.value)) {
    setSurfaceStatus("Pick what this instance is running.");
    return;
  }
  const entry = parseConfiguredOrigin(originEl.value, productEl.value);
  if (entry === null) {
    setSurfaceStatus("Enter the full URL, including https://");
    return;
  }
  await mutateOrigins((list) => upsertOrigin(list, entry));
  originEl.value = "";
  setSurfaceStatus("");
  await refreshSurfaces();
}

async function onSurfaceClick(event: Event): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const action = target.dataset["action"];
  const origin = target.dataset["origin"];
  if (action === undefined || origin === undefined) {
    return;
  }
  // A built-in row's `origin` is a display label, not a URL — its pattern comes
  // from the table, not from parsing. Fall back to parsing for the user's own
  // entries, which are always absolute origins.
  const builtIn = BUILT_IN_SURFACES.find((s) => s.label === origin);
  const pattern = builtIn?.pattern ?? hostPermissionPattern(origin);
  if (action === "remove" && builtIn === undefined) {
    await mutateOrigins((list) => removeConfiguredOrigin(list, origin));
    setSurfaceStatus("");
  } else if (action === "grant" && pattern !== null) {
    // Must run inside this click handler — chrome.permissions.request needs the gesture.
    const granted = await requestOrigin(pattern);
    setSurfaceStatus(granted ? "" : "Page access was not granted.");
  } else if (action === "revoke" && pattern !== null) {
    // Only claim the sibling entries were affected if the revoke actually
    // happened — otherwise the note would say access was withdrawn from a host
    // that still has it.
    if (await removeOrigin(pattern)) {
      // Page access is what the cue runs on, so revoking it turns the cue off
      // rather than leaving a stored "on" that cannot happen. Without this, a
      // later re-grant would silently resurrect a preference the user last saw
      // being withdrawn.
      await setAmbientHost(pattern, false);
      setSurfaceStatus(sharedHostNote(await surfaceRows(), origin) ?? "");
    } else {
      setSurfaceStatus("Page access could not be revoked.");
    }
  }
  await refreshSurfaces();
}

function onAmbientChange(event: Event): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.dataset["action"] !== "ambient") {
    return Promise.resolve();
  }
  const pattern = target.dataset["pattern"] ?? "";
  if (pattern === "") {
    return Promise.resolve();
  }
  const on = target.checked;
  ambientWrites = ambientWrites
    .catch(() => undefined)
    .then(async () => {
      await setAmbientHost(pattern, on);
    });
  return ambientWrites;
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("pair")?.addEventListener("click", () => void pair());
  document.getElementById("unpair")?.addEventListener("click", () => void onUnpairClick());
  document.getElementById("unpair-cancel")?.addEventListener("click", () => disarmUnpair());
  document.getElementById("surface-add")?.addEventListener("click", () => void addSurface());
  document
    .getElementById("surface-list")
    ?.addEventListener("click", (event) => void onSurfaceClick(event));
  document
    .getElementById("surface-list")
    ?.addEventListener("change", (event) => void onAmbientChange(event));
  void refreshConnection();
  void refreshSurfaces();
});
