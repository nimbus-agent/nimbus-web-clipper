// Typed message envelope passed between the popup/content scripts and the
// background service worker via chrome.runtime messaging. External data crossing
// the messaging boundary is `unknown` until narrowed by a guard here — never `any`.

import { isCanonicalRejection } from "./canonical.ts";
import { isSourceShape } from "./clip.ts";
import { CONNECTOR_STATES, type ConnectorHealth } from "./connector-health.ts";
import type {
  EgressError,
  EgressPartition,
  EgressProof,
  EgressVerdict,
  LedgerOutcome,
} from "./egress.ts";
import { gapNotesFrom, laneFindingsFrom, synthesisFrom } from "./findings-guards.ts";
import type { ClipPreview } from "./preview.ts";
import type { QueuedClipView } from "./queue.ts";
import { isRelatedHit } from "./related.ts";
import { safeHttpUrl } from "./safe-url.ts";
import { isNormalisedTerm } from "./term.ts";
import {
  AGENT_ERRORS,
  AGENT_LANES,
  type AgentError,
  type AgentLane,
  type CaptureError,
  type CaptureResult,
  type ClipError,
  type FetchError,
  type FetchOutcome,
  type FileResolution,
  type LaneState,
  type PairError,
  RESOLVE_MATCH_KINDS,
  type Recognition,
  type RelatedError,
  type RelatedHit,
  type ResolveCandidate,
  type ResolvedItem,
  type ResolveError,
  type ResolveOutcome,
  type ScopeGap,
} from "./types.ts";

/** A liveness probe the popup sends to confirm the service worker is responsive. */
export interface PingMessage {
  readonly kind: "ping";
}

export interface PingResponse {
  readonly ok: true;
}

export type ExtensionMessage = PingMessage;

export function isPingMessage(value: unknown): value is PingMessage {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "ping"
  );
}

export interface CaptureRequest {
  readonly kind: "capture";
  /** The panel's PINNED page. Untrusted — it arrives from a content script — so
   *  it is guarded here and re-checked against the live tab in capture-tab.ts. */
  readonly pageUrl: string;
}

/**
 * `preview: null` means the user switched the 1.3 preview off, so the panel
 * sends the clip without a confirm step. The WORKER decides this, because the
 * pref lives in `chrome.storage` (background/preview-pref.ts) and the panel is a
 * content script — and because keeping preview construction in one place is what
 * stops a second code path from building a payload preview differently.
 */
export type CaptureResponse =
  | {
      readonly kind: "capture";
      readonly ok: true;
      readonly capture: CaptureResult;
      readonly preview: ClipPreview | null;
    }
  | { readonly kind: "capture"; readonly ok: false; readonly reason: CaptureError };

export interface PairRequest {
  readonly kind: "pair";
  readonly origin: string;
  readonly code: string;
}

export interface ClipRequest {
  readonly kind: "clip";
  readonly capture: CaptureResult;
  readonly tags: string[];
}

export interface RelatedRequest {
  readonly kind: "related";
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly selection?: string;
  /** The indexed item the panel has already resolved this page to. Untrusted —
   *  it arrives from a content script — so it is guarded here like every other
   *  cross-boundary value. */
  readonly itemId?: string;
}

export interface ResolveRequest {
  readonly kind: "resolve";
  readonly pageUrl: string;
  readonly title?: string;
}

/**
 * The ambient cue asking for the panel on the tab it is mounted in.
 *
 * Carries NO payload on purpose. The cue runs in the page, so anything it sent
 * would be attacker-controllable on a hostile site; the worker instead uses the
 * sender's own tab, which the browser supplies and the page cannot forge.
 */
export interface CueOpenRequest {
  readonly kind: "cue-open";
}

export interface FetchRequest {
  readonly kind: "fetch";
  readonly pageUrl: string;
}

/**
 * Classify a URL — nothing more. The panel sends this while watching for a
 * client-side navigation, to learn whether the tab is still showing the item its
 * header names.
 *
 * Deliberately NOT a resolve: `handleRecognise` runs the pure recogniser and
 * makes no gateway call, so a navigation check costs no network and no token.
 */
export interface RecogniseRequest {
  readonly kind: "recognise";
  readonly pageUrl: string;
}

/**
 * What a lane is being asked about, beyond the page it was asked from. Shared by
 * both agent messages because the run and the poll must agree exactly: they key
 * the same cache entry, so a poll that omitted a field the run carried would look
 * up a different subject and report `collapsed` forever.
 *
 * Both fields arrive from a CONTENT SCRIPT and are therefore untrusted, which is
 * why each is narrowed below rather than merely typed here.
 */
