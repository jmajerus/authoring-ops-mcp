import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Poller, Snapshot } from "./poller.js";
import { SkillError, readSkillFile, versionLabel } from "./skills.js";

export const VERSION = "0.1.0";

/**
 * Short on purpose: the portal joins every server's instructions and cuts the result off at a length, so each
 * sentence here costs another server one. The suite's own routing comes from its config (guidance).
 */
export function instructions(poller: Poller): string {
  const { suite, guidance } = poller.config;
  return [
    `The front door to the ${suite} suite: which server does what, whether they're working, and the skills written for them.`,
    ...guidance,
    "If a tool fails or answers oddly, call status: one row per service (up or down, what it runs), and a count of open findings. findings lists them, each with who owns the fix. This server changes nothing.",
    ...(poller.skills ? ["Skills are step-by-step procedures for whole tasks (an article, a survey of sources, a check of a draft). If one is installed in this session, use that copy. If none is, list_skills names them and get_skill returns one to follow."] : []),
  ].join("\n");
}

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
    ...(s.skills ? { skills: { ref: s.skills.version.ref, ...(s.skills.version.commit ? { commit: s.skills.version.commit.slice(0, 7) } : {}), count: s.skills.names.length } } : {}),
    tools_total: s.tools_total,
    ...(s.tool_budget !== undefined ? { tool_budget: s.tool_budget } : {}),
    findings: { fail: s.findings.filter((f) => f.severity === "fail").length, drift: s.findings.filter((f) => f.severity === "drift").length },
  };
}

export function createServer(poller: Poller): McpServer {
  const { suite } = poller.config;
  const server = new McpServer({ name: `${suite}-ops-mcp`, version: VERSION }, { instructions: instructions(poller) });

  server.registerTool("status", {
    title: "Suite status",
    description: "Every service in the suite in one answer: up or down and since when, version, deployed branch and commit, and how many tools it lists; each terminology subscriber's lag; the suite's tool total; and the count of open findings (list them with findings). From the last poll, at most a minute or so old.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => json(statusOf(await poller.current())));

  server.registerTool("findings", {
    title: "Open findings",
    description: "What needs attention across the suite, worst and oldest first: services that are down, deployed from a branch, or deployed with uncommitted changes; subscribers behind or blocked on the terminology; tools the skills call that a service no longer lists; and one line for each cross-service check that isn't passing (the detail is at its link). Each has a severity (fail: wrong now; drift: healing or waiting for a person), who owns the fix, and when it was first seen.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    const s = await poller.current();
    return json({ suite: s.suite, polled_at: s.polled_at, findings: s.findings });
  });

  const skills = poller.skills;
  if (skills) {
    server.registerTool("list_skills", {
      title: "List the skills",
      description: `The skills written for the ${suite} suite: each one's name, what it's for and when to use it, and its files. For a session with no skills installed; an installed copy is the one to use. Fetch one with get_skill.`,
      inputSchema: {},
      annotations: readOnly,
    }, () => json({ source: versionLabel(skills.version), skills: skills.skills }));

    server.registerTool("get_skill", {
      title: "Get a skill",
      description: "A skill's instructions (its SKILL.md), or another of its files, as text to follow. Read SKILL.md first; it says when to read the others. A skill may tell you to run a script: without a shell, say so and do the step it describes by hand, or skip it and tell the person what went unchecked.",
      inputSchema: {
        name: z.string().describe("A skill's name, from list_skills"),
        file: z.string().optional().describe("One of the skill's files, from list_skills. Default SKILL.md"),
      },
      annotations: readOnly,
    }, ({ name, file }) => {
      try {
        const text = readSkillFile(skills, name, file);
        const others = skills.skills.find((s) => s.name === name)!.files.filter((f) => f !== (file ?? "SKILL.md"));
        const head = `[${name}/${file ?? "SKILL.md"}, from ${versionLabel(skills.version)}. Links in it are to the skill's other files${others.length ? ` (${others.join(", ")})` : ""}: fetch one with get_skill's file.]`;
        return { content: [{ type: "text", text: `${head}\n\n${text}` }] };
      } catch (error) {
        if (error instanceof SkillError) return { isError: true, content: [{ type: "text", text: error.message }] };
        throw error;
      }
    });
  }

  return server;
}
