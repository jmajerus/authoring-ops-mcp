#!/usr/bin/env node
// Deploys a service the suite runs from a fork of someone else's project (zotero-mcp): the tip of the fork's
// branch, pinned to its commit, installed with pip into the service's virtualenv on its LXC. Then a restart, a
// tool listing that must answer and still carry every tool the skills call, and, if either fails, the previous
// commit put back. What's installed is recorded on this server's LXC (forks.json, beside deployed.json), so the
// hourly fork check compares the running commit with upstream and counts commits on the branch not yet deployed.
//
// Nothing about the deploy lives in the fork: it stays a plain fork, easy to rebase on upstream.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runAsRoot, runAsRootByKey, shellQuote } from "./remote.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OPS_HOST = process.env.OPS_DEPLOY_HOST ?? "authoring@authoring-ops-mcp.localdomain";
const FORKS = "/var/lib/authoring-ops-mcp/forks.json";

const USAGE = `Usage: npm run deploy:fork -- <service> [--commit <sha>] [--adopt]

  (no flag)        install the tip of the fork's branch on the service's LXC, restart, check its tool
                   listing (and the tools the skills call), roll back to the previous commit on failure,
                   and record the commit on authoring-ops-mcp's LXC
  --commit <sha>   install that commit of the fork instead of the branch's tip
  --adopt          install nothing: record the commit the service already runs

The service's fork.deploy in the suite config (OPS_SUITE, suites/authoring.json) says where:
  { "ssh": "root@host", "venv": "/opt/x/venv", "package": "pip-name", "unit": "x.service" }
Its LXC must take this machine's SSH key as root. Recording needs AUTHORING_DEPLOY_PASSWORD in .env.`;

function args(argv) {
  const out = { service: undefined, commit: undefined, adopt: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--adopt") out.adopt = true;
    else if (a === "--commit") out.commit = argv[++i];
    else if (!a.startsWith("-") && !out.service) out.service = a;
    else throw new Error(`Unknown argument ${a}.\n\n${USAGE}`);
  }
  if (!out.service) throw new Error(USAGE);
  if (out.commit !== undefined && !/^[0-9a-f]{7,40}$/.test(out.commit)) throw new Error(`--commit needs a commit sha, not ${JSON.stringify(out.commit)}.`);
  return out;
}

function service(name) {
  const file = process.env.OPS_SUITE ?? path.join(root, "suites", "authoring.json");
  const suite = JSON.parse(fs.readFileSync(file, "utf8"));
  const s = suite.services?.find((x) => x.name === name);
  if (!s) throw new Error(`${file} has no service ${name}.`);
  const d = s.fork?.deploy;
  if (!s.fork?.repo || !s.fork?.branch || !d) throw new Error(`${name} has no fork.deploy in ${file}.\n\n${USAGE}`);
  for (const k of ["ssh", "venv", "package", "unit"]) if (typeof d[k] !== "string" || !d[k]) throw new Error(`${name}.fork.deploy.${k} must be set.`);
  if (!/^[\w.-]+@[\w.-]+$/.test(d.ssh)) throw new Error(`${name}.fork.deploy.ssh must be user@host.`);
  if (!/^[\w.@-]+\.service$/.test(d.unit) || !/^[\w.-]+$/.test(d.package) || !/^\/[\w./-]+$/.test(d.venv)) throw new Error(`${name}.fork.deploy has a unit, package, or venv that isn't a plain name or path.`);
  return { name, mcp: s.mcp, repo: s.fork.repo, branch: s.fork.branch, ...d };
}

async function github(p) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "authoring-ops-mcp" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com${p}`, { headers, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`GitHub ${p}: HTTP ${r.status}`);
  return r.json();
}

/** The script's lines that say NAME=value, as an object. */
const said = (out) => Object.fromEntries(out.split("\n").map((l) => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));

/** What the venv says it installed: the commit pip's direct_url.json records. */
const INSTALLED = (s) => `
py=$(ls -d ${s.venv}/lib/python3*/site-packages | head -1)
info=$(ls -d "$py"/${s.package.replace(/-/g, "_")}-*.dist-info 2>/dev/null | head -1)
[ -n "$info" ] && sed -n 's/.*"commit_id": *"\\([0-9a-f]*\\)".*/installed=\\1/p' "$info/direct_url.json" 2>/dev/null || true
echo`;

const install = (s, commit) => {
  const spec = shellQuote(`${s.package} @ git+https://github.com/${s.repo}.git@${commit}`);
  // The package at that commit even if its version didn't change, then whatever it now needs besides.
  return `${s.venv}/bin/pip install --quiet --disable-pip-version-check --force-reinstall --no-deps ${spec}
${s.venv}/bin/pip install --quiet --disable-pip-version-check ${spec}`;
};

