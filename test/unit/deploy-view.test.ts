// @vitest-environment jsdom
// test/unit/deploy-view.test.ts
import { describe, expect, test, vi } from "vitest";
import {
  DEPLOY_SECTION_TITLE,
  GAP_NOTE,
  RISK_FACTOR_LABEL,
  RISK_LEVEL_LABEL,
  renderBindForm,
  renderDeployBody,
  renderDoraLink,
  renderRisk,
  renderSectionFrame,
  verdictLine,
} from "../../src/panel/deploy/deploy-view.ts";
import type { DeployPreflightResult, DeployRisk } from "../../src/shared/deploy.ts";
import {
  PREFLIGHT_GAPS,
  RISK_FACTOR_IDS,
  RISK_LEVELS,
  UNRECOGNISED_GAP,
} from "../../src/shared/deploy.ts";

const result = (over: Partial<DeployPreflightResult> = {}): DeployPreflightResult =>
  ({
    service: "web",
    target_ref: "main",
    computed_at: "2026-09-10T00:00:00.000Z",
    verdict: "ok",
    checks: {
      active_p1_incidents: { count: 0, findings: [], gap: null },
      failing_ci_runs: { count: 0, findings: [], gap: null },
      merge_conflicts: { count: 0, findings: [], gap: null },
    },
    ...over,
  }) as DeployPreflightResult;

describe("GAP_NOTE", () => {
  // This is the test that proves the Record is exhaustive. Deleting an arm from
  // GAP_NOTE makes the build red; this makes a BLANK arm red too.
  test("every gap member has a non-empty sentence", () => {
    // The client-only member is in this loop too: a check the gateway gapped
    // for a reason we don't know still has to say something, or it renders as
    // a bare label under a zero — the "all clear" §4.4 forbids.
    for (const gap of [...PREFLIGHT_GAPS, UNRECOGNISED_GAP] as const) {
      expect(GAP_NOTE[gap], `gap ${gap}`).toBeTruthy();
    }
  });
});

describe("renderSectionFrame", () => {
  // The section is a sibling of the shell, so nothing above it labels it. The
  // spec's §2 naming rule is the UI string, and Options and development.md both
  // tell the user to look for it.
  test("names the section, and hands back a separate body to repaint", () => {
    const { title, body } = renderSectionFrame(document);
    expect(title.textContent).toBe(DEPLOY_SECTION_TITLE);
    expect(DEPLOY_SECTION_TITLE).toBe("Deploy readiness");
    expect(title.className).toBe("nimbus-deploy__title");
    // Separate elements: the controller replaces the body's children on every
    // state change and the heading must survive all of them.
    expect(body).not.toBe(title);
    expect(body.className).toBe("nimbus-deploy__body");
  });
});

describe("verdictLine", () => {
  test("a clean verdict reads as clear", () => {
    expect(verdictLine(result(), "page")).toMatch(/clear/i);
  });

  // The rule that matters: warn + count 0 + unknown_service is "could not
  // evaluate", NOT "all clear" and NOT "problems found".
  test("an unknown service says it could not evaluate, never all-clear", () => {
    const line = verdictLine(
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: "unknown_service" },
          failing_ci_runs: { count: 0, findings: [], gap: "unknown_service" },
          merge_conflicts: { count: 0, findings: [], gap: "unknown_service" },
        },
      }),
      "page",
    );
    expect(line).toMatch(/could not/i);
    expect(line).not.toMatch(/clear/i);
    expect(line).not.toMatch(/\b0 problem/i);
  });

  test("a real warning names the count", () => {
    const line = verdictLine(
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: null },
          failing_ci_runs: { count: 2, findings: [], gap: null },
          merge_conflicts: { count: 1, findings: [], gap: null },
        },
      }),
      "page",
    );
    expect(line).toMatch(/3/);
  });
});

const risk = (over: Partial<DeployRisk> = {}): DeployRisk => ({
  level: "high",
  why: "High risk, driven by change_velocity: 5 deploys in 24 hours.",
  factors: [
    {
      id: { known: true, value: "system_state" },
      level: "low",
      evidence: "clear",
      evaluated: true,
    },
    {
      id: { known: true, value: "change_velocity" },
      level: "high",
      evidence: "5 in 24h",
      evaluated: true,
    },
    {
      id: { known: true, value: "oncall_coverage" },
      level: "low",
      evidence: "covered",
      evaluated: true,
    },
    {
      id: { known: true, value: "time_of_week" },
      level: "low",
      evidence: "weekday",
      evaluated: true,
    },
  ],
  unreadableFactors: 0,
  failAt: "high",
  verdictEscalated: true,
  ...over,
});

