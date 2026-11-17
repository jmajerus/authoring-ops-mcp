/**
 * How far a service's fork has drifted from the project it was forked from, read from GitHub's API: the fork's
 * branch against upstream's latest release and against upstream's default branch. For deciding when to rebase
 * before the next customization; nothing here is wrong in itself, so it is reported, not raised as a finding.
 */

export interface ForkConfig {
  /** The fork, as owner/name. */
  repo: string;
  /** The branch the service runs. */
  branch: string;
}

export interface Comparison { ahead: number; behind: number }

export interface ForkState {
  ok: boolean;
  error?: string;
  checked_at: string;
  /** The upstream project, as owner/name. */
  upstream: string;
  repo: string;
  branch: string;
  release?: { tag: string; at?: string } & Comparison;
  head?: { branch: string } & Comparison;
}

export type GitHubGet = (path: string) => Promise<unknown>;

/** GET from api.github.com. With GITHUB_TOKEN set it is sent; without, the hourly check is well inside the anonymous limit. */
export const githubGet: GitHubGet = async (path) => {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "authoring-ops-mcp", "x-github-api-version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(8000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`);
  return response.json();
};

/** owner/name from a github.com project URL, or undefined. */
export function githubRepo(url: string | undefined): string | undefined {
  const m = url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return m?.[1];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ref = (s: string) => s.split("/").map(encodeURIComponent).join("/");

/** Compares the fork's branch with upstream's latest release and default branch. On failure the last good numbers are kept, marked not ok. */
export async function probeFork(upstream: string, fork: ForkConfig, get: GitHubGet, at: string, last?: ForkState): Promise<ForkState> {
  const base = { checked_at: at, upstream, repo: fork.repo, branch: fork.branch };
  const [owner, name] = fork.repo.split("/");
  const compare = async (from: string): Promise<Comparison> => {
    const c = await get(`/repos/${upstream}/compare/${ref(from)}...${owner}:${name}:${ref(fork.branch)}`);
    if (!isObject(c) || typeof c.ahead_by !== "number" || typeof c.behind_by !== "number") throw new Error(`GitHub can't compare ${fork.repo}:${fork.branch} with ${upstream} ${from}`);
    return { ahead: c.ahead_by, behind: c.behind_by };
  };
  try {
    const [repo, release] = await Promise.all([get(`/repos/${upstream}`), get(`/repos/${upstream}/releases/latest`)]);
    if (!isObject(repo) || typeof repo.default_branch !== "string") throw new Error(`GitHub has no project ${upstream}`);
    const tag = isObject(release) && typeof release.tag_name === "string" ? release.tag_name : undefined;
    const published = isObject(release) && typeof release.published_at === "string" ? release.published_at : undefined;
    const [head, sinceRelease] = await Promise.all([compare(repo.default_branch), tag ? compare(tag) : undefined]);
    return {
      ok: true, ...base, head: { branch: repo.default_branch, ...head },
      ...(tag && sinceRelease ? { release: { tag, ...(published ? { at: published } : {}), ...sinceRelease } } : {}),
    };
  } catch (error) {
    return {
      ok: false, error: (error as Error).message ?? String(error), ...base,
      ...(last?.release ? { release: last.release } : {}), ...(last?.head ? { head: last.head } : {}),
    };
  }
}

/** "3 ahead, 12 behind v0.17.2", for a line on a page. */
export function forkLine(f: ForkState): string {
  const c = f.release ?? f.head;
  if (!c) return "";
  const against = f.release ? f.release.tag : `${f.upstream}'s ${f.head!.branch}`;
  return `${c.ahead} ahead, ${c.behind} behind ${against}`;
}
