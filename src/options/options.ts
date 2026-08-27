import { getAmbientHosts, setAmbientHost } from "../background/ambient-prefs.ts";
import { isIndexSearchEnabled, setIndexSearchEnabled } from "../background/index-pref.ts";
import { getOrigins, setOrigins } from "../background/origin-store.ts";
import { isPreviewEnabled, setPreviewEnabled } from "../background/preview-pref.ts";
import { getAllCommands } from "../browser/commands.ts";
import { hasOrigin, removeOrigin, requestOrigin } from "../browser/permissions.ts";
import { isFirefoxRuntime, sendMessage } from "../browser/runtime.ts";
import { isBriefLogEntry } from "../shared/brief-log.ts";
import {
  type DiscoverResponse,
  type EgressWindowResponse,
  isConnectionResponse,
  isEgressWindowSuccess,
  type PairResponse,
} from "../shared/messages.ts";
import {
  hostPermissionPattern,
  isProduct,
  parseConfiguredOrigin,
  removeConfiguredOrigin,
  upsertOrigin,
} from "../shared/origins.ts";
import { BUILT_IN_SURFACES } from "../shared/recognise/index.ts";
import { SELF_HOSTABLE_PRODUCTS } from "../shared/recognise/registry.ts";
import type { ConfiguredOrigin } from "../shared/types.ts";
import { renderBriefLog } from "./brief-log-view.ts";
import { renderLedgerSummary } from "./ledger-summary-view.ts";
import { applyStages, healthLine, stagesFrom } from "./setup-view.ts";
import { renderShortcuts, shortcutRows, shortcutsHint } from "./shortcuts-view.ts";
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
  if (!isConnectionResponse(res)) {
    return;
  }
  applyStages(document, stagesFrom(res));
  const health = document.getElementById("health-line");
  if (health !== null) {
    health.textContent = healthLine(res, Date.now());
  }
  const status = document.getElementById("connection-status");
  if (status !== null) {
    // Stage 2's detail line stays as it was; healthLine above carries the state.
    status.textContent = res.paired ? `Paired as "${res.label}".` : "";
  }
  if (!res.paired) {
    disarmUnpair();
  }
  const trustOrigin = document.getElementById("trust-origin");
  if (trustOrigin !== null) {
    trustOrigin.textContent = res.paired ? res.origin : "your local gateway (not paired yet)";
  }
}

/**
 * The trust panel's second half. Read-only, and it never claims verification —
 * that is an explicit action, and its result belongs on the Activity page.
 *
 * `oursCount` comes from the partition the worker computed with the stored
 * device label, so this line and the page cannot disagree about what is ours.
 */
async function refreshLedgerSummary(): Promise<void> {
  const host = document.getElementById("trust-ledger");
  if (host === null) {
    return;
  }
  let res: EgressWindowResponse | undefined;
  try {
    res = (await sendMessage({ kind: "egress-window" })) as EgressWindowResponse | undefined;
  } catch {
    // The message channel rejected (service worker asleep or erroring). Same
    // posture as `refreshConnection`: report, never throw. An unguarded await
    // here surfaces as an unhandled rejection that fails the whole test run,
    // and in the browser would abandon the rest of the panel's render.
    renderLedgerSummary(host, { state: "error", reason: "unreachable" });
    return;
  }
  if (res !== undefined && isEgressWindowSuccess(res)) {
    const { ours, others, unattributable } = res.partition;
    renderLedgerSummary(host, {
      state: "loaded",
      // Actions, not rows: the partition has already had outcome markers split
      // out of it, so this counts what the gateway DID rather than what it wrote.
      actionsShown: ours.length + others.length + unattributable.length,
      oursCount: ours.length,
      rowsTruncated: res.rowsTruncated,
    });
    return;
  }
  // A null, a stale reply, or a response for a different request must not be read
  // as a window — `typeof res === "object"` does NOT reject null, which is how a
  // null reply used to reach `res.kind` and throw.
  const failure =
    res !== undefined &&
    typeof res === "object" &&
    res !== null &&
    (res as { kind?: unknown }).kind === "egress-window"
      ? (res as Extract<EgressWindowResponse, { ok: false }>)
      : null;
  if (failure !== null && failure.ok === false) {
    renderLedgerSummary(
      host,
      failure.scopeGap === undefined
        ? { state: "error", reason: failure.reason }
        : { state: "error", reason: failure.reason, scopeGap: failure.scopeGap },
    );
    return;
  }
  // `ok: true` that failed the guard above is malformed — reported, never read.
  renderLedgerSummary(host, { state: "error", reason: "server_error" });
}

