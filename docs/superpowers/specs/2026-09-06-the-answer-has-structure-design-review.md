# Design Review: Phase C8 — The answer has structure

**Date:** 2026-09-06  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Under Review  
**Target Spec:** [`2026-09-06-the-answer-has-structure-design.md`](./2026-09-06-the-answer-has-structure-design.md)  
**Target Slices:** C8.1 (Entry path, gaps/provenance, why), C8.2 (expert, impact, ownership), C8.3 (catchup, decisions, glossary)

---

## 1. Executive Summary

The design document [`2026-09-06-the-answer-has-structure-design.md`](./2026-09-06-the-answer-has-structure-design.md) is thoroughly reasoned and addresses a major gap in the extension's user experience: moving from lossy, single-paragraph markdown prose to rich, structured agent findings without expanding the gateway wire contract or compromising the extension's strict security posture.

Key strengths of the design:
1. **Zero-runtime SDK seam:** Importing `@nimbus-dev/sdk` purely as a type-only `devDependency` cleanly satisfies the "bundled, no runtime deps" rule while establishing a formal type boundary.
2. **Deep element-level guards:** Acknowledging that SDK runtime guards are "type narrow, runtime wide" and implementing client-side, element-level validation prevents unvalidated properties from causing runtime render failures.
3. **Fail-quiet degradation:** Unmodeled lanes or briefs failing validation seamlessly degrade to the existing `<pre>` markdown prose path without user disruption.
4. **Honesty across all seven lanes:** Surfacing `gaps` and `synthesis` provenance directly addresses the "empty lane vs unasked question" problem and makes local vs remote model execution transparent.

This review identifies **4 critical implementation & contract clarifications**, **4 architectural and state modeling improvements**, an **edge cases & boundary conditions matrix**, and **testing recommendations** to guide the C8.1–C8.3 implementation plans.

---

## 2. Critical Implementation & Contract Clarifications

### Q2.1: Domain Modeling of `synthesis` vs `findings` on `LaneState`

* **Context:** In §2, `GET /v1/agents/runs/{id}` returns `synthesis?: SynthesisProvenance` as a top-level sibling to `brief` and `findings`. In §4.1, `LaneState`'s `done` arm is defined as:
  ```ts
  | { readonly kind: "done"; readonly brief: string; readonly findings?: LaneFindings }
  ```
* **Issue:** The spec does not explicitly define where `synthesis: SynthesisProvenance` is stored on `LaneState` or inside `LaneFindings`.
  - If `synthesis` is embedded inside `LaneFindings`, dropping `findings` due to the byte limit (§4.8) or a guard rejection would also drop the synthesis provenance.
  - If `synthesis` is placed directly on `LaneState` alongside `brief`, provenance remains visible even when rendering the fallback prose brief (e.g., displaying "Synthesized by Claude 3.5 Sonnet (remote)" beneath the prose `<pre>`).
* **Recommendation:** Explicitly model `synthesis` on `LaneState`:
  ```ts
  | {
      readonly kind: "done";
      readonly brief: string;
      readonly findings?: LaneFindings;
      readonly synthesis?: SynthesisProvenance;
    }
  ```
  And provide a guard `isSynthesisProvenance(v: unknown): v is SynthesisProvenance` in `src/shared/messages.ts`.

---

### Q2.2: Stored Run Degradation Mechanism in `agent-run-store.ts` (`readGuarded`)

* **Context:** §4.1 states:
  > "a stored run whose findings fail the guard degrades to prose rather than being discarded — the brief text is still good."
* **Problem in Codebase:**
  - [`agent-run-store.ts`](../../../src/background/agent-run-store.ts) uses `readGuarded(STORE_KEY, isStoredEntry)`.
  - `isStoredEntry` checks `isLaneState(v["state"])`.
  - If `isLaneState` evaluates `findings` and returns `false` on an invalid/corrupted `findings` payload, `isStoredEntry` returns `false`, and `readGuarded` **deletes the entire stored run** from storage (including the valid `brief`).
* **Action Required:**
  - Define how the store gracefully degrades invalid findings on read.
  - In `agent-run-store.ts`, either:
    1. Let `isLaneState` in the storage layer accept `findings?: unknown`, and sanitize in `toStoredRun`:
       ```ts
       function toStoredRun(entry: StoredEntry): StoredRun {
         const { subject, lane, runId, state, expiresAtMs } = entry;
         if (state.kind === "done" && state.findings !== undefined) {
           const validFindings = isLaneFindings(state.findings, lane) ? state.findings : undefined;
           return { subject, lane, runId, state: { ...state, findings: validFindings }, expiresAtMs };
         }
         return { subject, lane, runId, state, expiresAtMs };
       }
       ```
    2. Or ensure storage read sanitization strips invalid `findings` while preserving `{ kind: "done", brief }`.

---

### Q2.3: `terminalLaneState` Signature Update (`lane` Parameter)