interface LaneInput {
  /**
   * The candidate the user picked out of an ambiguous resolve (C2.5). Honoured
   * by the handler only after it confirms the id appears in the candidate set
   * that resolve itself produced — an id the gateway never offered is refused.
   */
  readonly itemId?: string;
  /**
   * The selected term for a `{input:"term"}` lane. Already normalised by
   * `normaliseTerm` (shared/term.ts) before it is sent; the guard re-checks that,
   * so an unnormalised or over-long term never reaches the handler.
   */
  readonly term?: string;
}

/** Expand a lane: run its agent (or return the cached state if one already
 *  exists for this subject and lane — expanding a `done` lane must not re-invoke). */
export interface AgentRunRequest extends LaneInput {
  readonly kind: "agent-run";
  readonly lane: AgentLane;
  readonly pageUrl: string;
}

/** Poll a lane's current state. Read-only — never invokes. */
export interface AgentStateRequest extends LaneInput {
  readonly kind: "agent-state";
  readonly lane: AgentLane;
  readonly pageUrl: string;
}

export interface QueueListRequest {
  readonly kind: "queue-list";
}

export interface QueueRetryRequest {
  readonly kind: "queue-retry";
  readonly url?: string;
}

export interface QueueRemoveRequest {
  readonly kind: "queue-remove";
  readonly url: string;
}

export interface ConnectionStatusRequest {
  readonly kind: "connection-status";
}

export interface UnpairRequest {
  readonly kind: "unpair";
}

/** Ask the service worker to find a local gateway (roadmap 3.5). */
export interface DiscoverRequest {
  readonly kind: "discover";
}

/** Ask the worker which open tabs may be offered as brief sources. */
export interface BriefTabsRequest {
  readonly kind: "brief-tabs";
}

/**
 * One source the composer picked. ONE ordered list rather than `tabIds` plus
 * `passageUrls`: the order the composer displayed is then the order the gateway
 * is told, with no merge rule in the handler to get wrong.
 */
export type BriefPick =
  | { readonly kind: "tab"; readonly id: number }
  | { readonly kind: "passages"; readonly url: string };

/**
 * Start a brief.
 *
 * `picks` arrives from an extension page, which is same-origin and not a
 * content script — but it is still a message payload, and the worker will
 * `executeScript` into every tab id in it. So it is narrowed like every other
 * cross-boundary value: a tab id must be an integer, a passage url must pass
 * `safeHttpUrl`, and the list is at least one and never more than the
 * gateway's source cap. A forged id cannot widen what the worker may inject into
 * (host permission still gates that), but an unbounded list would let one
 * message fan out into arbitrarily many injections.
 */
export interface BriefStartRequest {
  readonly kind: "brief-start";
  readonly question: string;
  readonly picks: readonly BriefPick[];
  /**
   * Ask the gateway to ALSO search its index. Required, not optional: it arrives
   * from a page script like every other field here, and an absent boolean would
   * default silently — the one thing a control over egress must never do.
   */
  readonly useIndex: boolean;
}

/** Read a brief's current state. Read-only — never invokes. */
export interface BriefStateRequest {
  readonly kind: "brief-state";
  readonly id?: string;
}

export interface BriefSaveRequest {
  readonly kind: "brief-save";
  readonly id: string;
}

export interface BriefLogRequest {
  readonly kind: "brief-log";
}

export interface BriefLogClearRequest {
  readonly kind: "brief-log-clear";
}

/**
 * Drop collected passages: one passage when `at` names its capture instant,
 * otherwise every passage held for that page.
 *
 * One message for both because they are one gesture with two scopes, and the
 * store applies them through the same serialized read-modify-write. `url` is
 * narrowed by `safeHttpUrl` for the same reason a passage pick is — the same
 * string reaches the same collection.
 */
export interface PassageDropRequest {
  readonly kind: "passage-drop";
  readonly url: string;
  readonly at?: number;
}

/** Empty the whole collection. Carries nothing: there is nothing to name. */
export interface PassageClearRequest {
  readonly kind: "passage-clear";
}

/**
 * Read a page of the gateway's egress ledger. Read-only; causes no egress of its
 * own, and persists nothing — every row rendered comes from the gateway on that
 * read.
 */
export interface EgressWindowRequest {
  readonly kind: "egress-window";
  /** Cursor: return rows older than this ledger id. Absent means the newest page. */
  readonly before?: number;
}

export interface EgressVerifyRequest {
  readonly kind: "egress-verify";
}

export interface EgressProveRequest {
  readonly kind: "egress-prove";
  readonly since?: number;
  readonly until?: number;
}

/** Every way a ledger read can fail, plus the one the client raises itself. */
export type EgressFailure = EgressError | "not_paired";

