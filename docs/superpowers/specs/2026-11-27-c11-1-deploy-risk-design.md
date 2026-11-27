# C11.1 — Deploy risk on the deploy page · design

Status: approved in conversation 2026-11-27 (short design — a small change).
Roadmap brief: `ROADMAP.md` § C11.1. This spec is pruned once the feature ships;
anything still true afterwards moves into `docs/architecture.md` first.

## Intent

The deploy-readiness section (C10.1) answers "is this safe to ship?". The same
`GET /v1/preflight/deploy` answer now carries an optional, advisory `risk`
block that answers "and how risky is this moment?". Show it, honestly, in the
section the user already reads before deploying — and stop the verdict line
from misreporting a verdict the risk block escalated.

## The wire shape (verified against the gateway source)

Checked against Nimbus `origin/main` @ `bc2824a` (2026-11-27):
`packages/gateway/src/preflight/deploy-risk.ts` (the type),
`packages/gateway/src/preflight/preflight.ts:331-332` (the escalation), and
`packages/gateway/test/integration/http/preflight-deploy-route.test.ts` (an
integration test that exercises the real HTTP route and asserts the block's
presence, `advisory: true`, and the four factor ids in order). This retires the
roadmap brief's "Unverified" caveat; a live-gateway check remains a human step.

```ts
risk?: {
  level: "low" | "elevated" | "high" | "unknown";
  why: string;
  factors: { id: "system_state" | "change_velocity" | "oncall_coverage" | "time_of_week";
             level: "low" | "elevated" | "high" | "unknown";
             evidence: string;
             known: boolean }[];          // known:false ⇒ level "unknown"
  advisory: true;                         // always true
  fail_at: "elevated" | "high" | null;    // [preflight.risk] fail_at; null = never changes the verdict
  verdict_escalated: boolean;             // true only when fail_at was reached AND the checks said ok
}
```

The member is OPTIONAL and additive: an older gateway, or a service with no
risk config, omits it. The route stays `{ kind: "public" }` — no scope, no
re-pairing.

**The latent bug this fixes.** When `verdict_escalated` is true the gateway
returns `verdict: "warn"` with every check clean. Today's `verdictLine` renders
that as "0 things to look at before deploying X." — a count of nothing under a
warning. That is live on any gateway whose owner set `fail_at`, with or
without the rest of this feature.

## Goals

- Parse `risk` as an optional member of `DeployPreflightResult`.
- Render it as its own block under the three checks, before the "Delivery
  metrics →" link.
- Make the verdict line say why when the risk escalated it.
- Never render "0 things to look at" for any `warn`.

## Non-goals

- No change to the verdict this client shows — the gateway decides it.
- No new fetch, no new message type, no new route, no new permission.
- No risk on the DORA page, in the popup, or as its own palette row (the
  palette's existing "Deploy readiness" row opens the section that now
  contains it).
- No configuration UI for `fail_at` or quiet windows — that is gateway config.

## Anti-goals (a failure even if it "works")

- `unknown` — overall or per factor — ever reading as low, clear, or green.
- A malformed or newer-than-us risk block hiding or failing the verdict and
  checks.
- Any link built from `why` or `evidence` (gateway-authored prose).
- Silently dropping a factor this version does not recognise.

## Approaches

1. **Chosen — parse in `parseDeployPreflight`, render in `deploy-view.ts`.**
   The risk rides the response the worker already fetches and the message the
   panel already receives. (Corrected in final review: the message carries the
   PARSED shape, which the wire parser cannot validate, so the boundary uses
   its own `isDeployRisk` guard — see `docs/architecture.md`.)
2. *Rejected — a separate fetch or message for risk.* Same call twice, or a
   second guard to keep in step, for no gain.
3. *Rejected — fold risk into the verdict sentence* (option B in the
   conversation). Blurs the gateway's decision/advisory split and makes the
   `unknown` wording awkward. The user chose A: its own block.
4. *Rejected — show risk on the DORA page.* The decision to ship is made in the
   panel; the DORA page is history, not the moment.

## Design

### Parsing (`src/shared/deploy.ts`)

