import type { Finding, ServiceState } from "./findings.js";
import { type ForkState, forkLine } from "./github.js";
import type { StatsState } from "./probes.js";
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
ul{margin:4px 0 0;padding-left:1.2rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:10px;margin:8px 0 12px}
.card{border:1px solid var(--border);background:var(--surface);border-radius:10px;padding:12px 14px}
.card strong{display:block;font-size:1.5rem;line-height:1.3;font-variant-numeric:tabular-nums}`;

/**
 * The service a finding's fix belongs to: the first service its owner names, by name or repository. A check that
 * names two ("corpus-mcp for a book, quote-mcp for quotes") counts under the first. Undefined when it names none
 * (the skills repository, the portal's toggles).
 */
export function ownerOf(f: Finding, services: ServiceState[]): string | undefined {
  let best: { name: string; at: number } | undefined;
  for (const v of services) {
    for (const key of [v.name, v.repo].filter((k): k is string => !!k)) {
      const m = new RegExp(`(^|[^\\w/-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).exec(f.fix);
      if (m && (!best || m.index < best.at)) best = { name: v.name, at: m.index };
    }
  }
  return best?.name;
}

const attention = (n: number) => pill("stale", `${n} need${n === 1 ? "s" : ""} attention`);

function servicesTable(s: Snapshot, now: number, admin: boolean, lan: boolean): string {
  const counts = new Map<string, number>();
  for (const f of s.findings) {
    const owner = ownerOf(f, s.services);
    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
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
    // The count for anyone; on the LAN, what they are beside where they're fixed.
    const n = counts.get(v.name) ?? 0;
    const needs = n ? [attention(n), ...(admin || lan ? [`<a href="${esc(servicePath(v.name))}#attention">details</a>`, v.admin ? link(v.admin, "fix") : ""] : [])].filter(Boolean).join(" ") : "";
    return `<tr><td>${name}</td><td>${pill(v.up ? "up" : "down", v.up ? "up" : "down")} <span class="s">${time(v.since, now)}</span></td>
<td>${esc(v.health?.version ?? v.tools?.version)}</td><td><code>${commit}</code></td><td>${time(d?.at, now)}</td>
<td class="n">${v.tools ? v.tools.names.length : ""}</td><td>${needs}</td><td class="w">${notes}</td>${admin ? `<td>${v.admin ? link(v.admin, "admin") : ""}</td>` : ""}</tr>`;
  }).join("\n");
  return `<div class="wrap"><table><thead><tr><th>Service</th><th>State, for</th><th>Version</th><th>Commit</th><th>Deployed</th><th class="n">Tools</th><th>Needs attention</th><th></th>${admin ? "<th></th>" : ""}</tr></thead>
<tbody>${rows}</tbody></table></div>${elsewhere(s)}`;
}