export type EgressWindowResponse =
  | {
      readonly kind: "egress-window";
      readonly ok: true;
      readonly partition: EgressPartition;
      /** This browser's own device label — the one the partition was computed
       *  with, so the page names other clients without guessing at ours. */
      readonly ourLabel: string;
      /**
       * How each action ended, keyed by that action's own `rowHash`.
       *
       * A missing key means the outcome was NOT RECORDED — never that the fetch
       * is still running. A gateway older than the outcome marker writes rows
       * indistinguishable from ones whose marker was lost.
       */
      readonly outcomes: Readonly<Record<string, LedgerOutcome>>;
      readonly rowsTotal: number;
      readonly rowsTruncated: boolean;
    }
  | {
      readonly kind: "egress-window";
      readonly ok: false;
      readonly reason: EgressFailure;
      readonly scopeGap?: ScopeGap;
    };

export type EgressVerifyResponse =
  | { readonly kind: "egress-verify"; readonly ok: true; readonly verdict: EgressVerdict }
  | {
      readonly kind: "egress-verify";
      readonly ok: false;
      readonly reason: EgressFailure;
      readonly scopeGap?: ScopeGap;
    };

export type EgressProveResponse =
  | { readonly kind: "egress-prove"; readonly ok: true; readonly proof: EgressProof }
  | {
      readonly kind: "egress-prove";
      readonly ok: false;
      readonly reason: EgressFailure;
      readonly scopeGap?: ScopeGap;
    };

/** A ledger id from a page script: absent, or a non-negative integer. */
function isOptionalLedgerId(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0);
}

export function isEgressWindowRequest(v: unknown): v is EgressWindowRequest {
  return isObject(v) && v["kind"] === "egress-window" && isOptionalLedgerId(v["before"]);
}

/**
 * Is this a well-formed successful window response?
 *
 * `sendMessage` is typed `unknown` at the seam, and a hand-rolled
 * `typeof res === "object"` check does NOT reject `null` — `typeof null` is
 * `"object"`, so a null reply reached `res.kind` and threw. A malformed success
 * (`ok: true` with no partition) threw at the destructure instead.
 */
export function isEgressWindowSuccess(
  v: unknown,
): v is Extract<EgressWindowResponse, { ok: true }> {
  if (!isObject(v) || v["kind"] !== "egress-window" || v["ok"] !== true) {
    return false;
  }
  const partition = v["partition"];
  if (!isObject(partition)) {
    return false;
  }
  for (const bucket of ["ours", "others", "unattributable"]) {
    if (!Array.isArray(partition[bucket])) {
      return false;
    }
  }
  return typeof v["rowsTruncated"] === "boolean" && isObject(v["outcomes"]);
}

export function isEgressVerifyRequest(v: unknown): v is EgressVerifyRequest {
  return isObject(v) && v["kind"] === "egress-verify";
}

export function isEgressProveRequest(v: unknown): v is EgressProveRequest {
  return (
    isObject(v) &&
    v["kind"] === "egress-prove" &&
    isOptionalLedgerId(v["since"]) &&
    isOptionalLedgerId(v["until"])
  );
}

export type ExtensionRequest =
  | CaptureRequest
  | PairRequest
  | ClipRequest
  | RelatedRequest
  | ResolveRequest
  | CueOpenRequest
  | FetchRequest
  | RecogniseRequest
  | AgentRunRequest
  | AgentStateRequest
  | QueueListRequest
  | QueueRetryRequest
  | QueueRemoveRequest
  | ConnectionStatusRequest
  | UnpairRequest
  | DiscoverRequest
  | BriefTabsRequest
  | BriefStartRequest
  | BriefStateRequest
  | BriefSaveRequest
  | BriefLogRequest
  | BriefLogClearRequest
  | PassageDropRequest
  | PassageClearRequest
  | EgressWindowRequest
  | EgressVerifyRequest
  | EgressProveRequest;

export type PairResponse =
  | { readonly kind: "pair"; readonly ok: true; readonly label: string }
  | { readonly kind: "pair"; readonly ok: false; readonly reason: PairError };

export type ClipResponse =
  | {
      readonly kind: "clip";
      readonly ok: true;
      readonly status: "created" | "updated";
      readonly bookmarked: boolean;
    }
  | {
      readonly kind: "clip";
      readonly ok: false;
      readonly reason: ClipError;
      readonly queued?: boolean;
    };

export type RelatedResponse =
  | { readonly kind: "related"; readonly ok: true; readonly items: RelatedHit[] }
  | { readonly kind: "related"; readonly ok: false; readonly reason: RelatedError };