* **Context:** §4.1 states that `terminalLaneState` (`src/background/service-worker.ts:309-331`) narrows `findings` against the lane through a guard dispatch table.
* **Problem in Codebase:**
  - Currently, `terminalLaneState` has the signature:
    ```ts
    function terminalLaneState(result: AgentRunPollResult, label: string): LaneState
    ```
  - It does not take `lane: AgentLane`. Without `lane`, it cannot look up the lane-specific guard in the dispatch table.
* **Action Required:**
  - Update `terminalLaneState`'s signature to:
    ```ts
    function terminalLaneState(result: AgentRunPollResult, label: string, lane: AgentLane): LaneState
    ```
  - In `tickAgentPoll` (`service-worker.ts:429`), pass `run.lane`:
    ```ts
    state: terminalLaneState(result, conn.label, run.lane),
    ```

---

### Q2.4: Timestamp Normalization (`occurredAt` / `modifiedAt`) & Pure Date Formatting

* **Context:** Several findings objects (`WhyBrief.findings[].occurredAt`, `ExpertBrief.ranked[].evidence[].modifiedAt`, `CatchupBrief.sections[].items[].modifiedAt`) carry timestamps.
* **Subtlety:**
  - The gateway/SDK emits ISO 8601 strings (e.g., `"2026-08-19T14:32:00Z"`) or epoch numbers for these fields.
  - The clipper's freshness formatter (`formatAge` in [`src/shared/freshness.ts`](../../../src/shared/freshness.ts)) expects `(modifiedAtMs: number, nowMs: number)`.
  - Passing an unparsed string or `NaN` into `formatAge` results in invalid display text.
* **Action Required:**
  - Implement a timestamp parser:
    ```ts
    export function parseTimestampMs(raw: unknown): number | null {
      if (typeof raw === "number" && !Number.isNaN(raw)) return raw;
      if (typeof raw === "string") {
        const ms = Date.parse(raw);
        return Number.isNaN(ms) ? null : ms;
      }
      return null;
    }
    ```
  - Findings renderers in `src/panel/findings/` must accept `nowMs: number` alongside `doc: Document` and the typed brief so all relative time calculations are pure and deterministic in tests.

---

## 3. Architecture & State Modeling Improvements

### I3.1: Co-located CSS for Structured Findings in Shadow DOM

* **Context:** The panel is injected into a Shadow DOM (`src/panel/panel-in-page.ts`), where external stylesheets do not apply. All styles are defined in `PANEL_CSS` inside `panel-in-page.ts`.
* **Issue:** Adding styles for 7 distinct renderers (timelines, owner share tables, badges, disclosures, score chips, gaps boxes, provenance notes) directly to `panel-in-page.ts` will further bloat the repo's largest file (already 2,120 lines).
* **Recommendation:**
  - Create `src/panel/findings/findings.css.ts` exporting a `FINDINGS_CSS` string.
  - Interpolate `FINDINGS_CSS` into `PANEL_CSS` in `panel-in-page.ts`.
  - Keeps CSS co-located with the findings renderer modules.

---

### I3.2: Explicit Empty State Placeholders when Results and Gaps are Both Empty

* **Context:** §4.5 explains that `gaps` provides context when result lists are empty.
* **Issue:** What if an agent run completes successfully with 0 result items (e.g., `WhyBrief.findings: []`, `ImpactBrief.affected: []`) and `gaps` is also empty (`[]`)?
  - Without an explicit empty placeholder, the renderer would produce an empty DOM fragment, rendering a blank box under the lane header.
* **Recommendation:** Define a consistent, quiet fallback placeholder for each renderer when `items.length === 0 && gaps.length === 0`:
  - `why`: `"No timeline events recorded for this change."`
  - `expert`: `"No experts identified for this context."`
  - `impact`: `"No downstream impacted items detected."`
  - `ownership`: `"No owner distribution data recorded."`
  - `catchup`: `"No recent activity across indexed services."`
  - `decisions`: `"No architecture decisions recorded."`
  - `glossary`: `"No definitions found."`

---

### I3.3: Uniform Link Construction Helper & Accessibility

* **Context:** §4.6 inventories linkable URLs across `why`, `decisions`, and `glossary`.
* **Recommendation:** Create a shared link builder helper in `src/panel/findings/` following `renderHit`'s pattern in [`panel-view.ts`](../../../src/panel/panel-view.ts):
  ```ts
  export function createFindingLink(doc: Document, text: string, rawUrl: string | null | undefined): HTMLElement {
    const safe = rawUrl ? safeHttpUrl(rawUrl) : null;
    if (safe !== null) {
      const a = doc.createElement("a");
      a.href = safe;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = text;
      return a;
    }
    const span = doc.createElement("span");
    span.textContent = text;
    return span;
  }
  ```
  This guarantees that:
  1. `textContent` is always used (no XSS).
  2. Links always open safely in a new tab (`target="_blank"`, `rel="noopener noreferrer"`).
  3. Malformed/non-HTTP schemes degrade to safe text without throwing.

---

### I3.4: Byte Bound Evaluation & Threshold in `agent-run-store.ts`

