// Typed message envelope passed between the popup/content scripts and the
// background service worker via chrome.runtime messaging. External data crossing
// the messaging boundary is `unknown` until narrowed by a guard here — never `any`.

import type { QueuedClipView } from "./queue.ts";
import { isRelatedHit } from "./related.ts";
import type {
  CaptureResult,
  ClipError,
  PairError,
  Recognition,
  RelatedError,
  RelatedHit,
  ResolvedItem,
  ResolveError,
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
      readonly item: ResolvedItem | null;
    }
  | {
      readonly kind: "resolve";
      readonly ok: false;
      readonly recognition: Recognition;
      readonly reason: ResolveError;
    };

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

export function isResolvedItem(v: unknown): v is ResolvedItem {
  return (
    isObject(v) &&
    typeof v["id"] === "string" &&
    typeof v["service"] === "string" &&
    typeof v["type"] === "string" &&
    typeof v["title"] === "string" &&
    typeof v["canonicalUrl"] === "string" &&
    (v["url"] === null || typeof v["url"] === "string")
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
    return v["item"] === null || isResolvedItem(v["item"]);
  }
  return v["ok"] === false && typeof v["reason"] === "string";
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
