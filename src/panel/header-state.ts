// src/panel/header-state.ts
// Pure: the resolve response -> header derivation, shared by the panel and the
// command palette so the two never disagree about what a page is.
import { isCapturedCopy } from "../shared/capture-offer.ts";
import { isResolveResponse, type ResolveResponse } from "../shared/messages.ts";
import { surfaceLine } from "../shared/recognise/index.ts";
import type {
  AgentLane,
  FileMissReason,
  FileResolution,
  Recognition,
  ResolveCandidate,
} from "../shared/types.ts";
import type { HeaderState } from "./panel-view.ts";

const RESOLVE_MESSAGES: Record<string, string> = {
  not_paired: "Pair with Nimbus in Options to see what it knows about this page.",
  unauthorized: "Nimbus rejected this pairing. Re-pair in Options.",
  unsupported: "This Nimbus gateway can't resolve pages yet.",
  unreachable: "Couldn't connect to Nimbus.",
  server_error: "Nimbus had an error resolving this page.",
  // `insufficient_scope` is handled BEFORE this map is consulted, in headerFrom
  // below — but only when `surface !== null`. That guard always holds in
  // practice: `handleResolve` calls the gateway only after `recognise()`
  // succeeds, and a 403 can only come back from a gateway call, so a 403 always
  // carries a surface. This entry exists as a fallback for that invariant alone
  // — if it were ever violated, this is the one message this branch went out of
  // its way to avoid reusing the generic "Couldn't resolve this page." for.
  insufficient_scope:
    "This pairing can't resolve pages yet. Run nimbus clip status to find this device, then nimbus clip scopes.",
};

/**
 * The two ways the file probe can miss, each with the repo the coordinate named —
 * matching `RESOLVE_MESSAGES` above: an honest sentence per
 * reason rather than one generic "not indexed" that would hide which of the two
 * fixes (track the remote, index the file) actually applies.
 */
const FILE_MISS_SENTENCES: Record<FileMissReason, (repo: string) => string> = {
  remote_not_tracked: (repo) =>
    `Nimbus has no local checkout of \`${repo}\`, so it cannot answer about its files.`,
  file_not_indexed: (repo) =>
    `Nimbus has a checkout of \`${repo}\`, but this file is not in its index.`,
};

/**
 * The last phase of {@link headerFrom}: a recognised page whose answer is about ONE
 * indexed item — found (connector data or a captured copy), ambiguous, or not
 * indexed. `headerFrom` reaches this only after its refusal, unrecognised, `home` and
 * `file` arms, so `res.outcome` here is the real answer, never the inert placeholder
 * those two surfaces carry. Extracted to bring `headerFrom` under the
 * cognitive-complexity gate (Sonar `S3776`); the header states are unchanged.
 */
function itemOutcomeHeader(
  res: Extract<ResolveResponse, { ok: true }>,
  surface: string,
  nowMs: number,
  fetchSent: boolean,
): HeaderState {
  const outcome = res.outcome;
  if (outcome.kind === "found") {
    // A captured copy is keyed on the ITEM, never on "we just captured it" —
    // see `isCapturedCopy`'s own doc comment. Without this branch, a COLD
    // panel open on a page captured last week would present the copy as
    // ordinary connector data, which is exactly the dishonesty the `captured`
    // header arm exists to prevent — capturing IN this session is not the
    // only way to reach it.
    if (isCapturedCopy(outcome.item)) {
      return { kind: "captured", item: outcome.item, ageNowMs: nowMs };
    }
    return { kind: "resolved", surface, item: outcome.item, matchKind: outcome.matchKind, nowMs };
  }
  if (outcome.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      surface,
      candidates: outcome.candidates,
      truncated: outcome.truncated,
    };
  }
  // `unresolvable` means the gateway could not parse the URL we sent — a client
  // bug, not a user-facing distinction. It reads as "not indexed" either way.
  //
  // `res.recognition.ok` is guaranteed true whenever `surface` is non-null (see
  // `surfaceLine`), and `headerFrom` passes a non-null one, so this guard is
  // unreachable in practice; it exists only so TS can narrow `product` off
  // `res.recognition` without a non-null assertion.
  if (!res.recognition.ok) {
    return { kind: "unrecognised" };
  }
  return {
    kind: "not-indexed",
    surface,
    product: res.recognition.product,
    // Once a fetch has been sent for this panel, `fetchable` is forced false on
    // every subsequent resolve — including a recovery re-resolve that comes back
    // as another miss. See the `fetchSent` doc comment in `createPanel` for why
    // the button must not return.
    fetchable: outcome.fetchable && !fetchSent,
  };
}