/** Findings whose fix is in no service: one line, the count and where. */
function elsewhere(s: Snapshot): string {
  const rest = s.findings.filter((f) => !ownerOf(f, s.services));
  if (!rest.length) return "";
  const where = [...new Set(rest.map((f) => f.fix))];
  return `<p>${attention(rest.length)} <span class="s">outside the services: ${esc(where.join("; "))}</span></p>`;
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

function skillsSection(s: Snapshot): string {
  if (!s.skills) return `<h2>Skills</h2><p class="s">This release carries none.</p>`;
  const drift = s.findings.filter((f) => f.id.startsWith("skills:"));
  const state = drift.some((f) => f.severity === "fail") ? pill("down", "a tool is gone") : drift.length ? pill("stale", "tool list out of step") : pill("up", "every tool they call is listed");
  const { version, list } = s.skills;
  // The skills repository is public: each name links to the skill as this release carries it.
  const at = version.repo ? `https://github.com/${version.repo}/tree/${encodeURIComponent(version.commit ?? version.ref)}` : undefined;
  const service = (name: string) => {
    const v = s.services.find((x) => x.name === name);
    const href = v?.public ?? (v ? servicePath(name) : undefined);
    return href ? `<a href="${esc(href)}">${esc(name.replace(/-mcp$/, ""))}</a>` : esc(name.replace(/-mcp$/, ""));
  };
  const rows = list.map((k) => `<tr><td>${at ? link(`${at}/${encodeURIComponent(k.name)}`, k.name) : esc(k.name)}</td><td class="w">${esc(k.summary)}</td>
<td class="w">${k.services.map(service).join(", ")}</td><td>${k.missing.length ? pill("down", `${k.missing.length} gone`) : pill("up", "ok")}</td></tr>`).join("\n");
  const services = new Set(list.flatMap((k) => k.services)).size;
  return `<h2>Skills <span class="s">${esc(versionLabel(version))}</span></h2>
<p>${state} <span class="s">${list.length} skill${list.length === 1 ? "" : "s"}, calling ${s.skills.tools_checked} tools across ${services} service${services === 1 ? "" : "s"}. Installed in a client, or read from this server's <code>list_skills</code> and <code>get_skill</code>.</span></p>
<div class="wrap"><table><thead><tr><th>Skill</th><th>What it does</th><th>Calls</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
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

const num = (n: number) => n.toLocaleString("en-US");
/** "journalArticle" → "journal article". */
const typeName = (t: string) => t.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
/** A library's name for a public page: which kind it is, not whose. */
const libraryName = (l: string) => (l.startsWith("users/") ? "Personal library" : l.startsWith("groups/") ? "Group library" : "Library");

/** What the service serves, in numbers another service keeps (holdings-mcp's mirror, for zotero-mcp). Counts only. */
function statsSection(st: StatsState, owner: string | undefined, now: number): string {
  if (!st.libraries.length) return `<h2>Library</h2><p class="s">${st.ok ? "No libraries reported." : "The numbers can't be read just now."}</p>`;
  const many = st.libraries.length > 1;
  const libs = st.libraries.map((l) => {
    const card = (n: number | null, label: string) => (n === null ? "" : `<div class="card"><strong>${num(n)}</strong><span class="s">${esc(label)}</span></div>`);
    const types = Object.entries(l.by_type).sort((a, b) => b[1] - a[1]);
    const shown = types.slice(0, 8).map(([t, n]) => `${esc(typeName(t))} ${num(n)}`);
    const rest = types.slice(8).reduce((n, [, c]) => n + c, 0);
    return `${many ? `<h3>${esc(libraryName(l.library))}</h3>` : ""}
<div class="cards">${card(l.items, "items")}${card(l.collections, "collections")}${card(l.notes, "notes")}${card(l.attachments, "attachments")}</div>
${shown.length ? `<p class="s">${shown.join(" · ")}${rest ? ` · other ${num(rest)}` : ""}</p>` : ""}
<p class="s">${[l.trashed ? `${num(l.trashed)} in the trash` : "", l.searches ? `${num(l.searches)} saved search${l.searches === 1 ? "" : "es"}` : "", l.synced_at ? `synced ${time(l.synced_at, now)} ago` : ""].filter(Boolean).join(" · ")}</p>`;
  }).join("\n");
  return `<h2>Library${many ? "" : ` <span class="s">${esc(libraryName(st.libraries[0].library))}</span>`}</h2>
${libs}
<p class="s">From ${esc(owner ?? "another service")}'s mirror of Zotero${st.ok ? "" : `; it isn't answering just now, so these are from ${time(st.ok_at, now)} ago`}.</p>`;
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
<meta http-equiv="refresh" content="60"><title>${esc(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>${STYLE}</style></head><body>`;

/**
 * One service, as this server sees it from the last poll: up or down, its version and tools, which of them the
 * skills call, and its findings. Public, so as safe as the public page: summaries only, no addresses or errors.
 */
export function servicePage(s: Snapshot, name: string, toolsUsed: string[] = [], now = Date.now(), lan = false): string | undefined {
  const v = s.services.find((x) => x.name === name);
  if (!v) return undefined;
  const listed = v.tools?.names ?? [];
  const called = new Set(toolsUsed);
  const rows = listed.map((t) => `<tr><td><code>${esc(t)}</code></td><td>${called.has(t) ? "called by the skills" : ""}</td></tr>`);
  const gone = toolsUsed.filter((t) => v.tools?.ok && !listed.includes(t));
  rows.push(...gone.map((t) => `<tr><td><code>${esc(t)}</code></td><td>${pill("down", "called by the skills, not listed")}</td></tr>`));
  const findings = s.findings.filter((f) => ownerOf(f, s.services) === name);
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
${v.stats ? statsSection(v.stats, v.stats.owner?.split("/").pop(), now) : ""}
${v.fork ? forkSection(v.fork, version, now) : ""}
<h2>Tools <span class="s">${listed.length}${v.tools && !v.tools.ok ? ", from the last listing that answered" : ""}</span></h2>
${rows.length ? `<div class="wrap"><table><thead><tr><th>Tool</th><th></th></tr></thead><tbody>${rows.join("\n")}</tbody></table></div>` : `<p class="s">None listed.</p>`}
<h2 id="attention">Needs attention${findings.length ? ` <span class="s">${findings.length}</span>` : ""}</h2>
${findings.length ? `${lan && v.admin ? `<p>Fixed at ${link(v.admin, `${name} admin`)}.</p>` : ""}
<ul>${findings.map((f) => `<li>${esc(f.summary)} <span class="s">for ${time(f.first_seen, now)}</span>${lan && f.detail ? ` <span class="s">${esc(f.detail)}</span>` : ""}${lan && f.link ? ` ${link(f.link, "details")}` : ""}</li>`).join("\n")}</ul>` : `<p>${pill("up", "nothing")}</p>`}
</body></html>`;
}

export function dashboardPage(s: Snapshot | undefined, suite: string, options: PageOptions & { worklist?: string } = {}): string {
  const { admin = false, lan = false, now = Date.now() } = options;
  const head = pageHead(`${suite} ops${admin ? " admin" : ""}`);
  if (!s) return `${head}<h1>${esc(suite)} suite</h1><p class="s">The first poll is still running. This page reloads by itself.</p></body></html>`;
  const down = s.services.filter((v) => !v.up).length;
  const open = s.findings.length;
  const overall = down ? pill("down", `${down} down`) : open ? attention(open) : pill("up", "all up");
  const budget = s.tool_budget !== undefined ? ` of a budget of ${s.tool_budget}` : "";
  return `${head}<h1>${esc(s.suite)} suite${admin ? " admin" : ""} ${overall}</h1>
<p class="s">Polled ${time(s.polled_at, now)} ago. ${s.portal ? `Portal: ${portalLink(s.portal)}. ` : ""}Reloads every minute. This page reads and reports; it changes nothing.</p>
${admin ? adminSection(s, options.worklist) : ""}
<h2>Services</h2>
${servicesTable(s, now, admin, lan)}
<p class="s">${s.tools_total} tools across the suite${budget}, counting this server's ${s.skills ? "four" : "two"}. The portal's own toggles aren't visible from here.</p>
${subscribersTable(s, now, admin)}
${skillsSection(s)}
<p class="s" style="margin-top:32px">${esc(s.suite)}-ops-mcp ${VERSION}${admin ? ` · <a href="/">public page</a> · <a href="/api/status">/api/status</a> · <a href="/health">/health</a>` : lan ? ` · <a href="/admin">admin</a>` : ""}</p>
</body></html>`;
}
