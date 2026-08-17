// src/background/brief-handlers.ts
// The staged brief protocol, as pure orchestration over injected deps.
//
// A SUB-ROUTER's worth of work, kept out of service-worker.ts on purpose: that
// router is already a fourteen-branch function that needed `openPanelForCue`
// extracted to stay under Sonar's cognitive-complexity cap (S3776, 15). Six more
// message kinds routed inline would break the gate. The worker gains one branch
// that delegates here.
import type { CandidateTab, TabCandidates } from "../browser/tabs.ts";
import { BRIEF_CAPS, buildCreateBody, buildSourceBody, suggestQuestions } from "../shared/brief.ts";
import type { BriefLogEntry } from "../shared/brief-log.ts";
import type { BriefReport } from "../shared/brief-report.ts";
import type { BriefStartRequest } from "../shared/messages.ts";
import { recognise } from "../shared/recognise.ts";
import type { ConfiguredOrigin, Recognition } from "../shared/types.ts";
import type * as briefClient from "./brief-client.ts";
import { BRIEF_RUN_TTL_MS, type StoredBrief } from "./brief-run-store.ts";
import type { CaptureOutcome } from "./capture-tab.ts";

/** One page that could not be read, and the reason in the client's vocabulary. */
export type SkippedSource = { readonly title: string; readonly reason: string };

/** The page-facing view of a run. Never carries source text. */
export type BriefState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "feeding";
      readonly id: string;
      readonly received: number;
      readonly expected: number;
    }
  | { readonly kind: "running"; readonly id: string }
  | {
      readonly kind: "done";
      readonly id: string;
      readonly report: BriefReport;
      readonly skipped: readonly SkippedSource[];
      readonly truncated: readonly string[];
      readonly savedItemId?: string;
      /**
       * A failed Save, reported WITHOUT discarding the report.
       *
       * This is why a save failure is not a `failed` state: the page clears
       * before drawing, so transitioning to `failed` would erase the brief the
       * user was reading because a save they attempted afterwards didn't land.
       */
      readonly saveError?: string;
    }
  | {
      readonly kind: "failed";
      readonly id?: string;
      readonly reason: string;
      readonly hint?: string;
    }
  /**
   * Save failed. Carries no report, because the handler may no longer hold one —
   * the page merges this into the `done` state it is already showing.
   */
  | { readonly kind: "save-failed"; readonly id: string; readonly reason: string };

export interface BriefDeps {
  readonly now: () => number;
  readonly listTabs: () => Promise<TabCandidates>;
  readonly origins: () => Promise<readonly ConfiguredOrigin[]>;
  readonly capture: (tabId: number, expectedUrl: string) => Promise<CaptureOutcome>;
  readonly connection: () => Promise<{ origin: string; token: string } | null>;
  readonly client: {
    readonly createBrief: typeof briefClient.createBrief;
    readonly feedBriefSource: typeof briefClient.feedBriefSource;
    readonly runBrief: typeof briefClient.runBrief;
    readonly getBrief: typeof briefClient.getBrief;
    readonly saveBrief: typeof briefClient.saveBrief;
  };
  readonly store: {
    readonly get: (id: string, nowMs: number) => Promise<StoredBrief | null>;
    readonly put: (run: StoredBrief, nowMs: number) => Promise<void>;
  };
  readonly log: {
    readonly append: (entry: BriefLogEntry) => Promise<void>;
    readonly update: (runId: string, patch: Partial<BriefLogEntry>) => Promise<void>;
  };
  readonly onState: (state: BriefState) => void;
}

export interface BriefTabsResult {
  readonly named: readonly CandidateTab[];
  readonly hiddenCount: number;
  readonly enumerationFailed: boolean;
  readonly questions: readonly string[];
  readonly recognitions: readonly Recognition[];
}

export async function handleBriefTabs(deps: BriefDeps): Promise<BriefTabsResult> {
  const tabs = await deps.listTabs();
  const origins = await deps.origins();
  const recognitions = tabs.named.map((t) => recognise(t.url, origins));
  return {
    named: tabs.named,
    hiddenCount: tabs.hiddenCount,
    enumerationFailed: tabs.enumerationFailed,
    questions: suggestQuestions(recognitions),
    recognitions,
  };
}

function emit(deps: BriefDeps, state: BriefState): BriefState {
  deps.onState(state);
  return state;
}

interface FeedResult {
  readonly accepted: number;
  readonly skipped: readonly SkippedSource[];
  readonly truncated: readonly string[];
}

