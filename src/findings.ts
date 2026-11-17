import type { ServiceConfig, SuiteConfig } from "./config.js";
import type { ChecksState, HealthState, SubscribersState, ToolsState } from "./probes.js";
import type { SkillSet } from "./skills.js";
import type { Store } from "./store.js";

/**
 * What needs someone's attention, from one poll. Each finding names who owns the fix. Severities are
 * holdings-mcp's: `fail` is wrong now; `drift` should heal by itself or is waiting for a person.
 */

export interface ServiceState {
  name: string;
  repo?: string;
  admin?: string;
  third_party: boolean;
  up: boolean;
  since: string;
  health?: HealthState;
  tools?: ToolsState;
}

export interface Finding {
  id: string;
  severity: "fail" | "drift";
  /** Who owns the fix: a repository, or what the source said. */
  fix: string;
  summary: string;
  /** Where the detail is, when another service keeps it. */
  link?: string;
  first_seen: string;
}

interface Candidate extends Omit<Finding, "first_seen"> {
  first_seen?: string;
  /** Reported only once it has lasted this long: a subscriber a few changes behind between its polls isn't news. */
  after_minutes?: number;
}

/** This server's own tools: status and findings, and list_skills and get_skill when it carries skills. */
export const ownTools = (skills?: SkillSet) => (skills ? 4 : 2);

export function toolsTotal(services: ServiceState[], skills?: SkillSet): number {
  return services.reduce((n, s) => n + (s.tools?.names.length ?? 0), ownTools(skills));
}

export function findFindings(
  config: SuiteConfig, services: ServiceState[], subscribers: SubscribersState | undefined, checks: ChecksState | undefined,
  store: Store, at: string, skills?: SkillSet,
): Finding[] {
  const found: Candidate[] = [];
  const owner = (name: string) => config.services.find((s: ServiceConfig) => s.name === name)?.repo ?? name;

  for (const s of services) {
    const fix = s.repo ?? s.name;
    if (!s.up) {
      const why = s.health ? `isn't answering /health (${s.health.error ?? "no answer"})` : `isn't listing its tools (${s.tools?.error ?? "no answer"})`;
      found.push({ id: `down:${s.name}`, severity: "fail", fix, summary: `${s.name} ${why}.`, first_seen: s.since });
      continue;
    }
    if (s.health && s.tools && !s.tools.ok) {
      found.push({ id: `mcp:${s.name}`, severity: "fail", fix, summary: `${s.name} answers /health but not an MCP tool listing (${s.tools.error ?? "no answer"}).` });
    }
    const d = s.health?.deployed;
    if (d?.branch && d.branch !== "main") found.push({ id: `branch:${s.name}`, severity: "drift", fix, summary: `${s.name} is deployed from ${d.branch}, not main.`, first_seen: d.at });
    if (d?.dirty) found.push({ id: `dirty:${s.name}`, severity: "drift", fix, summary: `${s.name} was deployed from a checkout with uncommitted changes, so its commit doesn't say what it runs.`, first_seen: d.at });
    for (const c of s.health?.dependencies ?? []) {
      if (!c.ok) found.push({ id: `dependency:${s.name}:${c.name}`, severity: "fail", fix, summary: `${s.name} reports that it can't reach ${c.name}.` });
    }
  }

  if (config.subscribers && subscribers) {
    if (!subscribers.ok) {
      found.push({ id: "source:subscribers", severity: "fail", fix: config.subscribers.owner, summary: `The subscriber registry can't be read (${subscribers.error}).`, after_minutes: 5 });
    }
    for (const sub of subscribers.items) {
      if (sub.blocked) found.push({ id: `subscriber-blocked:${sub.id}`, severity: "fail", fix: owner(sub.id), summary: `${sub.label} is blocked on the terminology: ${sub.blocked}.` });
      else if (sub.pending > 0) {
        const breaking = sub.pending_breaking ? `, ${sub.pending_breaking} breaking` : "";
        found.push({
          id: `subscriber-pending:${sub.id}`, severity: "drift", fix: owner(sub.id), after_minutes: config.subscribers.lag_minutes,
          summary: `${sub.label} is ${sub.pending} terminology change${sub.pending === 1 ? "" : "s"} behind${breaking}.`,
        });
      }
      const seen = sub.last_seen ? Date.parse(sub.last_seen) : NaN;
      if (!(Date.parse(at) - seen < config.subscribers.stale_minutes * 60_000)) {
        found.push({ id: `subscriber-quiet:${sub.id}`, severity: "drift", fix: owner(sub.id), summary: `${sub.label} hasn't asked the terminology for changes since ${sub.last_seen ?? "it registered"}.`, first_seen: sub.last_seen ?? undefined });
      }
    }
  }

  if (config.checks && checks) {
    if (!checks.ok) found.push({ id: "source:checks", severity: "fail", fix: config.checks.owner, summary: `The cross-service checks can't be read (${checks.error}).`, after_minutes: 5 });
    for (const c of checks.items) {
      if (c.result !== "fail" && c.result !== "drift") continue;
      found.push({
        id: `cross-service:${c.name}`, severity: c.result, fix: c.fix || config.checks.owner, first_seen: c.first_seen,
        // One line a check: the examples, and dismissing one, stay with the service that keeps them.
        summary: `${c.name}: ${c.count} found.`, ...(config.checks.worklist ? { link: config.checks.worklist } : {}),
      });
    }
  }

  if (skills) found.push(...skillFindings(config, services, skills));

  const total = toolsTotal(services, skills);
  if (config.tool_budget !== undefined && total > config.tool_budget) {
    found.push({ id: "tool-budget", severity: "drift", fix: "the portal's tool toggles", summary: `The suite lists ${total} tools, over the budget of ${config.tool_budget}.` });
  }

  const now = Date.parse(at);
  const findings = found.map((c) => {
    const { after_minutes, ...rest } = c;
    const seen = store.firstSeen(c.id, at);
    const first_seen = c.first_seen && Date.parse(c.first_seen) < Date.parse(seen) ? c.first_seen : seen;
    return { finding: { ...rest, first_seen } as Finding, due: now - Date.parse(seen) >= (after_minutes ?? 0) * 60_000 };
  });
  store.keep(services.map((s) => s.name), found.map((c) => c.id));
  return findings.filter((f) => f.due).map((f) => f.finding)
    .sort((a, b) => (a.severity === b.severity ? a.first_seen.localeCompare(b.first_seen) : a.severity === "fail" ? -1 : 1));
}

