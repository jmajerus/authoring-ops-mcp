import type { Finding } from "./findings.js";
import { type ForkState, forkLine } from "./github.js";
import { VERSION } from "./mcp.js";
import type { Snapshot } from "./poller.js";
import { versionLabel } from "./skills.js";

/**
 * Two views of the last poll. The public one (/) is safe for anyone to see: no addresses, no error text, no
 * links to anything writable. The admin one (/admin, LAN only) adds what a person fixing things needs: what
 * each failing source said, the services' admin pages, the worklist, and a button to poll now. Neither page
 * changes anything itself; the admin page links to pages that do.
 */
export interface PageOptions {
  admin?: boolean;
  /** The public page, seen from the LAN: link to /admin. */
  lan?: boolean;
  now?: number;
}

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "3 d", "5 h", "12 min": how long ago, to the nearest unit worth reading. */
export function ago(iso: string | null | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const minutes = Math.max(0, Math.round((now - t) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${minutes} min`;
  if (minutes < 36 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

const pill = (state: "up" | "stale" | "down", label: string) => `<span class="pill ${state}"><span class="dot"></span>${esc(label)}</span>`;
const link = (url: string | undefined, label: string) => (url && /^https?:\/\//.test(url) ? `<a href="${esc(url)}">${esc(label)}</a>` : esc(label));
/** The portal's web page: the config names its MCP address, which a browser can't use. */
const site = (url: string) => { try { return new URL("/", url).href; } catch { return undefined; } };
const portalLink = (url: string) => `${link(site(url), new URL(url).host)} <span class="s">(MCP at <code>${esc(url)}</code>)</span>`;
const time = (iso: string | null | undefined, now: number) => (iso ? `<span title="${esc(iso)}">${esc(ago(iso, now))}</span>` : "");

const STYLE = `:root{color-scheme:light dark;--border:#8884;--surface:#8881;--mut:#777;--ok:#1a7f37;--warn:#9a6700;--danger:#b3261e}
@media (prefers-color-scheme:dark){:root{--mut:#999;--ok:#3fb950;--warn:#d29922;--danger:#f85149}}
body{font:15px/1.5 system-ui,sans-serif;max-width:68rem;margin:0 auto;padding:24px 16px}
h1{margin:0 0 4px;font-size:1.5rem}h2{margin:32px 0 8px;font-size:1.1rem}
.s{color:var(--mut);font-size:.87rem}.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%}th{text-align:left;font-weight:600;font-size:.82rem;color:var(--mut)}
th,td{vertical-align:top;padding:8px 14px 8px 0;border-bottom:1px solid var(--border);white-space:nowrap}td.w{white-space:normal}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
code{font:.86rem ui-monospace,monospace}
.pill{display:inline-block;border:1px solid var(--border);background:var(--surface);border-radius:999px;padding:2px 10px;font-size:.84rem}
.pill .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--danger)}
.pill.up .dot{background:var(--ok)}.pill.stale .dot{background:var(--warn)}
ul{margin:4px 0 0;padding-left:1.2rem}`;

function servicesTable(s: Snapshot, now: number, admin: boolean): string {
  const rows = s.services.map((v) => {
    const d = v.health?.deployed;
    const notes = [
      d?.branch && d.branch !== "main" ? pill("stale", d.branch) : "",
      d?.dirty ? pill("stale", "uncommitted changes") : "",
      v.up && v.tools && !v.tools.ok ? pill("down", "no tool listing") : "",
      v.third_party ? `<span class="s">third party</span>` : "",
      v.fork && forkLine(v.fork) ? `<span class="s">fork: ${esc(forkLine(v.fork))}</span>` : "",
      admin && !v.up ? `<span class="s">${esc(v.health?.error ?? v.tools?.error)}</span>` : "",
    ].filter(Boolean).join(" ");
    // The public page links each service's own public page; the admin page links the code.
    const repo = admin && v.repo ? `https://github.com/${v.repo}` : undefined;
    const commit = d?.commit ? link(repo && `${repo}/commit/${d.commit}`, d.commit.slice(0, 7)) : "";
    const name = admin ? link(repo, v.name) : v.public ? link(v.public, v.name) : `<a href="${esc(servicePath(v.name))}">${esc(v.name)}</a>`;
    return `<tr><td>${name}</td><td>${pill(v.up ? "up" : "down", v.up ? "up" : "down")} <span class="s">${time(v.since, now)}</span></td>
<td>${esc(v.health?.version ?? v.tools?.version)}</td><td><code>${commit}</code></td><td>${time(d?.at, now)}</td>
<td class="n">${v.tools ? v.tools.names.length : ""}</td><td class="w">${notes}</td>${admin ? `<td>${v.admin ? link(v.admin, "admin") : ""}</td>` : ""}</tr>`;
  }).join("\n");
  return `<div class="wrap"><table><thead><tr><th>Service</th><th>State, for</th><th>Version</th><th>Commit</th><th>Deployed</th><th class="n">Tools</th><th></th>${admin ? "<th></th>" : ""}</tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

function subscribersTable(s: Snapshot, now: number, admin: boolean): string {
  const subs = s.subscribers;
  if (!subs) return "";
  if (!subs.ok) return `<h2>Terminology subscribers</h2><p>${pill("down", "unreadable")}${admin ? ` <span class="s">${esc(subs.error)}</span>` : ""}</p>`;
  const rows = subs.items.map((u) => {
    const state = u.blocked ? pill("down", "blocked") : u.pending ? pill("stale", `${u.pending} behind`) : pill("up", "current");
    return `<tr><td>${esc(u.label)}</td><td>${state}</td><td>${esc(u.schemes.join(", "))}</td><td>${time(u.last_seen, now)}</td><td class="w s">${admin ? esc(u.blocked ?? "") : ""}</td></tr>`;
  }).join("\n");
  return `<h2>Terminology subscribers${subs.head !== undefined ? ` <span class="s">head ${esc(subs.head)}</span>` : ""}</h2>
<div class="wrap"><table><thead><tr><th>Subscriber</th><th>State</th><th>Schemes</th><th>Last seen</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function findingsTable(findings: Finding[], now: number, admin: boolean): string {
  if (!findings.length) return `<h2>Findings</h2><p>${pill("up", "none open")}</p>`;
  const groups = new Map<string, Finding[]>();
  for (const f of findings) groups.set(f.fix, [...(groups.get(f.fix) ?? []), f]);
  const rows = [...groups].map(([fix, list]) => list.map((f, i) => `<tr>${i === 0 ? `<td rowspan="${list.length}" class="w">${esc(fix)}</td>` : ""}
<td>${pill(f.severity === "fail" ? "down" : "stale", f.severity)}</td>
<td class="w">${esc(f.summary)}${admin && f.detail ? ` <span class="s">${esc(f.detail)}</span>` : ""}${admin && f.link ? ` ${link(f.link, "details")}` : ""}</td>
<td>${time(f.first_seen, now)}</td></tr>`).join("\n")).join("\n");
  return `<h2>Findings <span class="s">by who owns the fix</span></h2>
<div class="wrap"><table><thead><tr><th>Fix in</th><th>Severity</th><th>What</th><th>Open for</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function skillsSection(s: Snapshot): string {
  if (!s.skills) return `<h2>Skills</h2><p class="s">This release carries none.</p>`;
  const drift = s.findings.filter((f) => f.id.startsWith("skills:"));
  const state = drift.some((f) => f.severity === "fail") ? pill("down", "a tool is gone") : drift.length ? pill("stale", "tool list out of step") : pill("up", `${s.skills.tools_checked} tools still listed`);
  return `<h2>Skills <span class="s">${esc(versionLabel(s.skills.version))}</span></h2>
<p>${state} <span class="s">${esc(s.skills.names.join(", "))}</span></p>`;
}

/** The admin page's own section: where the fixes are made, and polling now. */
function adminSection(s: Snapshot, worklist: string | undefined): string {
  const links = [
    worklist ? `<li>${link(worklist, "Cross-service worklist")} <span class="s">holdings-mcp: dismiss or restore a finding</span></li>` : "",
    ...s.services.filter((v) => v.admin).map((v) => `<li>${link(v.admin, `${v.name} admin`)}</li>`),
    s.portal ? `<li>${link(site(s.portal), "The portal")}</li>` : "",
  ].filter(Boolean).join("\n");
  return `<h2>Admin</h2>
<form method="post" action="/admin/poll"><button type="submit">Poll now</button> <span class="s">Reads the suite again; changes nothing.</span></form>
${links ? `<ul>${links}</ul>` : ""}`;
}

/** Which fork a service runs, and how far it is from upstream's latest release and default branch. */
function forkSection(f: ForkState, running: string | undefined, now: number): string {
  const gh = (repo: string, path = "") => `https://github.com/${repo}${path}`;
  const count = (c: { ahead: number; behind: number }) => `${c.ahead} commit${c.ahead === 1 ? "" : "s"} ahead, ${c.behind} behind`;
  const [owner, name] = f.repo.split("/");
  const commit = f.installed?.commit;
  const runningRef = commit ?? `${owner}:${name}:${encodeURIComponent(f.branch)}`;
  const lines = [
    f.release ? `<li>Against upstream's latest release, ${link(gh(f.upstream, `/releases/tag/${encodeURIComponent(f.release.tag)}`), f.release.tag)}${f.release.at ? ` <span class="s">(${time(f.release.at, now)} ago)</span>` : ""}: ${count(f.release)}.</li>` : "",
    f.head ? `<li>Against upstream's ${esc(f.head.branch)}: ${link(gh(f.upstream, `/compare/${encodeURIComponent(f.head.branch)}...${runningRef}`), count(f.head))}.</li>` : "",
    commit && f.undeployed ? `<li>${f.undeployed.ahead ? link(gh(f.repo, `/compare/${commit}...${encodeURIComponent(f.branch)}`), `${f.undeployed.ahead} commit${f.undeployed.ahead === 1 ? "" : "s"} on ${f.branch} not deployed yet`) : `Nothing on ${esc(f.branch)} waiting to be deployed`}${f.undeployed.behind ? `; the installed commit isn't on ${esc(f.branch)}` : ""}.</li>` : "",
    running ? `<li>The server reports version ${esc(running)}.</li>` : "",
  ].filter(Boolean).join("\n");
  const runs = commit
    ? `Runs ${link(gh(f.repo, `/commit/${commit}`), commit.slice(0, 7))}${f.installed?.at ? `, deployed ${time(f.installed.at, now)} ago,` : ""} from ${link(gh(f.repo, `/tree/${encodeURIComponent(f.branch)}`), `${f.repo} ${f.branch}`)}`
    : `Runs ${link(gh(f.repo, `/tree/${encodeURIComponent(f.branch)}`), `${f.repo} ${f.branch}`)} <span class="s">(no deploy recorded: the comparisons are of the branch's tip)</span>`;
  return `<h2>Source</h2>
<p>${runs}, a fork of ${link(gh(f.upstream), f.upstream)}.</p>
${lines ? `<ul>${lines}</ul>` : ""}
<p class="s">Checked against GitHub ${time(f.checked_at, now)} ago, hourly.${f.ok ? "" : ` That check didn't answer${lines ? "; these are from the last one that did" : ""}.`}</p>`;
}

/** Where this server serves a service's own page: for one with no public page of its own, a third party's say. */
export const servicePath = (name: string) => `/services/${encodeURIComponent(name)}`;

const pageHead = (title: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60"><title>${esc(title)}</title><style>${STYLE}</style></head><body>`;

/**
 * One service, as this server sees it from the last poll: up or down, its version and tools, which of them the
 * skills call, and its findings. Public, so as safe as the public page: summaries only, no addresses or errors.
 */
export function servicePage(s: Snapshot, name: string, toolsUsed: string[] = [], now = Date.now()): string | undefined {
  const v = s.services.find((x) => x.name === name);
  if (!v) return undefined;
  const listed = v.tools?.names ?? [];
  const called = new Set(toolsUsed);
  const rows = listed.map((t) => `<tr><td><code>${esc(t)}</code></td><td>${called.has(t) ? "called by the skills" : ""}</td></tr>`);
  const gone = toolsUsed.filter((t) => v.tools?.ok && !listed.includes(t));
  rows.push(...gone.map((t) => `<tr><td><code>${esc(t)}</code></td><td>${pill("down", "called by the skills, not listed")}</td></tr>`));
  const findings = s.findings.filter((f) => f.id.split(":").includes(name));
  const version = v.health?.version ?? v.tools?.version;
  const about = [
    v.third_party ? "A third-party server" : "",
    version ? `version ${esc(version)}` : "",
    v.upstream ? link(v.upstream, "its project") : "",
    v.public ? link(v.public, "its own page") : "",
  ].filter(Boolean).join(" · ");
  return `${pageHead(`${name} · ${s.suite} suite`)}<p class="s"><a href="/">${esc(s.suite)} suite</a></p>
<h1>${esc(name)} ${pill(v.up ? "up" : "down", v.up ? "up" : "down")} <span class="s">for ${time(v.since, now)}</span></h1>
<p class="s">${about ? `${about}. ` : ""}Polled ${time(s.polled_at, now)} ago. Reloads every minute.</p>
${v.fork ? forkSection(v.fork, version, now) : ""}
<h2>Tools <span class="s">${listed.length}${v.tools && !v.tools.ok ? ", from the last listing that answered" : ""}</span></h2>
${rows.length ? `<div class="wrap"><table><thead><tr><th>Tool</th><th></th></tr></thead><tbody>${rows.join("\n")}</tbody></table></div>` : `<p class="s">None listed.</p>`}
<h2>Findings</h2>
${findings.length ? `<ul>${findings.map((f) => `<li>${pill(f.severity === "fail" ? "down" : "stale", f.severity)} ${esc(f.summary)} <span class="s">${time(f.first_seen, now)}</span></li>`).join("\n")}</ul>` : `<p>${pill("up", "none open")}</p>`}
</body></html>`;
}

export function dashboardPage(s: Snapshot | undefined, suite: string, options: PageOptions & { worklist?: string } = {}): string {
  const { admin = false, lan = false, now = Date.now() } = options;
  const head = pageHead(`${suite} ops${admin ? " admin" : ""}`);
  if (!s) return `${head}<h1>${esc(suite)} suite</h1><p class="s">The first poll is still running. This page reloads by itself.</p></body></html>`;
  const down = s.services.filter((v) => !v.up).length;
  const fails = s.findings.filter((f) => f.severity === "fail").length;
  const overall = down ? pill("down", `${down} down`) : fails ? pill("stale", "up, with failing checks") : pill("up", "all up");
  const budget = s.tool_budget !== undefined ? ` of a budget of ${s.tool_budget}` : "";
  return `${head}<h1>${esc(s.suite)} suite${admin ? " admin" : ""} ${overall}</h1>
<p class="s">Polled ${time(s.polled_at, now)} ago. ${s.portal ? `Portal: ${portalLink(s.portal)}. ` : ""}Reloads every minute. This page reads and reports; it changes nothing.</p>
${admin ? adminSection(s, options.worklist) : ""}
<h2>Services</h2>
${servicesTable(s, now, admin)}
<p class="s">${s.tools_total} tools across the suite${budget}, counting this server's ${s.skills ? "four" : "two"}. The portal's own toggles aren't visible from here.</p>
${findingsTable(s.findings, now, admin)}
${subscribersTable(s, now, admin)}
${skillsSection(s)}
<p class="s" style="margin-top:32px">${esc(s.suite)}-ops-mcp ${VERSION}${admin ? ` · <a href="/">public page</a> · <a href="/api/status">/api/status</a> · <a href="/health">/health</a>` : lan ? ` · <a href="/admin">admin</a>` : ""}</p>
</body></html>`;
}
