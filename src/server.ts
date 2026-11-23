import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { JWTVerifyGetKey } from "jose";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { dashboardPage, servicePage } from "./dashboard.js";
import { FAVICON } from "./favicon.js";
import { AccessError, authorizeRequest, isPublicPath, requestAccessConfig, type RequestAccessConfig } from "./http-access.js";
import { VERSION, createServer } from "./mcp.js";
import type { Poller } from "./poller.js";

/**
 * Streamable HTTP at /mcp (stateless: a fresh server per request, JSON responses), on holdings-mcp's pattern.
 * /mcp is open on the LAN and, through Cloudflare, to a verified Access token. The public page at / is for
 * anyone the tunnel lets through, with or without a token: it shows nothing a stranger shouldn't see. So is
 * /services/<name>, one service's page (for a third party, the only page it has).
 * Everything else is LAN only (a 404 through the tunnel): the admin page at /admin and its POST /admin/poll,
 * /health, GET /api/status (the last poll in full), and POST /api/poll (poll now, e.g. after a deploy).
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

/**
 * Did this POST come from a page on this server? A browser says so with Origin, or with Sec-Fetch-Site; one
 * that names another site is refused. With neither header, the request is from curl or a script, not a page:
 * `required` says whether that is enough (POST /api/poll) or not (the admin page's form, which a browser
 * always sends with one of them).
 */
export function fromThisSite(req: http.IncomingMessage, required: boolean): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined) return site === "same-origin";
  return !required;
}

export function serveHttp(poller: Poller, options: ServeOptions): Promise<http.Server> {
  const name = `${poller.config.suite}-ops-mcp`;
  const access = options.access ?? requestAccessConfig(process.env, [name, `${name}.localdomain`]);
  const json = { "content-type": "application/json", "cache-control": "no-store" };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const { via } = await authorizeRequest(req, url.pathname, access, options.accessKeys);
      if (url.pathname === "/") {
        if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
        const page = dashboardPage(poller.snapshot, poller.config.suite, { lan: via === "lan" });
        return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(req.method === "HEAD" ? undefined : page);
      }
      if (url.pathname === "/favicon.svg") {
        if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
        return void res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" })
          .end(req.method === "HEAD" ? undefined : FAVICON);
      }
      if (isPublicPath(url.pathname)) {
        if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
        let name: string;
        try { name = decodeURIComponent(url.pathname.slice("/services/".length)); } catch { return void res.writeHead(404).end(); }
        const page = poller.snapshot && servicePage(poller.snapshot, name, poller.skills?.toolsUsed?.[name], Date.now(), via === "lan");
        if (!page) return void res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("No such service in this suite, or no poll yet.");
        return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(req.method === "HEAD" ? undefined : page);
      }
      if (url.pathname !== "/mcp") {
        if (via !== "lan") return void res.writeHead(404, json).end(JSON.stringify({ error: "Not found." }));
        if (url.pathname === "/admin/poll") {
          if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
          // Only from the admin page itself, not a form on some other site the browser has open.
          if (!fromThisSite(req, true)) return void res.writeHead(403).end();
          await poller.poll();
          return void res.writeHead(303, { location: "/admin" }).end();
        }
        if (url.pathname === "/api/poll") {
          if (req.method !== "POST") return void res.writeHead(405, { ...json, allow: "POST" }).end(JSON.stringify({ error: "POST to poll." }));
          // For curl and scripts; a page on another site can't use it in place of /admin/poll.
          if (!fromThisSite(req, false)) return void res.writeHead(403, json).end(JSON.stringify({ error: "Not from this site." }));
          return void res.writeHead(200, json).end(JSON.stringify(await poller.poll()));
        }
        if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
        const send = (type: string, body: string) => void res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(req.method === "HEAD" ? undefined : body);
        if (url.pathname === "/health") return send("application/json", JSON.stringify(healthStatus(poller, options.stateDir)));
        if (url.pathname === "/api/status") return send("application/json", JSON.stringify(poller.snapshot ?? null));
        if (url.pathname === "/admin") return send("text/html; charset=utf-8", dashboardPage(poller.snapshot, poller.config.suite, { admin: true, worklist: poller.config.checks?.worklist }));
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
    console.error(`${name} ${VERSION} listening on ${typeof a === "object" && a ? `${a.address}:${a.port}` : options.port} (/, /admin, /mcp, /health)`);
    resolve(server);
  }));
}

export async function serveStdio(poller: Poller): Promise<void> {
  await createServer(poller).connect(new StdioServerTransport());
}