* **Context:** §4.8 introduces a per-run findings byte bound.
* **Recommendation:**
  - Define `MAX_FINDINGS_BYTES = 48 * 1024` (48 KB) in `agent-run-store.ts`.
  - In `putRun`, before persisting, measure the serialized size of `state.findings`:
    ```ts
    if (run.state.kind === "done" && run.state.findings !== undefined) {
      const findingsJson = JSON.stringify(run.state.findings);
      if (findingsJson.length > MAX_FINDINGS_BYTES) {
        run = {
          ...run,
          state: {
            kind: "done",
            brief: run.state.brief,
            synthesis: run.state.synthesis,
          },
        };
      }
    }
    ```
  - This ensures predictable storage usage while keeping `putRun` fast and synchronous.

---

## 4. Edge Cases & Boundary Conditions Matrix

| Scenario | Trigger / Payload | Expected Behavior | Verification |
|---|---|---|---|
| **Invalid/Unknown Lane in Findings** | `findings.kind` does not match `run.lane` | Guard rejects; degrades to prose `<pre>` rendering `brief`. | Unit test in guard dispatch suite. |
| **Malformed Element in Array** | `ExpertBrief.ranked` contains `[ { displayName: "Alice" }, null, 42 ]` | Guard rejects element array; degrades to prose `<pre>`. | Unit test with shallow-guard fixture. |
| **Discarded Synthesis with Detail** | `synthesis: { attempted: true, used: false, reason: "guardrail_violation", detail: "<alert>" }` | Renders discard reason and sanitized `detail` via `textContent`; no HTML parsing. | Unit test for provenance renderer. |
| **Dangerous URL in Finding** | `why.findings[0].url: "javascript:alert(1)"` | `safeHttpUrl` returns `null`; renders title as plain `<span>`, no `<a>` tag created. | Unit test asserting `querySelector("a") === null`. |
| **Zero Items with Gaps Present** | `why.findings: []`, `gaps: [{ category: "indexing", detail: "Repository not indexed", remediation: "Run nimbus index" }]` | Renders empty result notice + structured gap alert box with remediation instruction. | Unit test for `renderWhyFindings`. |
| **Decisions Brief Non-1 Version** | `DecisionsBrief.agentVersion: 2` | Guard accepts numeric `agentVersion` (per §8 item 3); does not reject valid brief. | Unit test with `agentVersion: 2`. |
| **Unresolved Owner Row** | `OwnershipBrief.target.owners[0]: { resolved: false, label: "git:user@example.com", share: 0.42 }` | Renders percentage `42%` with visual indicator/badge that identity is an unresolved commit email. | Unit test for `renderOwnershipFindings`. |
| **Missing Ownership Counts** | `OwnershipBrief.target.commitCount: null` | Renders count as *"unavailable"* (never *"complete"*, per `ownership-store.ts:22`). | Unit test for `renderOwnershipFindings`. |
| **Large Payload Exceeding Byte Cap** | `JSON.stringify(findings).length > MAX_FINDINGS_BYTES` | `putRun` stores `{ kind: "done", brief, synthesis }` without `findings`; stored run replays as prose. | Unit test in `agent-run-store.test.ts`. |

---

## 5. Testing Strategy Recommendations

1. **Element-Level Guard Suites (`test/unit/findings-guards.test.ts`):**
   - For every lane, test:
     - Full valid fixture returns `true`.
     - Shallow SDK shapes (`{ ranked: [42] }`, `{ affected: ["invalid"] }`) return `false`.
     - Missing required fields, nulls, and wrong types return `false`.
2. **Pure Findings Renderers (`test/unit/findings-renderers.test.ts`):**
   - Test each of the 7 renderer functions with `@vitest-environment jsdom`.
   - Assert exact DOM structure, classes, text content, and `safeHttpUrl` link generation.
   - Assert that no `innerHTML` or `dangerouslySetInnerHTML` is used.
3. **Storage Fallback & Byte Cap (`test/unit/agent-run-store.test.ts`):**
   - Assert that a stored run with malformed findings falls back to prose without being evicted by `readGuarded`.
   - Assert that a run with findings exceeding `MAX_FINDINGS_BYTES` drops `findings` while persisting `brief`.
4. **Build & Bundle Invariant Verification:**
   - Verify that `@nimbus-dev/sdk` is only imported via `import type`.
   - Ensure `bun run check-build` passes with no unexpected files or bundle bloat.
   - Confirm that `test/unit/doc-references.test.ts` resolves this review and the design spec.

---

## 6. Summary of Recommended Spec Enhancements

Before starting implementation on Slice C8.1, incorporate the following minor adjustments into [`2026-09-06-the-answer-has-structure-design.md`](./2026-09-06-the-answer-has-structure-design.md):
1. **Clarify `LaneState` & `synthesis`:** Add `synthesis?: SynthesisProvenance` to `LaneState`'s `done` arm.
2. **Explicit Storage Degradation:** Document how `agent-run-store.ts` handles invalid findings during `readAll` without discarding the run.
3. **Update `terminalLaneState` signature:** Document the addition of `lane: AgentLane`.
4. **Define Timestamp & CSS Strategy:** Reference `parseTimestampMs(raw)` and co-located `FINDINGS_CSS` in `src/panel/findings/`.