export function headerFrom(res: unknown, nowMs: number, fetchSent: boolean): HeaderState {
  if (!isResolveResponse(res)) {
    return { kind: "error", surface: null, message: "Couldn't read Nimbus's answer." };
  }
  const surface = surfaceLine(res.recognition);
  if (!res.ok) {
    // `insufficient_scope` is NOT an error: the route works, the owner just has
    // not granted this device the scope. It gets its own state so the panel can
    // say what to run instead of blaming Nimbus.
    if (res.reason === "insufficient_scope" && surface !== null) {
      return { kind: "needs-scope", surface, scopeGap: res.scopeGap ?? null };
    }
    return {
      kind: "error",
      surface,
      message: RESOLVE_MESSAGES[res.reason] ?? "Couldn't resolve this page.",
    };
  }
  if (surface === null) {
    return { kind: "unrecognised" };
  }
  // Before any outcome is read. A home page carries an inert outcome
  // (handlers.ts fills one in only because the response type demands it), so
  // reading it here would render a dashboard as a miss.
  if (res.recognition.ok && res.recognition.kind === "home") {
    // `res.connector` is optional only because the type is shared with every
    // other surface (see its doc comment in messages.ts) — `handlers.ts` always
    // fills one in for a home recognition, falling back to `unknown` itself when
    // the read failed or listed no row for this connector. The fallback here is
    // a second line of defence, for the same "unknown" reason: never guess.
    return {
      kind: "service",
      surface,
      product: res.recognition.product,
      connector: res.connector ?? { state: "unknown" },
      nowMs,
    };
  }
  // Same reasoning as the `home` branch above: a `file` recognition's `outcome`
  // is an inert `{kind:"not-indexed", fetchable:false}` (handlers.ts), filled in
  // only because `ResolveResponse`'s ok arm requires one. The real answer is
  // `res.file` — a 403 never reaches here (see this branch's own doc comment
  // in messages.ts and `FileResolution`'s), so only `found`/`miss`/`unsupported`
  // are possible.
  if (res.recognition.ok && res.recognition.kind === "file") {
    const file = res.file;
    if (file === undefined || file.kind === "unsupported" || file.kind === "found") {
      return { kind: "file", surface };
    }
    return { kind: "file", surface, banner: FILE_MISS_SENTENCES[file.reason](file.repo) };
  }
  return itemOutcomeHeader(res, surface, nowMs, fetchSent);
}

/**
 * Folds the user's pick out of an ambiguous answer into the header: a matching
 * candidate id turns `ambiguous` into `chosen`; anything else is returned as is.
 */
export function withPick(header: HeaderState, pickedId: string | null): HeaderState {
  if (header.kind !== "ambiguous" || pickedId === null) {
    return header;
  }
  const candidate: ResolveCandidate | undefined = header.candidates.find((c) => c.id === pickedId);
  return candidate === undefined ? header : { kind: "chosen", surface: header.surface, candidate };
}

/** What a resolve answer feeds the lane derivation besides its header. */
export interface LaneInputs {
  readonly recognition: Recognition;
  /** The file probe's answer — only on an `ok` answer, and only on a file page. */
  readonly file: FileResolution | null;
  /** The lanes the gateway offers here — only on an `ok` answer; `null` filters
   *  nothing (see `offeredLanes` in messages.ts). */
  readonly offered: readonly AgentLane[] | null;
}

/**
 * The resolve answer -> the lane inputs `laneContextFrom` takes beside the
 * header. One function for the panel (`loadHeader`) and the palette
 * (`resolvedFrom`), so the two cannot read the same answer differently. `null`
 * for an unreadable answer, which carries none of the three.
 */
export function laneInputsFrom(res: unknown): LaneInputs | null {
  if (!isResolveResponse(res)) {
    return null;
  }
  if (!res.ok) {
    return { recognition: res.recognition, file: null, offered: null };
  }
  return {
    recognition: res.recognition,
    file: res.file ?? null,
    offered: res.offeredLanes ?? null,
  };
}