async function putPhase(deps: BriefDeps, id: string, phase: StoredBrief["phase"]): Promise<void> {
  const nowMs = deps.now();
  const existing = await deps.store.get(id, nowMs);
  if (existing === null) {
    return;
  }
  await deps.store.put({ ...existing, phase }, nowMs);
}

/**
 * Capture and feed each declared tab, in order.
 *
 * Sequential, and not because of the rate limit — `brief-src` is a 60/min bucket
 * sized upstream so twenty back-to-back feeds cannot starve clipping. It is
 * sequential because every feed goes to `127.0.0.1` (there is no round-trip
 * latency to hide), because `run_capacity` attribution must be deterministic,
 * and because `received`/`expected` should be a monotonic count the page can
 * render honestly.
 */
async function feedAll(
  deps: BriefDeps,
  conn: { origin: string; token: string },
  id: string,
  picked: readonly CandidateTab[],
  expected: number,
): Promise<FeedResult> {
  const skipped: SkippedSource[] = [];
  const truncated: string[] = [];
  let accepted = 0;
  for (const tab of picked) {
    const outcome = await deps.capture(tab.id, tab.url);
    if (!outcome.ok) {
      skipped.push({ title: tab.title, reason: outcome.reason });
      continue;
    }
    const body = buildSourceBody({
      url: tab.url,
      title: tab.title,
      body: outcome.capture.body,
      capturedAt: deps.now(),
    });
    const res = await deps.client.feedBriefSource(conn.origin, conn.token, id, body);
    if (res.ok) {
      accepted += 1;
      if (body.truncated) {
        truncated.push(tab.title);
      }
      emit(deps, { kind: "feeding", id, received: res.received, expected });
      continue;
    }
    if (res.reason === "refused" && res.detail === "run_capacity") {
      // The run is full. Every remaining source would be refused too, and the
      // sources already accepted still produce a report whose `gaps` name the
      // shortfall. Stopping is the correct answer, not an error.
      skipped.push({ title: tab.title, reason: "run_capacity" });
      break;
    }
    skipped.push({ title: tab.title, reason: res.reason });
  }
  return { accepted, skipped, truncated };
}

/**
 * Poll once and interpret the result.
 *
 * The cadence itself belongs to the caller in the service worker — one poller,
 * and it is never in the page.
 */
async function settleRun(
  deps: BriefDeps,
  conn: { origin: string; token: string },
  id: string,
  fed: FeedResult,
): Promise<BriefState> {
  const res = await deps.client.getBrief(conn.origin, conn.token, id);
  if (!res.ok) {
    await putPhase(deps, id, { kind: "failed", reason: res.reason });
    return emit(deps, { kind: "failed", id, reason: res.reason });
  }
  if (res.status === "failed") {
    await deps.log.update(id, { failed: true });
    const reason = res.failureReason ?? "synthesis_failed";
    await putPhase(deps, id, { kind: "failed", reason });
    return emit(deps, { kind: "failed", id, reason });
  }
  // Narrowed positively rather than by exclusion: `collecting | running` is one
  // arm with a union-typed discriminant, which does not narrow away cleanly.
  if (res.status === "done") {
    const report = res.report;
    await deps.log.update(id, {
      model: report.synthesis.model,
      remote: report.synthesis.remote,
    });
    await putPhase(deps, id, { kind: "done", report });
    return emit(deps, {
      kind: "done",
      id,
      report,
      skipped: fed.skipped,
      truncated: fed.truncated,
    });
  }
  return emit(deps, { kind: "running", id });
}

/**
 * Create → capture → feed → run → poll.
 *
 * The order matters: every picked tab is DECLARED at create even though some may
 * fail to capture, because `BriefRun.declared` is fixed at create and the
 * gateway reports the shortfall in the report's `gaps` ("2 of 3"). Capturing
 * first and declaring only the survivors would hide it.
 */