async function refreshConnection(): Promise<void> {
  try {
    renderConnection(await sendMessage({ kind: "connection-status" }));
  } catch {
    // The message channel rejected (service worker asleep or erroring) —
    // leave the shipped HTML defaults in place (stages 2 and 3 locked) rather
    // than throwing away the render. Without this, a silent failure here
    // would leave every stage rendering fully active — including Unpair and
    // page-access controls — on a profile the extension never confirmed was
    // paired.
  }
}

async function refreshShortcuts(): Promise<void> {
  const list = document.getElementById("shortcut-list");
  const hint = document.getElementById("shortcut-hint");
  if (list === null || hint === null) {
    return;
  }
  // Read directly from the browser seam, not through the service worker: Options
  // is an extension page with its own access to chrome.commands, so a message
  // round-trip would add a failure mode without adding information.
  //
  // The try/catch is REQUIRED, not decoration. This is called as
  // `void refreshShortcuts()`, which attaches no rejection handler — a rejecting
  // `getAllCommands` would surface as an unhandled rejection and fail the Vitest
  // run. Same rule `refreshConnection` above already follows.
  try {
    list.replaceChildren(renderShortcuts(document, shortcutRows(await getAllCommands())));
  } catch {
    // An empty list, not a half-rendered one. The hint below still renders, so a
    // user who cannot see their bindings is at least told where to go and set them.
    list.replaceChildren();
  }
  // Outside the try on purpose: isFirefoxRuntime has its own catch and cannot
  // throw, and the hint is the more useful half when the binding read failed.
  hint.textContent = shortcutsHint(isFirefoxRuntime());
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

function isDiscoverResponse(v: unknown): v is DiscoverResponse {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "discover";
}

function setDiscoverStatus(text: string): void {
  const el = document.getElementById("discover-status");
  if (el !== null) {
    el.textContent = text;
  }
}

async function discover(): Promise<void> {
  const originEl = document.getElementById("origin");
  if (!(originEl instanceof HTMLInputElement)) {
    return;
  }
  setDiscoverStatus("Looking…");
  try {
    const res = await sendMessage({ kind: "discover" });
    if (!isDiscoverResponse(res)) {
      setDiscoverStatus("Unexpected response.");
      return;
    }
    if (res.origin === null) {
      setDiscoverStatus("No gateway found. Start Nimbus, or enter its URL below.");
      return;
    }
    originEl.value = res.origin;
    setDiscoverStatus(`Found Nimbus at ${res.origin}.`);
  } catch {
    setDiscoverStatus("Couldn't reach the extension — please try again.");
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
 *  second write would silently drop the first one's edit. Both the toggle
 *  handler and the revoke path fall through here — `setAmbientHost` does no
 *  serialisation of its own, so a second call site bypassing this chain would
 *  reopen the same lost-update window this chain exists to close. */
let ambientWrites: Promise<void> = Promise.resolve();

function mutateAmbient(pattern: string, on: boolean): Promise<void> {
  ambientWrites = ambientWrites
    .catch(() => undefined)
    .then(async () => {
      await setAmbientHost(pattern, on);
    });
  return ambientWrites;
}

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
  const rows = await surfaceRows();
  const list = document.getElementById("surface-list");
  if (list !== null) {
    list.replaceChildren(renderSurfaceList(document, rows));
  }
  const hosts = document.getElementById("trust-hosts");
  if (hosts !== null) {
    const granted = rows.filter((r) => r.granted).map((r) => r.origin);
    // textContent, never innerHTML — these strings are user-supplied origins.
    hosts.textContent = granted.length === 0 ? "no sites yet" : granted.join(", ");
  }
}

/**
 * Fill the self-hosted product picker from the registry.
 *
 * The five options used to be hardcoded in `options.html`, guarded by nothing:
 * `options.test.ts` writes its own `<select>` fixture, so a product added to
 * `PRODUCT_IDS` and forgotten here passed every test and was simply un-addable as a
 * self-hosted origin. Deriving it also keeps a SaaS-only product out, which is not a
 * tidiness point — offering one invites a user to configure an origin that cannot exist.
 */
function fillProductPicker(): void {
  const el = document.getElementById("surface-product");
  if (!(el instanceof HTMLSelectElement)) {
    return;
  }
  for (const rule of SELF_HOSTABLE_PRODUCTS) {
    const option = document.createElement("option");
    option.value = rule.product;
    option.textContent = rule.name;
    el.append(option);
  }
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
      // being withdrawn. Routed through mutateAmbient — same storage key the
      // toggle handler writes, so it must go through the same chain.
      await mutateAmbient(pattern, false);
      setSurfaceStatus(sharedHostNote(await surfaceRows(), origin) ?? "");
    } else {
      setSurfaceStatus("Page access could not be revoked.");
    }
  }
  await refreshSurfaces();
}