export type ResolveResponse =
  | {
      readonly kind: "resolve";
      readonly ok: true;
      readonly recognition: Recognition;
      readonly outcome: ResolveOutcome;
      /**
       * The health of the connector behind a recognised DASHBOARD, and only there —
       * absent on every other surface, because only the service lanes are gated on it.
       * `unknown` covers both "the read failed" and "the gateway listed no row for this
       * connector", which are indistinguishable from here and mean the same thing to the
       * panel: do not claim to know.
       */
      readonly connector?: ConnectorHealth;
      /**
       * The lanes the paired gateway can actually serve on THIS page — the roster
       * it publishes, narrowed by the version floor the item arm needs.
       *
       * ABSENT means "filter nothing", and the panel must read it as exactly that.
       * It never means "no lanes": withholding everything because a capability read
       * failed is a far larger claim than the one we failed to check. Same
       * fail-open as `connector`, above.
       *
       * Absent is NOT the same as "we did not learn", though, and reading it that
       * way is how the wrong lanes get offered. A roster read that failed outright
       * still sends a PRESENT, narrowed list on a surface whose lanes need an arm
       * only a new enough gateway serves (`issue`, `incident`) — the lanes we could
       * not confirm are withheld, the rest are not. It is `offeredLanes`
       * (`background/agents-capability.ts`) that decides which of the two a failed
       * read produces, per surface, and the reasoning lives there.
       */
      readonly offeredLanes?: readonly AgentLane[];
      /**
       * What the file probe learned, on a `file` surface and only there.
       *
       * Absent on every other surface. Unlike `offeredLanes`, absence here is NOT
       * fail-open: the panel offers file lanes only on `{ kind: "found" }`, so an
       * absent value withholds. That asymmetry is deliberate — a lane list we failed
       * to narrow is still a list we may offer, but a file we failed to place has no
       * subject to answer about at all.
       */
      readonly file?: FileResolution;
    }
  | {
      readonly kind: "resolve";
      readonly ok: false;
      readonly recognition: Recognition;
      readonly reason: ResolveError;
      readonly scopeGap?: ScopeGap;
    };

/**
 * The outer `ok` is not ceremony. The route's own `catch` — a `chrome.storage`
 * read failing in `getOrigins()` — has no recognition to report, and inventing
 * one would be indistinguishable from a legitimately unrecognised page. The
 * watcher that consumes this must be able to tell "there is no item here" from
 * "I could not look", because reading the second as the first raises a notice
 * claiming the user navigated away when they did not. Same reason
 * `ResolveResponse` and `FetchResponse` carry one.
 */
export type RecognitionResponse =
  | { readonly kind: "recognition"; readonly ok: true; readonly recognition: Recognition }
  | { readonly kind: "recognition"; readonly ok: false; readonly reason: "server_error" };

export type FetchResponse =
  | {
      readonly kind: "fetch";
      readonly ok: true;
      readonly recognition: Recognition;
      readonly outcome: FetchOutcome;
    }
  | {
      readonly kind: "fetch";
      readonly ok: false;
      readonly recognition: Recognition;
      readonly reason: FetchError;
      readonly scopeGap?: ScopeGap;
    };

/** Both `agent-run` and `agent-state` answer with the lane's current state —
 *  starting or polling converge on the same shape the panel repaints from. */
export interface AgentStateResponse {
  readonly kind: "agent-state";
  readonly lane: AgentLane;
  readonly state: LaneState;
}

export type QueueResponse = { readonly kind: "queue"; readonly items: QueuedClipView[] };

export type ConnectionResponse =
  | { readonly kind: "connection"; readonly paired: false }
  | {
      readonly kind: "connection";
      readonly paired: true;
      readonly label: string;
      readonly origin: string;
      readonly pairedAt: number;
      /** Absent when no clip has ever succeeded — including on a fresh pairing. */
      readonly lastClipAt?: number;
      readonly queueDepth: number;
      readonly reachable: boolean;
      readonly stale: boolean;
    };

export type DiscoverResponse = {
  readonly kind: "discover";
  /** The origin that answered, or null — null means "ask the user", not "error". */
  readonly origin: string | null;
};

export type ExtensionResponse =
  | CaptureResponse
  | PairResponse
  | ClipResponse
  | RelatedResponse
  | ResolveResponse
  | FetchResponse
  | RecognitionResponse
  | AgentStateResponse
  | QueueResponse
  | ConnectionResponse
  | DiscoverResponse;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isPreviewField(v: unknown): v is { readonly label: string; readonly value: string } {
  return isObject(v) && typeof v["label"] === "string" && typeof v["value"] === "string";
}

function isClipPreview(v: unknown): v is ClipPreview {
  return (
    isObject(v) &&
    Array.isArray(v["fields"]) &&
    v["fields"].every(isPreviewField) &&
    typeof v["excerpt"] === "string" &&
    typeof v["bodyLength"] === "number" &&
    typeof v["truncated"] === "boolean"
  );
}

export function isCaptureRequest(v: unknown): v is CaptureRequest {
  return isObject(v) && v["kind"] === "capture" && typeof v["pageUrl"] === "string";
}

export function isCaptureResponse(v: unknown): v is CaptureResponse {
  if (!isObject(v) || v["kind"] !== "capture") {
    return false;
  }
  if (v["ok"] === true) {
    return isCaptureResult(v["capture"]) && (v["preview"] === null || isClipPreview(v["preview"]));
  }
  return v["ok"] === false && typeof v["reason"] === "string";
}

