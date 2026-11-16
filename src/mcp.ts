import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Poller, Snapshot } from "./poller.js";

export const VERSION = "0.1.0";

const instructions = (suite: string) => `Is the ${suite} suite healthy, and if not, where do I look? One answer for every server behind the portal, so there's no need to call each one's own status tool.
Call status first: one row per service (up or down and since when, version, deployed commit and branch, tools listed), each terminology subscriber's lag, and how many findings are open. When that count isn't zero, findings lists them: a service that's down, one deployed from a branch or an unclean checkout, a subscriber behind or blocked, and the cross-service checks holdings-mcp runs. Each finding names the repository that owns the fix and when it was first seen.
A fail is wrong now. A drift should heal by itself or is waiting for a person; its age says which.
This server reads and reports. It restarts, deploys, and changes nothing; act on a finding in the repository it names.`;

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function statusOf(s: Snapshot) {
  return {
    suite: s.suite,
    polled_at: s.polled_at,
    services: s.services.map((v) => ({
      name: v.name, up: v.up, since: v.since,
      ...(v.health?.version ? { version: v.health.version } : {}),
      ...(v.health?.deployed ? { deployed: {
        ...(v.health.deployed.branch ? { branch: v.health.deployed.branch } : {}),
        ...(v.health.deployed.commit ? { commit: v.health.deployed.commit.slice(0, 7) } : {}),
        ...(v.health.deployed.at ? { at: v.health.deployed.at } : {}),
        ...(v.health.deployed.dirty ? { dirty: true } : {}),
      } } : {}),
      ...(v.tools ? { tools: v.tools.names.length } : {}),
      ...(v.third_party ? { third_party: true } : {}),
      ...(!v.up ? { error: v.health?.error ?? v.tools?.error } : {}),
    })),
    ...(s.subscribers ? { subscribers: s.subscribers.ok
      ? s.subscribers.items.map((u) => ({ id: u.id, pending: u.pending, blocked: u.blocked, last_seen: u.last_seen }))
      : { error: s.subscribers.error } } : {}),
    tools_total: s.tools_total,
    ...(s.tool_budget !== undefined ? { tool_budget: s.tool_budget } : {}),
    findings: { fail: s.findings.filter((f) => f.severity === "fail").length, drift: s.findings.filter((f) => f.severity === "drift").length },
  };
}

export function createServer(poller: Poller): McpServer {
  const { suite } = poller.config;
  const server = new McpServer({ name: `${suite}-ops-mcp`, version: VERSION }, { instructions: instructions(suite) });

  server.registerTool("status", {
    title: "Suite status",
    description: "Every service in the suite in one answer: up or down and since when, version, deployed branch and commit, and how many tools it lists; each terminology subscriber's lag; the suite's tool total; and the count of open findings (list them with findings). From the last poll, at most a minute or so old.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => json(statusOf(await poller.current())));

  server.registerTool("findings", {
    title: "Open findings",
    description: "What needs attention across the suite, worst and oldest first: services that are down, deployed from a branch, or deployed with uncommitted changes; subscribers behind or blocked on the terminology; and holdings-mcp's cross-service checks. Each has a severity (fail: wrong now; drift: healing or waiting for a person), the repository that owns the fix, and when it was first seen.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    const s = await poller.current();
    return json({ suite: s.suite, polled_at: s.polled_at, findings: s.findings });
  });

  return server;
}