/**
 * Paint the disclosure log from the worker's copy.
 *
 * The try/catch is REQUIRED, same rule as `refreshShortcuts` and
 * `refreshPreviewToggle`: this is `void`-called from DOMContentLoaded, so a
 * rejecting read would surface as an unhandled rejection and fail the Vitest
 * run. On a failed read the section stays empty rather than claiming nothing has
 * ever been sent — which would be the one wrong thing to say here.
 */
async function refreshBriefLog(): Promise<void> {
  const host = document.getElementById("brief-log");
  if (host === null) {
    return;
  }
  try {
    const res: unknown = await sendMessage({ kind: "brief-log" });
    const entries = (res as { entries?: unknown }).entries;
    renderBriefLog(host, Array.isArray(entries) ? entries.filter(isBriefLogEntry) : []);
  } catch {
    /* leave the section as it is — see the doc comment */
  }
}

async function onClearBriefLog(): Promise<void> {
  try {
    await sendMessage({ kind: "brief-log-clear" });
  } catch {
    /* the refresh below still repaints from whatever the worker holds */
  }
  await refreshBriefLog();
}

function previewToggle(): HTMLInputElement | null {
  const el = document.getElementById("preview-toggle");
  return el instanceof HTMLInputElement ? el : null;
}

/**
 * Paints the switch from the stored preference.
 *
 * The try/catch is REQUIRED, not decoration — same rule as `refreshShortcuts`
 * above: this is `void`-called from DOMContentLoaded, so a rejecting read would
 * surface as an unhandled rejection and fail the Vitest run. On a failed read we
 * leave the checkbox at its markup default (checked), which matches
 * `isPreviewEnabled`'s own fail-safe: an unreadable preference means the preview
 * SHOWS, because a preview the user switched off is a minor annoyance and a send
 * without one is the outcome this whole surface exists to prevent.
 */
async function refreshPreviewToggle(): Promise<void> {
  const toggle = previewToggle();
  if (toggle === null) {
    return;
  }
  try {
    toggle.checked = await isPreviewEnabled();
  } catch {
    toggle.checked = true;
  }
}

function onPreviewChange(): Promise<void> {
  const toggle = previewToggle();
  return toggle === null ? Promise.resolve() : setPreviewEnabled(toggle.checked);
}

function indexToggle(): HTMLInputElement | null {
  const el = document.getElementById("index-toggle");
  return el instanceof HTMLInputElement ? el : null;
}

/**
 * On a failed read we leave the checkbox at its markup default (UNCHECKED),
 * matching `isIndexSearchEnabled`'s own fail-safe. This is the opposite of
 * `refreshPreviewToggle` above, deliberately: an unreadable preference must
 * never present a wider search as switched on.
 */
async function refreshIndexToggle(): Promise<void> {
  const toggle = indexToggle();
  if (toggle === null) {
    return;
  }
  try {
    toggle.checked = await isIndexSearchEnabled();
  } catch {
    toggle.checked = false;
  }
}

function onIndexChange(): Promise<void> {
  const toggle = indexToggle();
  return toggle === null ? Promise.resolve() : setIndexSearchEnabled(toggle.checked);
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
  return mutateAmbient(pattern, target.checked);
}

document.addEventListener("DOMContentLoaded", () => {
  fillProductPicker();
  document.getElementById("discover")?.addEventListener("click", () => void discover());
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
  document.getElementById("preview-toggle")?.addEventListener("change", () => {
    void onPreviewChange();
  });
  document.getElementById("index-toggle")?.addEventListener("change", () => {
    void onIndexChange();
  });
  // Opens in a tab of its own — a brief run outlives this page too, and the
  // composer needs the room. Click-driven, deliberately not a `commands` entry.
  document.getElementById("open-brief")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("brief.html") }).catch(() => undefined);
  });
  document.getElementById("brief-log")?.addEventListener("click", (event) => {
    if (event.target instanceof HTMLButtonElement && event.target.id === "clear-brief-log") {
      void onClearBriefLog();
    }
  });
  void refreshConnection();
  void refreshLedgerSummary();
  void refreshSurfaces();
  document.getElementById("trust-ledger-open")?.addEventListener("click", () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("ledger.html") }).catch(() => undefined);
  });
  void refreshShortcuts();
  void refreshPreviewToggle();
  void refreshIndexToggle();
  void refreshBriefLog();
});
