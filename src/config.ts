import fs from "node:fs";
import { type ForkConfig, githubRepo } from "./github.js";

/**
 * The suite this server watches. The code names no service: everything it probes comes from this file
 * (suites/<suite>.json, chosen with OPS_SUITE), so a second suite is a second file and a second host.
 */

export interface ServiceConfig {
  name: string;
  /** GET for the health contract (docs/health-contract.md). Without one, a tool listing says whether it's up. */
  health?: string;
  /** The service's MCP endpoint, for its tool listing. */
  mcp?: string;
  /** The repository that owns a fix, as owner/name. */
  repo?: string;
  admin?: string;
  /** The service's own public page, read only: where the public page links its name. */
  public?: string;
  /** Where a third party's project lives, for its page here. */
  upstream?: string;
  /** The fork the service runs, when it isn't upstream's own release: checked hourly against upstream. */
  fork?: ForkConfig;
  third_party: boolean;
}

export interface SuiteConfig {
  suite: string;
  portal?: string;
  /** The portal's total tool count to stay under. Unset: the total is shown and nothing is reported. */
  tool_budget?: number;
  services: ServiceConfig[];
  /** A terminology registry (GET → { head|version, subscribers: [...] }). */
  subscribers?: { url: string; owner: string; lag_minutes: number; stale_minutes: number };
  /** Cross-service checks kept by another service (GET → { checks: [...] }, as holdings-mcp's /api/checks). */
  checks?: { url: string; owner: string; worklist?: string };
  /** The skills repository and the ref a release carries (tools/vendor-skills.mjs copies it in at deploy). */
  skills?: { repo: string; ref: string };
  /** Suite-level routing for an agent, added to this server's MCP instructions. Keep it short: the portal joins
   *  every server's instructions and cuts the result off at a length. */
  guidance: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function httpUrl(value: unknown, where: string, required: true): string;
function httpUrl(value: unknown, where: string, required?: false): string | undefined;
function httpUrl(value: unknown, where: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  let url: URL | undefined;
  try { url = new URL(String(value)); } catch { /* reported below */ }
  if (typeof value !== "string" || !url || !/^https?:$/.test(url.protocol)) throw new Error(`${where} must be an http(s) URL, not ${JSON.stringify(value)}.`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a name, not ${JSON.stringify(value)}.`);
  return value.trim();
}

export function parseConfig(raw: unknown): SuiteConfig {
  if (!isObject(raw)) throw new Error("The suite config must be an object.");
  const suite = text(raw.suite, "suite");
  if (!Array.isArray(raw.services) || !raw.services.length) throw new Error("services must list at least one service.");
  const services = raw.services.map((s, i): ServiceConfig => {
    if (!isObject(s)) throw new Error(`services[${i}] must be an object.`);
    const name = text(s.name, `services[${i}].name`);
    const service: ServiceConfig = {
      name, third_party: s.third_party === true,
      health: httpUrl(s.health, `${name}.health`), mcp: httpUrl(s.mcp, `${name}.mcp`), admin: httpUrl(s.admin, `${name}.admin`),
      public: httpUrl(s.public, `${name}.public`), upstream: httpUrl(s.upstream, `${name}.upstream`),
      repo: s.repo === undefined ? undefined : text(s.repo, `${name}.repo`),
    };
    if (s.fork !== undefined) {
      if (!isObject(s.fork)) throw new Error(`${name}.fork must be { repo, branch }.`);
      const repo = text(s.fork.repo, `${name}.fork.repo`);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`${name}.fork.repo must be owner/name, not ${JSON.stringify(repo)}.`);
      if (!githubRepo(service.upstream)) throw new Error(`${name}.fork needs upstream to be a github.com project URL, to compare against.`);
      service.fork = { repo, branch: text(s.fork.branch, `${name}.fork.branch`) };
    }
    if (!service.health && !service.mcp) throw new Error(`${name} needs a health or an mcp URL: there is nothing to probe.`);
    return service;
  });
  const twice = services.find((s, i) => services.findIndex((o) => o.name === s.name) !== i);
  if (twice) throw new Error(`services lists ${twice.name} twice.`);
  const minutes = (value: unknown, fallback: number, where: string) => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !(value > 0)) throw new Error(`${where} must be a number of minutes above 0.`);
    return value;
  };
  const budget = raw.tool_budget;
  if (budget !== undefined && budget !== null && (typeof budget !== "number" || !(budget > 0))) throw new Error("tool_budget must be a number above 0.");
  return {
    suite, services,
    portal: httpUrl(raw.portal, "portal"),
    ...(typeof budget === "number" ? { tool_budget: budget } : {}),
    ...(isObject(raw.subscribers) ? { subscribers: {
      url: httpUrl(raw.subscribers.url, "subscribers.url", true), owner: text(raw.subscribers.owner, "subscribers.owner"),
      lag_minutes: minutes(raw.subscribers.lag_minutes, 30, "subscribers.lag_minutes"),
      stale_minutes: minutes(raw.subscribers.stale_minutes, 60, "subscribers.stale_minutes"),
    } } : {}),
    ...(isObject(raw.checks) ? { checks: {
      url: httpUrl(raw.checks.url, "checks.url", true), owner: text(raw.checks.owner, "checks.owner"),
      ...(raw.checks.worklist !== undefined ? { worklist: httpUrl(raw.checks.worklist, "checks.worklist", true) } : {}),
    } } : {}),
    ...(isObject(raw.skills) ? { skills: { repo: text(raw.skills.repo, "skills.repo"), ref: text(raw.skills.ref, "skills.ref") } } : {}),
    guidance: Array.isArray(raw.guidance) ? raw.guidance.map((line, i) => text(line, `guidance[${i}]`)) : [],
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SuiteConfig {
  const file = env.OPS_SUITE ?? "suites/authoring.json";
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { throw new Error(`OPS_SUITE (${file}): ${(error as Error).message}`); }
  try { return parseConfig(raw); } catch (error) { throw new Error(`${file}: ${(error as Error).message}`); }
}
