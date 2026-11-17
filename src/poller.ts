import type { SuiteConfig } from "./config.js";
import { type Finding, type ServiceState, findFindings, toolsTotal } from "./findings.js";
import {
  type ChecksState, type FetchJson, type ListTools, type SubscribersState, type ToolsState,
  fetchJson, listTools, probeChecks, probeHealth, probeSubscribers, probeTools,
} from "./probes.js";
import type { SkillSet, SkillsVersion } from "./skills.js";
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
  skills?: { version: SkillsVersion; names: string[]; tools_checked: number };
  findings: Finding[];
}

/** Tools change at a deploy, not between polls. A service with no /health is listed every poll: it's the only sign of life. */
const LISTING_SECONDS = 600;

export interface PollerDeps { fetchJson?: FetchJson; listTools?: ListTools; clock?: () => Date; skills?: SkillSet }

export class Poller {
  snapshot: Snapshot | undefined;
  private running: Promise<Snapshot> | undefined;
  private readonly tools = new Map<string, ToolsState>();
  private readonly get: FetchJson;
  private readonly list: ListTools;
  private readonly clock: () => Date;
  /** The skills this release carries, if any. They don't change while it runs. */
  readonly skills: SkillSet | undefined;

  constructor(readonly config: SuiteConfig, private readonly store: Store, deps: PollerDeps = {}) {
    this.get = deps.fetchJson ?? fetchJson;
    this.list = deps.listTools ?? listTools;
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
    const [probed, subscribers, checks] = await Promise.all([
      Promise.all(config.services.map(async (service) => {
        const last = this.tools.get(service.name);
        const fresh = last?.ok && last.ok_at && Date.parse(at) - Date.parse(last.ok_at) < LISTING_SECONDS * 1000;
        const [health, tools] = await Promise.all([
          service.health ? probeHealth(service.health, this.get, at) : undefined,
          !service.mcp ? undefined : service.health && fresh ? last : probeTools(service.mcp, this.list, at, last),
        ]);
        if (tools) this.tools.set(service.name, tools);
        return { service, health, tools };
      })),
      config.subscribers ? probeSubscribers(config.subscribers.url, this.get, at) : undefined,
      config.checks ? probeChecks(config.checks.url, this.get, at) : undefined,
    ]);
    const services = probed.map(({ service, health, tools }): ServiceState => {
      const up = health ? health.ok : tools?.ok === true;
      const admin = health?.admin ?? service.admin;
      return {
        name: service.name, third_party: service.third_party, up, since: this.store.since(service.name, up, at),
        ...(service.repo ? { repo: service.repo } : {}), ...(admin ? { admin } : {}),
        ...(service.public ? { public: service.public } : {}), ...(service.upstream ? { upstream: service.upstream } : {}), ...(health ? { health } : {}), ...(tools ? { tools } : {}),
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
      } } : {}),
      findings,
    };
    return this.snapshot;
  }
}