const restart = (s) => `
systemctl restart ${s.unit}
for i in $(seq 1 30); do systemctl is-active --quiet ${s.unit} && break; sleep 1; done
systemctl is-active --quiet ${s.unit} || { journalctl -u ${s.unit} -n 20 --no-pager; exit 1; }`;

/** The service's tools, asked over MCP as the ops server asks; retried while it starts. */
async function listTools(url) {
  let last;
  for (let i = 0; i < 15; i++) {
    const client = new Client({ name: "authoring-ops-mcp-deploy", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { signal: AbortSignal.timeout(8000) } }));
      const names = [];
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        names.push(...page.tools.map((t) => t.name));
        cursor = page.nextCursor;
      } while (cursor);
      return { names, version: client.getServerVersion()?.version };
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      await client.close().catch(() => {});
    }
  }
  throw new Error(`${url} isn't listing its tools: ${last?.message ?? last}`);
}

/** The tools the skills call on this service, from the vendored copy (npm run skills), if there is one. */
function toolsUsed(name) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "skills", "tools-used.json"), "utf8"))[name] ?? []; } catch { return []; }
}

async function record(s, commit) {
  const password = process.env.AUTHORING_DEPLOY_PASSWORD;
  if (!password) {
    console.warn(`AUTHORING_DEPLOY_PASSWORD isn't set, so ${OPS_HOST} wasn't told: its fork check will compare ${s.branch}'s tip until it is (npm run deploy:fork -- ${s.name} --adopt).`);
    return;
  }
  const entry = Buffer.from(JSON.stringify({ commit, branch: s.branch, at: new Date().toISOString() })).toString("base64");
  // Merged into the file, so each service's record stays.
  await runAsRoot(OPS_HOST, password, `
set -euo pipefail
f=${FORKS}
[ -s "$f" ] || echo '{}' > "$f"
node -e 'const fs=require("fs");const [f,name,b64]=process.argv.slice(1);const all=JSON.parse(fs.readFileSync(f,"utf8"));all[name]=JSON.parse(Buffer.from(b64,"base64"));fs.writeFileSync(f+".new",JSON.stringify(all,null,1)+"\\n")' "$f" ${shellQuote(s.name)} ${shellQuote(entry)}
chmod 0644 "$f.new" && mv "$f.new" "$f"
echo "recorded ${s.name} at ${commit.slice(0, 7)} in $f"`);
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE);
  const a = args(argv);
  const s = service(a.service);
  const before = said(await runAsRootByKey(s.ssh, INSTALLED(s))).installed;
  console.log(`${s.name}: ${before ? `runs ${before.slice(0, 7)}` : "no commit recorded by pip"}`);

  if (a.adopt) {
    if (!before) throw new Error(`pip records no commit for ${s.package} on ${s.ssh}, so there is nothing to adopt; deploy it instead.`);
    return record(s, before);
  }

  const target = a.commit ? (await github(`/repos/${s.repo}/commits/${a.commit}`)).sha : (await github(`/repos/${s.repo}/commits/${encodeURIComponent(s.branch)}`)).sha;
  console.log(`${s.repo} ${a.commit ? "commit" : s.branch}: ${target.slice(0, 7)}`);
  if (before === target) console.log("Already installed; reinstalling it anyway.");

  const listedBefore = await listTools(s.mcp).catch(() => undefined);
  await runAsRootByKey(s.ssh, `set -euo pipefail\n${install(s, target)}\n${restart(s)}\n${INSTALLED(s)}`);

  const check = async () => {
    const listed = await listTools(s.mcp);
    const missing = toolsUsed(s.name).filter((t) => !listed.names.includes(t));
    if (missing.length) throw new Error(`${s.name} no longer lists ${missing.join(", ")}, which the skills call.`);
    return listed;
  };
  let listed;
  try {
    listed = await check();
  } catch (error) {
    console.error(`${error.message}`);
    if (!before) throw new Error(`No previous commit to roll back to; ${s.name} runs ${target.slice(0, 7)}.`);
    console.error(`Rolling back to ${before.slice(0, 7)}.`);
    await runAsRootByKey(s.ssh, `set -euo pipefail\n${install(s, before)}\n${restart(s)}`);
    await check();
    throw new Error(`Deploy failed; ${s.name} is back on ${before.slice(0, 7)}.`);
  }
  const gone = listedBefore ? listedBefore.names.filter((t) => !listed.names.includes(t)) : [];
  const added = listedBefore ? listed.names.filter((t) => !listedBefore.names.includes(t)) : [];
  console.log(`${s.name} ${listed.version ?? ""} lists ${listed.names.length} tools${gone.length ? `; gone: ${gone.join(", ")}` : ""}${added.length ? `; new: ${added.join(", ")}` : ""}.`);
  await record(s, target);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
