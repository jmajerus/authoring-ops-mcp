#!/usr/bin/env node
// Copies the suite's skills into ./skills, from a checkout of the skills repository at the ref the suite config
// pins (skills.ref). The server serves that copy and nothing else: it never fetches skills at run time, so what
// it serves is what was deployed, and /health names the ref. `npm run deploy` runs this before it packs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const USAGE = `Usage: npm run skills -- [--ref <tag, branch, or commit>] [--worktree] [--from <checkout>]

  (no flag)     the ref in the suite config (OPS_SUITE, suites/authoring.json), from ../<repository's name>
  --ref         another ref, for a look at what a tag would serve
  --worktree    the checkout's files as they are now, committed or not (for development; never deployed)
  --from        the checkout, if it isn't beside this one (or set OPS_SKILLS_CHECKOUT)`;

export function vendorSkills({ ref, worktree = false, from, out = path.join(root, "skills"), suite = process.env.OPS_SUITE ?? path.join(root, "suites/authoring.json") } = {}) {
  const config = JSON.parse(fs.readFileSync(suite, "utf8")).skills;
  if (!config) return null;
  const checkout = from ?? process.env.OPS_SKILLS_CHECKOUT ?? path.join(root, "..", String(config.repo).split("/").pop());
  if (!fs.existsSync(path.join(checkout, ".git"))) throw new Error(`No checkout of ${config.repo} at ${checkout}. Clone it there, or name it with --from.`);
  const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  let source = checkout;
  let version;
  let temp;
  if (worktree) {
    version = { repo: config.repo, ref: "worktree", commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
  } else {
    const wanted = ref ?? config.ref;
    let commit;
    try { commit = git("rev-parse", "--verify", "--quiet", `${wanted}^{commit}`); } catch { throw new Error(`${config.repo} has no ref ${wanted} in ${checkout}. Tag it (git tag ${wanted}), fetch, or pass --ref.`); }
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
    const tar = path.join(temp, "skills.tar");
    git("archive", "--format=tar", "-o", tar, commit);
    source = path.join(temp, "tree");
    fs.mkdirSync(source);
    execFileSync("tar", ["xf", tar, "-C", source]);
    version = { repo: config.repo, ref: wanted, commit };
  }

  const skills = fs.readdirSync(source).filter((d) => fs.existsSync(path.join(source, d, "SKILL.md"))).sort();
  if (!skills.length) throw new Error(`${checkout} has no folder with a SKILL.md at ${version.ref}.`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const skill of skills) copyThrough(path.join(source, skill), path.join(out, skill));
  const used = path.join(source, "tools-used.json");
  if (fs.existsSync(used)) fs.copyFileSync(used, path.join(out, "tools-used.json"));
  fs.writeFileSync(path.join(out, "version.json"), `${JSON.stringify({ ...version, at: new Date().toISOString() }, null, 2)}\n`);
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
  return { ...version, skills, tools_used: fs.existsSync(used) };
}

/** Copies a folder, following links: a skill's link to a shared file becomes the file, so each folder stands alone. */
function copyThrough(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const source = path.join(from, name);
    const stat = fs.statSync(source);
    if (stat.isDirectory()) copyThrough(source, path.join(to, name));
    else if (stat.isFile()) fs.copyFileSync(source, path.join(to, name));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  try {
    if (argv.includes("--help") || argv.includes("-h")) console.log(USAGE);
    else {
      const r = vendorSkills({ ref: option("--ref"), worktree: argv.includes("--worktree"), from: option("--from") });
      console.log(r ? `skills: ${r.skills.length} from ${r.repo} at ${r.ref} (${r.commit.slice(0, 7)}${r.dirty ? ", uncommitted changes" : ""})${r.tools_used ? "" : "; no tools-used.json at that ref"}` : "The suite config pins no skills.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
