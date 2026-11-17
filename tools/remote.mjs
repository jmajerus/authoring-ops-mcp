// Running scripts on the suite's LXCs over SSH, for the deploy tools. Each script goes as base64, so nothing in
// it is parsed by the remote login shell.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const sshOptions = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** SSH that answers a password prompt from AUTHORING_DEPLOY_PASSWORD (tools/askpass.mjs) rather than a terminal. */
export function sshEnv() {
  return { ...process.env, SSH_ASKPASS: path.join(root, "tools", "askpass.mjs"), SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY || "ops-deploy" };
}

function run(host, args, command, stdin, env) {
  return new Promise((resolve, reject) => {
    const ssh = spawn("ssh", [...sshOptions, ...args, host, command], { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    ssh.stdout.on("data", (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    ssh.stdin.end(stdin);
    ssh.on("error", reject);
    ssh.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${host}: remote script exited with ${code}`))));
  });
}

const decode = (script) => `"$(printf %s '${Buffer.from(script).toString("base64")}' | base64 -d)"`;

/** Runs a bash script as root through `sudo -S`, the password on stdin; resolves with its stdout (also echoed). */
export function runAsRoot(host, password, script) {
  return run(host, [], `sudo -S -p '' bash -c ${decode(script)}`, `${password}\n`, sshEnv());
}

/** Runs a bash script on a host that takes this machine's key as root (no password, no prompt). */
export function runAsRootByKey(host, script) {
  return run(host, ["-o", "BatchMode=yes"], `bash -c ${decode(script)}`, "", process.env);
}
