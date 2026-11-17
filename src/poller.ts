import type { SuiteConfig } from "./config.js";
import { type Finding, type ServiceState, findFindings, toolsTotal } from "./findings.js";
import {
  type ChecksState, type FetchJson, type ListTools, type StatsState, type SubscribersState, type ToolsState,
  fetchJson, listTools, probeChecks, probeHealth, probeStats, probeSubscribers, probeTools,
} from "./probes.js";
import { type ForkState, type GitHubGet, type Installed, githubGet, githubRepo, probeFork } from "./github.js";
import { type SkillSet, type SkillsVersion, describedServers, skillSummary } from "./skills.js";
import type { Store } from "./store.js";

/** One poll's view of the suite. Everything the dashboard and the tools show comes from the last one. */
export interface Snapshot {
  suite: string;
  portal?: string;
  polled_at: string;
  services: ServiceState[];
  subscribers?: SubscribersState;
  checks?: ChecksState;
  tools_total: number;
  tool_budget?: number;
  skills?: { version: SkillsVersion; names: string[]; tools_checked: number; list: SkillRow[] };
  findings: Finding[];
}

/** One skill, for the pages: what it does, the services whose tools it calls, and any of those tools now gone. */
export interface SkillRow { name: string; summary: string; services: string[]; missing: string[] }

/**
 * Which services each skill works through: those its description names ("… MCP servers (holdings, corpus)"),
 * else those whose tools (by tools-used.json) its own SKILL.md names; the references every skill carries name
 * them all. A tool is missing when any file of the skill names it and a listing that answered lacks it, as the
 * findings count it.
 */
export function skillRows(skills: SkillSet, services: ServiceState[]): SkillRow[] {
  const used = Object.entries(skills.toolsUsed ?? {});
  const known = new Set([...used.map(([s]) => s), ...services.map((s) => s.name)]);
  const resolve = (n: string) => [n, `${n}-mcp`].find((x) => known.has(x));
  return skills.skills.map((skill) => {
    const described = describedServers(skill.description).map(resolve).filter((s): s is string => !!s);
    const called = used.filter(([, tools]) => tools.some((t) => skill.own.includes(t))).map(([s]) => s);
    const missing = used.flatMap(([service, tools]) => {
      const listing = services.find((s) => s.name === service)?.tools;
      return listing?.ok ? tools.filter((t) => skill.mentioned.includes(t) && !listing.names.includes(t)).map((t) => `${service} ${t}`) : [];
    });
    return { name: skill.name, summary: skillSummary(skill.description), services: described.length ? described : called, missing };
  });
}

/** Tools change at a deploy, not between polls. A service with no /health is listed every poll: it's the only sign of life. */
const LISTING_SECONDS = 600;

/** A fork moves when someone pushes to it or upstream releases: once an hour is plenty, and well inside GitHub's anonymous limit. */
const FORK_SECONDS = 3600;

export interface PollerDeps {
  fetchJson?: FetchJson; listTools?: ListTools; github?: GitHubGet; clock?: () => Date; skills?: SkillSet;
  /** What the fork deploy last installed, by service (forks.json). Read every poll: a deploy changes it. */
  installed?: () => Record<string, Installed>;
}

export class Poller {
  snapshot: Snapshot | undefined;
  private running: Promise<Snapshot> | undefined;
  private readonly tools = new Map<string, ToolsState>();
  private readonly forks = new Map<string, ForkState>();
  private readonly stats = new Map<string, StatsState>();
  private readonly get: FetchJson;
  private readonly list: ListTools;
  private readonly github: GitHubGet;
  private readonly installed: () => Record<string, Installed>;
  private readonly clock: () => Date;
  /** The skills this release carries, if any. They don't change while it runs. */
  readonly skills: SkillSet | undefined;

  constructor(readonly config: SuiteConfig, private readonly store: Store, deps: PollerDeps = {}) {
    this.get = deps.fetchJson ?? fetchJson;
    this.list = deps.listTools ?? listTools;
    this.github = deps.github ?? githubGet;
    this.installed = deps.installed ?? (() => ({}));
    this.clock = deps.clock ?? (() => new Date());
    this.skills = deps.skills;
  }

