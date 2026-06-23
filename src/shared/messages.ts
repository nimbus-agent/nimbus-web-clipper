// Typed message envelope passed between the popup/content scripts and the
// background service worker via chrome.runtime messaging. External data crossing
// the messaging boundary is `unknown` until narrowed by a guard here — never `any`.

import { isRelatedHit } from "./related.ts";
import type { CaptureResult, ClipError, PairError, RelatedError, RelatedHit } from "./types.ts";

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

export type ExtensionRequest = PairRequest | ClipRequest | RelatedRequest;

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
  | { readonly kind: "clip"; readonly ok: false; readonly reason: ClipError };

export type RelatedResponse =
  | { readonly kind: "related"; readonly ok: true; readonly items: RelatedHit[] }
  | { readonly kind: "related"; readonly ok: false; readonly reason: RelatedError };

export type ExtensionResponse = PairResponse | ClipResponse | RelatedResponse;

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
