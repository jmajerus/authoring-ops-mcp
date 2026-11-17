import type { Finding } from "./findings.js";
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
      admin && !v.up ? `<span class="s">${esc(v.health?.error ?? v.tools?.error)}</span>` : "",
    ].filter(Boolean).join(" ");
    const repo = v.repo ? `https://github.com/${v.repo}` : undefined;
    const commit = d?.commit ? link(repo && `${repo}/commit/${d.commit}`, d.commit.slice(0, 7)) : "";
    return `<tr><td>${link(repo, v.name)}</td><td>${pill(v.up ? "up" : "down", v.up ? "up" : "down")} <span class="s">${time(v.since, now)}</span></td>
<td>${esc(v.health?.version)}</td><td><code>${commit}</code></td><td>${time(d?.at, now)}</td>
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
    s.portal ? `<li>${link(s.portal, "The portal")}</li>` : "",
  ].filter(Boolean).join("\n");
  return `<h2>Admin</h2>
<form method="post" action="/admin/poll"><button type="submit">Poll now</button> <span class="s">Reads the suite again; changes nothing.</span></form>
${links ? `<ul>${links}</ul>` : ""}`;
}

export function dashboardPage(s: Snapshot | undefined, suite: string, options: PageOptions & { worklist?: string } = {}): string {
  const { admin = false, lan = false, now = Date.now() } = options;
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60"><title>${esc(suite)} ops${admin ? " admin" : ""}</title><style>${STYLE}</style></head><body>`;
  if (!s) return `${head}<h1>${esc(suite)} suite</h1><p class="s">The first poll is still running. This page reloads by itself.</p></body></html>`;
  const down = s.services.filter((v) => !v.up).length;
  const fails = s.findings.filter((f) => f.severity === "fail").length;
  const overall = down ? pill("down", `${down} down`) : fails ? pill("stale", "up, with failing checks") : pill("up", "all up");
  const budget = s.tool_budget !== undefined ? ` of a budget of ${s.tool_budget}` : "";
  return `${head}<h1>${esc(s.suite)} suite${admin ? " admin" : ""} ${overall}</h1>
<p class="s">Polled ${time(s.polled_at, now)} ago. ${s.portal ? `Portal: ${link(s.portal, s.portal)}. ` : ""}Reloads every minute. This page reads and reports; it changes nothing.</p>
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