export function isPairRequest(v: unknown): v is PairRequest {
  return (
    isObject(v) &&
    v["kind"] === "pair" &&
    typeof v["origin"] === "string" &&
    typeof v["code"] === "string"
  );
}

function isCaptureResult(v: unknown): v is CaptureResult {
  return (
    isObject(v) &&
    typeof v["url"] === "string" &&
    (v["canonicalUrl"] === undefined || typeof v["canonicalUrl"] === "string") &&
    (v["canonicalRejected"] === undefined || isCanonicalRejection(v["canonicalRejected"])) &&
    // Deliberately shallow. This value comes from a script running IN THE
    // PAGE, and `buildClipSource` rebuilds it from the five known fields
    // before anything is sent — so a malformed member is dropped there rather
    // than costing the user the whole capture here, which is the same trade
    // the gateway's own validator makes. What this rung IS for is refusing a
    // `source` that is not an object at all: that is caller error rather than
    // a page being creative.
    (v["source"] === undefined || isSourceShape(v["source"])) &&
    typeof v["title"] === "string" &&
    (v["mode"] === "article" || v["mode"] === "selection") &&
    typeof v["body"] === "string" &&
    typeof v["readableFound"] === "boolean"
  );
}

export function isClipRequest(v: unknown): v is ClipRequest {
  return (
    isObject(v) &&
    v["kind"] === "clip" &&
    isCaptureResult(v["capture"]) &&
    Array.isArray(v["tags"]) &&
    v["tags"].every((t) => typeof t === "string")
  );
}

export function isRelatedRequest(v: unknown): v is RelatedRequest {
  return (
    isObject(v) &&
    v["kind"] === "related" &&
    (v["title"] === undefined || typeof v["title"] === "string") &&
    (v["canonicalUrl"] === undefined || typeof v["canonicalUrl"] === "string") &&
    (v["selection"] === undefined || typeof v["selection"] === "string") &&
    (v["itemId"] === undefined || typeof v["itemId"] === "string")
  );
}

export function isRelatedResponse(v: unknown): v is RelatedResponse {
  if (!isObject(v) || v["kind"] !== "related") {
    return false;
  }
  if (v["ok"] === true) {
    return Array.isArray(v["items"]) && v["items"].every(isRelatedHit);
  }
  if (v["ok"] === false) {
    return typeof v["reason"] === "string";
  }
  return false;
}

export function isResolveRequest(v: unknown): v is ResolveRequest {
  return (
    isObject(v) &&
    v["kind"] === "resolve" &&
    typeof v["pageUrl"] === "string" &&
    (v["title"] === undefined || typeof v["title"] === "string")
  );
}

export function isCueOpenRequest(v: unknown): v is CueOpenRequest {
  return isObject(v) && v["kind"] === "cue-open";
}

export function isFetchRequest(v: unknown): v is FetchRequest {
  return isObject(v) && v["kind"] === "fetch" && typeof v["pageUrl"] === "string";
}

export function isRecogniseRequest(v: unknown): v is RecogniseRequest {
  return isObject(v) && v["kind"] === "recognise" && typeof v["pageUrl"] === "string";
}

function isCandidate(v: unknown): v is ResolveCandidate {
  return (
    isObject(v) &&
    typeof v["id"] === "string" &&
    typeof v["service"] === "string" &&
    typeof v["type"] === "string" &&
    typeof v["title"] === "string" &&
    (v["url"] === null || typeof v["url"] === "string")
  );
}

export function isResolvedItem(v: unknown): v is ResolvedItem {
  return isCandidate(v) && typeof (v as { modifiedAt?: unknown })["modifiedAt"] === "number";
}

/**
 * Guards the DOMAIN outcome crossing the SW→panel boundary — not the wire shape.
 * The wire's `modified_at` is renamed in gateway-client.ts and never reaches here.
 */
function isResolveOutcome(v: unknown): v is ResolveOutcome {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "found") {
    return (
      isResolvedItem(v["item"]) &&
      typeof v["matchKind"] === "string" &&
      (RESOLVE_MATCH_KINDS as readonly string[]).includes(v["matchKind"])
    );
  }
  if (v["kind"] === "not-indexed" || v["kind"] === "unresolvable") {
    return typeof v["fetchable"] === "boolean";
  }
  if (v["kind"] !== "ambiguous") {
    return false;
  }
  return (
    typeof v["fetchable"] === "boolean" &&
    typeof v["truncated"] === "boolean" &&
    Array.isArray(v["candidates"]) &&
    v["candidates"].every(isCandidate)
  );
}

/** Exported so `agent-run-store.ts`'s storage guard can reuse this instead of
 *  hand-rolling a second copy — the exact drift class (a predicate that claims
 *  `v is X` while checking fewer fields than X has) that already shipped once
 *  in this repo as `isResolvedItem`. */
