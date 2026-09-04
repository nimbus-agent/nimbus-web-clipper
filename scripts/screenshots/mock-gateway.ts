// Loopback mock of the Nimbus gateway's locked endpoints, plus a sample
// article page to inject the related panel into. Dev/CI fixture only — never
// bundled into dist/. Run directly: `bun run mock-gateway`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { GATEWAY_PATHS } from "../../src/shared/gateway.ts";
import { AGENT_LANES } from "../../src/shared/types.ts";
import {
  AGENT_INVOKE,
  AGENT_RUN_DONE,
  BRIEF_REPORT,
  CLIP_INGEST,
  EGRESS_HEAD,
  EGRESS_PROVE,
  EGRESS_VERIFY,
  EGRESS_WINDOW,
  FETCH_FIXTURE,
  type FedBriefCreate,
  type FedBriefSource,
  type FedClip,
  INDEX_BRIEF_REPORT,
  PAIR_CONFIRM,
  RELATED,
  RESOLVE_FILE_FIXTURE,
  RESOLVE_FIXTURE,
  type Scenario,
} from "./gateway-fixtures.ts";

export const DEFAULT_PORT = 8765;

/**
 * `canonicalHref` is parametric so the "good" and "bad" sample pages below
 * cannot drift from each other in anything but the one line that matters.
 *
 * The default page's declaration is deliberately **relative** (`/sample`),
 * not an absolute `http://127.0.0.1/sample` pinned to port 80. The mock
 * listens on an ephemeral port, so a port-80 declaration is cross-origin to
 * whatever port the mock actually bound — after Task 1's `resolveCanonical`
 * that is a REJECTION, not the resolved value every e2e spec that touches
 * this page expects. A relative href instead resolves correctly against
 * whatever port the mock lands on, and it is what exercises the
 * absolutise-against-the-page-URL path — the exact bug this slice exists to
 * fix — on every run rather than a rejection nothing asserts on.
 *
 * The same reasoning governs `og:image` below: it is relative for the same
 * ephemeral-port reason, and it is what gives `test/e2e/metadata.e2e.ts` an
 * absolutise path to assert on in a real browser.
 */