- New types, with the wire vocabulary and the parsed vocabulary kept apart:

  ```ts
  export const RISK_LEVELS = ["low", "elevated", "high", "unknown"] as const;
  export type RiskLevel = (typeof RISK_LEVELS)[number];          // wire
  export type ParsedRiskLevel = RiskLevel | "unrecognised";       // client-only extra
  export const RISK_FACTOR_IDS =
    ["system_state", "change_velocity", "oncall_coverage", "time_of_week"] as const;
  export type RiskFactorId = (typeof RISK_FACTOR_IDS)[number];
  export type RiskFailAt = "elevated" | "high";

  export interface DeployRiskFactor {
    /** A known id, or the gateway's own string for one this version does not know. */
    readonly id: { readonly known: true; readonly value: RiskFactorId }
              | { readonly known: false; readonly value: string };
    readonly level: ParsedRiskLevel;
    readonly evidence: string;
    readonly evaluated: boolean;                 // the wire's `known`
  }
  export interface DeployRisk {
    readonly level: ParsedRiskLevel;
    readonly why: string;
    readonly factors: readonly DeployRiskFactor[];
    /** Factor entries dropped as unreadable, so the view can say so. */
    readonly unreadableFactors: number;
    readonly failAt: RiskFailAt | null;
    readonly verdictEscalated: boolean;
  }
  ```

  The factor id is a tagged pair rather than `RiskFactorId | string` (which
  collapses to `string` and loses the narrowing the label Record needs). The
  wire's `known` is renamed `evaluated` in the parsed type so it cannot be
  confused with the id's `known` tag. Names are the builder's to adjust; the
  separation is not. `DeployPreflightResult` gains
  `readonly risk?: DeployRisk` (absent ⇔ no usable block).
- `parseDeployRisk(v: unknown): DeployRisk | null`, called from
  `parseDeployPreflight`. A `null` result OMITS `risk` — it never makes
  `parseDeployPreflight` return `null`. A bad advisory never costs the verdict.
- The rule, on the `PreflightGap` / `UNRECOGNISED_GAP` precedent
  (`deploy.ts`): a value of the wrong **type** is a broken shape and rejects;
  an unfamiliar **string** is a newer vocabulary and degrades visibly.
- Whole-block rejection (→ omitted) when: not an object; `level` not a string;
  `why` not a string; `factors` not an array; `verdict_escalated` not a
  boolean.
- Tolerant per field, so a newer gateway degrades visibly instead of vanishing:
  - an overall or factor `level` that is a string outside the four known
    values becomes `"unrecognised"` (never on the wire);
  - a factor `id` string outside the four known ids is kept as
    `{ known: false, value }` and rendered under a generic label (see
    Rendering);
  - a factor entry is dropped and counted in `unreadableFactors` when it is
    not an object, or its `id`, `level` or `evidence` is not a string, or its
    `known` is not a boolean. The block then renders "1 factor could not be
    read." / "N factors could not be read." (singular for one);
  - a factor with `known: false` is forced to `"unknown"` whatever level it
    claims (type narrow, runtime wide: never trust the pair to agree);
  - `fail_at` outside `"elevated" | "high"` parses as `null`.
- Bounds: the gateway's evidence strings are short prose; cap `why` and each
  `evidence` at a fixed length (builder picks, e.g. 500) and cap factors at a
  small number (e.g. 16) before rendering, so a hostile local response cannot
  balloon the panel. Truncation is visible ("…").
- `advisory` is not required to parse (it is always true upstream) and is not
  carried.

### Rendering (`src/panel/deploy/deploy-view.ts`, `deploy-css.ts`)

Block order inside `renderDeployBody`: verdict → three checks → **risk** →
(section adds the DORA link after, unchanged).

```
Risk right now: elevated
  Elevated risk, driven by change_velocity, oncall_coverage: <evidence>. Not evaluated: time_of_week.
                                                  ↑ `why`: one string, verbatim, wraps naturally
  · System state      low              — <evidence>
  · Change velocity   elevated         — <evidence>
  · On-call coverage  elevated         — <evidence>
  · Time of week      not enough data  — <evidence>
```

- Head line: `Risk right now: <label>`. Labels via a
  `Record<ParsedRiskLevel, string>` (exhaustive by construction: a Record, not
  a switch, so a new member without a label is a type error and no unreachable
  backstop line is left for coverage to count): `low` → "low", `elevated` →
  "elevated", `high` → "high", `unknown` → "not enough data", `unrecognised` →
  "couldn't be read by this version".
- Factor labels via `Record<RiskFactorId, string>`: System state, Change
  velocity, On-call coverage, Time of week. An id with `known: false` renders
  as "Other factor (`<value>`)" with the value as text.
- A factor with `evaluated: false` shows "not enough data", never a level.
- The unreadable-factors line, when `unreadableFactors > 0`, follows the list.
- Factors in the gateway's order.
- Tone classes: `high` and `elevated` use the existing warn styling;
  `low` uses the plain body colour — **not** the verdict's `--ok` accent, so a
  low risk never looks like an extra green light; `unknown` / `unrecognised`
  use the muted gap styling. No new colour tokens.
