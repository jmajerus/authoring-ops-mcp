import path from "node:path";
import { loadConfig } from "./config.js";
import { statusOf } from "./mcp.js";
import { Poller } from "./poller.js";
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

const commands: Record<string, () => unknown> = {
  serve: async () => {
    const poller = new Poller(loadConfig(), new Store(stateFile()), { skills: skills() });
    await serveHttp(poller, { host: process.env.OPS_HOST ?? "0.0.0.0", port: Number(process.env.OPS_PORT ?? 8000), stateDir: path.dirname(stateFile()) });
    poller.start(Number(process.env.OPS_POLL_SECONDS ?? 60));
  },
  status: async () => {
    const snapshot = await new Poller(loadConfig(), new Store(), { skills: skills() }).poll();
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