function samplePage(canonicalHref: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Designing local-first software</title>
  <link rel="canonical" href="${canonicalHref}" />
  <meta name="author" content="Ada Lovelace" />
  <meta property="og:site_name" content="Example Journal" />
  <meta property="article:published_time" content="2024-03-11T09:30:00Z" />
  <meta property="og:image" content="/img/hero.jpg" />
</head>
<body style="max-width:680px;margin:40px auto;font:16px/1.6 system-ui,sans-serif">
  <h1>Designing local-first software</h1>
  <p>Local-first software keeps your data on your own machine while still
  supporting collaboration and sync. This sample page exists so the related
  panel has a real article context to render against.</p>
  <p>The extension reads the page title and canonical URL, asks the local Nimbus
  gateway for related items, and shows them in an on-demand side panel.</p>
</body>
</html>
`;
}

const SAMPLE_PAGE = samplePage("/sample");

/**
 * Same body, a canonical declared for a different origin entirely —
 * `resolveCanonical` refuses this as `cross-origin`. Exists so
 * `test/e2e/canonical.e2e.ts` can assert the refusal path against a real
 * page in a real browser, the one thing the unit tests (which drive
 * `capture-in-page.ts`/`panel-in-page.ts` through jsdom, not a live DOM) do
 * not cover.
 */
const SAMPLE_PAGE_BAD_CANONICAL = samplePage("https://elsewhere.example/stolen");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Local, deliberately — see the module comment on `newBriefRuns` for why this
 *  does not import `isObject` from `src/`. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * One mock server's live brief runs, keyed by the id it issued. Created per
 * `startMockGateway` call and closed over by that server alone — NOT module
 * scope, so two harnesses (or two suites' servers) alive in one process
 * cannot see each other's counts, the same isolation every other per-test
 * fixture in this file gets from being constructed fresh.
 *
 * `nextId` is a monotonic counter held alongside the map, not `byId.size` —
 * this file never deletes a run, so today the two agree, but sizing off the
 * map would silently start reissuing ids the moment something did.
 */
export interface BriefRuns {
  readonly byId: Map<string, { expected: number; received: number; useIndex: boolean }>;
  nextId(): string;
}

export function newBriefRuns(): BriefRuns {
  const byId = new Map<string, { expected: number; received: number; useIndex: boolean }>();
  let counter = 0;
  return {
    byId,
    nextId: () => {
      counter += 1;
      return `brief-${counter}`;
    },
  };
}

/**
 * Pure request→response routing, over the Fetch API's `Request`/`Response`
 * so it is unit-testable without a real socket. `startMockGateway` is the
 * only caller that adapts this to a Node `http.Server`.
 */
/** Resolves after `ms` — the one legitimate use of a timer in this file: a
 *  scenario-requested, deliberate delay, never an arbitrary wait a caller
 *  didn't ask for. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleRequest(
  req: Request,
  scenario: Scenario = {},
  runs: BriefRuns = newBriefRuns(),
): Promise<Response> {
  const url = new URL(req.url);
  scenario.onRequest?.(url.pathname);
  const delayMs = scenario.delayMs?.[url.pathname];
  if (delayMs !== undefined && delayMs > 0) {
    await wait(delayMs);
  }
  const override = scenario.status?.[url.pathname];
  if (override !== undefined && override !== 200) {
    return new Response(null, { status: override });
  }
  if (req.method === "GET" && url.pathname === "/sample") {
    return new Response(SAMPLE_PAGE, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (req.method === "GET" && url.pathname === "/sample-bad-canonical") {
    return new Response(SAMPLE_PAGE_BAD_CANONICAL, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  // `GET /v1/health` — the unauthenticated liveness route zero-config discovery
  // probes. Mirrors the real gateway's body exactly (`status: "ok"`), because
  // `probeHealth` shape-checks it: something else listening on the port can
  // return 200, so a bare 200 must NOT read as "Nimbus is here".
  if (req.method === "GET" && url.pathname === GATEWAY_PATHS.health) {
    return jsonResponse({ status: "ok", gateway: "read_only_http" });
  }
  if (req.method === "GET" && url.pathname === GATEWAY_PATHS.resolve) {
    const target = url.searchParams.get("url") ?? "";
    const keyed = scenario.resolve?.[target];
    return jsonResponse(keyed ?? scenario.resolveDefault ?? RESOLVE_FIXTURE);
  }
  // `GET /v1/items/resolve-file` — C7's proposed forge-file probe, not shipped
  // upstream yet (see GATEWAY_PATHS.resolveFile's own doc comment). Same
  // keyed-by-exact-request shape as `resolve` just above: the default answers
  // a hit for any coordinate, and a scenario keys a specific coordinate to
  // either miss fixture so both are reachable. No separate auth/scope check —
  // it falls under the same generic `scenario.status` override every other
  // path already gets, checked once above before routing.
  if (req.method === "GET" && url.pathname === GATEWAY_PATHS.resolveFile) {
    const service = url.searchParams.get("service") ?? "";
    const repo = url.searchParams.get("repo") ?? "";
    const refAndPath = url.searchParams.get("refAndPath") ?? "";
    const target = `${service}:${repo}:${refAndPath}`;
    const keyed = scenario.resolveFile?.[target];
    return jsonResponse(keyed ?? scenario.resolveFileDefault ?? RESOLVE_FILE_FIXTURE);
  }
  // The four egress-ledger reads. GETs, checked before the POST-only gate below.
  // `egress` is matched before its three children because none of them is a
  // prefix of another — an exact match each, same as the real route table.
  if (req.method === "GET" && url.pathname === GATEWAY_PATHS.egress) {
    if (scenario.egress !== undefined) {
      return jsonResponse(scenario.egress);
    }
    // Honour `before` and `limit` against the default fixture. A mock that
    // ignored the cursor would answer every page with the same four rows, so a
    // paging test could pass against a client that never sent one.
    const before = Number.parseInt(url.searchParams.get("before") ?? "", 10);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    let rows = [...EGRESS_WINDOW.rows];
    if (Number.isSafeInteger(before)) {
      rows = rows.filter((r) => r.id < before);
    }
    if (Number.isSafeInteger(limit) && limit > 0) {
      rows = rows.slice(0, limit);
    }
    return jsonResponse({
      rows,
      // Counted over the WHOLE window, never the page — the property the real
      // route exists to provide.
      rowsTotal: EGRESS_WINDOW.rowsTotal,
      rowsTruncated: rows.length < EGRESS_WINDOW.rowsTotal,
    });
  }
  if (req.method === "GET" && url.pathname === GATEWAY_PATHS.egressHead) {
    return jsonResponse(scenario.egressHead ?? EGRESS_HEAD);
  }
  if (req.method === "GET" && url.pathname === GATEWAY_PATHS.egressVerify) {
    return jsonResponse(scenario.egressVerify ?? EGRESS_VERIFY);
  }
  if (req.method === "GET" && url.pathname === GATEWAY_PATHS.egressProve) {
    return jsonResponse(scenario.egressProve ?? EGRESS_PROVE);
  }
  // `GET /v1/agents/runs/{id}` — the poll route. Checked ahead of the
  // POST-only gate below because it is the one GET route under `/v1/agents`;
  // every run reports `done` immediately (see AGENT_RUN_DONE's doc comment).
  if (req.method === "GET" && url.pathname.startsWith(`${GATEWAY_PATHS.agentRuns}/`)) {
    return jsonResponse(scenario.agentRun ?? AGENT_RUN_DONE);
  }
  // The five research-brief routes. `expected` is echoed from what create
  // declared, so the page's received/expected counter is real rather than fixed.
  // Checked ahead of the POST-only gate below because `GET /v1/briefs/{id}` (the
  // poll route) is not POST — create is the bare base, the other four append
  // `/{id}` and an action.
  if (url.pathname === GATEWAY_PATHS.briefs && req.method === "POST") {
    const body: unknown = await req.json();
    const sources = isObject(body) && Array.isArray(body["sources"]) ? body["sources"] : [];
    const useIndex = isObject(body) && body["useIndex"] === true;
    scenario.onBriefCreate?.((isObject(body) ? body : {}) as FedBriefCreate);
    const id = runs.nextId();
    runs.byId.set(id, { expected: sources.length, received: 0, useIndex });
    return jsonResponse({ id, status: "collecting", expected: sources.length });
  }
  const brief = /^\/v1\/briefs\/([^/]+)(?:\/(sources|run|save))?$/.exec(url.pathname);
  if (brief !== null) {
    const id = brief[1] ?? "";
    const run = runs.byId.get(id);
    if (run === undefined) {
      // An id this server never issued. 404 rather than a cheerful default: a
      // fixture that answers for a run it does not have hides a client bug.
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    // Every action below is method-checked, not just `sources`: a GET to
    // `.../sources`, or a GET/PUT to `.../run` or `.../save`, is a client bug
    // exactly as an unknown run id is — the cheerful 200 default two lines
    // above exists for the base poll route (`GET`, no action), not for these.
    const action = brief[2];
    if (action === "sources") {
      if (req.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      scenario.onBriefSource?.((await req.json()) as FedBriefSource);
      run.received += 1;
      return jsonResponse({ accepted: true, received: run.received, expected: run.expected });
    }
    if (action === "run") {
      if (req.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      return jsonResponse({ status: "running" });
    }
    if (action === "save") {
      if (req.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      return jsonResponse({ itemId: "item-1" });
    }
    if (req.method !== "GET") {
      return new Response(null, { status: 405 });
    }
    // Only a run that asked to search the index ever gets clip citations back
    // — a run that did not must see none at all, the same as the real gateway.
    return jsonResponse({
      status: "done",
      report: run.useIndex ? INDEX_BRIEF_REPORT : BRIEF_REPORT,
    });
  }
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }
  // `POST /v1/agents/{agent}` — the invoke route. Carries a path parameter
  // (the agent name), which the exact-match switch below cannot express, so
  // it is checked ahead of it. 404s on any agent this phase does not ship —
  // mirroring the real gateway's "unknown agent" 404 — rather than accepting
  // an arbitrary lane name.
  if (url.pathname.startsWith(`${GATEWAY_PATHS.agents}/`)) {
    const agent = url.pathname.slice(GATEWAY_PATHS.agents.length + 1);
    return (AGENT_LANES as readonly string[]).includes(agent)
      ? new Response(JSON.stringify(AGENT_INVOKE), {
          status: 202,
          headers: { "content-type": "application/json" },
        })
      : new Response(null, { status: 404 });
  }
  switch (url.pathname) {
    case GATEWAY_PATHS.pairConfirm:
      return jsonResponse(PAIR_CONFIRM);
    case GATEWAY_PATHS.ingest: {
      if (scenario.onClipIngest !== undefined) {
        const body: unknown = await req.json();
        scenario.onClipIngest((isObject(body) ? body : {}) as FedClip);
      }
      return jsonResponse(scenario.ingest ?? CLIP_INGEST);
    }
    case GATEWAY_PATHS.related:
      return jsonResponse(scenario.related ?? RELATED);
    case GATEWAY_PATHS.itemsFetch:
      return jsonResponse(scenario.itemsFetch ?? FETCH_FIXTURE);
    default:
      return new Response(null, { status: 404 });
  }
}

function toFetchHeaders(incoming: IncomingMessage["headers"]): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    }
  }
  return headers;
}

/** Buffer the whole request body. Node's `IncomingMessage` is a readable
 *  stream, and the brief routes are the first ones in this file that need the
 *  POST body at all (every earlier route ignores it) — so buffering it here,
 *  once, is simpler than teaching `Request` to stream a Node stream, and a
 *  loopback dev fixture has no reason to handle a body large enough for that
 *  to matter. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  scenario: Scenario,
  runs: BriefRuns,
): Promise<void> {
  const method = req.method ?? "GET";
  // Fetch's `Request` refuses a body on GET/HEAD, so only buffer — and only
  // attach — one for a method that can carry one.
  const bodyBuf = method === "GET" || method === "HEAD" ? null : await readBody(req);
  const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
    method,
    headers: toFetchHeaders(req.headers),
    ...(bodyBuf !== null && bodyBuf.length > 0 ? { body: new Uint8Array(bodyBuf) } : {}),
  });
  const response = await handleRequest(request, scenario, runs);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(response.body === null ? undefined : await response.text());
}

export function startMockGateway(scenario: Scenario = {}, port: number = DEFAULT_PORT): Server {
  // One run map per server, closed over here — see `newBriefRuns`'s own
  // comment for why this must not live at module scope.
  const runs = newBriefRuns();
  const server = createServer((req, res) => {
    serve(req, res, port, scenario, runs).catch(() => {
      res.writeHead(500).end();
    });
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`mock gateway listening on http://127.0.0.1:${port}`);
  });
  return server;
}

// Start only when run directly (not when imported by the capture driver).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startMockGateway();
}
