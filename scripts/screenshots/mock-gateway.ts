// Loopback mock of the Nimbus gateway's locked endpoints, plus a sample
// article page to inject the related panel into. Dev/CI fixture only — never
// bundled into dist/. Run directly: `bun run mock-gateway`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { GATEWAY_PATHS } from "../../src/shared/gateway.ts";
import {
  CLIP_INGEST,
  FETCH_FIXTURE,
  PAIR_CONFIRM,
  RELATED,
  RESOLVE_FIXTURE,
} from "./gateway-fixtures.ts";

export const DEFAULT_PORT = 8765;

const SAMPLE_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Designing local-first software</title>
  <link rel="canonical" href="http://127.0.0.1/sample" />
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Pure request→response routing, over the Fetch API's `Request`/`Response`
 * so it is unit-testable without a real socket. `startMockGateway` is the
 * only caller that adapts this to a Node `http.Server`.
 */
export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/sample") {
    return new Response(SAMPLE_PAGE, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (req.method === "GET" && url.pathname === GATEWAY_PATHS.resolve) {
    return jsonResponse(RESOLVE_FIXTURE);
  }
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }
  switch (url.pathname) {
    case GATEWAY_PATHS.pairConfirm:
      return jsonResponse(PAIR_CONFIRM);
    case GATEWAY_PATHS.ingest:
      return jsonResponse(CLIP_INGEST);
    case GATEWAY_PATHS.related:
      return jsonResponse(RELATED);
    case GATEWAY_PATHS.itemsFetch:
      return jsonResponse(FETCH_FIXTURE);
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

async function serve(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
  const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers: toFetchHeaders(req.headers),
  });
  const response = await handleRequest(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(response.body === null ? undefined : await response.text());
}

export function startMockGateway(port: number = DEFAULT_PORT): Server {
  const server = createServer((req, res) => {
    serve(req, res, port).catch(() => {
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
