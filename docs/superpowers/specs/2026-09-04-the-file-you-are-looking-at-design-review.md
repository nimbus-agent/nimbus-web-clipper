# Design Review: C7 — the file you are looking at, and the C6 close-out

**Date:** 2026-09-04  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Under Review  
**Target Spec:** [`2026-09-04-the-file-you-are-looking-at-design.md`](./2026-09-04-the-file-you-are-looking-at-design.md)  
**Supersedes:** §5 and §5.4 of [`2026-08-31-lanes-for-every-recognised-page-design.md`](./2026-08-31-lanes-for-every-recognised-page-design.md)

---

## 1. Executive Summary

The design provides a crisp, well-reasoned architectural convergence between the C7 source file lanes and the C6.1 item close-out. It correctly addresses upstream reality (Nimbus gateway v7.6.0/v7.7.0) by:
1. **Replacing a synthetic version floor with a direct probe:** Probing `GET /v1/items/resolve-file` acts as both the file resolution mechanism and the capability signal, eliminating version drift risk.
2. **Refactoring `needsItemArm` to pair granularity:** Resolving the cross-product coupling bug (F3) so `expert` on `pr` can sharpen without erroneously flooring `why` on `pr`.
3. **Structured miss handling:** Bypassing prose matching in favor of the upstream typed discriminant (`remote_not_tracked` vs `file_not_indexed`), ensuring no empty or misleading lanes are rendered.

This review identifies **5 critical implementation and contract clarifications**, **3 architectural/state modeling improvements**, and **3 testing pins** to ensure seamless execution.

---

## 2. Critical Implementation & Contract Clarifications