- `why` and every `evidence` are `textContent`. Nothing in the block is a link.
  The gateway's `why` (`whyLine`, `deploy-risk.ts:467-476`) is one string. It
  names driving factors by their raw ids (`change_velocity`) and, when some
  factors were not evaluated, appends " Not evaluated: <ids>." — but not when
  all were evaluated, and the overall-`unknown` sentence has its own wording.
  Render it verbatim whatever it says — do not rewrite or parse gateway prose —
  and let the labelled factor list below carry the readable names.
- When overall `level` is `unknown`, the `why` line is still shown (the gateway
  explains what is missing) and every factor still lists — the known ones keep
  their levels.

### The verdict line (`verdictLine`)

Evaluated in this order; the first arm that matches wins:

1. `verdict === "ok"` → unchanged (including the `basis: "none"` wording).
2. `warn`, total > 0 → unchanged ("N things to look at…"). Counted problems
   always win over escalation, so this arm sits above it. (Upstream only
   escalates when the checks said `ok`, i.e. total 0, so a response matching
   both is contradictory; the counted problems are the safer thing to say.)
3. `warn`, total 0, every check gapped → unchanged ("Could not evaluate…").
   Above escalation for the same reason: "no blockers found" would be a claim
   about checks that never ran. The risk block below still renders.
4. `warn`, total 0, `risk?.verdictEscalated === true` →
   - `basis !== "none"`: "No blockers found for `<service>`, but deploy risk
     is `<level label>` right now — your gateway is set to warn at
     `<failAt>`."
   - `basis === "none"`: "No blockers found for `<service>`, but CI was not
     checked, and deploy risk is `<level label>` right now — your gateway is
     set to warn at `<failAt>`." (The same rule as arm 1's: an answer about
     `HEAD` is never repeated as clear.)
   - `failAt === null` with escalation true is contradictory; end the
     sentence "…your gateway is set to warn on risk." rather than a blank.
   - The head-line labels do not read inside this sentence for the two
     non-levels, so it uses its own phrase: `low` / `elevated` / `high` →
     "deploy risk is <level> right now"; `unknown` / `unrecognised` → "deploy
     risk could not be read". (Upstream `reachesFailAt` never escalates on
     `unknown`, so both are contradictory payloads; say something true anyway.)
5. `warn`, total 0, otherwise (no readable reason) → "Nimbus says to wait
   before deploying `<service>`, but sent no reason this version can read."
   — replaces the "0 things" sentence, which can no longer be produced.

The tone class stays as today (`warn` for every `warn`).

### Supporting changes

- `scripts/screenshots/gateway-fixtures.ts` / `mock-gateway.ts`: the deploy
  fixture can carry a `risk` block (and one without, for the unchanged case).
- `test/e2e/deploy-readiness.e2e.ts`: one scenario with a risk block (head
  line, factors, unknown wording) and one with `verdict_escalated`, tagged
  with new `e2e:` ids.
- `docs/development.md` § Manual verification — Deploy readiness: a new step
  with those `<!-- e2e:… -->` markers, plus a human-only step to confirm a real
  gateway's block renders (the mock cannot compute risk).
- `CHANGELOG.md` under `[Unreleased]`: the risk block and the escalation fix.
- `ROADMAP.md` § C11.1: mark shipped and drop the "Unverified" caveat when the
  feature lands.
- `docs/architecture.md`: one durable paragraph — risk is advisory, parsed
  tolerantly, never fails the verdict, `unknown` never reads as clear — before
  this spec is pruned.

## Tests (unit, Vitest)

- `parseDeployPreflight`: absent risk → no member; well-formed → parsed; each
  whole-block rejection → member omitted but preflight still parses; unknown
  level → `unrecognised`; `known:false` + `level:"low"` → `unknown`; unknown
  factor id kept; malformed factor entry dropped and counted; bad `fail_at` →
  null; over-long strings truncated.
- `isDeployPreflightResponse` still accepts a response with a malformed risk.
- `verdictLine`: each of the five arms, including the "no readable reason"
  arm that replaced "0 things"; escalation with `basis: "none"`; escalation
  with `failAt: null`; escalated + total > 0 (counted problems win);
  escalated + every check gapped ("Could not evaluate" wins).
- `parseDeployRisk` type-vs-vocabulary split: a numeric overall `level`
  rejects the block; a numeric factor `level` drops that factor and counts it;
  an unfamiliar level string becomes `unrecognised`.
- `renderDeployBody` (jsdom): no block without risk (DOM identical to today's
  for an existing fixture); head line per level; `unknown` never carries the
  low/ok classes; no `<a>` inside the risk block even when evidence looks like
  a URL; unrecognised factor label; dropped-factor line.

## Left to the builder

- Exact string caps and the factor cap.
- CSS details within the existing tokens.
- Whether the risk block is a `<ul>` or a definition list — pick what reads
  well in the Shadow DOM panel and is accessible.
- The new `e2e:` id names.