  /** Polls now. Calls made while a poll is running share it. */
  poll(): Promise<Snapshot> {
    return (this.running ??= this.pollOnce().finally(() => { this.running = undefined; }));
  }

  /** The last snapshot, or the first poll's. */
  async current(): Promise<Snapshot> {
    return this.snapshot ?? this.poll();
  }

  /** Polls now and then every `seconds`. A poll that throws is logged; the last snapshot stands. */
  start(seconds: number): NodeJS.Timeout | undefined {
    const run = () => void this.poll().catch((error) => console.error(`poll: ${(error as Error).message}`));
    run();
    return seconds > 0 ? setInterval(run, seconds * 1000).unref() : undefined;
  }

  private async pollOnce(): Promise<Snapshot> {
    const { config } = this;
    const at = this.clock().toISOString();
    const installed = this.installed();
    const [probed, subscribers, checks] = await Promise.all([
      Promise.all(config.services.map(async (service) => {
        const last = this.tools.get(service.name);
        const fresh = last?.ok && last.ok_at && Date.parse(at) - Date.parse(last.ok_at) < LISTING_SECONDS * 1000;
        const lastFork = this.forks.get(service.name);
        const now = installed[service.name];
        // A deploy since the last check is news now, not in up to an hour.
        const forkFresh = lastFork && lastFork.installed?.commit === now?.commit && Date.parse(at) - Date.parse(lastFork.checked_at) < FORK_SECONDS * 1000;
        const [health, tools, fork, stats] = await Promise.all([
          service.health ? probeHealth(service.health, this.get, at) : undefined,
          !service.mcp ? undefined : service.health && fresh ? last : probeTools(service.mcp, this.list, at, last),
          !service.fork ? undefined : forkFresh ? lastFork : probeFork(githubRepo(service.upstream)!, service.fork, this.github, at, lastFork, now),
          service.stats ? probeStats(service.stats.url, this.get, at, this.stats.get(service.name)) : undefined,
        ]);
        if (tools) this.tools.set(service.name, tools);
        if (fork) this.forks.set(service.name, fork);
        if (stats) this.stats.set(service.name, stats);
        return { service, health, tools, fork, stats };
      })),
      config.subscribers ? probeSubscribers(config.subscribers.url, this.get, at) : undefined,
      config.checks ? probeChecks(config.checks.url, this.get, at) : undefined,
    ]);
    const services = probed.map(({ service, health, tools, fork, stats }): ServiceState => {
      const up = health ? health.ok : tools?.ok === true;
      const admin = health?.admin ?? service.admin;
      return {
        name: service.name, third_party: service.third_party, up, since: this.store.since(service.name, up, at),
        ...(service.repo ? { repo: service.repo } : {}), ...(admin ? { admin } : {}),
        ...(service.public ? { public: service.public } : {}), ...(service.upstream ? { upstream: service.upstream } : {}), ...(fork ? { fork } : {}), ...(stats ? { stats: { ...stats, owner: service.stats!.owner } } : {}), ...(health ? { health } : {}), ...(tools ? { tools } : {}),
      };
    });
    const findings = findFindings(config, services, subscribers, checks, this.store, at, this.skills);
    this.store.save();
    this.snapshot = {
      suite: config.suite, ...(config.portal ? { portal: config.portal } : {}), polled_at: at, services,
      ...(subscribers ? { subscribers } : {}), ...(checks ? { checks } : {}),
      tools_total: toolsTotal(services, this.skills), ...(config.tool_budget !== undefined ? { tool_budget: config.tool_budget } : {}),
      ...(this.skills ? { skills: {
        version: this.skills.version, names: this.skills.skills.map((s) => s.name),
        tools_checked: Object.values(this.skills.toolsUsed ?? {}).flat().length,
        list: skillRows(this.skills, services),
      } } : {}),
      findings,
    };
    return this.snapshot;
  }
}
