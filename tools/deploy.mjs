#!/usr/bin/env node
// Deploys authoring-ops-mcp to its LXC (authoring-ops-mcp.localdomain), on holdings-mcp's pattern: SSH as the
// shared `authoring` login, one `sudo -S` call per step with the password piped on stdin, a release directory
// per deploy, a health check, and rollback to the previous release on failure. There is no store to migrate:
// the state file is a few "since" times, and any release reads it.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NAME = "authoring-ops-mcp";
const HOST = process.env.OPS_DEPLOY_HOST ?? `authoring@${NAME}.localdomain`;
const ASKPASS = path.join(root, "tools", "askpass.mjs");
const ENV_NAMES = ["ACCESS_TEAM_DOMAIN", "OPS_POLL_SECONDS"];

const USAGE = `Usage: npm run deploy -- [--provision | --env] [--skip-tests]

  (no flag)        build, test, install this checkout as a new release, restart, health-check, roll
                   back on failure, and record the branch and commit in /var/lib/${NAME}/deployed.json
                   (the server's /health reports it)
  --provision      one-time setup of the LXC (Node 22, ops user, directories)
  --env            copy the server's settings from .env into its /etc/${NAME}/env (mode 0640) and
                   restart: ${ENV_NAMES.join(", ")}.
                   Only those set in .env are replaced; the server's others are left as they are
  --skip-tests     deploy without running the test suite first

Needs AUTHORING_DEPLOY_PASSWORD in .env.`;

const password = process.env.AUTHORING_DEPLOY_PASSWORD;
const sshOptions = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];

function sshEnv() {
  return { ...process.env, SSH_ASKPASS: ASKPASS, SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY || "ops-deploy" };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Runs a bash script as root on the host; resolves with its stdout (also echoed). */
function runAsRoot(script) {
  const encoded = Buffer.from(script).toString("base64");
  const command = `sudo -S -p '' bash -c "$(printf %s '${encoded}' | base64 -d)"`;
  return new Promise((resolve, reject) => {
    const ssh = spawn("ssh", [...sshOptions, HOST, command], { env: sshEnv(), stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    ssh.stdout.on("data", (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    ssh.stdin.end(`${password}\n`);
    ssh.on("error", reject);
    ssh.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${HOST}: remote script exited with ${code}`))));
  });
}

const WAIT_FOR_HEALTH = `
set -a; . /etc/${NAME}/env; set +a
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$OPS_PORT/health"; then echo; break; fi
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$OPS_PORT/health"`;

async function provision() {
  await runAsRoot(fs.readFileSync(path.join(root, "deploy", "provision.sh"), "utf8"));
  console.log("\nProvisioned. Next: npm run deploy -- --env, then npm run deploy");
}

/** Sets the server's settings from this machine's .env, so nothing passes through a chat or a command line. */
async function pushEnv() {
  const names = ENV_NAMES.filter((n) => process.env[n]?.trim());
  if (!names.length) throw new Error(`None of ${ENV_NAMES.join(", ")} is set in .env.`);
  console.log(`Setting ${names.join(", ")} on the server; leaving ${ENV_NAMES.filter((n) => !names.includes(n)).join(", ") || "nothing else"} as it is.`);
  const encoded = Buffer.from(`${names.map((n) => `${n}=${process.env[n].trim()}`).join("\n")}\n`).toString("base64");
  await runAsRoot(`
set -euo pipefail
f=/etc/${NAME}/env
grep -v ${names.map((n) => `-e '^${n}='`).join(" ")} "$f" > "$f.new" || true
printf %s ${shellQuote(encoded)} | base64 -d >> "$f.new"
chown root:ops "$f.new" && chmod 0640 "$f.new" && mv "$f.new" "$f"
cut -d= -f1 "$f" | tr '\\n' ' '; echo
systemctl is-active --quiet ${NAME}.service || exit 0
systemctl restart ${NAME}.service
${WAIT_FOR_HEALTH}`);
}

async function deploy({ skipTests }) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (!skipTests) execFileSync("npm", ["test"], { cwd: root, stdio: "inherit" });

  const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const tarball = path.join(os.tmpdir(), `${NAME}-${id}.tgz`);
  execFileSync("tar", ["czf", tarball, "-C", root, "dist", "deploy", "suites", "package.json", "package-lock.json"]);
  execFileSync("scp", [...sshOptions, tarball, `${HOST}:/tmp/`], { env: sshEnv(), stdio: "inherit" });
  fs.rmSync(tarball);

  await runAsRoot(`
set -euo pipefail
release=/opt/${NAME}/releases/${id}
mkdir -p "$release"
tar xzf /tmp/${NAME}-${id}.tgz -C "$release"
rm -f /tmp/${NAME}-${id}.tgz
cd "$release"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
previous=$(readlink /opt/${NAME}/current || true)
echo "previous=$previous"
install_unit() {
  install -m 0644 "$1/deploy/${NAME}.service" /etc/systemd/system/ && systemctl daemon-reload
}
# From the switch on, any failure puts the previous release (and its unit) back.
rollback() {
  status=$?
  [ "$status" -eq 0 ] && return
  journalctl -u ${NAME}.service -n 20 --no-pager || true
  if [ -n "$previous" ]; then
    ln -sfn "$previous" /opt/${NAME}/current
    if install_unit "$previous"; then
      systemctl restart ${NAME}.service || echo "${NAME} didn't restart on $previous"
      echo "rolled_back=$previous"
    else
      echo "rollback_incomplete=$previous: its unit couldn't be put back"
    fi
  fi
  exit "$status"
}
trap rollback EXIT
ln -sfn "$release" /opt/${NAME}/current.new && mv -T /opt/${NAME}/current.new /opt/${NAME}/current
install_unit "$release"
systemctl enable --quiet ${NAME}.service
systemctl restart ${NAME}.service
${WAIT_FOR_HEALTH}
trap - EXIT
echo "installed=${id}"
ls -1dt /opt/${NAME}/releases/* | tail -n +4 | xargs -r rm -rf
`);
  await writeDeployed({ branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), commit: git(["rev-parse", "HEAD"]), local: true, dirty: git(["status", "--porcelain"]) !== "" });
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const DEPLOYED = `/var/lib/${NAME}/deployed.json`;

/** Records what the server now runs ({ branch, commit, local, dirty, at }), for /health. */
async function writeDeployed(record) {
  const encoded = Buffer.from(JSON.stringify({ ...record, at: new Date().toISOString() })).toString("base64");
  await runAsRoot(`printf %s ${shellQuote(encoded)} | base64 -d > ${DEPLOYED}.new && chmod 0644 ${DEPLOYED}.new && mv ${DEPLOYED}.new ${DEPLOYED} && echo`);
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return console.log(USAGE);
  const known = new Set(["--provision", "--env", "--skip-tests"]);
  const unknown = argv.find((a) => !known.has(a));
  if (unknown) throw new Error(`Unknown argument ${unknown}.\n\n${USAGE}`);
  if (!password) throw new Error(`AUTHORING_DEPLOY_PASSWORD is not set.\n\n${USAGE}`);
  if (argv.includes("--provision")) return provision();
  if (argv.includes("--env")) return pushEnv();
  return deploy({ skipTests: argv.includes("--skip-tests") });
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