export async function handleBriefStart(
  deps: BriefDeps,
  req: BriefStartRequest,
): Promise<BriefState> {
  const conn = await deps.connection();
  if (conn === null) {
    return emit(deps, { kind: "failed", reason: "not_paired" });
  }
  const tabs = await deps.listTabs();
  const picked = req.tabIds
    .map((id) => tabs.named.find((t) => t.id === id))
    .filter((t): t is CandidateTab => t !== undefined)
    .slice(0, BRIEF_CAPS.maxSources);
  if (picked.length === 0) {
    return emit(deps, { kind: "failed", reason: "no_sources" });
  }

  const created = await deps.client.createBrief(
    conn.origin,
    conn.token,
    buildCreateBody(
      req.question,
      picked.map((t) => ({ url: t.url, title: t.title })),
    ),
  );
  if (!created.ok) {
    const hint = "hint" in created ? created.hint : undefined;
    return emit(deps, {
      kind: "failed",
      reason: created.reason,
      ...(hint === undefined ? {} : { hint }),
    });
  }

  const id = created.id;
  const nowMs = deps.now();
  await deps.store.put(
    {
      id,
      question: req.question,
      declared: picked.map((t) => ({ url: t.url, title: t.title })),
      phase: { kind: "feeding", received: 0, expected: created.expected },
      expiresAtMs: nowMs + BRIEF_RUN_TTL_MS,
    },
    nowMs,
  );
  emit(deps, { kind: "feeding", id, received: 0, expected: created.expected });

  const fed = await feedAll(deps, conn, id, picked, created.expected);
  if (fed.accepted === 0) {
    await putPhase(deps, id, { kind: "failed", reason: "no_sources_captured" });
    return emit(deps, { kind: "failed", id, reason: "no_sources_captured" });
  }

  const started = await deps.client.runBrief(conn.origin, conn.token, id);
  if (!started.ok) {
    await putPhase(deps, id, { kind: "failed", reason: started.reason });
    return emit(deps, { kind: "failed", id, reason: started.reason });
  }

  // The log entry is written HERE — when `/run` is accepted, which is the moment
  // of egress — not when the report arrives. A run that fails during synthesis
  // still sent its source text, so it still gets an entry.
  await deps.log.append({
    runId: id,
    at: deps.now(),
    question: req.question,
    sourceCount: fed.accepted,
    truncatedCount: fed.truncated.length,
  });
  await putPhase(deps, id, { kind: "running" });
  emit(deps, { kind: "running", id });

  return settleRun(deps, conn, id, fed);
}

/**
 * Poll a run once and settle it if it has finished.
 *
 * The worker's loop calls this; the cadence lives there, never here and never in
 * the page. Reached both by the live `setTimeout` loop and by the eviction-net
 * alarm after a worker death.
 *
 * The shortfall (`skipped` / `truncated`) is empty here, and deliberately so: it
 * is per-attempt knowledge held by `handleBriefStart`'s call frame, which a
 * resumed poll does not have. The gateway's own `gaps` still carries the
 * authoritative "2 of 3 sources" account, so a resumed run reports the shortfall
 * from the report rather than losing it — it just cannot re-name which local tab
 * failed and why.
 */
export async function handleBriefPoll(deps: BriefDeps, id: string): Promise<BriefState> {
  const conn = await deps.connection();
  if (conn === null) {
    return { kind: "failed", id, reason: "not_paired" };
  }
  const stored = await deps.store.get(id, deps.now());
  if (stored === null) {
    // Expired or cleared under us. Emit nothing: there is no run to report on,
    // and a `failed` broadcast here would overwrite whatever the page is
    // legitimately showing.
    return { kind: "idle" };
  }
  return settleRun(deps, conn, id, { accepted: 0, skipped: [], truncated: [] });
}

/**
 * Save on the user's explicit click.
 *
 * EVERY failure path here is `save-failed`, never `failed`. A brief the user is
 * reading must not vanish because the save they tried afterwards was refused —
 * and refusal is a real state, not a theoretical one: the gateway retains only
 * `MAX_RETAINED_TERMINAL_RUNS` finished runs and does not refresh the TTL on
 * access, so a brief left open for half an hour is genuinely no longer saveable.
 */
export async function handleBriefSave(deps: BriefDeps, id: string): Promise<BriefState> {
  const conn = await deps.connection();
  if (conn === null) {
    return emit(deps, { kind: "save-failed", id, reason: "not_paired" });
  }
  const nowMs = deps.now();
  const stored = await deps.store.get(id, nowMs);
  if (stored === null || stored.phase.kind !== "done") {
    return emit(deps, { kind: "save-failed", id, reason: "expired" });
  }
  const saved = await deps.client.saveBrief(conn.origin, conn.token, id);
  if (!saved.ok) {
    return emit(deps, { kind: "save-failed", id, reason: saved.reason });
  }
  await deps.log.update(id, { savedItemId: saved.itemId });
  const phase = stored.phase;
  await deps.store.put({ ...stored, phase: { ...phase, savedItemId: saved.itemId } }, nowMs);
  return emit(deps, {
    kind: "done",
    id,
    report: phase.report,
    skipped: [],
    truncated: [],
    savedItemId: saved.itemId,
  });
}