export function isScopeGap(v: unknown): v is ScopeGap {
  return (
    isObject(v) &&
    typeof v["label"] === "string" &&
    typeof v["required"] === "string" &&
    Array.isArray(v["granted"]) &&
    v["granted"].every((s) => typeof s === "string")
  );
}

function isForgeFile(v: unknown): boolean {
  // ABSENT is valid — every non-file recognition omits it. Present-but-malformed is not:
  // this value reaches a gateway query string, so a non-string here would be coerced into
  // one silently.
  if (v === undefined) {
    return true;
  }
  return isObject(v) && typeof v["repo"] === "string" && typeof v["refAndPath"] === "string";
}

function isRecognition(v: unknown): v is Recognition {
  if (!isObject(v)) {
    return false;
  }
  if (v["ok"] === true) {
    return (
      typeof v["product"] === "string" &&
      typeof v["kind"] === "string" &&
      typeof v["label"] === "string" &&
      typeof v["ref"] === "string" &&
      typeof v["resolveUrl"] === "string" &&
      isForgeFile(v["forgeFile"])
    );
  }
  return v["ok"] === false && typeof v["reason"] === "string";
}

/**
 * Unlike `parseConnectorHealth` (which COERCES an unrecognised upstream state to
 * `"unknown"`, because that side reads the gateway's own HTTP body), this guard
 * REJECTS a `state` outside `CONNECTOR_STATES` outright. The producer here is our
 * own service worker, not an external gateway, so a `connector.state` this guard
 * has never seen means a bug in this client, not an older or unfamiliar gateway —
 * and a bug is exactly what a boundary guard must refuse, not paper over.
 */
function isConnectorHealth(v: unknown): v is ConnectorHealth {
  if (!isObject(v) || typeof v["state"] !== "string") {
    return false;
  }
  if (!(CONNECTOR_STATES as readonly string[]).includes(v["state"])) {
    return false;
  }
  return (
    v["lastSuccessfulSyncMs"] === undefined ||
    (typeof v["lastSuccessfulSyncMs"] === "number" && Number.isFinite(v["lastSuccessfulSyncMs"]))
  );
}

/** Every entry a lane this build knows, or the whole field is refused. An unknown
 *  name would key the panel's lane-state map with an id nothing can render.
 *
 *  The cast is on the KNOWN list, never on the datum — the same shape
 *  `isConnectorHealth` uses two functions up. `Array.isArray` narrows only to
 *  `any[]`, so casting each element to `AgentLane` would assert the very thing
 *  this guard exists to check. Widening `AGENT_LANES` to `readonly string[]`
 *  keeps the guard honest: the cast lands on the known list rather than the
 *  unknown datum, so the guard cannot be quietly weakened by someone widening
 *  the union later. */
function isAgentLaneList(v: unknown): v is readonly AgentLane[] {
  return Array.isArray(v) && v.every((x) => (AGENT_LANES as readonly string[]).includes(x));
}

const FILE_MISS_REASONS: readonly string[] = ["remote_not_tracked", "file_not_indexed"];

function isFileResolution(v: unknown): v is FileResolution {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "found") {
    return typeof v["path"] === "string";
  }
  if (v["kind"] === "miss") {
    // REJECTS a reason outside the closed set rather than coercing it, matching
    // isConnectorHealth's own rule: the producer here is our own service worker,
    // and a reason it did not send is a bug, not an upstream variation.
    return (
      typeof v["reason"] === "string" &&
      FILE_MISS_REASONS.includes(v["reason"]) &&
      typeof v["repo"] === "string"
    );
  }
  return v["kind"] === "unsupported";
}

/** The recognition is required on BOTH arms: a gateway failure must not erase
 *  the fact that the client knows what page this is. */
export function isResolveResponse(v: unknown): v is ResolveResponse {
  if (!isObject(v) || v["kind"] !== "resolve" || !isRecognition(v["recognition"])) {
    return false;
  }
  if (v["ok"] === true) {
    return (
      isResolveOutcome(v["outcome"]) &&
      (v["connector"] === undefined || isConnectorHealth(v["connector"])) &&
      (v["offeredLanes"] === undefined || isAgentLaneList(v["offeredLanes"])) &&
      (v["file"] === undefined || isFileResolution(v["file"]))
    );
  }
  return (
    v["ok"] === false &&
    typeof v["reason"] === "string" &&
    (v["scopeGap"] === undefined || isScopeGap(v["scopeGap"]))
  );
}

export function isRecognitionResponse(v: unknown): v is RecognitionResponse {
  if (!isObject(v) || v["kind"] !== "recognition") {
    return false;
  }
  if (v["ok"] === true) {
    return isRecognition(v["recognition"]);
  }
  return v["ok"] === false && typeof v["reason"] === "string";
}