const clean = {
  active_p1_incidents: { count: 0, findings: [], gap: null },
  failing_ci_runs: { count: 0, findings: [], gap: null },
  merge_conflicts: { count: 0, findings: [], gap: null },
} as const;

const escalated = (over: Partial<DeployRisk> = {}) =>
  result({ verdict: "warn", checks: clean, risk: risk(over) });

describe("verdictLine — risk escalation (C11.1)", () => {
  const lines: string[] = [];
  const line = (r: DeployPreflightResult, basis: "page" | "default_branch" | "none") => {
    const out = verdictLine(r, basis);
    lines.push(out);
    return out;
  };

  test.each(["page", "default_branch"] as const)("escalated with basis %s names risk", (basis) => {
    expect(line(escalated(), basis)).toBe(
      "No blockers found for web, but deploy risk is high right now — your gateway is set to warn at high.",
    );
  });

  test("escalated with basis none still says CI was not checked", () => {
    expect(line(escalated(), "none")).toBe(
      "No blockers found for web, but CI was not checked, and deploy risk is high right now — your gateway is set to warn at high.",
    );
  });

  test("escalated with no failAt says it warns on risk, never a blank", () => {
    expect(line(escalated({ failAt: null }), "page")).toMatch(
      /— your gateway is set to warn on risk\.$/,
    );
  });

  test.each(["unknown", "unrecognised"] as const)(
    "escalated at level %s says risk could not be read",
    (level) => {
      expect(line(escalated({ level }), "page")).toContain("deploy risk could not be read");
    },
  );

  test("counted problems win over escalation", () => {
    const r = result({
      verdict: "warn",
      checks: { ...clean, failing_ci_runs: { count: 2, findings: [], gap: null } },
      risk: risk(),
    });
    expect(line(r, "page")).toBe("2 things to look at before deploying web.");
  });

  test("every check gapped wins over escalation", () => {
    const gapped = { count: 0, findings: [], gap: "no_repos" } as const;
    const r = result({
      verdict: "warn",
      checks: { active_p1_incidents: gapped, failing_ci_runs: gapped, merge_conflicts: gapped },
      risk: risk(),
    });
    expect(line(r, "page")).toBe("Could not evaluate web — see below.");
  });

  test("a warn with nothing counted and no risk says no readable reason", () => {
    expect(line(result({ verdict: "warn", checks: clean }), "page")).toBe(
      "Nimbus says to wait before deploying web, but sent no reason this version can read.",
    );
  });

  test("a warn with nothing counted and an unescalated risk says the same", () => {
    expect(line(escalated({ verdictEscalated: false }), "page")).toBe(
      "Nimbus says to wait before deploying web, but sent no reason this version can read.",
    );
  });

  test("no arm ever says 0 things", () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toMatch(/^0 things/);
  });
});

