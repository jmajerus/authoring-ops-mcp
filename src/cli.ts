import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { readInstalled } from "./github.js";
import { statusOf } from "./mcp.js";
import { Poller } from "./poller.js";
import { readHealth } from "./probes.js";
import { serveHttp, serveStdio } from "./server.js";
import { loadSkills } from "./skills.js";
import { Store } from "./store.js";

/**
 *   ops serve      The dashboard at /, MCP over HTTP at /mcp, and /health (OPS_HOST, OPS_PORT), polling the suite
 *                  in OPS_SUITE every OPS_POLL_SECONDS (60) and keeping "since" times in OPS_STATE. Serves the
 *                  skills in OPS_SKILLS (./skills), if this release carries any.
 *   ops status     Polls once and prints what the status tool answers, then the findings. Keeps nothing.
 *   ops stdio      MCP over stdio, for local clients and tests.
 */

const stateFile = () => process.env.OPS_STATE ?? "data/state.json";
/** The skills this release carries (OPS_SKILLS, ./skills): put there by `npm run skills`, or by the deploy. */
const skills = () => loadSkills(process.env.OPS_SKILLS ?? "skills");

/** What tools/deploy-fork.mjs last installed, from forks.json beside the state file: read each poll. */
const installed = () => () => {
  try { return readInstalled(JSON.parse(fs.readFileSync(path.join(path.dirname(stateFile()), "forks.json"), "utf8"))); } catch { return {}; }
};

/** What this server's own deploy recorded, from deployed.json beside the state file: read each poll. */
const deployed = () => () => {
  try { return readHealth({ deployed: JSON.parse(fs.readFileSync(path.join(path.dirname(stateFile()), "deployed.json"), "utf8")) }, "").deployed; } catch { return undefined; }
};

const commands: Record<string, () => unknown> = {
  serve: async () => {
    const poller = new Poller(loadConfig(), new Store(stateFile()), { skills: skills(), installed: installed(), deployed: deployed() });
    await serveHttp(poller, { host: process.env.OPS_HOST ?? "0.0.0.0", port: Number(process.env.OPS_PORT ?? 8000), stateDir: path.dirname(stateFile()) });
    poller.start(Number(process.env.OPS_POLL_SECONDS ?? 60));
  },
  status: async () => {
    const snapshot = await new Poller(loadConfig(), new Store(), { skills: skills(), installed: installed() }).poll();
    console.log(JSON.stringify({ ...statusOf(snapshot), findings: snapshot.findings }, null, 2));
  },
  stdio: () => serveStdio(new Poller(loadConfig(), new Store(), { skills: skills() })),
};

const command = process.argv[2];
if (!command || !commands[command]) {
  console.error(`Usage: ops <${Object.keys(commands).join(" | ")}>`);
  process.exitCode = 2;
} else {
  Promise.resolve(commands[command]()).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
