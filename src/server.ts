import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { JWTVerifyGetKey } from "jose";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { dashboardPage } from "./dashboard.js";
import { AccessError, authorizeRequest, requestAccessConfig, type RequestAccessConfig } from "./http-access.js";
import { VERSION, createServer } from "./mcp.js";
import type { Poller } from "./poller.js";

/**
 * Streamable HTTP at /mcp (stateless: a fresh server per request, JSON responses), on holdings-mcp's pattern.
 * /mcp is open on the LAN and, through Cloudflare, to a verified Access token. Everything else is LAN only
 * (a 404 through Access): the dashboard at /, /health, GET /api/status (the last poll in full), and
 * POST /api/poll (poll now, e.g. after a deploy; it still only reads).
 */

export interface ServeOptions {
  access?: RequestAccessConfig;
  accessKeys?: JWTVerifyGetKey;
  host: string;
  port: number;
  /** Where deployed.json is (beside the state file). */
  stateDir?: string;
}

/** This server's own /health, under the contract it asks of the others (docs/health-contract.md). */
export function healthStatus(poller: Poller, stateDir = "data") {
  let deployed: unknown = null;
  try { deployed = JSON.parse(fs.readFileSync(path.join(stateDir, "deployed.json"), "utf8")); } catch { /* No record on a fresh installation. */ }
  const s = poller.snapshot;
  return {
    ok: true, service: `${poller.config.suite}-ops-mcp`, version: VERSION, deployed,
    skills: poller.skills ? { ref: poller.skills.version.ref, commit: poller.skills.version.commit ?? null, count: poller.skills.skills.length } : null,
    polled_at: s?.polled_at ?? null,
    ...(s ? { services: { up: s.services.filter((v) => v.up).length, down: s.services.filter((v) => !v.up).map((v) => v.name) },
      findings: { fail: s.findings.filter((f) => f.severity === "fail").length, drift: s.findings.filter((f) => f.severity === "drift").length } } : {}),
  };
}

export function serveHttp(poller: Poller, options: ServeOptions): Promise<http.Server> {
  const name = `${poller.config.suite}-ops-mcp`;
  const access = options.access ?? requestAccessConfig(process.env, [name, `${name}.localdomain`]);
  const json = { "content-type": "application/json", "cache-control": "no-store" };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const { via } = await authorizeRequest(req, url.pathname, access, options.accessKeys);
      if (url.pathname !== "/mcp") {
        if (via !== "lan") return void res.writeHead(404, json).end(JSON.stringify({ error: "Not found." }));
        if (url.pathname === "/api/poll") {
          if (req.method !== "POST") return void res.writeHead(405, { ...json, allow: "POST" }).end(JSON.stringify({ error: "POST to poll." }));
          return void res.writeHead(200, json).end(JSON.stringify(await poller.poll()));
        }
        if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
        const send = (type: string, body: string) => void res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(req.method === "HEAD" ? undefined : body);
        if (url.pathname === "/health") return send("application/json", JSON.stringify(healthStatus(poller, options.stateDir)));
        if (url.pathname === "/api/status") return send("application/json", JSON.stringify(poller.snapshot ?? null));
        if (url.pathname === "/") return send("text/html; charset=utf-8", dashboardPage(poller.snapshot, poller.config.suite));
        return void res.writeHead(404).end();
      }
      if (req.method === "OPTIONS") return void res.writeHead(204).end();
      if (req.method !== "POST") {
        // Stateless: no server-initiated stream (GET) and no sessions to end (DELETE).
        return void res.writeHead(405, { allow: "POST, OPTIONS", "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null,
        }));
      }
      const mcp = createServer(poller);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (error instanceof AccessError) {
        if (!res.headersSent) res.writeHead(error.status, json).end(JSON.stringify({ error: error.message }));
        return;
      }
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  return new Promise((resolve) => server.listen(options.port, options.host, () => {
    const a = server.address();
    console.error(`${name} ${VERSION} listening on ${typeof a === "object" && a ? `${a.address}:${a.port}` : options.port} (/, /mcp, /health)`);
    resolve(server);
  }));
}

export async function serveStdio(poller: Poller): Promise<void> {
  await createServer(poller).connect(new StdioServerTransport());
}