describe("renderDeployBody", () => {
  test("renders a gap sentence rather than a bare zero", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: "no_pagerduty_mapping" },
          failing_ci_runs: { count: 0, findings: [], gap: null },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
      "page",
    );
    expect(el.textContent).toContain(GAP_NOTE.no_pagerduty_mapping);
  });

  // A count with nothing under it is the same dishonesty as a bare zero: every
  // finding here was malformed and dropped, and the label alone would read as
  // one the user can go and look at.
  test("says so when a count arrives with no findings to show", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: null },
          failing_ci_runs: { count: 1, findings: [], gap: null },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
      "page",
    );
    const note = el.querySelector(".nimbus-deploy__more");
    expect(note?.textContent).toMatch(/no details/i);
    expect(note?.textContent).not.toMatch(/showing 0/i);
  });

  test("a capped list still reads as a cap, not as missing details", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: null },
          failing_ci_runs: {
            count: 12,
            findings: [
              {
                id: "c1",
                title: "build #9",
                conclusion: "failure",
                modified_at_ms: 1,
                branch: "main",
                head_sha: null,
                url: null,
              },
            ],
            gap: null,
          },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
      "page",
    );
    expect(el.querySelector(".nimbus-deploy__more")?.textContent).toBe("Showing 1 of 12.");
  });

  test("renders the client-only sentence for a gap this version doesn't know", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: UNRECOGNISED_GAP },
          failing_ci_runs: { count: 0, findings: [], gap: null },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
      "page",
    );
    expect(el.textContent).toContain(GAP_NOTE[UNRECOGNISED_GAP]);
  });

  test("links a finding that carries an http url", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: null },
          failing_ci_runs: {
            count: 1,
            findings: [
              {
                id: "c1",
                title: "build #9",
                conclusion: "failure",
                modified_at_ms: 1,
                branch: "main",
                head_sha: null,
                url: "https://ci.example/9",
              },
            ],
            gap: null,
          },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
      "page",
    );
    const a = el.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://ci.example/9");
    expect(a?.textContent).toBe("build #9");
  });

  test("renders a javascript: url as plain text, never a link", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: null },
          failing_ci_runs: {
            count: 1,
            findings: [
              {
                id: "c1",
                title: "hostile",
                conclusion: "failure",
                modified_at_ms: 1,
                branch: "main",
                head_sha: null,
                url: "javascript:alert(1)",
              },
            ],
            gap: null,
          },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
      "page",
    );
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("hostile");
  });

  test("a title is written with textContent, never as markup", () => {
    const el = renderDeployBody(
      document,
      result({
        verdict: "warn",
        checks: {
          active_p1_incidents: { count: 0, findings: [], gap: null },
          failing_ci_runs: {
            count: 1,
            findings: [
              {
                id: "c1",
                title: "<img src=x onerror=alert(1)>",
                conclusion: "failure",
                modified_at_ms: 1,
                branch: "main",
                head_sha: null,
                url: null,
              },
            ],
            gap: null,
          },
          merge_conflicts: { count: 0, findings: [], gap: null },
        },
      }),
      "page",
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("what the CI check was asked about", () => {
  const ciBox = (el: HTMLElement) =>
    [...el.querySelectorAll(".nimbus-deploy__check")].find((b) =>
      b.textContent?.startsWith("Failing CI runs"),
    );

  test("the page's own branch adds no note, and keeps the count", () => {
    const el = renderDeployBody(document, result(), "page");
    expect(ciBox(el)?.querySelector(".nimbus-deploy__gap")).toBeNull();
    expect(ciBox(el)?.textContent).toBe("Failing CI runs: 0");
  });

  test("a default-branch fallback names the branch it did check", () => {
    const el = renderDeployBody(document, result({ target_ref: "release" }), "default_branch");
    const note = ciBox(el)?.querySelector(".nimbus-deploy__gap")?.textContent;
    expect(note).toContain("release");
    expect(note).toMatch(/doesn't know this page's own branch/);
    // A build page already on the default branch reads this too.
    expect(note).not.toMatch(/not this page's/);
    expect(ciBox(el)?.textContent).toContain("Failing CI runs: 0");
  });

  // A zero against the literal HEAD is not a measurement: no branch has that name.
  test("no branch at all drops the zero and says CI was not checked", () => {
    const el = renderDeployBody(document, result({ target_ref: "HEAD" }), "none");
    const box = ciBox(el);
    expect(box?.querySelector(".nimbus-deploy__check-head")?.textContent).toBe("Failing CI runs");
    expect(box?.querySelector(".nimbus-deploy__gap")?.textContent).toMatch(/not checked/i);
    expect(box?.textContent).not.toContain("HEAD");
  });

  test("an ok verdict with no branch is never 'clear', nor painted as ok", () => {
    const r = result({ target_ref: "HEAD" });
    expect(verdictLine(r, "none")).not.toMatch(/clear/i);
    expect(verdictLine(r, "none")).not.toContain("HEAD");
    expect(verdictLine(r, "none")).toMatch(/CI was not checked/);
    const verdict = renderDeployBody(document, r, "none").querySelector(".nimbus-deploy__verdict");
    expect(verdict?.className).toContain("nimbus-deploy__verdict--warn");
  });

  test("an ok verdict on the default branch names that branch", () => {
    expect(verdictLine(result({ target_ref: "release" }), "default_branch")).toBe(
      "Clear to deploy web at release.",
    );
  });

  // The gateway's own reason wins: it explains the check, and a second sentence
  // about branches would describe a query that never ran.
  test("a gapped CI check shows the gateway's reason, not a branch note", () => {
    const r = result({
      verdict: "warn",
      checks: {
        active_p1_incidents: { count: 0, findings: [], gap: null },
        failing_ci_runs: { count: 0, findings: [], gap: "no_repos" },
        merge_conflicts: { count: 0, findings: [], gap: null },
      },
    } as Partial<DeployPreflightResult>);
    const notes = ciBox(renderDeployBody(document, r, "none"))?.querySelectorAll(
      ".nimbus-deploy__gap",
    );
    expect(notes).toHaveLength(1);
    expect(notes?.[0]?.textContent).toBe(GAP_NOTE.no_repos);
  });

  test("a real finding on the default branch keeps its count and gains the note", () => {
    const r = result({
      verdict: "warn",
      target_ref: "main",
      checks: {
        active_p1_incidents: { count: 0, findings: [], gap: null },
        failing_ci_runs: {
          count: 1,
          findings: [
            {
              id: "c1",
              title: "build",
              conclusion: "failure",
              modified_at_ms: 1,
              branch: "main",
              head_sha: null,
              url: null,
            },
          ],
          gap: null,
        },
        merge_conflicts: { count: 0, findings: [], gap: null },
      },
    } as unknown as Partial<DeployPreflightResult>);
    const box = ciBox(renderDeployBody(document, r, "default_branch"));
    expect(box?.textContent).toContain("Failing CI runs: 1");
    expect(box?.querySelector(".nimbus-deploy__gap")?.textContent).toContain("main");
  });
});

describe("renderBindForm", () => {
  test("a resolved outcome seeds the gateway's id and says so", () => {
    const form = renderBindForm(document, "web", { kind: "resolved", serviceId: "checkout" });
    expect(form.querySelector("input")?.value).toBe("checkout");
    expect(form.textContent).toMatch(/checkout/);
  });

  test("an unclaimed outcome keeps the guess and never says 'not configured'", () => {
    const form = renderBindForm(document, "web", { kind: "unclaimed" });
    expect(form.querySelector("input")?.value).toBe("web");
    const text = form.textContent ?? "";
    expect(text).toMatch(/names this repository/i);
    expect(text).not.toMatch(/not configured|isn't configured|set up DORA/i);
  });

  test("ambiguous renders one real button per candidate, and clicking rewrites the input", () => {
    const form = renderBindForm(document, "web", {
      kind: "ambiguous",
      serviceId: "checkout",
      candidates: ["checkout", "cart"],
    });
    const input = form.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("checkout");

    const group = form.querySelector('[role="group"]') as HTMLElement;
    expect(group.getAttribute("aria-label")).toBeTruthy();
    const chips = Array.from(group.querySelectorAll("button"));
    expect(chips.map((b) => b.textContent)).toEqual(["checkout", "cart"]);
    // Native buttons: focusable and Enter/Space-activated without help.
    expect(chips.every((b) => b.type === "button")).toBe(true);
    expect(chips.some((b) => b.hasAttribute("tabindex"))).toBe(false);

    chips[1]?.click();
    expect(input.value).toBe("cart");
  });

  test("forbidden names the scope fix and renders a pasteable command", () => {
    const form = renderBindForm(document, "web", {
      kind: "forbidden",
      scopeGap: { label: "laptop", required: "resolve", granted: ["clip", "briefs"] },
    });
    expect(form.querySelector("input")?.value).toBe("web");
    expect(form.textContent).toMatch(/nimbus clip scopes/);
  });

  // A label that is not safe to put in a shell command gets the note without
  // a command — never a pasteable line built from untrusted text.
  test("forbidden with an unsafe device label names the fix but builds no command", () => {
    const form = renderBindForm(document, "web", {
      kind: "forbidden",
      scopeGap: { label: "laptop; rm -rf ~", required: "resolve", granted: ["clip"] },
    });
    expect(form.querySelector(".nimbus-deploy__resolution")).not.toBeNull();
    expect(form.querySelector("code")).toBeNull();
    expect(form.textContent).not.toContain("rm -rf");
  });

  test("silent adds no note at all", () => {
    const form = renderBindForm(document, "web", { kind: "silent" });
    expect(form.querySelector("input")?.value).toBe("web");
    expect(form.querySelector(".nimbus-deploy__resolution")).toBeNull();
  });

  test("a refusal note replaces the resolution note but keeps the candidates", () => {
    const form = renderBindForm(
      document,
      "checkout",
      { kind: "ambiguous", serviceId: "checkout", candidates: ["checkout", "cart"] },
      "Nimbus has no [metrics.dora.checkout] block configured for that id.",
    );
    const text = form.textContent ?? "";
    expect(text).toMatch(/no \[metrics\.dora\.checkout\] block/);
    // Never both: the mapping sentence above the refusal reads as a contradiction.
    expect(text).not.toMatch(/Nimbus maps this repository/);
    expect(form.querySelectorAll('[role="group"] button')).toHaveLength(2);
  });

  // LOAD-BEARING: a `noteOverride` is only ever a bind REFUSAL, and `seed` is
  // then the id the user actually submitted. Preferring the resolution's id
  // there silently swaps their choice: pick `cart` out of the ambiguous set,
  // have the bind refused, and the form repaints reading `checkout` — so the
  // next click binds a service they never selected, while looking exactly like
  // a retry of the one they did.
  test("a refusal keeps the id the user submitted, not the resolution's", () => {
    const form = renderBindForm(
      document,
      "cart",
      { kind: "ambiguous", serviceId: "checkout", candidates: ["checkout", "cart"] },
      "Nimbus has no [metrics.dora.cart] block configured for that id.",
    );
    expect(form.querySelector("input")?.value).toBe("cart");
  });

  // The same "never both" rule, on the one outcome that carries a SECOND piece
  // of prose beside its note. A refusal replaces the forbidden note but the
  // scope command used to survive it, leaving `nimbus clip scopes …` sitting
  // under "Nimbus has no [metrics.dora.web] block" — a remedy for a problem
  // that is no longer on screen.
  test("a refusal over a forbidden resolution drops the scope command too", () => {
    const form = renderBindForm(
      document,
      "web",
      {
        kind: "forbidden",
        scopeGap: { label: "laptop", required: "resolve", granted: ["clip", "briefs"] },
      },
      "Nimbus has no [metrics.dora.web] block configured for that id.",
    );
    const text = form.textContent ?? "";
    expect(text).toMatch(/no \[metrics\.dora\.web\] block/);
    expect(text).not.toMatch(/nimbus clip scopes/);
    expect(text).not.toMatch(/missing the .resolve. scope/i);
    expect(form.querySelectorAll(".nimbus-deploy__resolution")).toHaveLength(1);
  });
});

describe("renderDoraLink", () => {
  test("is a button naming the service, never a chrome-extension:// anchor", () => {
    const onOpen = vi.fn();
    const p = renderDoraLink(document, "web-ci", onOpen);
    const b = p.querySelector("button");
    expect(b?.textContent).toBe("Delivery metrics for web-ci →");
    expect(p.querySelector("a")).toBeNull();
    b?.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("renderRisk (C11.1)", () => {
  const head = (el: HTMLElement) => el.querySelector(".nimbus-deploy__risk-head");
  const items = (el: HTMLElement) => [...el.querySelectorAll("li.nimbus-deploy__risk-factor")];

  test("every level and every factor id has a non-empty label", () => {
    for (const level of [...RISK_LEVELS, "unrecognised"] as const) {
      expect(RISK_LEVEL_LABEL[level], `level ${level}`).toBeTruthy();
    }
    for (const id of RISK_FACTOR_IDS) expect(RISK_FACTOR_LABEL[id], `id ${id}`).toBeTruthy();
  });

  test.each([
    ["low", "Risk right now: low"],
    ["elevated", "Risk right now: elevated"],
    ["high", "Risk right now: high"],
    ["unknown", "Risk right now: not enough data"],
    ["unrecognised", "Risk right now: couldn't be read by this version"],
  ] as const)("the head line for %s", (level, text) => {
    expect(head(renderRisk(document, risk({ level })))?.textContent).toBe(text);
  });

  test("nothing in the block ever carries the ok accent, at any level", () => {
    for (const level of [...RISK_LEVELS, "unrecognised"] as const) {
      const el = renderRisk(document, risk({ level }));
      for (const node of el.querySelectorAll("*")) expect(node.className).not.toMatch(/--ok/);
    }
  });

  test("tones: unknown head and an unevaluated factor are muted, a low factor is plain", () => {
    const el = renderRisk(
      document,
      risk({
        level: "unknown",
        factors: [
          {
            id: { known: true, value: "system_state" },
            level: "low",
            evidence: "e",
            evaluated: true,
          },
          {
            id: { known: true, value: "time_of_week" },
            level: "unknown",
            evidence: "e",
            evaluated: false,
          },
          {
            id: { known: true, value: "change_velocity" },
            level: "high",
            evidence: "e",
            evaluated: true,
          },
        ],
      }),
    );
    expect(head(el)?.classList.contains("nimbus-deploy__risk--muted")).toBe(true);
    const [low, unevaluated, high] = items(el);
    expect(low?.classList.contains("nimbus-deploy__risk--plain")).toBe(true);
    expect(unevaluated?.classList.contains("nimbus-deploy__risk--muted")).toBe(true);
    expect(high?.classList.contains("nimbus-deploy__risk--warn")).toBe(true);
  });

  test("an unevaluated factor reads not enough data, whatever level it carries", () => {
    const el = renderRisk(
      document,
      risk({
        factors: [
          {
            id: { known: true, value: "oncall_coverage" },
            level: "low",
            evidence: "no shift data",
            evaluated: false,
          },
        ],
      }),
    );
    expect(items(el)[0]?.textContent).toBe("On-call coverage: not enough data — no shift data");
  });

  test("a factor line is label, level and evidence, in the gateway's order", () => {
    const el = renderRisk(document, risk());
    expect(items(el).map((li) => li.textContent)).toEqual([
      "System state: low — clear",
      "Change velocity: high — 5 in 24h",
      "On-call coverage: low — covered",
      "Time of week: low — weekday",
    ]);
  });

  test("why and evidence are inert text, even when they look like links", () => {
    const el = renderRisk(
      document,
      risk({
        why: "see https://evil.example/why",
        factors: [
          {
            id: { known: true, value: "system_state" },
            level: "high",
            evidence: "see https://evil.example",
            evaluated: true,
          },
        ],
      }),
    );
    expect(el.querySelectorAll("a")).toHaveLength(0);
    expect(el.querySelector(".nimbus-deploy__risk-why")?.textContent).toBe(
      "see https://evil.example/why",
    );
    expect(items(el)[0]?.textContent).toContain("see https://evil.example");
  });

  test("an unfamiliar factor id is named as another factor, never dropped", () => {
    const el = renderRisk(
      document,
      risk({
        factors: [
          {
            id: { known: false, value: "moon_phase" },
            level: "low",
            evidence: "full",
            evaluated: true,
          },
        ],
      }),
    );
    expect(items(el)[0]?.textContent?.startsWith("Other factor (`moon_phase`)")).toBe(true);
  });

  test.each([
    [0, null],
    [1, "1 factor could not be read."],
    [3, "3 factors could not be read."],
  ] as const)("%i unreadable factors", (n, text) => {
    const el = renderRisk(document, risk({ unreadableFactors: n }));
    expect(el.querySelector(".nimbus-deploy__risk-unreadable")?.textContent ?? null).toBe(text);
  });

  // Every factor unreadable: the head, the why and the count still say
  // something, and no empty list is left behind.
  test("no readable factors renders no list, but still the count", () => {
    const el = renderRisk(document, risk({ factors: [], unreadableFactors: 4 }));
    expect(el.querySelector(".nimbus-deploy__risk-factors")).toBeNull();
    expect(head(el)?.textContent).toBe("Risk right now: high");
    expect(el.querySelector(".nimbus-deploy__risk-unreadable")?.textContent).toBe(
      "4 factors could not be read.",
    );
  });

  test("renderDeployBody without risk renders no risk block", () => {
    const body = renderDeployBody(document, result(), "page");
    expect(body.querySelector(".nimbus-deploy__risk")).toBeNull();
  });

  test("renderDeployBody with risk puts the block last, after the three checks", () => {
    const body = renderDeployBody(
      document,
      result({ risk: risk({ verdictEscalated: false }) }),
      "page",
    );
    expect(body.lastElementChild?.classList.contains("nimbus-deploy__risk")).toBe(true);
    expect(body.querySelectorAll(".nimbus-deploy__check")).toHaveLength(3);
  });
});
