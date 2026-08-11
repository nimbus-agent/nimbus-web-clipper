// Typed message envelope passed between the popup/content scripts and the
// background service worker via chrome.runtime messaging. External data crossing
// the messaging boundary is `unknown` until narrowed by a guard here — never `any`.

import type { QueuedClipView } from "./queue.ts";
import { isRelatedHit } from "./related.ts";
import {
  AGENT_ERRORS,
  AGENT_LANES,
  type AgentError,
  type AgentLane,
  type CaptureResult,
  type ClipError,
  type FetchError,
  type FetchOutcome,
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
}

export interface ResolveRequest {
  readonly kind: "resolve";
  readonly pageUrl: string;
  readonly title?: string;
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

/** Expand a lane: run its agent (or return the cached state if one already
 *  exists for this item and lane — expanding a `done` lane must not re-invoke). */
export interface AgentRunRequest {
  readonly kind: "agent-run";
  readonly lane: AgentLane;
  readonly pageUrl: string;
}

/** Poll a lane's current state. Read-only — never invokes. */
export interface AgentStateRequest {
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

export type ExtensionRequest =
  | PairRequest
  | ClipRequest
  | RelatedRequest
  | ResolveRequest
  | FetchRequest
  | RecogniseRequest
  | AgentRunRequest
  | AgentStateRequest
  | QueueListRequest
  | QueueRetryRequest
  | QueueRemoveRequest
  | ConnectionStatusRequest
  | UnpairRequest;

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
    }
  | {
      readonly kind: "resolve";
      readonly ok: false;
      readonly recognition: Recognition;
      readonly reason: ResolveError;
      readonly scopeGap?: ScopeGap;
    };

export type RecognitionResponse = {
  readonly kind: "recognition";
  readonly recognition: Recognition;
};

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
    };

export type ExtensionResponse =
  | PairResponse
  | ClipResponse
  | RelatedResponse
  | ResolveResponse
  | FetchResponse
  | AgentStateResponse
  | QueueResponse
  | ConnectionResponse;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
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
    (v["selection"] === undefined || typeof v["selection"] === "string")
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
      typeof v["resolveUrl"] === "string"
    );
  }
  return v["ok"] === false && typeof v["reason"] === "string";
}

/** The recognition is required on BOTH arms: a gateway failure must not erase
 *  the fact that the client knows what page this is. */
export function isResolveResponse(v: unknown): v is ResolveResponse {
  if (!isObject(v) || v["kind"] !== "resolve" || !isRecognition(v["recognition"])) {
    return false;
  }
  if (v["ok"] === true) {
    return isResolveOutcome(v["outcome"]);
  }
  return (
    v["ok"] === false &&
    typeof v["reason"] === "string" &&
    (v["scopeGap"] === undefined || isScopeGap(v["scopeGap"]))
  );
}

export function isRecognitionResponse(v: unknown): v is RecognitionResponse {
  return isObject(v) && v["kind"] === "recognition" && isRecognition(v["recognition"]);
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

export function isAgentRunRequest(v: unknown): v is AgentRunRequest {
  return (
    isObject(v) &&
    v["kind"] === "agent-run" &&
    isAgentLane(v["lane"]) &&
    typeof v["pageUrl"] === "string"
  );
}

export function isAgentStateRequest(v: unknown): v is AgentStateRequest {
  return (
    isObject(v) &&
    v["kind"] === "agent-state" &&
    isAgentLane(v["lane"]) &&
    typeof v["pageUrl"] === "string"
  );
}

/**
 * Guards the DOMAIN state crossing the SW→panel boundary — not the wire shape.
 * The wire's `status`/`runId`/`failureReason` vocabulary is parsed in
 * gateway-client.ts and never reaches here (mirrors isResolveOutcome/isFetchOutcome
 * above).
 */
function isLaneState(v: unknown): v is LaneState {
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
    return typeof v["brief"] === "string";
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
    isObject(v) && v["kind"] === "agent-state" && isAgentLane(v["lane"]) && isLaneState(v["state"])
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
      typeof v["pairedAt"] === "number"
    );
  }
  return false;
}