/**
 * Guards the DOMAIN outcome crossing the SW→panel boundary — not the wire shape.
 * The wire's `status` field is parsed in gateway-client.ts and never reaches here.
 */
function isFetchOutcome(v: unknown): v is FetchOutcome {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "indexed") {
    return typeof v["itemId"] === "string";
  }
  return (
    v["kind"] === "unfetchable" || v["kind"] === "not-configured" || v["kind"] === "rate-limited"
  );
}

/** The recognition is required on BOTH arms, mirroring `isResolveResponse`: a
 *  gateway failure must not erase the fact that we know what page this is. */
export function isFetchResponse(v: unknown): v is FetchResponse {
  if (!isObject(v) || v["kind"] !== "fetch" || !isRecognition(v["recognition"])) {
    return false;
  }
  if (v["ok"] === true) {
    return isFetchOutcome(v["outcome"]);
  }
  return (
    v["ok"] === false &&
    typeof v["reason"] === "string" &&
    (v["scopeGap"] === undefined || isScopeGap(v["scopeGap"]))
  );
}

function isAgentLane(v: unknown): v is AgentLane {
  return typeof v === "string" && (AGENT_LANES as readonly string[]).includes(v);
}

/** Exported so `agent-run-store.ts`'s storage guard can reuse this instead of
 *  hand-rolling a second copy — the exact drift class (a predicate that claims
 *  `v is X` while checking fewer fields than X has) that already shipped once
 *  in this repo as `isResolvedItem`, and that `isLaneState` below was itself
 *  making with a bare `typeof v["reason"] === "string"` check before this. */
export function isAgentError(v: unknown): v is AgentError {
  return typeof v === "string" && (AGENT_ERRORS as readonly string[]).includes(v);
}

/**
 * The two optional lane inputs, narrowed identically for the run and the poll.
 *
 * `itemId` is checked for shape only — whether it names a real candidate is a
 * question about a resolve answer this module has never seen, so the handler
 * verifies it against the candidate set and refuses an id the gateway never
 * offered. An empty string is rejected here because it can only be a bug: it
 * would key a cache entry under nothing.
 *
 * `term` must arrive ALREADY normalised. The guard re-runs `normaliseTerm` and
 * demands the input equals its own normal form, so an over-long or whitespace-
 * ragged term is refused at the boundary rather than rewritten by it — a guard
 * that quietly repaired its input would be validating nothing. The panel does
 * the normalising, and renders the refusal copy itself, because it is the side
 * that still has the user in front of it.
 */
function hasValidLaneInput(v: Record<string, unknown>): boolean {
  const itemId = v["itemId"];
  const term = v["term"];
  return (
    (itemId === undefined || (typeof itemId === "string" && itemId !== "")) &&
    (term === undefined || isNormalisedTerm(term))
  );
}

export function isAgentRunRequest(v: unknown): v is AgentRunRequest {
  return (
    isObject(v) &&
    v["kind"] === "agent-run" &&
    isAgentLane(v["lane"]) &&
    typeof v["pageUrl"] === "string" &&
    hasValidLaneInput(v)
  );
}

export function isAgentStateRequest(v: unknown): v is AgentStateRequest {
  return (
    isObject(v) &&
    v["kind"] === "agent-state" &&
    isAgentLane(v["lane"]) &&
    typeof v["pageUrl"] === "string" &&
    hasValidLaneInput(v)
  );
}

/**
 * The two caps this guard enforces, duplicated from `shared/brief.ts` rather
 * than imported.
 *
 * Deliberate: this module is the narrowing boundary every entry point imports,
 * and pulling in the brief module here would drag `types.ts` into it. A test
 * asserts the two agree (`messages.test.ts`), so the duplication is checked
 * rather than trusted.
 */
const MAX_BRIEF_SOURCES = 20;
const MAX_BRIEF_QUESTION_CHARS = 4000;

function isBriefPick(v: unknown): v is BriefPick {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "tab") {
    const id = v["id"];
    return typeof id === "number" && Number.isInteger(id) && id >= 0;
  }
  if (v["kind"] === "passages") {
    // safeHttpUrl, not `typeof === "string"`: the shipped scheme validation
    // rather than a second, weaker rule beside it.
    return typeof v["url"] === "string" && safeHttpUrl(v["url"]) !== null;
  }
  return false;
}

export function isBriefStartRequest(v: unknown): v is BriefStartRequest {
  if (!isObject(v) || v["kind"] !== "brief-start") {
    return false;
  }
  const question = v["question"];
  if (typeof question !== "string" || question.trim() === "") {
    return false;
  }
  if (question.length > MAX_BRIEF_QUESTION_CHARS) {
    return false;
  }
  const picks = v["picks"];
  if (!Array.isArray(picks) || picks.length === 0 || picks.length > MAX_BRIEF_SOURCES) {
    return false;
  }
  if (typeof v["useIndex"] !== "boolean") {
    return false;
  }
  return picks.every(isBriefPick);
}