/**
 * Do the services still list the tools the skills call? A renamed or dropped tool otherwise shows only when a
 * skill trips over it mid-run. A service whose listing failed is left out: it has its own finding, and an old
 * listing proves nothing.
 */
function skillFindings(config: SuiteConfig, services: ServiceState[], skills: SkillSet): Candidate[] {
  const repo = skills.version.repo ?? "the skills repository";
  if (!skills.toolsUsed) {
    return [{ id: "skills:no-tool-list", severity: "drift", fix: repo, summary: `The skills at ${skills.version.ref} have no tools-used.json, so nothing checks that the tools they call still exist.` }];
  }
  const found: Candidate[] = [];
  for (const [name, tools] of Object.entries(skills.toolsUsed)) {
    const service = services.find((s) => s.name === name);
    if (!service) {
      found.push({ id: `skills:service:${name}`, severity: "fail", fix: repo, summary: `The skills call tools on ${name}, which isn't a service in the ${config.suite} suite.` });
      continue;
    }
    if (!service.tools?.ok) continue;
    for (const tool of tools.filter((t) => !service.tools!.names.includes(t))) {
      found.push({
        id: `skills:missing:${name}:${tool}`, severity: "fail", fix: `${service.repo ?? name}; or ${repo}, if the rename was meant`,
        summary: `${name} no longer lists ${tool}, which the skills call.`,
      });
    }
  }
  // The other direction: a tool a skill names that tools-used.json leaves out is a tool nothing watches. A name
  // two services share is taken as covered when either lists it.
  const covered = new Set(Object.values(skills.toolsUsed).flat());
  for (const service of services) {
    if (!service.tools?.ok) continue;
    for (const tool of skills.mentioned.filter((t) => service.tools!.names.includes(t) && !covered.has(t))) {
      found.push({ id: `skills:unwatched:${service.name}:${tool}`, severity: "drift", fix: repo, summary: `The skills name ${service.name}'s ${tool}, but tools-used.json doesn't list it, so a rename would go unseen.` });
    }
  }
  return found;
}
