import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** What this server reads from the others, and the shapes it keeps. Every read is a GET or an MCP tools/list. */

export type FetchJson = (url: string) => Promise<unknown>;
export type ListTools = (url: string) => Promise<string[]>;

export const fetchJson: FetchJson = async (url) => {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

/** A service's tool names, asked over MCP as any client would (zotero-mcp needs a session, so a bare POST won't do). */
export const listTools: ListTools = async (url) => {
  const client = new Client({ name: "authoring-ops-mcp", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { signal: AbortSignal.timeout(8000) } });
  try {
    await client.connect(transport);
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      names.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
    } while (cursor);
    return names.sort();
  } finally {
    await client.close().catch(() => {});
  }
};

export interface Deployed { branch?: string; commit?: string; at?: string; dirty?: boolean; local?: boolean }

export interface HealthState {
  ok: boolean;
  error?: string;
  version?: string;
  deployed?: Deployed;
  /** The contract's optional dependencies: a service's own view of what it relies on. */
  dependencies?: { name: string; ok: boolean }[];
  admin?: string;
  checked_at: string;
}

export interface ToolsState { ok: boolean; error?: string; names: string[]; checked_at: string; ok_at?: string }

export interface Subscriber {
  id: string; label: string; schemes: string[]; pending: number; pending_breaking: number;
  blocked: string | null; last_seen: string | null;
}
export interface SubscribersState { ok: boolean; error?: string; head?: number; items: Subscriber[]; checked_at: string }

export interface Check {
  name: string; result: "ok" | "drift" | "fail" | "skipped"; count: number; fix: string;
  first_seen?: string; examples: string[];
}
export interface ChecksState { ok: boolean; error?: string; items: Check[]; checked_at: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const message = (error: unknown) => {
  const e = error as Error & { cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError") return "no answer in time";
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(error);
};

/** Reads a /health body under the contract. Fields a server doesn't send are left out, never guessed. */
export function readHealth(body: unknown, at: string): HealthState {
  if (!isObject(body)) return { ok: false, error: "/health didn't return an object", checked_at: at };
  const d = isObject(body.deployed) ? body.deployed : undefined;
  const version = typeof body.version === "string" || typeof body.version === "number" ? String(body.version) : undefined;
  const admin = str(body.admin);
  return {
    ok: body.ok !== false, ...(body.ok === false ? { error: "reports ok: false" } : {}),
    ...(version ? { version } : {}),
    ...(d ? { deployed: {
      branch: str(d.branch), commit: str(d.commit), at: str(d.at),
      ...(typeof d.dirty === "boolean" ? { dirty: d.dirty } : {}), ...(typeof d.local === "boolean" ? { local: d.local } : {}),
    } } : {}),
    ...(Array.isArray(body.dependencies) ? { dependencies: body.dependencies.filter(isObject).filter((c) => typeof c.name === "string").map((c) => ({ name: c.name as string, ok: c.ok !== false })) } : {}),
    ...(admin && /^https?:\/\//.test(admin) ? { admin } : {}),
    checked_at: at,
  };
}

export async function probeHealth(url: string, get: FetchJson, at: string): Promise<HealthState> {
  try { return readHealth(await get(url), at); } catch (error) { return { ok: false, error: message(error), checked_at: at }; }
}

/** Lists a service's tools. On failure the last good listing's names are kept, marked not ok. */
export async function probeTools(url: string, list: ListTools, at: string, last?: ToolsState): Promise<ToolsState> {
  try {
    return { ok: true, names: await list(url), checked_at: at, ok_at: at };
  } catch (error) {
    return { ok: false, error: message(error), names: last?.names ?? [], checked_at: at, ...(last?.ok_at ? { ok_at: last.ok_at } : {}) };
  }
}

export async function probeSubscribers(url: string, get: FetchJson, at: string): Promise<SubscribersState> {
  try {
    const body = await get(url);
    if (!isObject(body) || !Array.isArray(body.subscribers)) throw new Error("no subscribers list in the answer");
    const head = typeof body.version === "number" ? body.version : undefined;
    const items = body.subscribers.filter(isObject).map((s): Subscriber => ({
      id: String(s.id), label: str(s.label) ?? String(s.id),
      schemes: Array.isArray(s.schemes) ? s.schemes.map(String) : [],
      pending: typeof s.pending === "number" ? s.pending : 0,
      pending_breaking: typeof s.pendingBreaking === "number" ? s.pendingBreaking : 0,
      blocked: s.blocked === null || s.blocked === undefined || s.blocked === false ? null : typeof s.blocked === "string" ? s.blocked : JSON.stringify(s.blocked),
      last_seen: str(s.lastSeen) ?? null,
    }));
    return { ok: true, ...(head !== undefined ? { head } : {}), items, checked_at: at };
  } catch (error) {
    return { ok: false, error: message(error), items: [], checked_at: at };
  }
}

export async function probeChecks(url: string, get: FetchJson, at: string): Promise<ChecksState> {
  try {
    const body = await get(url);
    if (!isObject(body) || !Array.isArray(body.checks)) throw new Error("no checks list in the answer");
    const items = body.checks.filter(isObject).map((c): Check => ({
      name: String(c.name),
      result: c.result === "ok" || c.result === "drift" || c.result === "fail" ? c.result : "skipped",
      count: typeof c.count === "number" ? c.count : 0,
      fix: str(c.fix) ?? "",
      ...(str(c.first_seen) ? { first_seen: str(c.first_seen) } : {}),
      examples: Array.isArray(c.examples) ? c.examples.filter(isObject).slice(0, 3).map((e) => str(e.detail) ?? str(e.ref) ?? "").filter(Boolean) : [],
    }));
    return { ok: true, items, checked_at: at };
  } catch (error) {
    return { ok: false, error: message(error), items: [], checked_at: at };
  }
}