/**
 * `at` is the passage's capture instant, and it is OPTIONAL: absent means "the
 * whole page". So it is checked as an integer only when present — accepting a
 * fractional or non-numeric `at` would silently match no passage and read to the
 * user as a remove that did nothing.
 */
export function isPassageDropRequest(v: unknown): v is PassageDropRequest {
  if (!isObject(v) || v["kind"] !== "passage-drop") {
    return false;
  }
  if (typeof v["url"] !== "string" || safeHttpUrl(v["url"]) === null) {
    return false;
  }
  const at = v["at"];
  return at === undefined || (typeof at === "number" && Number.isInteger(at));
}

export function isPassageClearRequest(v: unknown): v is PassageClearRequest {
  return isObject(v) && v["kind"] === "passage-clear";
}

/**
 * Guards the DOMAIN state crossing the SW→panel boundary — not the wire shape.
 * The wire's `status`/`runId`/`failureReason` vocabulary is parsed in
 * gateway-client.ts and never reaches here (mirrors isResolveOutcome/isLedgerOutcome
 * above).
 */
function isLaneState(v: unknown, lane: AgentLane): v is LaneState {
  if (!isObject(v)) {
    return false;
  }
  if (v["kind"] === "collapsed") {
    return true;
  }
  if (v["kind"] === "running") {
    return typeof v["runId"] === "string";
  }
  if (v["kind"] === "done") {
    if (typeof v["brief"] !== "string") {
      return false;
    }
    // Each optional field must be ABSENT or well-formed. Re-uses the same
    // predicates the SW narrowed with, rather than a second hand-rolled copy —
    // the predicate-vs-type drift class that already shipped once as
    // `isResolvedItem`. `lane` is in scope here because the envelope carries it.
    return (
      (v["gaps"] === undefined || gapNotesFrom(v["gaps"]) !== undefined) &&
      (v["synthesis"] === undefined || synthesisFrom(v["synthesis"]) !== undefined) &&
      (v["findings"] === undefined || laneFindingsFrom(lane, v["findings"]) !== undefined)
    );
  }
  return (
    v["kind"] === "failed" &&
    isAgentError(v["reason"]) &&
    (v["scopeGap"] === undefined || isScopeGap(v["scopeGap"])) &&
    (v["detail"] === undefined || typeof v["detail"] === "string")
  );
}

export function isAgentStateResponse(v: unknown): v is AgentStateResponse {
  return (
    isObject(v) &&
    v["kind"] === "agent-state" &&
    isAgentLane(v["lane"]) &&
    isLaneState(v["state"], v["lane"])
  );
}

export function isQueueListRequest(v: unknown): v is QueueListRequest {
  return isObject(v) && v["kind"] === "queue-list";
}

export function isQueueRetryRequest(v: unknown): v is QueueRetryRequest {
  return (
    isObject(v) &&
    v["kind"] === "queue-retry" &&
    (v["url"] === undefined || typeof v["url"] === "string")
  );
}

export function isQueueRemoveRequest(v: unknown): v is QueueRemoveRequest {
  return isObject(v) && v["kind"] === "queue-remove" && typeof v["url"] === "string";
}

function isQueuedClipView(v: unknown): v is QueuedClipView {
  return (
    isObject(v) &&
    typeof v["url"] === "string" &&
    typeof v["title"] === "string" &&
    typeof v["queuedAt"] === "number" &&
    typeof v["attempts"] === "number" &&
    (v["lastReason"] === undefined || typeof v["lastReason"] === "string")
  );
}

export function isQueueResponse(v: unknown): v is QueueResponse {
  return (
    isObject(v) &&
    v["kind"] === "queue" &&
    Array.isArray(v["items"]) &&
    v["items"].every(isQueuedClipView)
  );
}

export function isConnectionStatusRequest(v: unknown): v is ConnectionStatusRequest {
  return isObject(v) && v["kind"] === "connection-status";
}

export function isUnpairRequest(v: unknown): v is UnpairRequest {
  return isObject(v) && v["kind"] === "unpair";
}

export function isDiscoverRequest(v: unknown): v is DiscoverRequest {
  return isObject(v) && v["kind"] === "discover";
}

export function isConnectionResponse(v: unknown): v is ConnectionResponse {
  if (!isObject(v) || v["kind"] !== "connection") {
    return false;
  }
  if (v["paired"] === false) {
    return true;
  }
  if (v["paired"] === true) {
    return (
      typeof v["label"] === "string" &&
      typeof v["origin"] === "string" &&
      typeof v["pairedAt"] === "number" &&
      typeof v["queueDepth"] === "number" &&
      typeof v["reachable"] === "boolean" &&
      typeof v["stale"] === "boolean" &&
      (v["lastClipAt"] === undefined || typeof v["lastClipAt"] === "number")
    );
  }
  return false;
}