### Q2.1: `forgeFile` Dropped by `recognise()` Pipeline
* **Context:** §4.1 states that all three forge matchers emit `Match.forgeFile` with `refAndPath`, and that `resolveForAgent`'s `file` arm makes no resolve call.
* **Problem in Codebase:**
  - `Match` ([`rule.ts`](file:///C:/gitrep/nimbus-web-clipper/src/shared/recognise/rule.ts#L26)) carries `forgeFile?: { repo: string; refAndPath: string }`.
  - However, `recognise()` ([`src/shared/recognise/index.ts`](file:///C:/gitrep/nimbus-web-clipper/src/shared/recognise/index.ts#L171-L179)) constructs `Recognition` without forwarding `match.forgeFile`.
  - `Recognition` ([`src/shared/types.ts`](file:///C:/gitrep/nimbus-web-clipper/src/shared/types.ts#L211-L227)) currently lacks the `forgeFile` field, and `isRecognition` ([`src/shared/messages.ts`](file:///C:/gitrep/nimbus-web-clipper/src/shared/messages.ts#L740)) does not validate it.
  - Furthermore, `resolveForAgent` in [`src/background/handlers.ts`](file:///C:/gitrep/nimbus-web-clipper/src/background/handlers.ts#L705-L720) does not have an `if (recognition.kind === "file")` branch and currently falls through to `resolveItem`.
* **Action Required:**
  1. Add `forgeFile?: { readonly repo: string; readonly refAndPath: string }` to `Recognition` (or discriminate by `kind: "file"`).
  2. Forward `match.forgeFile` inside `recognise()`.
  3. Update `isRecognition` boundary guard in `messages.ts`.
  4. Add the `recognition.kind === "file"` branch in `resolveForAgent` to return `scope: "file"`.
  5. Include `src/shared/recognise/index.ts` in §4.6 (Files table).

### Q2.2: Stored Run Invalidation Bug in `agent-run-store.ts` (`isRunSubject`)
* **Context:** §4.1 and [`agent-run-store.ts`](file:///C:/gitrep/nimbus-web-clipper/src/background/agent-run-store.ts#L75) define `RunSubject` with `{ kind: "file", repo: string, refAndPath: string }`.
* **Problem in Codebase:**
  - The runtime storage guard `isRunSubject` ([`agent-run-store.ts:L113-124`](file:///C:/gitrep/nimbus-web-clipper/src/background/agent-run-store.ts#L113-L124)) validates `item`, `term`, and `service`, but **omits `file`**:
    ```ts
    function isRunSubject(v: unknown): v is RunSubject {
      if (!isObject(v)) return false;
      if (v["kind"] === "item") return typeof v["id"] === "string";
      if (v["kind"] === "term") return typeof v["term"] === "string";
      return v["kind"] === "service" && typeof v["service"] === "string";
    }
    ```
  - Any cached run for a file lane persisted to `chrome.storage` will fail `readGuarded` and be silently discarded on storage reads.
* **Action Required:**
  - Update `isRunSubject` in `agent-run-store.ts` to include:
    ```ts
    if (v["kind"] === "file") {
      return typeof v["repo"] === "string" && typeof v["refAndPath"] === "string";
    }
    ```
  - Add `src/background/agent-run-store.ts` to §4.6 (Files table).

### Q2.3: Missing `403 insufficient_scope` Mapping on `resolveFile`
* **Context:** §4.2 defines the 3 probe outcomes:
  - `200 { ok: true }` → all five offered
  - `200 { ok: false, reason }` → none, reason sentence
  - `404 / unreachable` → none, no banner
* **Issue:**
  - What happens when a gateway supports `GET /v1/items/resolve-file`, but the client's bearer token lacks the `resolve` scope (e.g. legacy pairings with `["clip", "briefs"]`)?
  - The gateway returns `403` with a `ScopeGap` body.
  - If `403` is collapsed into `unreachable` / silent fallback, the user receives no lanes and no guidance explaining that granting `--set resolve` will unblock the feature.
* **Recommendation:**
  - Explicitly specify that `403 insufficient_scope` from `resolveFile` returns `{ ok: false, reason: "insufficient_scope", scopeGap }`, rendering standard scope guidance (`nimbus-related__status` with `scopeCommand`).

### Q2.4: Specification of Copy for the Five File Lane Titles
* **Context:** §4.6 mentions adding "five lane titles" across `panel-in-page.ts` and `panel-view.ts`. `LANE_TITLES` requires default strings for `Record<AgentLane, string>`, and `SURFACE_LANE_TITLES` allows surface overrides.
* **Issue:** The spec does not state the exact title strings for `ghost` and `conflicts`, nor whether `impact`, `expert`, and `ownership` use default PR titles or file-specific titles on `file`.
* **Recommendation:** Explicitly document the title table:
  - `LANE_TITLES`:
    - `ghost`: `"Who else is editing this"` (or `"Active edits"`)
    - `conflicts`: `"Conflicting branches"` (or `"Potential conflicts"`)
  - `SURFACE_LANE_TITLES["file"]`:
    - `impact`: `"What breaks if this changes"` (vs PR: `"What breaks if it lands"`)
    - `expert`: `"Who understands this file"` (vs PR: `"Who should review it"`)
    - `ownership`: `"Who owns this"`

### Q2.5: `needsItemArm` Gating vs `expert` on `pr` Fallback
* **Context:** §5.2 explains that `expert` on `pr` sharpens to `{ itemUrl }` when `meetsFloor(roster.version, ITEM_ARM_FLOOR)`, but falls back to `{ topicOrFile: item.title }` when below the floor, ensuring it is never withheld.
* **Subtlety:**
  - In `agents-capability.ts`, `offeredLanes(roster, kind)` withholds any lane where `needsItemArm(lane, kind)` is true if `roster.version` does not meet the floor.
  - Therefore, `needsItemArm("expert", "pr")` **must return `false`**.
  - If `needsItemArm("expert", "pr")` returned `true`, `offeredLanes` would withhold `expert` from gateways `< 7.5.0`, contradicting the requirement that it is never withheld.
* **Recommendation:** Explicitly define `ITEM_ARM_PAIRS`:
  ```ts
  const ITEM_ARM_PAIRS: ReadonlySet<`${AgentLane}:${SurfaceKind}`> = new Set([
    "why:issue", "why:incident",
    "expert:issue", "expert:incident",
    "ownership:issue", "ownership:incident",
  ]);
  ```
  `agentParams` handles `expert` on `pr` independently via `meetsFloor(roster.version, ITEM_ARM_FLOOR)`.

---

## 3. Architecture & State Modeling Improvements

### I3.1: Dedicated `HeaderState` Arm for File Pages (`offersCapture` Isolation)
* **Context:** [`offersCapture(state)`](file:///C:/gitrep/nimbus-web-clipper/src/shared/capture-offer.ts#L30) checks `state.kind`. On `not-indexed` (with `fetchable: false`), it returns `true` and appends `"Save a copy to Nimbus"`.
* **Issue:**
  - If a file miss (`remote_not_tracked` / `file_not_indexed`) is represented as `not-indexed`, `offersCapture` would display a clip offer beneath the miss explanation.
  - Clipping a forge blob HTML page does not index a repository or create a local git checkout.
* **Recommendation:**
  - Add a dedicated `HeaderState` arm for file pages:
    ```ts
    | {
        readonly kind: "file";
        readonly surface: string;
        readonly banner?: string; // the miss sentence, or omitted on hit / unsupported
      }
    ```
  - Ensure `offersCapture` returns `false` for `kind: "file"`.
  - Update `laneContext()` in `panel-in-page.ts`: `pageSubject: shown.kind === "resolved" || shown.kind === "service" || shown.kind === "chosen" || (shown.kind === "file" && shown.banner === undefined)`.

### I3.2: Concurrent Resolution in `handleResolve` on `file` Pages
* **Context:** `handleResolve` runs `resolveItem` and `offeredFor` concurrently using `Promise.all` on item pages.
* **Recommendation:** Apply the exact same pattern for `recognition.kind === "file"`:
  ```ts
  const [fileRes, offered] = await Promise.all([
    deps.resolveFile(conn.origin, conn.token, recognition.product, recognition.forgeFile.repo, recognition.forgeFile.refAndPath),
    offeredFor(deps, conn.origin, conn.token, "file"),
  ]);
  ```
  This keeps worst-case latency bounded to `max(resolveFile, roster)` rather than `resolveFile + roster`.

### I3.3: Query String URL Encoding for `resolve-file`
* **Context:** `refAndPath` frequently contains slashes, branch qualifiers, tags, and special characters (e.g. `feature/user-auth#2/src/main.ts` or `v1.0.0-rc.1/path with spaces.ts`).
* **Recommendation:** Ensure `gateway-client.ts` constructs the query using `URLSearchParams` to guarantee compliant percent-encoding for `service`, `repo`, and `refAndPath`.

---

## 4. Edge Cases & Boundary Conditions

| Scenario | Expected Behavior | Verification |
| --- | --- | --- |
| **Self-Hosted GitLab with Deep Groups** | `repo` is full group path (`group/subgroup/project`), delimiter is `/-/blob/`. | Pass full repo coordinate and remainder `refAndPath` to `resolveFile`. |
| **Branch with Multiple Slashes** | URL is `/blob/feat/jira-123/sub-fix/src/app.ts`. `refAndPath` is `feat/jira-123/sub-fix/src/app.ts`. | Client does not split; gateway splits against checkout file list. |
| **SPA Route Change from PR to File** | User navigates from PR (`#482`) to a file view on GitHub without full page reload. | `checkNavigation` detects `kind` change (`pr` → `file`), cancels PR poll timers, updates `pinnedRecognition`, and issues `handleResolve`. |
| **Gateway 7.5.0 (Item Arm, No Version)** | `roster.version` is `null`. `meetsFloor(null, "7.5.0")` is `false`. | `expert` on `pr` sends `{ topicOrFile: item.title }`; `expert` on `issue` is withheld. |
| **Gateway 7.8.1 (Probe Route Available)** | Probe returns `200 { ok: true, path: "src/foo.ts" }`. | All 5 file lanes offered; agent invokes send `{ service, repo, refAndPath }`. |

---

## 5. Testing Strategy Recommendations

1. **Storage Guard Test for File Subjects:** Add unit test in `agent-run-store.test.ts` verifying that `isRunSubject({ kind: "file", repo: "acme/web", refAndPath: "main/src/index.ts" })` returns `true` and round-trips through `putRun` / `getRun`.
2. **Recognition Metadata Test:** Assert in `recognise.test.ts` that GitHub, GitLab, and Bitbucket file fixtures produce a `Recognition` object containing `forgeFile: { repo, refAndPath }`.
3. **`offersCapture` Negative Test:** Assert in `capture-offer.test.ts` that `offersCapture({ kind: "file", ... })` is strictly `false` for both hit and miss states.
4. **Table-Driven `needsItemArm` Test:** Test exhaustively all `(AgentLane, SurfaceKind)` combinations against `needsItemArm`, specifically verifying that `"expert:pr"` is `false` and `"why:pr"` is `false`.
5. **Probe Response Matrix Fixtures:** Test `handleResolve` with mock responses for:
   - `200 { ok: true, path: "..." }` → returns 5 offered lanes, no banner.
   - `200 { ok: false, reason: "remote_not_tracked" }` → returns 0 offered lanes, remote sentence.
   - `200 { ok: false, reason: "file_not_indexed" }` → returns 0 offered lanes, index sentence.
   - `404 Not Found` → returns 0 offered lanes, no banner.
   - `403 Forbidden { scopeGap }` → returns `needs-scope` state with CLI command.
