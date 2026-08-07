// Loopback mock of the Nimbus gateway's three locked endpoints, plus a sample
// article page to inject the related panel into. Dev/CI fixture only — never
// bundled into dist/. Run directly: `bun run mock-gateway`.
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { CLIP_PATHS, PROPOSED_PATHS } from "../../src/shared/gateway.ts";
import { CLIP_INGEST, PAIR_CONFIRM, RELATED, RESOLVE } from "./gateway-fixtures.ts";

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

export function startMockGateway(port: number = DEFAULT_PORT): Server {
  const server = createServer((req, res) => {
    const json = (body: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/sample") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(SAMPLE_PAGE);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    switch (req.url) {
      case CLIP_PATHS.pairConfirm:
        json(PAIR_CONFIRM);
        return;
      case CLIP_PATHS.ingest:
        json(CLIP_INGEST);
        return;
      case CLIP_PATHS.related:
        json(RELATED);
        return;
      // PROPOSED route — the real gateway 404s here today, which the client maps
      // to "this gateway can't resolve pages yet". Serving it lets the dev and
      // screenshot harness exercise the resolved path.
      case PROPOSED_PATHS.resolve:
        json(RESOLVE);
        return;
      default:
        res.writeHead(404).end();
    }
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
