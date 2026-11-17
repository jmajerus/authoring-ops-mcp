import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** What this server reads from the others, and the shapes it keeps. Every read is a GET or an MCP tools/list. */

export type FetchJson = (url: string) => Promise<unknown>;
/** A service's tool names, and the version it gives when a client connects (a third party has no /health to say). */
export type ListTools = (url: string) => Promise<string[] | { names: string[]; version?: string }>;

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
    const version = client.getServerVersion()?.version;
    return { names: names.sort(), ...(version ? { version } : {}) };
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

export interface ToolsState { ok: boolean; error?: string; names: string[]; version?: string; checked_at: string; ok_at?: string }

export interface Subscriber {
  id: string; label: string; schemes: string[]; pending: number; pending_breaking: number;
  blocked: string | null; last_seen: string | null;
}
export interface SubscribersState { ok: boolean; error?: string; head?: number; items: Subscriber[]; checked_at: string }

export interface Check {
  name: string; result: "ok" | "drift" | "fail" | "skipped"; count: number; fix: string;
  first_seen?: string;
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
    const got = await list(url);
    const { names, version } = Array.isArray(got) ? { names: got, version: undefined } : got;
    return { ok: true, names, ...(version ? { version: String(version) } : {}), checked_at: at, ok_at: at };
  } catch (error) {
    return {
      ok: false, error: message(error), names: last?.names ?? [], ...(last?.version ? { version: last.version } : {}),
      checked_at: at, ...(last?.ok_at ? { ok_at: last.ok_at } : {}),
    };
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

/** One library in numbers, as holdings-mcp's GET /api/zotero/stats gives it. Counts only. */
export interface LibraryStats {
  library: string; items: number; notes: number; attachments: number; trashed: number;
  by_type: Record<string, number>; collections: number | null; searches: number | null;
  version?: number; synced_at: string | null;
}
export interface StatsState {
  ok: boolean; error?: string; libraries: LibraryStats[]; checked_at: string; ok_at?: string;
  /** The service that keeps the numbers, from the suite config. */
  owner?: string;
}

const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
const countOrNull = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** Reads a library-stats source. On failure the last good numbers are kept, marked not ok. */
export async function probeStats(url: string, get: FetchJson, at: string, last?: StatsState): Promise<StatsState> {
  try {
    const body = await get(url);
    if (!isObject(body) || !Array.isArray(body.libraries)) throw new Error("no libraries list in the answer");
    const libraries = body.libraries.filter(isObject).filter((l) => typeof l.library === "string").map((l): LibraryStats => ({
      library: l.library as string, items: count(l.items), notes: count(l.notes), attachments: count(l.attachments), trashed: count(l.trashed),
      by_type: isObject(l.by_type) ? Object.fromEntries(Object.entries(l.by_type).filter(([k, v]) => /^[A-Za-z]+$/.test(k) && countOrNull(v) !== null)) as Record<string, number> : {},
      collections: countOrNull(l.collections), searches: countOrNull(l.searches),
      ...(typeof l.version === "number" ? { version: l.version } : {}), synced_at: str(l.synced_at) ?? null,
    }));
    return { ok: true, libraries, checked_at: at, ok_at: at };
  } catch (error) {
    return { ok: false, error: message(error), libraries: last?.libraries ?? [], checked_at: at, ...(last?.ok_at ? { ok_at: last.ok_at } : {}) };
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
    }));
    return { ok: true, items, checked_at: at };
  } catch (error) {
    return { ok: false, error: message(error), items: [], checked_at: at };
  }
}
