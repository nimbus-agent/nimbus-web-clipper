import type { CaptureResult } from "./types.ts";

export interface ClipPayload {
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title: string;
  readonly mode: "article" | "selection";
  readonly body: string;
  readonly tags: readonly string[];
  readonly capturedAt: number;
}

/** Comma-split, trim, drop empties, dedupe (case-sensitive, multi-word kept). */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const tag = raw.trim();
    if (tag !== "" && !out.includes(tag)) {
      out.push(tag);
    }
  }
  return out;
}

export function buildClipPayload(c: CaptureResult, tags: string[], nowMs: number): ClipPayload {
  return {
    url: c.url,
    ...(c.canonicalUrl !== undefined ? { canonicalUrl: c.canonicalUrl } : {}),
    title: c.title,
    mode: c.mode,
    body: c.body,
    tags,
    capturedAt: nowMs,
  };
}
