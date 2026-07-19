export interface CaptureResult {
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title: string;
  readonly mode: "article" | "selection";
  readonly body: string;
  readonly readableFound: boolean;
}

export interface Connection {
  readonly origin: string;
  readonly token: string;
  readonly label: string;
  readonly pairedAt: number;
}

export type PairError = "pairing_failed" | "bad_origin" | "unreachable" | "server_error";
export type ClipError =
  | "not_paired"
  | "unauthorized"
  | "invalid_request"
  | "unreachable"
  | "server_error";

export interface RelatedHit {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly snippet: string;
  readonly url: string | null;
}

export type RelatedError = "not_paired" | "unauthorized" | "unreachable" | "server_error";

/** The three feedback states a quick-clip toast can show. */
export type ToastVariant = "success" | "offline" | "error";

export interface ToastState {
  readonly variant: ToastVariant;
  readonly text: string;
}
