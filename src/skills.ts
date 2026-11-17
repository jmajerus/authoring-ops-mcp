import fs from "node:fs";
import path from "node:path";

/**
 * The skills this release carries: a copy of the skills repository at a pinned ref, put in ./skills by
 * tools/vendor-skills.mjs at deploy. Read once at start; nothing is fetched at run time. They're served to
 * clients that can't install skills, and their tool list is checked against what the services list.
 */

export interface SkillsVersion { repo?: string; ref: string; commit?: string; dirty?: boolean; at?: string }
export interface Skill { name: string; description: string; files: string[] }
export interface SkillSet {
  dir: string;
  version: SkillsVersion;
  skills: Skill[];
  /** tools-used.json: the tools the skills call, by service. Undefined when that ref has no such file. */
  toolsUsed?: Record<string, string[]>;
  /** Every `name_like_this` the skills' Markdown puts in backticks: tool names among field names. */
  mentioned: string[];
}

export class SkillError extends Error {}

/** Larger than any skill file should be; a file over it isn't sent whole into a context window. */
const MAX_BYTES = 200_000;

function filesUnder(dir: string, prefix = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(path.join(dir, entry.name), relative) : entry.isFile() ? [relative] : [];
  }).sort();
}

/** The skills in `dir`, or undefined when this release carries none. */
export function loadSkills(dir: string): SkillSet | undefined {
  let version: SkillsVersion;
  try { version = JSON.parse(fs.readFileSync(path.join(dir, "version.json"), "utf8")) as SkillsVersion; } catch { return undefined; }
  const mentioned = new Set<string>();
  const skills = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "SKILL.md"))).sort().map((name): Skill => {
    const files = filesUnder(path.join(dir, name));
    for (const file of files.filter((f) => f.endsWith(".md"))) {
      for (const m of fs.readFileSync(path.join(dir, name, file), "utf8").matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) mentioned.add(m[1]);
    }
    const front = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8").match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
    return { name, description: front.match(/^description: (.*)$/m)?.[1]?.trim() ?? "", files: ["SKILL.md", ...files.filter((f) => f !== "SKILL.md")] };
  });
  let toolsUsed: Record<string, string[]> | undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "tools-used.json"), "utf8")) as Record<string, unknown>;
    toolsUsed = Object.fromEntries(Object.entries(raw).filter(([, tools]) => Array.isArray(tools)).map(([service, tools]) => [service, (tools as unknown[]).map(String)]));
  } catch { /* A ref from before the file existed: the drift check says so instead of passing. */ }
  return { dir, version, skills, ...(toolsUsed ? { toolsUsed } : {}), mentioned: [...mentioned].sort() };
}

/** One file of a skill. Only files the listing names can be read, so a path can't leave the skill's folder. */
export function readSkillFile(set: SkillSet, name: string, file = "SKILL.md"): string {
  const skill = set.skills.find((s) => s.name === name);
  if (!skill) throw new SkillError(`There is no skill "${name}". The skills are: ${set.skills.map((s) => s.name).join(", ")}.`);
  if (!skill.files.includes(file)) throw new SkillError(`${name} has no file "${file}". Its files are: ${skill.files.join(", ")}.`);
  const body = fs.readFileSync(path.join(set.dir, name, file));
  if (body.includes(0)) throw new SkillError(`${name}/${file} isn't text.`);
  if (body.length > MAX_BYTES) throw new SkillError(`${name}/${file} is ${body.length} bytes, too large to send whole.`);
  return body.toString("utf8");
}

export function versionLabel(v: SkillsVersion): string {
  return `${v.repo ?? "skills"} at ${v.ref}${v.commit ? ` (${v.commit.slice(0, 7)}${v.dirty ? ", with uncommitted changes" : ""})` : ""}`;
}
