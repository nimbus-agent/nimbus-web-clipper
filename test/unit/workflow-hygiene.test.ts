import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIR = resolve(ROOT, ".github/workflows");

/**
 * Repo-wide hygiene rules for `.github/workflows/`, as a test rather than a
 * script — the same reasoning `doc-references.test.ts` records: no new gate to
 * wire, it rides `bun run test`, which CI already runs.
 *
 * Each rule below is here because its absence is invisible until it costs
 * something. A job without `timeout-minutes` inherits GitHub's six-hour default,
 * so one hung step holds a runner for the rest of the day; `store-credential-check`
 * was that job, and it is the one holding all seven store credentials. An action
 * on a floating tag is a supply-chain hole that no review notices, because the
 * line does not change when the code behind it does.
 *
 * `publish-workflow.test.ts` asserts the CONTENT of the release pipeline. This
 * file asserts the SHAPE of every workflow, including ones added later.
 */

type Workflow = { readonly name: string; readonly text: string };

function workflows(): Workflow[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(WORKFLOW_DIR, name), "utf8") }));
}

/**
 * Job name → that job's YAML block.
 *
 * Sliced from the `jobs:` key onward so the two-space keys under `on:` (`push`,
 * `pull_request`, `schedule`, …) are not mistaken for jobs, and stopped at the
 * next top-level key in case `jobs:` is ever not last.
 */
function jobBlocks(text: string): Map<string, string> {
  const jobsIdx = text.search(/^jobs:$/m);
  if (jobsIdx === -1) {
    throw new Error("no top-level `jobs:` key");
  }
  const after = text.slice(jobsIdx + "jobs:".length);
  const endIdx = after.search(/^[A-Za-z]/m);
  const body = endIdx === -1 ? after : after.slice(0, endIdx);

  const blocks = new Map<string, string>();
  const headers = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
  for (const [i, header] of headers.entries()) {
    const start = header.index ?? 0;
    const end = headers[i + 1]?.index ?? body.length;
    blocks.set(header[1] as string, body.slice(start, end));
  }
  return blocks;
}

const allJobs = (): { file: string; job: string; body: string }[] =>
  workflows().flatMap((wf) =>
    [...jobBlocks(wf.text)].map(([job, body]) => ({ file: wf.name, job, body })),
  );

describe("workflow hygiene", () => {
  // Guards the guard: every assertion below iterates a parsed set, and a parser
  // that silently returns nothing would make all of them pass over an empty list.
  test("every workflow parses to at least one job", () => {
    const empty = workflows()
      .filter((wf) => jobBlocks(wf.text).size === 0)
      .map((wf) => wf.name);
    expect(empty).toEqual([]);
    expect(allJobs().length).toBeGreaterThanOrEqual(workflows().length);
  });

  test("every job declares timeout-minutes", () => {
    const missing = allJobs()
      .filter(({ body }) => !/^\s{4}timeout-minutes:\s*\d+$/m.test(body))
      .map(({ file, job }) => `${file}:${job}`);
    expect(missing).toEqual([]);
  });

  test("every action is pinned to a 40-character commit SHA", () => {
    const floating: string[] = [];
    for (const wf of workflows()) {
      for (const match of wf.text.matchAll(/^\s*uses:\s*(\S+)\s*$/gm)) {
        const ref = match[1] as string;
        if (!/@[0-9a-f]{40}$/.test(ref)) {
          floating.push(`${wf.name} -> ${ref}`);
        }
      }
    }
    expect(floating).toEqual([]);
  });

  test("every workflow declares a top-level permissions block", () => {
    const missing = workflows()
      .filter((wf) => !/^permissions:$/m.test(wf.text))
      .map((wf) => wf.name);
    expect(missing).toEqual([]);
  });

  test("every checkout opts out of persisted credentials", () => {
    // `actions/checkout` leaves a usable push token in `.git/config` by default;
    // nothing here needs it, and a later step running untrusted code would.
    const offenders: string[] = [];
    for (const wf of workflows()) {
      const steps = wf.text.split(/^\s*- name:/m);
      for (const step of steps) {
        if (!step.includes("actions/checkout@")) continue;
        if (!step.includes("persist-credentials: false")) {
          offenders.push(wf.name);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("PR-triggered workflows cancel superseded runs", () => {
    // A push to an open PR should not leave the previous run burning minutes.
    const missing = workflows()
      .filter((wf) => /^\s{2}pull_request(_target)?:/m.test(wf.text))
      .filter((wf) => !/^concurrency:$/m.test(wf.text))
      .map((wf) => wf.name);
    expect(missing).toEqual([]);
  });

  test("no tag-triggered workflow cancels itself in progress", () => {
    // The inverse rule, and the more expensive one to get wrong: cancelling a
    // release mid-upload can leave a store submission half-made.
    const cancels = workflows()
      .filter((wf) => /^\s{4}tags:$/m.test(wf.text))
      .filter((wf) => /cancel-in-progress:\s*true/.test(wf.text))
      .map((wf) => wf.name);
    expect(cancels).toEqual([]);
  });
});
